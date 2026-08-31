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
    }


def display_name(user: Optional[Dict[str, Any]]) -> str:
    """What goes in a `created_by` column — 50 characters of something readable."""
    if not user:
        return settings.default_user
    return str(user.get("full_name") or user.get("email") or settings.default_user)[:50]


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
    email: str,
    password: str,
    *,
    full_name: Optional[str] = None,
    role: str = ROLE_FIELD,
    created_by: Optional[str] = None,
) -> Dict[str, Any]:
    email = _clean_email(email)
    check_password_strength(password)

    with transaction() as cur:
        role_id = _resolve_role(cur, role)

        cur.execute("SELECT 1 FROM app_user WHERE email = %s", (email,))
        if cur.fetchone():
            raise UserExists("An account already exists for %s" % email)

        user_id = _next_user_id(cur)
        cur.execute(
            """
            INSERT INTO app_user (user_id, email, full_name, role_id, password_hash, created_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (user_id, email, (full_name or "").strip()[:120] or None,
             role_id, hash_password(password), created_by),
        )
        created = _read_user(cur, user_id=user_id)

    logger.info("Created %s account for %s", created["role"], email)
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
# sessions
# --------------------------------------------------------------------------- #
def login(email: str, password: str, user_agent: Optional[str] = None) -> Dict[str, Any]:
    """Exchange credentials for a session token.

    Every failure gives the same message: telling an attacker which half was
    wrong halves their work.
    """
    GENERIC = "Email or password is incorrect"
    email = str(email or "").strip().lower()

    # The outcome is decided inside the transaction but raised outside it:
    # recording a failed attempt is a write that has to survive, and raising
    # here would roll it back — which would leave the lockout counter forever
    # at zero.
    failure: Optional[str] = None
    result: Optional[Dict[str, Any]] = None

    with transaction() as cur:
        cur.execute("SELECT * FROM app_user WHERE email = %s FOR UPDATE", (email,))
        row = cur.fetchone()
        now = datetime.utcnow()

        if not row:
            failure = GENERIC
        else:
            user = dict(row)

            if user["locked_until"] and user["locked_until"] > now:
                minutes = max(1, int((user["locked_until"] - now).total_seconds() // 60) + 1)
                failure = f"Too many attempts — try again in {minutes} minutes"

            elif not user["is_active"]:
                failure = "This account has been deactivated"

            elif not verify_password(password, user["password_hash"]):
                attempts = int(user["failed_logins"]) + 1
                locked = (now + timedelta(minutes=LOCKOUT_MINUTES)
                          if attempts >= MAX_FAILED_LOGINS else None)
                cur.execute(
                    "UPDATE app_user SET failed_logins = %s, locked_until = %s WHERE user_id = %s",
                    (attempts, locked, user["user_id"]),
                )
                if locked:
                    logger.warning("Locked %s after %d failed attempts", email, attempts)
                failure = GENERIC

            else:
                # A correct password predating a cost increase is upgraded in place.
                if needs_rehash(user["password_hash"]):
                    cur.execute(
                        "UPDATE app_user SET password_hash = %s WHERE user_id = %s",
                        (hash_password(password), user["user_id"]),
                    )

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

    logger.info("%s signed in", email)
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
