"""The CIMMYT Controlled Vocabulary: loading it, and reading what it holds.

    POST /api/standards/cimmyt/import     the workbook, as an upload
    GET  /api/standards/cimmyt/variables  what is loaded

It rides on the standards module's own permissions rather than inventing a
pair: importing a vocabulary is `standards.manage` whichever vocabulary it is,
and reading one is `standards.view`. The variables land in `standard_variable`
like every other standard's, so nothing downstream — the browser, the search,
the field mapping — needed a second code path.
"""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel

from app.core.deps import needs
from app.modules.standards.cimmyt import cv_importer
from app.modules.standards.icasa import variable_service
from app.modules.standards.icasa.permissions import STANDARDS_MANAGE, STANDARDS_VIEW

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/standards/cimmyt", tags=["standards"])


@router.get("/variables")
def variables(
    q: str = Query("", description="Part of a variable name, code or definition"),
    limit: int = Query(200, ge=1, le=500),
    user: Dict[str, Any] = Depends(needs(STANDARDS_VIEW)),
):
    """Every CIMMYT variable, or the ones matching `q`.

    The whole list by default: this vocabulary is an institutional core set,
    tens of variables rather than ICASA's 1,384, and a page that shows it all is
    more use than one that makes somebody guess a search term first.
    """
    if q.strip():
        return {"variables": variable_service.search(
            q, standard=cv_importer.STANDARD_NAME, limit=limit)}

    return {"variables": variable_service.all_of(
        cv_importer.STANDARD_NAME, limit=limit)}


class VariableIn(BaseModel):
    """One variable, typed in rather than imported.

    Deliberately narrow: the fields somebody filling this in can actually
    answer. The rest of the workbook's columns are governance — predicates,
    formula references, stewardship — and a blank is more honest than a guess.
    """
    name: str
    definition: str = ""
    data_type: str = ""
    unit: str = ""
    catalog_id: str = ""
    observation_entity: str = ""
    measurement_role: str = ""
    concept_id: str = ""
    method: str = ""
    status: str = ""
    version: str = ""
    #: Passed back to edit an existing variable; absent means a new one.
    external_id: str = ""


@router.post("/variables")
def save_variable(
    variable: VariableIn,
    user: Dict[str, Any] = Depends(needs(STANDARDS_MANAGE)),
):
    """Add or edit one variable by hand.

    The manual half of the same vocabulary. It writes the row the importer
    writes, so a question mapped to a variable added here behaves exactly like
    one mapped to a variable CIMMYT published.
    """
    try:
        return cv_importer.save_variable(variable.model_dump())
    except cv_importer.CvWorkbookProblem as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.delete("/variables/{external_id}")
def delete_variable(
    external_id: str,
    user: Dict[str, Any] = Depends(needs(STANDARDS_MANAGE)),
):
    """Remove a variable added here. A workbook variable is refused — 409."""
    try:
        cv_importer.delete_variable(external_id)
    except cv_importer.CvWorkbookProblem as exc:
        raise HTTPException(status_code=409, detail=str(exc))

    return {"deleted": external_id}


@router.post("/import")
async def import_workbook(
    file: UploadFile = File(...),
    version: Optional[str] = Query(None),
    user: Dict[str, Any] = Depends(needs(STANDARDS_MANAGE)),
):
    """Load a CIMMYT Controlled Vocabulary workbook.

    Idempotent, and keyed on the ids the workbook publishes — re-importing a
    revised vocabulary updates the variables a saved form already points at
    rather than making a second set beside them.

    The reply says what was read and what could not be resolved, because a unit
    or catalogue a variable refers to but the workbook never defines is a gap in
    the workbook, and saying so is more use than inventing a value for it.
    """
    data = await file.read()

    try:
        return cv_importer.import_workbook(data, version=version or "")
    except cv_importer.CvWorkbookProblem as exc:
        raise HTTPException(status_code=422, detail=str(exc))
