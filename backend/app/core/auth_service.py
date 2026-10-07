"""Accounts, sessions and password resets.

Authorisation is by permission, not by role name. A role is a set of
permissions (see `role_service`), a user holds one role, and `may(user, perm)`
asks the only question worth asking: is this person allowed to do this?

That indirection is what lets an admin invent a role — "Supervisor", say — and
decide for themselves what it may do, without a line of code changing.
"""
import logging
import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from app.core.config import settings
from app.core.database import table_exists, transaction
from app.core.security import (
    WeakPassword,
    check_password_strength,
    hash_password,
    hash_token,
    needs_rehash,
    new_token,
    verify_password,
)

logger = logging.getLogger(__name__)

# Named here rather than imported: `permissions` imports modules while it
# assembles its catalogue, and this module is one of the things they reach.
USERS_MANAGE_KEY = "users.manage"

# The system roles an installation starts with, and the default for a new
# account. What somebody may do *inside a project* is not here — that comes from
# the role their membership carries. See app/modules/projects/permissions.py.
ROLE_STANDARD = "standard"
ROLE_ADMIN = "admin"

# `field` became `standard`. Kept so a script, a seed file or a caller written
# against the old name still resolves rather than failing at "Unknown role".
ROLE_FIELD = ROLE_STANDARD
ROLE_EDITOR = "editor"

LEGACY_ROLE_NAMES = {"field": ROLE_STANDARD}

USER_ID_PREFIX = "USR"
MAX_FAILED_LOGINS = 5
LOCKOUT_MINUTES = 15

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class AuthError(RuntimeError):
    """Wrong credentials, a locked account, or a token that will not do."""


class UserNotFound(LookupError):
    pass


class UserExists(ValueError):
    pass


# --------------------------------------------------------------------------- #
# permissions
# --------------------------------------------------------------------------- #
def may(user: Optional[Dict[str, Any]], permission: str) -> bool:
    """Is this user allowed to do this?"""
    if not user or not user.get("is_active", True):
        return False
    return permission in set(user.get("permissions") or [])


# Every read of a user joins their role, so `permissions` is always populated
# and no caller has to remember to look it up.
_USER_SELECT = """
    SELECT u.*, r.name AS role, r.label AS role_label,
           COALESCE(
               (SELECT array_agg(p.permission ORDER BY p.permission)
                FROM role_permission p WHERE p.role_id = u.role_id),
               ARRAY[]::varchar[]
           ) AS permissions
    FROM   app_user u
    LEFT JOIN app_role r ON r.role_id = u.role_id
"""


def _public(row: Dict[str, Any]) -> Dict[str, Any]:
    """A user as the API returns it — never the password hash."""
    return {
        "user_id": row["user_id"],
        "email": row["email"],
        "username": row.get("username"),
        "phone": row.get("phone"),
        "full_name": row.get("full_name"),
        "role_id": row.get("role_id"),
        "role": row.get("role"),
        "role_label": row.get("role_label") or row.get("role"),
        "permissions": [str(p) for p in (row.get("permissions") or [])],
        "is_active": row.get("is_active", True),
        "last_login_on": row.get("last_login_on"),
        "created_on": row.get("created_on"),
        "created_by": row.get("created_by"),
        "locked": bool(row.get("locked_until") and row["locked_until"] > datetime.utcnow()),
        # Whether a voice is enrolled, never the voiceprint itself. This
        # function is a whitelist precisely so that `u.*` growing a column
        # cannot start returning it.
        "voice_enrolled": bool(row.get("voiceprint")),
        "voice_enrolled_on": row.get("voiceprint_on"),
    }


def display_name(user: Optional[Dict[str, Any]]) -> str:
    """What goes in a `created_by` column — 50 characters of something readable."""
    if not user:
        return settings.default_user
    # Whichever of the three the account has — it may not have an email.
    return str(user.get("full_name") or user.get("email") or user.get("username")
               or user.get("phone") or settings.default_user)[:50]


