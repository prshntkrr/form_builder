"""API for client-controlled catalogs.

Reading is what a form does when it is drawn; writing is the Catalogue Builder.
Both work on the same two tables the workbook importer fills, so a catalogue
built here and one imported from a spreadsheet behave identically afterwards.
"""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from app.core import auth_service
from app.core.deps import needs
from app.modules.client_catalog import catalog_options as catalog_options_service
from app.modules.client_catalog import catalog_service
from app.modules.client_catalog import eagrology_import
from app.modules.client_catalog.importer import (
    CatalogImportError,
    get_catalog,
    get_values,
    import_catalog_workbook,
)
from app.modules.client_catalog.permissions import (
    CATALOG_MANAGE,
    CATALOG_VIEW,
)

router = APIRouter(
    prefix="/api/client-catalogs",
    tags=["client catalogs"],
)


# --------------------------------------------------------------------------- #
# what a request may say
# --------------------------------------------------------------------------- #
class CreateCatalogRequest(BaseModel):
    catalog_id: str = Field(..., description="The id forms will refer to, e.g. CAT-STATE")
    name: str
    description: str = ""
    version: str = "1.0"
    status: str = "Candidate"
    parent_catalog_id: Optional[str] = Field(
        None, description="For a dependent list: the catalogue its values hang off")


class UpdateCatalogRequest(BaseModel):
    """Only what was sent is changed. The catalogue id itself never changes —
    forms hold it, and renaming it would strand them."""
    name: Optional[str] = None
    description: Optional[str] = None
    version: Optional[str] = None
    status: Optional[str] = None
    parent_catalog_id: Optional[str] = None


class AddValueRequest(BaseModel):
    code: str = Field(..., description="The stable identifier stored in an answer")
    label: str = ""
    definition: str = ""
    parent_code: Optional[str] = None
    display_order: Optional[int] = None
    status: str = "Active"


class UpdateValueRequest(BaseModel):
    """The code is absent on purpose: it is what answers already carry."""
    label: Optional[str] = None
    definition: Optional[str] = None
    parent_code: Optional[str] = None
    display_order: Optional[int] = None
    status: Optional[str] = None


def _sent(req: BaseModel) -> Dict[str, Any]:
    """Only the fields the caller actually set, so a PATCH cannot blank a field
    by not mentioning it."""
    return req.model_dump(exclude_unset=True)


def _handle(exc: Exception):
    if isinstance(exc, catalog_service.CatalogNotFound):
        raise HTTPException(status_code=404, detail=str(exc))
    raise HTTPException(status_code=400, detail=str(exc))


# --------------------------------------------------------------------------- #
# reading
# --------------------------------------------------------------------------- #
@router.get("")
def catalogs(
    search: Optional[str] = Query(None, description="Match on id, name or description"),
    user: Dict[str, Any] = Depends(needs(CATALOG_VIEW)),
):
    return {
        "catalogs": catalog_service.list_catalogs(search),
        "catalog_statuses": list(catalog_service.CATALOG_STATUSES),
        "value_statuses": list(catalog_service.VALUE_STATUSES),
    }


@router.get("/{catalog_id}")
def catalog(
    catalog_id: str,
    user: Dict[str, Any] = Depends(needs(CATALOG_VIEW)),
):
    try:
        return catalog_service.get(catalog_id)
    except catalog_service.CatalogNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{catalog_id}/values")
def catalog_values(
    catalog_id: str,
    parent_code: Optional[str] = None,
    user: Dict[str, Any] = Depends(needs(CATALOG_VIEW)),
):
    """Every value, whatever its status — this is the management view.

    Withdrawn values are included deliberately: they still have to be readable,
    and the builder has to be able to bring one back. `/options` is the endpoint
    that decides what may be *answered*.
    """

    catalog = get_catalog(catalog_id)

    if catalog is None:
        raise HTTPException(
            status_code=404,
            detail=f"No client catalog '{catalog_id}'",
        )

    return {
        "catalog": catalog,
        "values": get_values(
            catalog_id,
            parent_code=parent_code,
        ),
    }


