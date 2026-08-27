"""API for client-controlled catalogs."""

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.core.deps import needs
from app.modules.client_catalog import catalog_options as catalog_options_service
from app.modules.client_catalog.importer import (
    CatalogImportError,
    get_catalog,
    get_values,
    import_catalog_workbook,
    list_catalogs,
)
from app.modules.client_catalog.permissions import (
    CATALOG_MANAGE,
    CATALOG_VIEW,
)

router = APIRouter(
    prefix="/api/client-catalogs",
    tags=["client catalogs"],
)


@router.get("")
def catalogs(
    user: Dict[str, Any] = Depends(needs(CATALOG_VIEW)),
):
    return {
        "catalogs": list_catalogs(),
    }


@router.get("/{catalog_id}")
def catalog(
    catalog_id: str,
    user: Dict[str, Any] = Depends(needs(CATALOG_VIEW)),
):

    result = get_catalog(catalog_id)

    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"No client catalog '{catalog_id}'",
        )

    return result


@router.get("/{catalog_id}/values")
def catalog_values(
    catalog_id: str,
    parent_code: Optional[str] = None,
    user: Dict[str, Any] = Depends(needs(CATALOG_VIEW)),
):

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
    user: Dict[str, Any] = Depends(needs(CATALOG_VIEW)),
):
    """The catalog's values shaped as form options.

    What a field with `options_from.source == "client_catalog"` is drawn from.
    `parent_code` narrows a dependent list to the chosen parent.
    """

    if get_catalog(catalog_id) is None:
        raise HTTPException(
            status_code=404,
            detail=f"No client catalog '{catalog_id}'",
        )

    return catalog_options_service.options_for(
        catalog_id,
        parent_code=parent_code,
    )


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

    try:

        result = import_catalog_workbook(
            data,
            source=filename,
        )

    except CatalogImportError as exc:

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