# --------------------------------------------------------------------------- #
# accounts
# --------------------------------------------------------------------------- #
def _next_user_id(cur) -> str:
    cur.execute(
        f"""
        SELECT COALESCE(MAX(CAST(SUBSTRING(user_id, {len(USER_ID_PREFIX) + 1}) AS INTEGER)), 0) + 1
               AS next_no
        FROM app_user WHERE user_id ~ %s
        """,
        (f"^{USER_ID_PREFIX}[0-9]+$",),
    )
    return f"{USER_ID_PREFIX}{int(cur.fetchone()['next_no']):05d}"


def _clean_email(email: str) -> str:
    value = str(email or "").strip().lower()
    if not _EMAIL.match(value):
        raise AuthError(f"'{email}' is not a valid email address")
    return value[:255]


# --------------------------------------------------------------------------- #
# Three ways to say who you are
#
# An account may sign in by email, by username or by phone number. One password,
# one account, one lockout counter — only the way of naming it differs.
#
# **The three must never be able to collide.** If a username could be written
# like an email, somebody could claim `asha@example.com` as their username and
# sign-in attempts meant for that address would find their account instead. So
# each shape is exclusive, enforced where accounts are made:
#
#     email     has an @
#     username  letters, digits, dot, dash, underscore — no @, and never all
#               digits, which would read as a phone number
#     phone     digits, with an optional leading +
#
# Each is also stored in one canonical form, because `Asha`, `asha` and ` asha `
# are one person, and `+91 98765 43210` and `9876543210` are one number.
# --------------------------------------------------------------------------- #
_USERNAME = re.compile(r"^[a-z0-9][a-z0-9._-]{2,49}$")

#: Longest an international number gets, counting the country code.
_MAX_PHONE = 15


def clean_username(username: str) -> str:
    """Lowercased, and refused if it could be read as an email or a number."""
    value = str(username or "").strip().lower()

    if "@" in value:
        raise AuthError("A username cannot contain '@' — that would read as an "
                        "email address.")
    if value.isdigit():
        raise AuthError("A username cannot be only digits — that would read as "
                        "a phone number.")
    if not _USERNAME.match(value):
        raise AuthError(
            f"'{username}' is not a valid username. Use 3 to 50 characters: "
            "letters, digits, dots, dashes or underscores.")

    return value


def clean_phone(phone: str) -> str:
    """Digits, keeping a leading `+`.

    Everything people put between the digits — spaces, dashes, brackets — is
    formatting, and two of the same number written differently have to store
    identically or the uniqueness constraint means nothing.
    """
    raw = str(phone or "").strip()
    plus = raw.startswith("+")
    digits = re.sub(r"\D", "", raw)

    if not 6 <= len(digits) <= _MAX_PHONE:
        raise AuthError(f"'{phone}' is not a valid phone number.")

    return ("+" if plus else "") + digits


def _as_identifiers(value: str) -> Dict[str, Optional[str]]:
    """What this could be, in each namespace's own canonical form.

    None where the text cannot be that kind of thing at all, so a sign-in never
    looks for a username that could not have been created.
    """
    text = str(value or "").strip()

    def _or_none(clean):
        try:
            return clean(text)
        except AuthError:
            return None

    phone = _or_none(clean_phone)

    return {
        "email": _or_none(_clean_email),
        "username": _or_none(clean_username),
        "phone": phone,
        # The same number without its country code. Somebody enrolled as
        # `+919876543210` types `9876543210` as often as not, and an exact match
        # alone turns that into "incorrect details" for the right number.
        #
        # Only ever a *lookup* convenience: what is stored stays exactly what was
        # enrolled, uniqueness is still the column's, and a suffix matching two
        # accounts — the same national number in two countries — is refused
        # rather than resolved to one of them. Ten digits minimum, so a short
        # extension cannot sweep up unrelated numbers.
        "phone_suffix": ("%" + phone.lstrip("+")) if phone and len(phone.lstrip("+")) >= 10 else None,
    }


def _resolve_role(cur, role):
    """Accept a role id or a role name; return the id.

    A name this installation has renamed still resolves — `field` finds
    `standard` — so nothing written against the old name breaks.
    """
    wanted = str(role or ROLE_STANDARD).strip()
    wanted = LEGACY_ROLE_NAMES.get(wanted.lower(), wanted)
    cur.execute(
        "SELECT role_id FROM app_role WHERE role_id = %s OR name = %s",
        (wanted, wanted.lower()),
    )
    row = cur.fetchone()
    if not row:
        raise AuthError("Unknown role '%s'" % role)
    return row["role_id"]


