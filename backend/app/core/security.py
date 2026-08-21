"""Password hashing and token generation.

Deliberately built on the standard library — `hashlib.pbkdf2_hmac` and `secrets`
are enough for this, and the project has no crypto dependency to reach for.

Two shapes of secret:

  * **passwords** are hashed with PBKDF2-HMAC-SHA256 and a per-user salt. The
    iteration count is stored alongside, so it can be raised later without
    invalidating existing hashes.
  * **tokens** (sessions, reset links) are random and opaque. Only their SHA-256
    is stored, so a leaked table cannot be used to log in — the same reason
    passwords are not stored in the clear.
"""
import hashlib
import hmac
import secrets
from typing import Tuple

ALGORITHM = "pbkdf2_sha256"
ITERATIONS = 240_000
SALT_BYTES = 16
TOKEN_BYTES = 32

MIN_PASSWORD_LENGTH = 8


class WeakPassword(ValueError):
    """The password is too easily guessed to accept."""


def check_password_strength(password: str) -> None:
    """A floor, not a policy. Length does more than character classes."""
    if not password or len(password) < MIN_PASSWORD_LENGTH:
        raise WeakPassword(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters"
        )
    if password.lower() in {
        "password", "12345678", "qwertyui", "letmein1", "changeme", "admin123",
    }:
        raise WeakPassword("That password is too common — choose another")


def hash_password(password: str, iterations: int = ITERATIONS) -> str:
    """`pbkdf2_sha256$iterations$salt$hash`, self-describing so it can be
    re-hashed at a higher cost later."""
    salt = secrets.token_bytes(SALT_BYTES)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"{ALGORITHM}${iterations}${salt.hex()}${derived.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time comparison; False for anything malformed."""
    try:
        algorithm, iterations, salt_hex, expected_hex = str(stored).split("$")
        if algorithm != ALGORITHM:
            return False
        derived = hashlib.pbkdf2_hmac(
            "sha256", (password or "").encode("utf-8"),
            bytes.fromhex(salt_hex), int(iterations),
        )
    except (AttributeError, ValueError):
        return False
    return hmac.compare_digest(derived.hex(), expected_hex)


def needs_rehash(stored: str, iterations: int = ITERATIONS) -> bool:
    """True once the stored hash is weaker than what we now issue."""
    try:
        algorithm, stored_iterations, _, _ = str(stored).split("$")
    except (AttributeError, ValueError):
        return True
    return algorithm != ALGORITHM or int(stored_iterations) < iterations


def new_token() -> Tuple[str, str]:
    """(token to hand out, hash to store). The raw token is never persisted."""
    token = secrets.token_urlsafe(TOKEN_BYTES)
    return token, hash_token(token)


def hash_token(token: str) -> str:
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()
