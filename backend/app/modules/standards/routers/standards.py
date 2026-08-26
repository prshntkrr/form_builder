"""Standardised variables, and attaching them to fields."""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.deps import needs
from app.modules.standards import enrichment, icasa_importer, variable_service
from app.modules.standards.permissions import STANDARDS_MANAGE, STANDARDS_VIEW

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/standards", tags=["standards"])


class EnrichRequest(BaseModel):
    form_json: Dict[str, Any]


@router.get("")
def loaded(user: Dict[str, Any] = Depends(needs(STANDARDS_VIEW))):
    """Which standards have been imported."""
    return icasa_importer.loaded()


@router.get("/variables/search")
def search(
    q: str = Query("", description="Part of a variable name, code or definition"),
    standard: Optional[str] = Query(None),
    limit: int = Query(25, ge=1, le=100),
    user: Dict[str, Any] = Depends(needs(STANDARDS_VIEW)),
):
    return variable_service.search(q, standard=standard, limit=limit)


@router.get("/variables/{variable_id}")
def detail(variable_id: int, user: Dict[str, Any] = Depends(needs(STANDARDS_VIEW))):
    try:
        return variable_service.get(variable_id)
    except variable_service.VariableNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/variables/{variable_id}/options")
def options(variable_id: int, user: Dict[str, Any] = Depends(needs(STANDARDS_VIEW))):
    """The variable's coded values, shaped as form options.

    Empty for most variables — only 90 of ICASA's 1384 are code-valued.
    """
    try:
        return variable_service.as_field_options(variable_id)
    except variable_service.VariableNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/enrich")
def enrich(req: EnrichRequest, user: Dict[str, Any] = Depends(needs(STANDARDS_VIEW))):
    """Attach standards to a draft where the match is confident. Nothing is saved."""
    return enrichment.enrich_form(req.form_json)


@router.post("/match-field")
def match_field(field: Dict[str, Any], user: Dict[str, Any] = Depends(needs(STANDARDS_VIEW))):
    """What the standards can say about one field, including the near misses."""
    return enrichment.enrich_field(field)


@router.delete("/{name}")
def remove(name: str, user: Dict[str, Any] = Depends(needs(STANDARDS_MANAGE))):
    return icasa_importer.remove(name)


@router.get("/mapping/{form_id}")
def mapping(form_id: str, user: Dict[str, Any] = Depends(needs(STANDARDS_VIEW))):
    """The standard identifiers behind one form's columns.

    What a downstream job needs to turn a form's own column names into something
    portable: for every field, the key it is stored under and whatever standards
    it carries. Fields with no standard are listed too, with nulls, because a
    consumer needs to know they exist and were not simply missed.

    Reads the version the form is live on, so a mapping stays true to the
    definition the data was collected under.
    """
    from app.modules.forms import form_service

    try:
        form = form_service.get_form(form_id)
    except Exception:
        raise HTTPException(status_code=404, detail=f"No form {form_id}")

    definition = form["form_json"] or {}
    columns = []
    for field in definition.get("fields") or []:
        if not isinstance(field, dict):
            continue
        columns.append({
            "stored_as": field.get("name"),
            "label": field.get("label"),
            "type": field.get("type"),
            "semantic_concept": field.get("semantic_concept"),
            "data_standard": field.get("data_standard"),
        })

    return {
        "form_id": form["form_id"],
        "form_title": form["form_title"],
        "version_no": form.get("version_no"),
        "table_name": definition.get("table_name"),
        "columns": columns,
    }