def _read_user(cur, user_id=None, email=None):
    where = "WHERE u.user_id = %s" if user_id else "WHERE u.email = %s"
    cur.execute(_USER_SELECT + where, (user_id or email,))
    row = cur.fetchone()
    return dict(row) if row else None


def create_user(
    email: Optional[str] = None,
    password: str = "",
    *,
    full_name: Optional[str] = None,
    role: str = ROLE_FIELD,
    created_by: Optional[str] = None,
    username: Optional[str] = None,
    phone: Optional[str] = None,
) -> Dict[str, Any]:
    """An account, and the ways it may be signed in to.

    Any one of email, username or phone — each optional on its own, and at
    least one required, because an account nobody can name is an account nobody
    can sign in to. The same rule is a CHECK constraint on the table, so no code
    path can leave one behind.

    Worth knowing when choosing: **a password reset is sent by email.** An
    account without one has no self-service way back in, and its password has to
    be set for it by somebody who can manage users.

    Each of the three is unique across every account.
    """
    email = _clean_email(email) if str(email or "").strip() else None
    username = clean_username(username) if str(username or "").strip() else None
    phone = clean_phone(phone) if str(phone or "").strip() else None

    if not (email or username or phone):
        raise AuthError(
            "An account needs at least one of an email address, a username or "
            "a phone number to sign in with.")

    check_password_strength(password)

    with transaction() as cur:
        role_id = _resolve_role(cur, role)

        # Checked here for a message that says which one is taken; the UNIQUE
        # constraints are what actually guarantee it, including against two
        # requests arriving at once.
        for column, value, said in (("email", email, email),
                                    ("username", username, f"the username '{username}'"),
                                    ("phone", phone, f"the phone number {phone}")):
            if value is None:
                continue
            cur.execute(f"SELECT 1 FROM app_user WHERE {column} = %s", (value,))
            if cur.fetchone():
                raise UserExists(f"An account already exists for {said}")

        user_id = _next_user_id(cur)
        cur.execute(
            """
            INSERT INTO app_user
                (user_id, email, username, phone, full_name, role_id,
                 password_hash, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (user_id, email, username, phone,
             (full_name or "").strip()[:120] or None,
             role_id, hash_password(password), created_by),
        )
        created = _read_user(cur, user_id=user_id)

    logger.info("Created %s account for %s", created["role"],
                email or username or phone)
    return _public(created)


def list_users(include_inactive: bool = True) -> List[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute(
            _USER_SELECT
            + ("" if include_inactive else "WHERE u.is_active ")
            + "ORDER BY r.label NULLS LAST, u.email"
        )
        return [_public(dict(r)) for r in cur.fetchall()]


def get_user(user_id: str) -> Dict[str, Any]:
    with transaction() as cur:
        row = _read_user(cur, user_id=user_id)
        if not row:
            raise UserNotFound("No user %s" % user_id)
        return _public(row)


def _can_still_manage_roles(cur, excluding_user: str) -> bool:
    """Is there another active account that can hand out roles?"""
    from app.core import permissions

    cur.execute(
        """
        SELECT COUNT(*) AS n
        FROM   app_user u
        JOIN   role_permission p ON p.role_id = u.role_id AND p.permission = %s
        WHERE  u.is_active AND u.user_id <> %s
        """,
        (permissions.ROLES_MANAGE, excluding_user),
    )
    return int(cur.fetchone()["n"]) > 0


def delete_user(user_id: str) -> Dict[str, Any]:
    """Remove an account for good, and everything that only describes it.

    **What goes.** The row itself, and by cascade its sessions, its password
    reset tokens, its project memberships, its project group memberships, and
    any form assigned to it by name. All of those are statements *about* an
    account and mean nothing once it is gone.

    **What stays.** Everything it collected or decided. `created_by` on a form
    and a response, and `submitted_by` / `reviewed_by` on a review, are display
    names rather than foreign keys — they were written down at the time and are
    still true afterwards. A submission keeps saying who filled it in and who
    approved it, and no history is rewritten or lost.

    That is the whole strategy: cascade the relationships, keep the record.

    Deactivating is usually the better answer, and is what the Users page offers
    first — an account that is switched off keeps its memberships and can be
    turned back on. Deletion is for an account that should never have existed.

    Two things it will not do. The last account that can manage access cannot be
    deleted, or the installation locks itself out. And an account cannot delete
    itself; that is refused by the route, so the check lives beside the session
    that made the request.
    """
    with transaction() as cur:
        cur.execute(
            "SELECT u.user_id, u.email, u.full_name, r.name AS role "
            "FROM app_user u LEFT JOIN app_role r ON r.role_id = u.role_id "
            "WHERE u.user_id = %s",
            (user_id,),
        )
        found = cur.fetchone()
        if found is None:
            raise UserNotFound(f"No account '{user_id}'")

        # The last way in. Counted by permission, never by role name: an
        # installation may rename its administrator role or invent another.
        cur.execute(
            """
            SELECT COUNT(*) AS n
            FROM   app_user u
            JOIN   role_permission rp ON rp.role_id = u.role_id
            WHERE  u.is_active AND rp.permission = %s AND u.user_id <> %s
            """,
            (USERS_MANAGE_KEY, user_id),
        )
        if int(cur.fetchone()["n"]) == 0:
            raise AuthError(
                "This is the last account that can manage access. Give another "
                "account that permission before removing this one."
            )

        # Counted before the row goes, so the answer can say what was removed.
        removed = {}
        for table, column in (("project_member", "user_id"),
                              ("project_group_member", "user_id"),
                              ("form_assignment", "user_id")):
            if not table_exists(cur, table):
                continue
            cur.execute(f"SELECT COUNT(*) AS n FROM {table} WHERE {column} = %s", (user_id,))
            removed[table] = int(cur.fetchone()["n"])

        # One statement, one transaction. Every relationship above is ON DELETE
        # CASCADE, so nothing is left pointing at an account that is gone.
        cur.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))

    logger.info("Deleted account %s (%s)", user_id, found["email"])
    return {
        "user_id": user_id,
        "email": found["email"],
        "deleted": True,
        "memberships_removed": removed.get("project_member", 0),
        "group_memberships_removed": removed.get("project_group_member", 0),
        "assignments_removed": removed.get("form_assignment", 0),
    }


def update_user(
    user_id: str,
    *,
    role: Optional[str] = None,
    full_name: Optional[str] = None,
    is_active: Optional[bool] = None,
    unlock: bool = False,
) -> Dict[str, Any]:
    """Change someone's role, name or access.

    Refuses the change that would leave nobody able to hand out roles — an
    installation locked out of its own administration needs database surgery to
    recover.
    """
    from app.core import permissions

    with transaction() as cur:
        existing = _read_user(cur, user_id=user_id)
        if not existing:
            raise UserNotFound("No user %s" % user_id)

        role_id = _resolve_role(cur, role) if role is not None else None
        held = set(existing.get("permissions") or [])

        losing = permissions.ROLES_MANAGE in held and (
            is_active is False
            or (role_id is not None and role_id != existing["role_id"])
        )
        if losing and not _can_still_manage_roles(cur, user_id):
            raise AuthError(
                "This is the only account that can manage roles — give someone else "
                "that permission first"
            )

        cur.execute(
            """
            UPDATE app_user
               SET role_id       = COALESCE(%s, role_id),
                   full_name     = COALESCE(%s, full_name),
                   is_active     = COALESCE(%s, is_active),
                   failed_logins = CASE WHEN %s THEN 0 ELSE failed_logins END,
                   locked_until  = CASE WHEN %s THEN NULL ELSE locked_until END,
                   updated_on    = CURRENT_TIMESTAMP
             WHERE user_id = %s
            """,
            (role_id, (full_name or "").strip()[:120] or None, is_active,
             unlock, unlock, user_id),
        )
        updated = _read_user(cur, user_id=user_id)

        # Losing access should end the sessions that access was granted through.
        if is_active is False or (role_id is not None and role_id != existing["role_id"]):
            cur.execute("DELETE FROM user_session WHERE user_id = %s", (user_id,))

    logger.info("Updated %s (role=%s active=%s)",
                user_id, updated["role"], updated["is_active"])
    return _public(updated)


# --------------------------------------------------------------------------- #
# voice enrolment
# --------------------------------------------------------------------------- #
def enrol_voice(user_id: str, recordings, *, consented: bool = False) -> Dict[str, Any]:
    """Store a voiceprint for someone from several recordings of them speaking.

    `recordings` are already-decoded 16 kHz mono samples — the browser decodes
    and resamples, because it has an audio decoder and the server would
    otherwise need one per codec a phone might choose. What crosses the wire is
    audio and never a vector: a client that could post a vector could post
    somebody else's.

    The recordings are not written anywhere. They exist for the length of this
    call, the vector is kept, and that is the end of them.

    Consent is required and dated rather than assumed, because this is biometric
    data about a person and "they were on screen when it was recorded" is not a
    record of anything.
    """
    from app.core import voiceprint

    if not consented:
        raise AuthError(
            "Voice sign-in records somebody's voice, so it needs their "
            "agreement before it can be set up.")

    # Before the work: a voiceprint takes a second of CPU, and there is no
    # reason to spend it on an account that is not there.
    with transaction() as cur:
        found = _read_user(cur, user_id=user_id)
        if not found:
            raise UserNotFound("No user %s" % user_id)
        if not found["is_active"]:
            raise AuthError("That account has been deactivated.")

    try:
        vector = voiceprint.enrol(list(recordings))
    except voiceprint.VoiceError as exc:
        # Said in the words the module chose — they describe what to do
        # differently, which a generic failure would throw away.
        raise AuthError(str(exc))

    with transaction() as cur:
        cur.execute(
            """
            UPDATE app_user
               SET voiceprint             = %s,
                   voiceprint_model       = %s,
                   voiceprint_on          = CURRENT_TIMESTAMP,
                   voiceprint_consent_on  = COALESCE(voiceprint_consent_on,
                                                     CURRENT_TIMESTAMP),
                   updated_on             = CURRENT_TIMESTAMP
             WHERE user_id = %s
            """,
            (voiceprint.pack(vector), voiceprint.MODEL, user_id),
        )
        updated = _read_user(cur, user_id=user_id)

    # The account, never the vector and never a similarity figure: a log that
    # records how closely somebody's voice matched is a biometric record too.
    logger.info("Enrolled a voice for %s (%s)", user_id, voiceprint.MODEL)
    return _public(updated)


def forget_voice(user_id: str) -> Dict[str, Any]:
    """Remove someone's voiceprint.

    Erasure has to be real and immediate for biometric data, which is why this
    clears the vector rather than flagging it. The consent date goes with it —
    an agreement to hold something that is no longer held is not a record worth
    keeping, and re-enrolling asks again.
    """
    with transaction() as cur:
        if not _read_user(cur, user_id=user_id):
            raise UserNotFound("No user %s" % user_id)
        cur.execute(
            """
            UPDATE app_user
               SET voiceprint            = NULL,
                   voiceprint_model      = NULL,
                   voiceprint_on         = NULL,
                   voiceprint_consent_on = NULL,
                   updated_on            = CURRENT_TIMESTAMP
             WHERE user_id = %s
            """,
            (user_id,),
        )
        updated = _read_user(cur, user_id=user_id)

    logger.info("Removed the voiceprint for %s", user_id)
    return _public(updated)


# --------------------------------------------------------------------------- #
# sessions
# --------------------------------------------------------------------------- #
def login(email: str, password: str, user_agent: Optional[str] = None) -> Dict[str, Any]:
    """Exchange a password for a session token."""
    return _sign_in(email, user_agent, lambda cur, user: _password_matches(
        cur, user, password))


def login_with_voice(email: str, recording, user_agent: Optional[str] = None
                     ) -> Dict[str, Any]:
    """Exchange a recording of somebody speaking for a session token.

    The same account lookup, the same lockout counter and the same deliberately
    vague failure as the password path — this is a second kind of credential,
    not a second way in around the first. A voice that does not match counts
    towards the lockout exactly as a wrong password does, or the voice endpoint
    would be a way to make unlimited attempts at an account whose password door
    is bolted.

    `recording` is already-decoded 16 kHz mono samples; the browser does that
    part, and what it sends is audio and never a voiceprint.

    Raises `voiceprint.VoiceError` for a recording that cannot be measured at
    all, rather than folding it into an `AuthError`. They are different answers:
    one is "that is not who you say you are" and the other is "speak closer to
    the microphone", and only the first is about the account.
    """
    from app.core import voiceprint

    # Outside the transaction, deliberately. The vector does not depend on which
    # account is being claimed, and it is most of a second of CPU — not
    # something to hold a row lock through. It also means an unusable recording
    # is rejected without touching the account or its lockout counter.
    spoken = voiceprint.embed(recording)

    return _sign_in(email, user_agent, lambda cur, user: _voice_matches(user, spoken),
                    how="voice")


def _password_matches(cur, user: Dict[str, Any], password: str) -> bool:
    if not verify_password(password, user["password_hash"]):
        return False
    # A correct password predating a cost increase is upgraded in place.
    if needs_rehash(user["password_hash"]):
        cur.execute("UPDATE app_user SET password_hash = %s WHERE user_id = %s",
                    (hash_password(password), user["user_id"]))
    return True


def _voice_matches(user: Dict[str, Any], spoken) -> bool:
    """Whether this voice is close enough to the one enrolled on the account.

    An account with nothing enrolled is a failure like any other and never a
    different message: saying "no voice is set up for this account" would turn
    the endpoint into a way of asking which accounts have one.
    """
    from app.core import voiceprint

    enrolled = voiceprint.unpack(user.get("voiceprint"))
    if enrolled is None:
        return False

    # A voiceprint from a different model is not merely a poor match — the
    # numbers mean something else entirely, and comparing them would be
    # arithmetic on unrelated quantities.
    if (user.get("voiceprint_model") or "") != voiceprint.MODEL:
        logger.warning("%s has a voiceprint from %s; this server runs %s",
                       user["user_id"], user.get("voiceprint_model"), voiceprint.MODEL)
        return False

    # Not logged, at any level: how closely somebody's voice matched is itself a
    # biometric measurement, and a log full of them is a log of biometric data.
    return voiceprint.similarity(enrolled, spoken) >= settings.voice_match_threshold


def _sign_in(email: str, user_agent: Optional[str], check, *, how: str = "password"
             ) -> Dict[str, Any]:
    """The sign-in that both credentials share, with `check` as the difference.

    `check(cur, user)` says whether the credential is right, and may write — the
    password path rehashes on the way through. Everything around it is the part
    that must not be reimplemented per credential: finding the account from any
    of its three identifiers, refusing a locked or deactivated one, counting a
    failure towards the lockout, and issuing the session.

    `email` is whatever was typed into the first box: an email address, a
    username or a phone number. The parameter keeps its name because every
    caller and the mobile contract send `email`, and renaming it would break
    them for no gain — see `_as_identifiers` for how the three are told apart.

    Every failure gives the same message: telling an attacker which half was
    wrong halves their work, and that holds for all three ways of signing in —
    an unknown username must read exactly like a wrong password, or the login
    form becomes a way to find out who has an account here.
    """
    GENERIC = "Those sign-in details are incorrect"
    looked_up = _as_identifiers(email)

    # The outcome is decided inside the transaction but raised outside it:
    # recording a failed attempt is a write that has to survive, and raising
    # here would roll it back — which would leave the lockout counter forever
    # at zero.
    failure: Optional[str] = None
    result: Optional[Dict[str, Any]] = None

    with transaction() as cur:
        # The three namespaces cannot overlap and each column is unique, so
        # only the country-code-less phone match can return more than one row.
        # Two rows means the text does not identify an account, which is a
        # failure — never a reason to pick one of them.
        cur.execute(
            """
            SELECT * FROM app_user
            WHERE  (%(email)s        IS NOT NULL AND email    = %(email)s)
               OR  (%(username)s     IS NOT NULL AND username = %(username)s)
               OR  (%(phone)s        IS NOT NULL AND phone    = %(phone)s)
               OR  (%(phone_suffix)s IS NOT NULL AND phone LIKE %(phone_suffix)s)
            LIMIT 2
            FOR UPDATE
            """,
            looked_up,
        )
        found = cur.fetchall()
        row = found[0] if len(found) == 1 else None
        now = datetime.utcnow()

        if len(found) > 1:
            logger.warning("A sign-in identifier matched %d accounts", len(found))

        if not row:
            failure = GENERIC
        else:
            user = dict(row)

            if user["locked_until"] and user["locked_until"] > now:
                minutes = max(1, int((user["locked_until"] - now).total_seconds() // 60) + 1)
                failure = f"Too many attempts — try again in {minutes} minutes"

            elif not user["is_active"]:
                failure = "This account has been deactivated"

            elif not check(cur, user):
                attempts = int(user["failed_logins"]) + 1
                locked = (now + timedelta(minutes=LOCKOUT_MINUTES)
                          if attempts >= MAX_FAILED_LOGINS else None)
                cur.execute(
                    "UPDATE app_user SET failed_logins = %s, locked_until = %s WHERE user_id = %s",
                    (attempts, locked, user["user_id"]),
                )
                if locked:
                    # The account, not what was typed at it: the lockout belongs
                    # to the account however it was named.
                    logger.warning("Locked %s after %d failed %s attempts",
                                   user["user_id"], attempts, how)
                failure = GENERIC

            else:
                token, token_hash = new_token()
                expires = now + timedelta(hours=settings.session_hours)
                cur.execute(
                    """
                    INSERT INTO user_session (token_hash, user_id, expires_on, user_agent)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (token_hash, user["user_id"], expires, (user_agent or "")[:200] or None),
                )
                cur.execute(
                    "UPDATE app_user SET failed_logins = 0, locked_until = NULL, "
                    "last_login_on = CURRENT_TIMESTAMP WHERE user_id = %s",
                    (user["user_id"],),
                )
                result = {
                    "token": token,
                    "expires_on": expires,
                    "user": _public(_read_user(cur, user_id=user["user_id"])),
                }

    if failure:
        raise AuthError(failure)

    logger.info("%s signed in by %s", result["user"]["user_id"], how)
    return result


