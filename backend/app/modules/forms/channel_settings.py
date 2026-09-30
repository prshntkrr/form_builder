"""How a channel is operated, per project: the timeout and the credential.

Not what a form asks — that is the form definition, which is versioned,
published and handed to phones. This is the operating configuration around it:

    session_timeout_seconds   how long a silence ends a conversation
    api_token                 what the gateway is reached with

The token is the reason this is a table and not a setting in `.env`. One
installation serves several projects, each with its own Picky Assist account,
and a credential that lives in the environment cannot be rotated by the person
who owns it. It is sealed with `app/core/secrets.py` — the same mechanism the
saved external-database passwords use — so the column holds a blob and never a
token, and reading it back needs `SECRET_KEY`.

**The plaintext never leaves this module except towards Picky Assist.** What an
API returns is `shown()`: whether a token is set, and its last four characters,
which is enough for somebody to recognise the one they pasted and no use to
anybody else. Nothing here is logged.

Scope follows `channel_form_route`: a project's own row, or the system row
(`project_id IS NULL`) for the forms that belong to no project. A project with
no row of its own falls back to the system row, and then to the defaults below —
so an installation can configure one token centrally and a project can override
it without anything having to be copied.
"""
import logging
from typing import Any, Dict, Optional

from app.core import secrets
from app.core.database import transaction

logger = logging.getLogger(__name__)

#: Ten minutes, which is what the first WhatsApp webhook hard-coded. Kept as the
#: default so nothing changes for an installation that never opens the screen.
DEFAULT_TIMEOUT_SECONDS = 600

#: A conversation is not a form-filling session that can be left overnight: the
#: person is in a chat window. An hour is generous; a day is somebody having
#: typed the wrong thing.
MIN_TIMEOUT_SECONDS = 60
MAX_TIMEOUT_SECONDS = 24 * 60 * 60


class SettingsError(ValueError):
    """The settings cannot be stored as asked. The message is safe to show."""


def _aad(channel: str, project_id: Optional[str]) -> str:
    """What a sealed token is bound to.

    Its own row's identity, so a blob lifted from one project's settings and
    pasted into another's does not open. See `secrets.seal`.
    """
    return f"channel_settings:{channel}:{project_id or ''}"


def _row(cur, channel: str, project_id: Optional[str]) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT * FROM channel_settings "
        "WHERE channel = %s AND project_id IS NOT DISTINCT FROM %s",
        (channel, project_id),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def _defaults(channel: str, project_id: Optional[str]) -> Dict[str, Any]:
    return {
        "channel": channel,
        "project_id": project_id,
        "session_timeout_seconds": DEFAULT_TIMEOUT_SECONDS,
        "api_token": "",
        "token_hint": "",
        "token_set_on": None,
        "token_set_by": "",
        "updated_by": "",
    }


def effective(channel: str, project_id: Optional[str] = None) -> Dict[str, Any]:
    """The settings that apply here, with the system row and defaults behind.

    A project row wins over the system row field by field rather than wholesale:
    a project that set only a timeout still uses the installation's token, which
    is the ordinary case — one Picky Assist account, several projects.
    """
    with transaction() as cur:
        system = _row(cur, channel, None)
        mine = _row(cur, channel, project_id) if project_id else None

    settings = _defaults(channel, project_id)
    for source in (system, mine):
        if not source:
            continue
        if source.get("session_timeout_seconds"):
            settings["session_timeout_seconds"] = int(source["session_timeout_seconds"])
        if source.get("api_token"):
            # The scope the token was sealed under travels with it — it is what
            # `unseal` has to be given to open it.
            settings.update(api_token=source["api_token"],
                            token_hint=source.get("token_hint") or "",
                            token_set_on=source.get("token_set_on"),
                            token_set_by=source.get("token_set_by") or "",
                            token_scope=source.get("project_id"))
    return settings


def timeout_seconds(project_id: Optional[str] = None, channel: str = "whatsapp") -> int:
    """How long a silence ends a conversation here."""
    return int(effective(channel, project_id)["session_timeout_seconds"])


