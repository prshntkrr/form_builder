"""Live form rendering + submission endpoints."""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from app.core import auth_service
from app.modules.forms import form_service
from app.modules.forms import submission_service
from app.modules.forms import translations
from app.modules.forms import view_service
from app.core.deps import needs, viewer
from app.modules.forms.permissions import (
    FORMS_EDIT, RECORDS_CREATE, RECORDS_VIEW, RESPONSES_EXPORT, RESPONSES_VIEW,
    VIEW_CONFIGURE,
)
from app.core.database import transaction
from app.modules.forms.schemas import SubmitRequest, TestSubmissionRequest, ViewConfigRequest

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/forms", tags=["submissions"])


def _load(form_id: str):
    try:
        return form_service.get_form(form_id)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/live/list")
def live_forms(user: Dict[str, Any] = Depends(needs(RECORDS_VIEW))):
    """The forms anyone signed in may fill in right now.

    Separate from `GET /api/forms` because that one is the builder's view — it
    carries table names, versions and response counts, none of which a field
    officer needs or should see. This returns Active forms and nothing else.
    """
    return [
        {
            "form_id": f["form_id"],
            "form_title": f["form_title"],
            "form_description": f["form_description"],
            "field_count": f["field_count"],
        }
        for f in form_service.list_forms(status="Active", limit=500)
    ]


@router.get("/{form_id}/render")
def render(
    form_id: str,
    language: Optional[str] = Query(None, description="Language code, e.g. 'hi'"),
    user: Dict[str, Any] = Depends(needs(RECORDS_CREATE)),
):
    """Everything a client needs to draw the live form.

    `language` returns the definition with its words already swapped, so the
    page that draws the form needs no translation logic of its own. Field names
    are untouched, so the answers still land in the same columns.
    """
    form = _load(form_id)
    if form["form_status"] != "Active":
        raise HTTPException(
            status_code=403,
            detail="This form is paused and is not accepting responses."
            if form["form_status"] == "Inactive"
            else "This form is no longer available.",
        )
    form_json = form["form_json"] or {}
    languages = translations.form_languages(form_json)
    chosen = language if language in languages else translations.default_language(form_json)

    return {
        "form_id": form["form_id"],
        "form_status": form["form_status"],
        "version_no": form["version_no"],
        "form_json": translations.translate_form(form_json, chosen),
        "language": chosen,
        "languages": [
            {"code": code, "name": translations.SUPPORTED_LANGUAGES[code]}
            for code in languages
        ],
    }


@router.post("/{form_id}/submissions", status_code=201)
def create_submission(form_id: str, req: SubmitRequest, user: Dict[str, Any] = Depends(needs(RECORDS_CREATE))):
    form = _load(form_id)
    try:
        return submission_service.submit(
            form, req.data,
            created_by=auth_service.display_name(user),
            language=req.language,
        )
    except submission_service.ValidationFailed as exc:
        raise HTTPException(status_code=422, detail={"errors": exc.errors})
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        logger.exception("Submission failed for %s", form_id)
        raise HTTPException(status_code=500, detail=f"Could not save submission: {exc}")


@router.post("/{form_id}/test-submission")
def test_submission(
    form_id: str,
    req: TestSubmissionRequest,
    user: Dict[str, Any] = Depends(needs(FORMS_EDIT)),
):
    """Run a submission through validation and write nothing.

    How a draft is tested before anyone publishes it: the answers go through the
    same coercion a real submission would, and the reply is the exact `form_data`
    that would be stored. Because nothing is written, a test leaves no row to
    explain later and works on a form that is not accepting answers yet.

    Pass `form_json` to test what is on screen rather than what is saved, so the
    builder can try a change before committing to it.
    """
    form = _load(form_id)
    definition = req.form_json or form["form_json"] or {}
    result = submission_service.test_payload(definition, req.data, req.language)
    return {**result, "form_id": form_id, "form_status": form["form_status"]}


@router.get("/{form_id}/records")
def records(
    form_id: str,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: Dict[str, Any] = Depends(needs(RECORDS_VIEW)),
):
    """The records of this form, as whoever is asking is allowed to see them.

    An editor gets every column. Anyone else gets the ones an admin chose, and
    the hidden answers are stripped here rather than in the browser.
    """
    form = _load(form_id)
    form_json = form["form_json"] or {}
    data = submission_service.list_submissions(form, limit=limit, offset=offset)

    if auth_service.may(user, RESPONSES_VIEW):
        allowed = [c["name"] for c in data["columns"]]
    else:
        with transaction() as cur:
            allowed = view_service.visible_fields(cur, form_id, form_json)

    keep = set(allowed)
    return {
        "form_id": form_id,
        "form_title": form["form_title"],
        "form_status": form["form_status"],
        "total": data["total"],
        "limit": data["limit"],
        "offset": data["offset"],
        "columns": [c for c in data["columns"] if c["name"] in keep],
        "rows": [
            {
                "survey_id": row["survey_id"],
                "created_on": row["created_on"],
                "created_by": row["created_by"],
                "form_data": {k: v for k, v in (row["form_data"] or {}).items() if k in keep},
            }
            for row in data["rows"]
        ],
    }


@router.get("/{form_id}/view-config")
def get_view_config(form_id: str, user: Dict[str, Any] = Depends(needs(RESPONSES_VIEW))):
    """Every question, and whether it shows to people who cannot edit."""
    form = _load(form_id)
    return view_service.describe(form_id, form["form_json"] or {})


@router.put("/{form_id}/view-config")
def set_view_config(
    form_id: str, req: ViewConfigRequest, user: Dict[str, Any] = Depends(needs(VIEW_CONFIGURE))
):
    """Choose which columns everyone else sees. Admin only."""
    form = _load(form_id)
    form_json = form["form_json"] or {}

    if req.show_all:
        view_service.reset_config(form_id)
    else:
        view_service.set_visible_fields(
            form_id, req.visible_fields, form_json,
            updated_by=auth_service.display_name(user),
        )
    return view_service.describe(form_id, form_json)


@router.get("/{form_id}/submissions")
def list_submissions(
    form_id: str,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: Dict[str, Any] = Depends(needs(RESPONSES_VIEW)),
):
    form = _load(form_id)
    return submission_service.list_submissions(form, limit=limit, offset=offset)


@router.get("/{form_id}/submissions/export")
def export(form_id: str, user: Dict[str, Any] = Depends(needs(RESPONSES_EXPORT))):
    form = _load(form_id)
    csv_text = submission_service.export_csv(form)
    table = (form["form_json"] or {}).get("table_name") or form_id
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{table}.csv"'},
    )