def resolve_session(token: str) -> Optional[Dict[str, Any]]:
    """The user behind a token, or None. Expired sessions are cleared as found."""
    if not token:
        return None

    with transaction() as cur:
        cur.execute(
            """
            SELECT s.token_hash, s.expires_on, u.*, r.name AS role, r.label AS role_label,
                   COALESCE(
                       (SELECT array_agg(p.permission ORDER BY p.permission)
                        FROM role_permission p WHERE p.role_id = u.role_id),
                       ARRAY[]::varchar[]
                   ) AS permissions
            FROM   user_session s
            JOIN   app_user u ON u.user_id = s.user_id
            LEFT   JOIN app_role r ON r.role_id = u.role_id
            WHERE  s.token_hash = %s
            """,
            (hash_token(token),),
        )
        row = cur.fetchone()
        if not row:
            return None

        session = dict(row)
        if session["expires_on"] <= datetime.utcnow():
            cur.execute("DELETE FROM user_session WHERE token_hash = %s", (session["token_hash"],))
            return None
        if not session["is_active"]:
            return None

        cur.execute(
            "UPDATE user_session SET last_seen = CURRENT_TIMESTAMP WHERE token_hash = %s",
            (session["token_hash"],),
        )
        return _public(session)


def logout(token: str) -> bool:
    with transaction() as cur:
        cur.execute(
            "DELETE FROM user_session WHERE token_hash = %s RETURNING token_hash",
            (hash_token(token),),
        )
        return cur.fetchone() is not None