def token(project_id: Optional[str] = None, channel: str = "whatsapp") -> str:
    """The plaintext credential, for the one call that needs it. Never logged.

    Empty when this installation has none configured, and empty — rather than an
    exception — when the sealed value cannot be opened, because a conversation
    failing to send a message is not the place to raise a key-management
    problem. The failure is logged without the value.
    """
    settings = effective(channel, project_id)
    sealed = settings.get("api_token")
    if not sealed:
        return ""

    try:
        return secrets.unseal(sealed, _aad(channel, settings.get("token_scope")))
    except (secrets.SecretUnavailable, secrets.SecretTampered) as exc:
        logger.error("The %s token for %s could not be read: %s",
                     channel, settings.get("token_scope") or "the system", exc)
        return ""


def shown(channel: str, project_id: Optional[str] = None) -> Dict[str, Any]:
    """What an API may return: everything except the token.

    `token_set` and the last four characters. Deliberately not the token, not
    the sealed blob, and not a fixed-width row of asterisks that would say how
    long it is.
    """
    with transaction() as cur:
        row = _row(cur, channel, project_id)

    resolved = effective(channel, project_id)
    return {
        "channel": channel,
        "project_id": project_id,
        "session_timeout_seconds": resolved["session_timeout_seconds"],
        # Whether *this scope* has its own row, so the screen can say whether it
        # is showing an override or what it inherited.
        "configured": row is not None,
        "token_set": bool(resolved.get("api_token")),
        "token_hint": resolved.get("token_hint") or "",
        "token_set_on": resolved.get("token_set_on"),
        "token_set_by": resolved.get("token_set_by") or "",
        "token_inherited": bool(resolved.get("api_token"))
                           and resolved.get("token_scope") != project_id,
        "secrets_available": secrets.available(),
    }


def _check_timeout(raw: Any) -> int:
    try:
        seconds = int(raw)
    except (TypeError, ValueError):
        raise SettingsError("The timeout is a number of seconds.")
    if not MIN_TIMEOUT_SECONDS <= seconds <= MAX_TIMEOUT_SECONDS:
        raise SettingsError(
            f"A timeout is between {MIN_TIMEOUT_SECONDS // 60} minute and "
            f"{MAX_TIMEOUT_SECONDS // 3600} hours.")
    return seconds


def save(channel: str, project_id: Optional[str] = None, *,
         session_timeout_seconds: Optional[int] = None,
         api_token: Optional[str] = None,
         updated_by: str = "") -> Dict[str, Any]:
    """Store what was changed, and only what was changed.

    `api_token` of None leaves the stored credential alone — which is what a
    screen that never showed it has to send back. An empty string clears it.
    Anything else replaces it.

    Rotation is this same call with a new token, and it is atomic: the row is
    updated in one statement, so the old credential is in use right up to the
    commit and the new one from it. There is never a moment with neither.
    """
    assignments = ["updated_by = %s", "updated_on = CURRENT_TIMESTAMP"]
    values: list = [updated_by]

    if session_timeout_seconds is not None:
        assignments.append("session_timeout_seconds = %s")
        values.append(_check_timeout(session_timeout_seconds))

    if api_token is not None:
        text = str(api_token).strip()
        if text and not secrets.available():
            raise SettingsError(
                "This installation has no SECRET_KEY, so a token cannot be "
                "stored. Set SECRET_KEY (at least 32 characters) and restart "
                "the server.")
        assignments += ["api_token = %s", "token_hint = %s", "token_set_by = %s",
                        "token_set_on = " + ("CURRENT_TIMESTAMP" if text else "NULL")]
        values += [secrets.seal(text, _aad(channel, project_id)) if text else "",
                   text[-4:] if text else "",
                   updated_by if text else ""]

    with transaction() as cur:
        # The row may not exist yet. Inserting the defaults first and then
        # applying the changes keeps one UPDATE to maintain instead of an
        # ON CONFLICT with every column spelled out twice.
        cur.execute(
            "INSERT INTO channel_settings (channel, project_id, updated_by) "
            "VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
            (channel, project_id, updated_by),
        )
        cur.execute(
            f"UPDATE channel_settings SET {', '.join(assignments)} "
            "WHERE channel = %s AND project_id IS NOT DISTINCT FROM %s",
            [*values, channel, project_id],
        )

    # Says that a token changed, never what it changed to.
    logger.info("%s settings saved for %s (token %s)", channel,
                project_id or "the system",
                secrets.redact(api_token) if api_token is not None else "unchanged")
    return shown(channel, project_id)