@router.get("/{catalog_id}/options")
def catalog_options(
    catalog_id: str,
    parent_code: Optional[str] = None,
    language: Optional[str] = Query(None, description="Label language, e.g. 'en'"),
    user: Dict[str, Any] = Depends(needs(CATALOG_VIEW)),
):
    """The catalogue's values shaped as form options.

    What a field with `options_from.source == "client_catalog"` is drawn from.
    `parent_code` narrows a dependent list to the chosen parent. Withdrawn
    values are not offered here, though they stay readable on old answers.

    `language` changes the wording and nothing else: the value is the client's
    code in every language, because that is what an answer stores.
    """

    if get_catalog(catalog_id) is None:
        raise HTTPException(
            status_code=404,
            detail=f"No client catalog '{catalog_id}'",
        )

    return catalog_options_service.options_for(
        catalog_id,
        parent_code=parent_code,
        language=language,
    )


# --------------------------------------------------------------------------- #
# building
# --------------------------------------------------------------------------- #
@router.post("", status_code=201)
def create_catalog(
    req: CreateCatalogRequest,
    user: Dict[str, Any] = Depends(needs(CATALOG_MANAGE)),
):
    """A new, empty catalogue."""
    try:
        return catalog_service.create_catalog(
            catalog_id=req.catalog_id,
            name=req.name,
            description=req.description,
            version=req.version,
            status=req.status,
            parent_catalog_id=req.parent_catalog_id,
            created_by=auth_service.display_name(user),
        )
    except (catalog_service.CatalogError, catalog_service.CatalogNotFound) as exc:
        _handle(exc)


@router.patch("/{catalog_id}")
def update_catalog(
    catalog_id: str,
    req: UpdateCatalogRequest,
    user: Dict[str, Any] = Depends(needs(CATALOG_MANAGE)),
):
    try:
        return catalog_service.update_catalog(catalog_id, _sent(req))
    except (catalog_service.CatalogError, catalog_service.CatalogNotFound) as exc:
        _handle(exc)


@router.post("/{catalog_id}/values", status_code=201)
def add_value(
    catalog_id: str,
    req: AddValueRequest,
    user: Dict[str, Any] = Depends(needs(CATALOG_MANAGE)),
):
    try:
        return catalog_service.add_value(
            catalog_id,
            code=req.code,
            label=req.label,
            definition=req.definition,
            parent_code=req.parent_code,
            display_order=req.display_order,
            status=req.status,
        )
    except (catalog_service.CatalogError, catalog_service.CatalogNotFound) as exc:
        _handle(exc)


@router.patch("/{catalog_id}/values/{code}")
def update_value(
    catalog_id: str,
    code: str,
    req: UpdateValueRequest,
    user: Dict[str, Any] = Depends(needs(CATALOG_MANAGE)),
):
    """Revise a value, or take it out of circulation.

    There is no delete. A value that has been answered has to stay readable, so
    it leaves circulation by becoming Withdrawn instead.
    """
    try:
        return catalog_service.update_value(catalog_id, code, _sent(req))
    except (catalog_service.CatalogError, catalog_service.CatalogNotFound) as exc:
        _handle(exc)


# --------------------------------------------------------------------------- #
# importing
# --------------------------------------------------------------------------- #
@router.post("/import")
async def import_catalogs(
    file: UploadFile = File(...),
    user: Dict[str, Any] = Depends(needs(CATALOG_MANAGE)),
):

    filename = file.filename or "workbook.xlsx"

    if not filename.lower().endswith(
        (".xlsx", ".xlsm")
    ):
        raise HTTPException(
            status_code=400,
            detail="Please upload an Excel .xlsx or .xlsm file.",
        )

    data = await file.read()

    # ------------------------------------------------------------------
    # Which reader this workbook needs.
    #
    #   Catalogs                        the client's own sheet:
    #                                   List / Variable / Label Spanish / Label ENG
    #
    #   04_Value_Catalogs               CIMMYT Controlled Vocabulary
    #   05_Catalog_Values
    #
    # Asked in that order, and asked before either reader runs, so a client
    # workbook is never handed to the reader that would demand sheets it was
    # never meant to have. The CIMMYT reader keeps its own requirements.
    # ------------------------------------------------------------------
    try:

        if eagrology_import.is_eagrology_workbook(data):

            result = eagrology_import.import_workbook(
                data,
                source=filename,
            )

        else:

            result = import_catalog_workbook(
                data,
                source=filename,
            )

    except (CatalogImportError, eagrology_import.EagrologyCatalogError) as exc:

        raise HTTPException(
            status_code=422,
            detail=str(exc),
        )

    except Exception as exc:

        raise HTTPException(
            status_code=422,
            detail=f"Catalog import failed: {exc}",
        )

    return {
        "source": filename,
        **result,
    }