def purge_expired_sessions() -> int:
    with transaction() as cur:
        cur.execute("DELETE FROM user_session WHERE expires_on <= CURRENT_TIMESTAMP")
        return cur.rowcount


# --------------------------------------------------------------------------- #
# passwords
# --------------------------------------------------------------------------- #
def change_password(user_id: str, current_password: str, new_password: str) -> None:
    check_password_strength(new_password)

    with transaction() as cur:
        cur.execute("SELECT * FROM app_user WHERE user_id = %s FOR UPDATE", (user_id,))
        row = cur.fetchone()
        if not row:
            raise UserNotFound(f"No user {user_id}")
        if not verify_password(current_password, row["password_hash"]):
            raise AuthError("Your current password is incorrect")

        cur.execute(
            "UPDATE app_user SET password_hash = %s, updated_on = CURRENT_TIMESTAMP "
            "WHERE user_id = %s",
            (hash_password(new_password), user_id),
        )
        # Other devices should not keep a session opened with the old password.
        cur.execute("DELETE FROM user_session WHERE user_id = %s", (user_id,))

    logger.info("%s changed their password", user_id)


def begin_password_reset(email: str) -> Optional[Tuple[str, Dict[str, Any]]]:
    """Issue a reset token, or None if there is no such account.

    The caller must not disclose which it was — see the route.
    """
    email = str(email or "").strip().lower()

    with transaction() as cur:
        cur.execute("SELECT * FROM app_user WHERE email = %s AND is_active", (email,))
        row = cur.fetchone()
        if not row:
            return None

        user = dict(row)
        # One live link at a time; requesting again invalidates the previous.
        cur.execute(
            "DELETE FROM password_reset WHERE user_id = %s AND used_on IS NULL",
            (user["user_id"],),
        )
        token, token_hash = new_token()
        expires = datetime.utcnow() + timedelta(minutes=settings.reset_minutes)
        cur.execute(
            "INSERT INTO password_reset (token_hash, user_id, expires_on) VALUES (%s, %s, %s)",
            (token_hash, user["user_id"], expires),
        )

    logger.info("Issued a password reset for %s", email)
    return token, _public(user)


