"""The Standard Form Library: look one up, add one, or start from it.

Reuse produces a *draft* definition which the client then saves through
`POST /api/forms` like any other — so a form created from a standard goes
through exactly the same validation and table creation as one built by hand,
and is just as editable afterwards.
"""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile

from app.core import auth_service
from app.modules.forms import form_service
from app.modules.forms import standard_library
from app.core.deps import needs
from app.modules.forms.permissions import LIBRARY_MANAGE, LIBRARY_VIEW
from app.modules.forms.config_validation import ConfigValidationError, validate_config
from app.modules.forms.form_schema import FormSchemaError, normalize_form
from app.modules.forms.schemas import (
    AddToLibraryRequest,
    BorrowRequest,
    SaveImportedFormRequest,
    StartFromStandardRequest,
)

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


# --------------------------------------------------------------------------- #
# importing a workbook the client already wrote
# --------------------------------------------------------------------------- #
# 8 MB. A form definition is a small spreadsheet; anything larger is a mistake.
MAX_WORKBOOK_BYTES = 8 * 1024 * 1024


@router.post("/import")
async def import_workbook(
    file: UploadFile = File(...),
    user: Dict[str, Any] = Depends(needs(LIBRARY_MANAGE)),
):
    """Read a workbook into draft definitions. **Nothing is saved.**

    The workbook is the authority on the form: its fields, their wording, their
    permitted values and the language it is written in all come from the file
    and are never translated or invented here.

    The standards are then applied as they are to any draft — they add meaning
    beside the client's definition and do not replace it. A field answered from
    a client catalog keeps that catalog.

    One draft comes back per profile in the workbook. The caller tests one and
    saves it through `/import/save`; leaving without saving creates nothing.
    """
    from app.modules.forms.excel_import import (
        WorkbookProblem,
        import_workbook as read_cimmyt,
    )

    from app.modules.forms.edit_view_import import (
        EditViewWorkbookProblem,
        is_edit_view_workbook,
        read_workbook as read_edit_view,
    )

    name = file.filename or "workbook.xlsx"
    if not name.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(
            status_code=400,
            detail="That is not an .xlsx file. Export the workbook as Excel and try again.",
        )

    data = await file.read()
    if len(data) > MAX_WORKBOOK_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"That file is larger than {MAX_WORKBOOK_BYTES // (1024 * 1024)} MB.",
        )

    try:
        # ---------------------------------------------------------------
        # Detect workbook format.
        #
        # CIMMYT Controlled Vocabulary:
        #   03_Variables / 14_Profiles / etc.
        #
        # Client Edit View:
        #   VARIABLE / FIELD TYPE / LABEL / CATALOG / etc.
        #
        # Do not weaken the CIMMYT reader by removing its 03_Variables
        # requirement. Use the appropriate reader for the workbook.
        # ---------------------------------------------------------------

        if is_edit_view_workbook(data):

            definitions = read_edit_view(
                data,
                source=name,
            )

        else:

            definitions = read_cimmyt(
                data,
                source=name,
            )

    except EditViewWorkbookProblem as exc:

        raise HTTPException(
            status_code=422,
            detail=str(exc),
        )

    except WorkbookProblem as exc:

        raise HTTPException(
            status_code=422,
            detail=str(exc),
        )

    except Exception as exc:

        logger.exception("Workbook import failed")

        raise HTTPException(
            status_code=422,
            detail=f"Could not read that workbook: {exc}",
        )

    drafts = []
    for definition in definitions:
        try:
            prepared = normalize_form(definition)
        except FormSchemaError as exc:
            logger.warning("Skipping a profile that did not normalize: %s", exc)
            continue

        enriched = _enrich_imported(prepared)
        drafts.append({
            "form_json": enriched["form_json"],
            "standards": enriched["attached"],
            "profile": definition.get("import_source", {}),
        })

    if not drafts:
        raise HTTPException(
            status_code=422,
            detail="The workbook held no form this reader could build.",
        )

    return {"source": name, "forms": drafts}


def _enrich_imported(form_json: Dict[str, Any]) -> Dict[str, Any]:
    """Apply the standards to an imported definition, adding never replacing.

    Each pass is optional and defensive: a module that is switched off, or that
    fails, must not stop a client's own form being imported.
    """
    attached: list = []

    try:
        from app.modules.forms import dictionary_service
        applied = dictionary_service.apply_to_form(form_json)
        form_json = applied["form_json"]
        attached.extend(applied["applied"])
    except Exception:
        logger.exception("Data dictionary enrichment failed on an import")

    try:
        from app.modules.standards.icasa import enrichment
        result = enrichment.enrich_form(form_json, form_json.get("title") or "")
        form_json = result["form_json"]
        attached.extend(result["attached"])
    except Exception:
        logger.exception("Standards enrichment failed on an import")

    # A field asking *which crop* is answered from the imported ontologies, not
    # from a list written into the workbook. The same pass a generated draft
    # goes through — an imported form must not be the one place where the crop
    # question comes out as free text.
    try:
        from app.modules.standards.crop_ontology import enrichment as crop
        wired = crop.apply_dynamic_options(form_json)
        form_json = wired["form_json"]
        for change in wired["dynamic"]:
            attached.append({
                "field": change["field"],
                "confidence": 1.0,
                "attached": [f"Crop ontology: {change['source']}"],
            })
    except Exception:
        logger.exception("Could not wire the crop fields on an import")

    try:
        form_json = normalize_form(form_json)
    except FormSchemaError:
        logger.exception("An enriched import stopped normalizing; keeping it as read")

    return {"form_json": form_json, "attached": attached}


@router.post("/import/save", status_code=201)
def save_imported(
    req: SaveImportedFormRequest,
    user: Dict[str, Any] = Depends(needs(LIBRARY_MANAGE)),
):
    """Put a tested import into the library. This is the only step that stores it.

    Uses the same library mechanism as any other standard, so an imported form
    behaves exactly like one contributed from a built form.
    """
    from datetime import datetime

    from app.core.database import transaction

    try:
        definition = normalize_form(req.form_json)
        validate_config(definition)
    except ConfigValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.as_payload())
    except FormSchemaError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # When the import came from and out of which file, kept with the definition.
    imported = dict(definition.get("import_source") or {})
    if req.source:
        imported["file"] = req.source
    imported["imported_on"] = datetime.utcnow().isoformat(timespec="seconds")
    imported["imported_by"] = auth_service.display_name(user)
    definition["import_source"] = imported

    with transaction() as cur:
        entry = standard_library.add_form(
            cur,
            definition,
            title=req.title or definition.get("title"),
            category=req.category or "Imported",
            tags=req.tags,
            summary=req.summary,
            added_by=auth_service.display_name(user),
        )
    return entry
