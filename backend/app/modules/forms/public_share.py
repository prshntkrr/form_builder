"""A form, open to whoever holds the link.

One form, one link, no session. The token in the address is the whole of what
the caller presents, and it resolves to exactly one form on the server — so
nothing a public caller sends ever names a form, a table or a field.

What a link is *not*: it is not an account, and it grants nothing beyond
reading this form's live definition and adding a submission to it. Every other
route in this application still needs a session, including the ones that read
what was collected.

Answers arrive through the ordinary submission path — same validation, same
survey id sequence, same table — and are recorded with the channel
``public_web`` beside them, the way mobile, WhatsApp and IVR submissions
already are.
"""
import logging
import secrets
from datetime import datetime
from typing import Any, Dict, Optional

from app.core.database import transaction
from app.modules.forms import form_service
from app.modules.forms.media_service import MEDIA_TYPES

logger = logging.getLogger(__name__)

#: What a submission through a public link is recorded as.
PUBLIC_CHANNEL = "public_web"

#: What `created_by` says for an answer nobody signed in to give. A literal,
#: deliberately: attributing a stranger's submission to the person who issued
#: the link would put a real name on work they did not do.
PUBLIC_AUTHOR = "Public link"


class ShareError(Exception):
    """A form that cannot be shared, with the reason somebody can act on."""


def media_fields(form_json: Dict[str, Any]) -> list:
    """The questions on this form that take an upload.

    A public submitter cannot upload: presigning an object needs a session and
    the records permission. Rather than let a public form half-work — a
    required photo that can never be provided, or answers quietly arriving
    without it — a form that asks for one is refused a link, and says so.
    """
    return [
        field.get("name")
        for field in (form_json or {}).get("fields") or []
        if isinstance(field, dict) and field.get("type") in MEDIA_TYPES
    ]


def _state(row: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """What the builder screen shows about a form's link."""
    if row is None:
        return {"enabled": False, "token": None}

    return {
        "enabled": bool(row.get("public_enabled")),
        "token": row.get("public_token"),
        "expires_on": row.get("public_expires_on"),
        "allow_multiple": bool(row.get("public_allow_multiple", True)),
        "shared_by": row.get("public_shared_by"),
        "shared_on": row.get("public_shared_on"),
    }


def get_state(form_id: str) -> Dict[str, Any]:
    with transaction() as cur:
        cur.execute(
            """
            SELECT public_token, public_enabled, public_expires_on,
                   public_allow_multiple, public_shared_by, public_shared_on
            FROM forms WHERE form_id = %s
            """,
            (form_id,),
        )
        return _state(cur.fetchone())


def share(form_id: str, shared_by: Optional[str], *, regenerate: bool = False,
          expires_on: Optional[datetime] = None,
          allow_multiple: bool = True) -> Dict[str, Any]:
    """Issue the link for a form, or replace the one it has.

    Sharing again returns the same token rather than minting a new one: the
    first link may already have been sent to people, and silently breaking it
    would be a surprising thing for a second click to do. `regenerate` is how
    somebody asks for that deliberately, and it is the only thing that breaks
    an address already handed out.
    """
    form = form_service.get_form(form_id)          # raises FormNotFound

    if form.get("form_status") != "Active":
        raise ShareError(
            "Only an active form can be shared. Publish it first."
        )

    asks_for_files = media_fields(form.get("form_json") or {})

    if asks_for_files:
        raise ShareError(
            "This form asks for a file or a photo, which somebody filling it "
            "in without an account cannot upload. Remove "
            f"{', '.join(str(name) for name in asks_for_files)} to share it."
        )

    with transaction() as cur:
        cur.execute(
            "SELECT public_token FROM forms WHERE form_id = %s FOR UPDATE",
            (form_id,),
        )
        row = cur.fetchone()

        existing = (row or {}).get("public_token")
        # 32 bytes from the system source: not guessable, and not derived from
        # anything about the form.
        token = secrets.token_urlsafe(32) if (regenerate or not existing) else existing

        cur.execute(
            """
            UPDATE forms
            SET    public_token = %s,
                   public_enabled = TRUE,
                   public_expires_on = %s,
                   public_allow_multiple = %s,
                   public_shared_by = %s,
                   public_shared_on = CURRENT_TIMESTAMP
            WHERE  form_id = %s
            """,
            (token, expires_on, allow_multiple, shared_by, form_id),
        )

    return get_state(form_id)


def disable(form_id: str) -> Dict[str, Any]:
    """Switch the link off. Every copy of it stops working at once.

    The token is kept rather than cleared, so the screen can say this form was
    shared and is not any more — and so switching it back on does not hand out
    a different address than the one people were given.
    """
    with transaction() as cur:
        cur.execute(
            "UPDATE forms SET public_enabled = FALSE WHERE form_id = %s",
            (form_id,),
        )

    return get_state(form_id)


def resolve(token: str) -> Optional[Dict[str, Any]]:
    """The form behind a link, or nothing.

    Nothing covers every way a link can fail to name a live form — never
    issued, mistyped, switched off, expired, or belonging to a form that has
    since been paused or removed. They are deliberately indistinguishable: a
    reply that told them apart would be a way to learn which tokens exist.
    """
    if not token:
        return None

    with transaction() as cur:
        cur.execute(
            """
            SELECT form_id, public_expires_on, public_allow_multiple
            FROM forms
            WHERE public_token = %s
              AND public_enabled = TRUE
              AND form_status = 'Active'
            """,
            (token,),
        )
        row = cur.fetchone()

    if row is None:
        return None

    expires_on = row.get("public_expires_on")

    if expires_on is not None and expires_on < datetime.now():
        return None

    try:
        form = form_service.get_form(row["form_id"])
    except form_service.FormNotFound:
        return None

    form["public_allow_multiple"] = bool(row.get("public_allow_multiple", True))
    return form