def complete_password_reset(token: str, new_password: str) -> Dict[str, Any]:
    check_password_strength(new_password)

    with transaction() as cur:
        cur.execute(
            """
            SELECT r.token_hash, r.expires_on, r.used_on, u.*
            FROM   password_reset r
            JOIN   app_user u ON u.user_id = r.user_id
            WHERE  r.token_hash = %s
            FOR UPDATE OF r
            """,
            (hash_token(token),),
        )
        row = cur.fetchone()
        if not row:
            raise AuthError("This reset link is not valid")

        reset = dict(row)
        if reset["used_on"]:
            raise AuthError("This reset link has already been used")
        if reset["expires_on"] <= datetime.utcnow():
            raise AuthError("This reset link has expired — request another")
        if not reset["is_active"]:
            raise AuthError("This account has been deactivated")

        cur.execute(
            "UPDATE app_user SET password_hash = %s, failed_logins = 0, locked_until = NULL, "
            "updated_on = CURRENT_TIMESTAMP WHERE user_id = %s",
            (hash_password(new_password), reset["user_id"]),
        )
        cur.execute(
            "UPDATE password_reset SET used_on = CURRENT_TIMESTAMP WHERE token_hash = %s",
            (reset["token_hash"],),
        )
        # A reset is also how you recover a compromised account.
        cur.execute("DELETE FROM user_session WHERE user_id = %s", (reset["user_id"],))

    logger.info("%s completed a password reset", reset["email"])
    return _public(reset)


