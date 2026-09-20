"""Storing a secret this application must later use again — and read back.

Passwords are hashed and never read back (`security.py`). This is the other
case: an external database password or a Databricks access token, which the
server has to present to somebody else's service days after it was typed. It
has to be reversible, so it is encrypted rather than hashed, and the key lives
in configuration rather than in the database it protects.

    seal(value, aad)   -> "v1$salt$nonce$ciphertext$tag"
    unseal(blob, aad)  -> value, or SecretTampered

Built from the standard library, like the rest of this project's secret
handling — there is no crypto dependency to reach for — but out of ordinary
pieces rather than an invented cipher:

  * **PBKDF2-HMAC-SHA256** over the master key and a fresh 16-byte salt derives
    two independent keys per record: one to encrypt with, one to authenticate
    with.
  * **HMAC-SHA256 in counter mode** is the keystream: block *n* is
    HMAC(key, nonce || n), XORed with the plaintext. A nonce is random per
    record and never reused with the same derived key, because the salt is
    fresh too.
  * **Encrypt-then-MAC**: the tag is HMAC-SHA256 over the version, salt, nonce,
    ciphertext and `aad` — the record's own identity, so a sealed credential
    cannot be moved to another row and still open. It is checked, in constant
    time, before anything is decrypted.

The master key is `SECRET_KEY` in the environment, never in source. Without it
nothing can be sealed: the feature that needed it says so, rather than storing
a credential in the clear. Rotating it makes existing sealed values unreadable,
which is a deliberate, visible failure — those credentials have to be entered
again.
"""
import base64
import hashlib
import hmac
import secrets as random_secrets
from typing import Optional

from app.core.config import settings

VERSION = "v1"
ITERATIONS = 100_000
SALT_BYTES = 16
NONCE_BYTES = 16
KEY_BYTES = 32            # one to encrypt with, one to authenticate with
MINIMUM_KEY_LENGTH = 32


class SecretUnavailable(RuntimeError):
    """There is no key configured, so nothing can be sealed or opened."""


class SecretTampered(ValueError):
    """The stored value does not match its tag, or was sealed with another key."""


def available() -> bool:
    """Whether this installation can store a credential at all."""
    return len(str(settings.secret_key or "").strip()) >= MINIMUM_KEY_LENGTH


def _master() -> bytes:
    key = str(settings.secret_key or "").strip()
    if len(key) < MINIMUM_KEY_LENGTH:
        raise SecretUnavailable(
            "This installation has no SECRET_KEY, so credentials cannot be stored. "
            "Set SECRET_KEY (at least 32 characters) and restart the server.")
    return key.encode("utf-8")


def _keys(salt: bytes) -> tuple:
    material = hashlib.pbkdf2_hmac("sha256", _master(), salt, ITERATIONS,
                                   dklen=KEY_BYTES * 2)
    return material[:KEY_BYTES], material[KEY_BYTES:]


def _keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < length:
        out.extend(hmac.new(key, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest())
        counter += 1
    return bytes(out[:length])


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def seal(value: str, aad: str = "") -> str:
    """One secret, encrypted and authenticated, safe to put in a column."""
    plain = str(value).encode("utf-8")
    salt = random_secrets.token_bytes(SALT_BYTES)
    nonce = random_secrets.token_bytes(NONCE_BYTES)
    cipher_key, mac_key = _keys(salt)

    hidden = bytes(a ^ b for a, b in zip(plain, _keystream(cipher_key, nonce, len(plain))))
    tag = hmac.new(mac_key,
                   VERSION.encode() + salt + nonce + hidden + str(aad).encode("utf-8"),
                   hashlib.sha256).digest()
    return "$".join([VERSION, _b64(salt), _b64(nonce), _b64(hidden), _b64(tag)])


def unseal(blob: str, aad: str = "") -> str:
    """The secret back, or `SecretTampered` — never a half-decrypted guess."""
    try:
        version, salt_b64, nonce_b64, hidden_b64, tag_b64 = str(blob).split("$")
        if version != VERSION:
            raise ValueError(f"unknown version {version!r}")
        salt, nonce = _unb64(salt_b64), _unb64(nonce_b64)
        hidden, tag = _unb64(hidden_b64), _unb64(tag_b64)
    except SecretUnavailable:
        raise
    except Exception as exc:
        raise SecretTampered("That stored credential could not be read.") from exc

    cipher_key, mac_key = _keys(salt)
    expected = hmac.new(mac_key,
                        version.encode() + salt + nonce + hidden + str(aad).encode("utf-8"),
                        hashlib.sha256).digest()
    if not hmac.compare_digest(expected, tag):
        # Wrong key, a changed row, or a value moved from another record.
        raise SecretTampered(
            "That stored credential could not be read. It may have been saved "
            "with a different SECRET_KEY; enter it again to replace it.")

    plain = bytes(a ^ b for a, b in zip(hidden, _keystream(cipher_key, nonce, len(hidden))))
    return plain.decode("utf-8")


def redact(value: Optional[str]) -> str:
    """For a log line that wants to say something about a secret. Never it."""
    return "set" if value else "-"
