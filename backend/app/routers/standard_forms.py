"""The Standard Form Library: look one up, add one, or start from it.

Reuse produces a *draft* definition which the client then saves through
`POST /api/forms` like any other — so a form created from a standard goes
through exactly the same validation and table creation as one built by hand,
and is just as editable afterwards.
"""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import auth_service, form_service, standard_library
from ..auth import needs
from ..permissions import LIBRARY_MANAGE, LIBRARY_VIEW
from ..config_validation import ConfigValidationError, validate_config
from ..schemas import AddToLibraryRequest, BorrowRequest, StartFromStandardRequest

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/standard-forms", tags=["standard forms"])


@router.get("")
def index(
    search: Optional[str] = None,
    category: Optional[str] = Query(None, description="Exact category match"),
    user: Dict[str, Any] = Depends(needs(LIBRARY_VIEW)),
):
    """Look up standard forms by title, summary, category or tag."""
    return {
        "categories": standard_library.categories(),
        "forms": [entry.summary_entry() for entry in standard_library.search(search, category)],
    }


@router.get("/{standard_id}")
def detail(standard_id: str, user: Dict[str, Any] = Depends(needs(LIBRARY_VIEW))):
    """One standard form, with its full definition."""
    entry = standard_library.get(standard_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"No standard form '{standard_id}'")
    return entry.full_entry()


@router.post("", status_code=201)
def add(req: AddToLibraryRequest, user: Dict[str, Any] = Depends(needs(LIBRARY_MANAGE))):
    """Offer a saved form as a standard others can start from.

    The definition is copied into the library, so the standard is independent of
    the form: edit that form, or delete it, and the standard is unaffected.
    """
    try:
        return form_service.add_to_library(
            req.form_id,
            req.version_no,
            standard_id=req.standard_id,
            category=req.category,
            tags=req.tags,
            summary=req.summary,
            added_by=req.added_by or auth_service.display_name(user),
        )
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except standard_library.LibraryError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except form_service.FormServiceError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ConfigValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.as_payload())


@router.delete("/{standard_id}")
def withdraw(standard_id: str, user: Dict[str, Any] = Depends(needs(LIBRARY_MANAGE))):
    """Take a standard back out of the library.

    Only the library entry goes; the form it was taken from is untouched, and
    forms already started from it keep working — they simply report the standard
    as missing.
    """
    if not form_service.remove_from_library(standard_id):
        raise HTTPException(status_code=404, detail=f"No standard form '{standard_id}'")
    return {"standard_id": standard_id, "removed": True}


@router.post("/{standard_id}/start")
def start(standard_id: str, req: StartFromStandardRequest, user: Dict[str, Any] = Depends(needs(LIBRARY_VIEW))):
    """The whole standard as a new draft.

    An ordinary draft: rename it, reword it, add or remove questions, or hand it
    to the model to revise. Nothing about it is locked.
    """
    try:
        return {"form_json": standard_library.start_from(standard_id, req.title)}
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/{standard_id}/borrow")
def borrow(standard_id: str, req: BorrowRequest, user: Dict[str, Any] = Depends(needs(LIBRARY_VIEW))):
    """Merge this standard's fields, or one section of them, into a draft.

    Returns the combined draft. Colliding field keys are suffixed rather than
    overwritten, and the result is validated before it is handed back so a merge
    can never produce a config that would be rejected on save.
    """
    try:
        merged = standard_library.borrow(req.form_json, standard_id, req.section)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    try:
        validate_config(merged)
    except ConfigValidationError as exc:
        logger.error("Borrowing %s produced an invalid draft: %s", standard_id, exc)
        raise HTTPException(status_code=422, detail=exc.as_payload())

    return {"form_json": merged}
