"""Live form rendering + submission endpoints."""
import logging

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from .. import form_service, submission_service
from ..schemas import SubmitRequest

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/forms", tags=["submissions"])


def _load(form_id: str):
    try:
        return form_service.get_form(form_id)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{form_id}/render")
def render(form_id: str):
    """Everything a client needs to draw the live form."""
    form = _load(form_id)
    if form["form_status"] != "Active":
        raise HTTPException(
            status_code=403,
            detail="This form is paused and is not accepting responses."
            if form["form_status"] == "Inactive"
            else "This form is no longer available.",
        )
    return {
        "form_id": form["form_id"],
        "form_status": form["form_status"],
        "version_no": form["version_no"],
        "form_json": form["form_json"],
    }


@router.post("/{form_id}/submissions", status_code=201)
def create_submission(form_id: str, req: SubmitRequest):
    form = _load(form_id)
    try:
        return submission_service.submit(form, req.data, created_by=req.created_by)
    except submission_service.ValidationFailed as exc:
        raise HTTPException(status_code=422, detail={"errors": exc.errors})
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        logger.exception("Submission failed for %s", form_id)
        raise HTTPException(status_code=500, detail=f"Could not save submission: {exc}")


@router.get("/{form_id}/submissions")
def list_submissions(
    form_id: str,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    form = _load(form_id)
    return submission_service.list_submissions(form, limit=limit, offset=offset)


@router.get("/{form_id}/submissions/export")
def export(form_id: str):
    form = _load(form_id)
    csv_text = submission_service.export_csv(form)
    table = (form["form_json"] or {}).get("table_name") or form_id
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{table}.csv"'},
    )
