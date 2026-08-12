"""Form authoring + management endpoints."""
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from .. import form_service, llm
from ..form_schema import FormSchemaError, normalize_form
from ..migration_service import MigrationError
from ..schemas import (
    CreateFormRequest,
    GenerateRequest,
    RefineRequest,
    RevalidateRequest,
    StatusRequest,
    UpdateFormRequest,
    ValidateRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/forms", tags=["forms"])


# --------------------------------------------------------------------------- #
# authoring (LLM) — nothing here touches the database
# --------------------------------------------------------------------------- #
@router.post("/generate")
def generate(req: GenerateRequest):
    """Prompt -> a complete, normalized form definition (not yet saved)."""
    try:
        raw = llm.generate_form(req.prompt, req.language)
        return {"form_json": normalize_form(raw), "prompt": req.prompt}
    except llm.LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except FormSchemaError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/refine")
def refine(req: RefineRequest):
    """Existing definition + instruction -> revised definition (not yet saved)."""
    try:
        raw = llm.refine_form(req.form_json, req.instruction)
        return {"form_json": normalize_form(raw), "prompt": req.instruction}
    except llm.LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except FormSchemaError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/validate")
def validate(req: ValidateRequest):
    """Normalize a hand-edited definition without calling the model."""
    try:
        return {"form_json": normalize_form(req.form_json)}
    except FormSchemaError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


# --------------------------------------------------------------------------- #
# persistence
# --------------------------------------------------------------------------- #
@router.post("", status_code=201)
def create(req: CreateFormRequest):
    """Save the form, open version 1, and create its Postgres table."""
    try:
        return form_service.create_form(
            req.form_json,
            created_by=req.created_by,
            form_type=req.form_type,
            parent_id=req.parent_id,
            status=req.form_status,
        )
    except FormSchemaError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.exception("Form creation failed")
        raise HTTPException(status_code=500, detail=f"Could not save form: {exc}")


@router.get("")
def index(
    status: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    return form_service.list_forms(status=status, search=search, limit=limit, offset=offset)


@router.get("/{form_id}")
def detail(form_id: str):
    try:
        return form_service.get_form(form_id)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.put("/{form_id}")
def update(form_id: str, req: UpdateFormRequest):
    """Save a revision, moving stored answers for any renamed field."""
    try:
        return form_service.update_form(
            form_id,
            req.form_json,
            updated_by=req.updated_by,
            status=req.form_status,
            renames=req.renames,
        )
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except (FormSchemaError, MigrationError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.exception("Form update failed")
        raise HTTPException(status_code=500, detail=f"Could not update form: {exc}")


@router.post("/{form_id}/revalidate")
def revalidate(form_id: str, req: RevalidateRequest):
    """Check stored responses against the current definition after a hand edit.

    `fix: false` reports only; `fix: true` also re-coerces the values it can.
    """
    try:
        return form_service.check_submissions(form_id, fix=req.fix)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.exception("Revalidation failed")
        raise HTTPException(status_code=500, detail=f"Could not check responses: {exc}")


@router.patch("/{form_id}/status")
def change_status(form_id: str, req: StatusRequest):
    try:
        return form_service.set_status(form_id, req.form_status)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except form_service.FormServiceError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/{form_id}")
def soft_delete(form_id: str):
    """Marks the form Deleted. The data table and its rows are left untouched."""
    try:
        return form_service.set_status(form_id, "Deleted")
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/{form_id}/rebuild-tabular")
def rebuild_tabular(form_id: str):
    """Rebuild the flat `<form>_tabular` mirror from the JSONB table.

    Happens automatically whenever columns change; call this for a form whose
    responses were collected before the mirror existed.
    """
    try:
        return form_service.rebuild_tabular(form_id)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.exception("Tabular rebuild failed")
        raise HTTPException(status_code=500, detail=f"Could not rebuild: {exc}")


@router.get("/{form_id}/versions")
def versions(form_id: str, include_json: bool = False):
    try:
        form_service.get_form(form_id)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return form_service.get_versions(form_id, include_json=include_json)


@router.get("/{form_id}/diff")
def diff(
    form_id: str,
    from_version: Optional[int] = Query(None, alias="from"),
    to_version: Optional[int] = Query(None, alias="to"),
):
    """What changed between two saved versions.

    Defaults to the newest version against the one before it. Fields renamed
    along the way are followed, so a rename reads as a change rather than as one
    field removed and another added.
    """
    try:
        return form_service.diff_versions(form_id, from_version, to_version)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
