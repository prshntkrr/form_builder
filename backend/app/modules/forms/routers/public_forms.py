"""A form, answered by whoever holds the link.

These are the only routes in this module that take no session. They are written
to give away as little as possible: an unguessable token names exactly one
form, and nothing a caller sends names anything at all — not a form, not a
table, not a field, not somebody else's submission.

What a link does *not* open: reading what was collected, listing forms,
uploading a file, or attaching to another submission. Those all still need an
account, and the routes that do them are unchanged.

Answers go through the same `_store` every other channel uses — the same
version check, the same validation, the same survey id sequence, the same row —
and are recorded with the channel `public_web` beside them.
"""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.modules.forms import public_share, translations

# The one way a submission is stored, whatever it arrived on. Imported rather
# than reimplemented: a channel with its own copy of the version check, the
# validation and the survey id sequence would be a second product.
from app.modules.forms.routers.submissions import _store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/public/forms", tags=["public forms"])


class PublicSubmitRequest(BaseModel):
    """What somebody filling in a public form may send: answers, and nothing else.

    No survey id, no parent submission, no form version, no channel. Each of
    those is a claim the signed-in endpoint is allowed to make because the
    account behind it was already authorised; nobody here has been authorised
    for anything, so the server decides all of them.
    """

    data: Dict[str, Any]
    language: Optional[str] = None


#: What a definition is allowed to say to somebody with no account.
#:
#: A whitelist rather than a list of things to strip, because a definition
#: grows: the stored `form_json` also carries the form's id, the name of the
#: database table behind it and who built it, none of which somebody filling
#: the form in needs — and all of which a public link would otherwise hand to
#: anyone who opened it.
PUBLIC_FORM_KEYS = (
    "title",
    "description",
    "fields",
    "sections",
    "submit_label",
    "success_message",
    "languages",
    "default_language",
    "translations",
)


def _public_view(form_json: Dict[str, Any]) -> Dict[str, Any]:
    """The questions, and nothing about where the answers are kept."""
    return {
        key: value
        for key, value in (form_json or {}).items()
        if key in PUBLIC_FORM_KEYS
    }


def _resolved(token: str) -> Dict[str, Any]:
    """The form behind a link, or a 404 that says nothing about which.

    Never issued, mistyped, switched off, expired, paused or deleted all answer
    the same way on purpose: a reply that told them apart would be a way to
    learn which tokens exist.
    """
    form = public_share.resolve(token)

    if form is None:
        raise HTTPException(status_code=404, detail="This link is not valid.")

    return form


@router.get("/{token}")
def public_form(token: str, language: Optional[str] = Query(None)):
    """Everything the page needs to draw this form. No session.

    Deliberately not the form's id, its table, its project, who built it or how
    many answers it already has — none of which somebody filling it in needs.
    """
    form = _resolved(token)

    form_json = form.get("form_json") or {}
    languages = translations.form_languages(form_json)
    chosen = (
        language if language in languages
        else translations.default_language(form_json)
    )

    return {
        "form_json": _public_view(translations.translate_form(form_json, chosen)),
        "language": chosen,
        "languages": [
            {"code": code, "name": translations.SUPPORTED_LANGUAGES[code]}
            for code in languages
        ],
        "version_no": form.get("version_no"),
        "allow_multiple": form.get("public_allow_multiple", True),
    }


@router.post("/{token}/submissions", status_code=201)
def public_submit(token: str, req: PublicSubmitRequest):
    """Answers from somebody with no account. No session.

    `created_by` is a literal rather than a person: attributing a stranger's
    submission to whoever issued the link would put a real name on work they
    did not do. The submission path itself is untouched — it reads only the
    display name and whether a parent was supplied, and a child form with no
    parent is refused here exactly as it is everywhere else.
    """
    form = _resolved(token)

    stored = _store(
        form,
        {"full_name": public_share.PUBLIC_AUTHOR},
        data=req.data,
        language=req.language,
        location=None,
        parent_survey_id=None,
        survey_id=None,
        form_version=None,
        channel=public_share.PUBLIC_CHANNEL,
    )

    # The reference, and nothing else: a public caller has no business reading
    # back a stored row.
    return {"survey_id": stored.get("survey_id")}