def reset_link(token: str) -> str:
    return f"{settings.app_url.rstrip('/')}/reset-password?token={token}"


def deliver_reset(email: str, token: str) -> None:
    """Get the link to the person.

    With no mail server configured the link is logged instead, which is what
    makes this usable in development — and why `AUTH_EXPOSE_RESET_LINK` exists
    for local work only.
    """
    link = reset_link(token)
    if not settings.smtp_host:
        logger.warning("PASSWORD RESET for %s (no SMTP configured): %s", email, link)
        return

    import smtplib
    from email.message import EmailMessage

    message = EmailMessage()
    message["Subject"] = "Reset your e-Agrology password"
    message["From"] = settings.smtp_from or settings.smtp_user
    message["To"] = email
    message.set_content(
        "Someone asked to reset the password for this account.\n\n"
        f"{link}\n\n"
        f"The link works once and expires in {settings.reset_minutes} minutes. "
        "If this was not you, nothing has changed and you can ignore this email."
    )

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as smtp:
            if settings.smtp_tls:
                smtp.starttls()
            if settings.smtp_user:
                smtp.login(settings.smtp_user, settings.smtp_password)
            smtp.send_message(message)
        logger.info("Sent a reset link to %s", email)
    except Exception as exc:
        logger.error("Could not email the reset link to %s: %s", email, exc)
        logger.warning("PASSWORD RESET for %s: %s", email, link)
