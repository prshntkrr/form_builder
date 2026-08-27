"""Crop-specific traits, methods, scales and variables.

Every answer comes from PostgreSQL. Nothing here calls cropontology.org — that
happens only in the importer, which is run by hand.
"""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.deps import needs
from app.modules.crop_ontology import dynamic_options, importer, variable_service
from app.modules.crop_ontology.permissions import CROP_ONTOLOGY_MANAGE, CROP_ONTOLOGY_VIEW

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/crop-ontology", tags=["crop ontology"])


@router.get("")
def loaded(user: Dict[str, Any] = Depends(needs(CROP_ONTOLOGY_VIEW))):
    """Which crop ontologies are imported, and how big each one is."""
    return importer.loaded()


@router.get("/options")
def options_for_field(
    kind: str = Query(..., description="crop, trait or variable"),
    depends_on: Optional[str] = Query(None, description="the chosen crop's ontology id"),
    user: Dict[str, Any] = Depends(needs(CROP_ONTOLOGY_VIEW)),
):
    """The choices for a field whose options are read when the form is drawn.

    `kind=crop` lists the imported crops; `kind=trait` needs `depends_on` to be
    the chosen crop, because every crop has its own traits.

    Straight from PostgreSQL. Nothing here calls cropontology.org.
    """
    if kind not in dynamic_options.KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown kind '{kind}'. Use one of: {', '.join(dynamic_options.KINDS)}",
        )
    return dynamic_options.options_for(kind, depends_on)


@router.get("/search")
def search(
    q: str = Query("", description="Part of a trait or variable name"),
    crop: Optional[str] = Query(None, description="Restrict to one ontology, e.g. CO_322"),
    limit: int = Query(25, ge=1, le=100),
    user: Dict[str, Any] = Depends(needs(CROP_ONTOLOGY_VIEW)),
):
    return variable_service.search_variables(q, ontology_id=crop, limit=limit)


@router.get("/traits")
def traits(
    q: str = Query(""),
    crop: Optional[str] = Query(None),
    limit: int = Query(25, ge=1, le=100),
    user: Dict[str, Any] = Depends(needs(CROP_ONTOLOGY_VIEW)),
):
    return variable_service.search_traits(q, ontology_id=crop, limit=limit)


@router.get("/traits/{trait_id:path}")
def trait(trait_id: str, user: Dict[str, Any] = Depends(needs(CROP_ONTOLOGY_VIEW))):
    try:
        return variable_service.get_trait(trait_id)
    except variable_service.NotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/variables/{variable_id:path}/options")
def options(variable_id: str, user: Dict[str, Any] = Depends(needs(CROP_ONTOLOGY_VIEW))):
    """The variable's scale categories, shaped as form options.

    Empty unless the values pass has been run — the OWL does not publish them.
    """
    try:
        return variable_service.scale_options(variable_id)
    except variable_service.NotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/variables/{variable_id:path}")
def variable(variable_id: str, user: Dict[str, Any] = Depends(needs(CROP_ONTOLOGY_VIEW))):
    """One variable with its trait, method, scale and provenance."""
    try:
        return variable_service.get_variable(variable_id)
    except variable_service.NotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.delete("/{ontology_id}")
def remove(ontology_id: str, user: Dict[str, Any] = Depends(needs(CROP_ONTOLOGY_MANAGE))):
    return importer.remove(ontology_id)
