"""Searching an ontology, and pulling standardised answers out of it."""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.deps import needs
from app.modules.ontology import concept_service, importer
from app.modules.ontology.permissions import ONTOLOGY_MANAGE, ONTOLOGY_VIEW

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ontology", tags=["ontology"])


@router.get("")
def loaded(user: Dict[str, Any] = Depends(needs(ONTOLOGY_VIEW))):
    """Which ontologies have been imported."""
    return importer.loaded()


@router.get("/search")
def search(
    q: str = Query("", description="Part of a concept label"),
    ontology: Optional[str] = Query(None),
    limit: int = Query(25, ge=1, le=100),
    user: Dict[str, Any] = Depends(needs(ONTOLOGY_VIEW)),
):
    """Concepts whose label contains `q`, case-insensitively."""
    return concept_service.search(q, ontology=ontology, limit=limit)


@router.get("/{concept_id}")
def detail(concept_id: int, user: Dict[str, Any] = Depends(needs(ONTOLOGY_VIEW))):
    try:
        return concept_service.get(concept_id)
    except concept_service.ConceptNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{concept_id}/children")
def children(concept_id: int, user: Dict[str, Any] = Depends(needs(ONTOLOGY_VIEW))):
    """The named subclasses of a concept.

    An empty list is a normal answer — plenty of concepts carry meaning without
    carrying a list of values.
    """
    try:
        return concept_service.children(concept_id)
    except concept_service.ConceptNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{concept_id}/options")
def options(concept_id: int, user: Dict[str, Any] = Depends(needs(ONTOLOGY_VIEW))):
    """The same children, already shaped as form field options."""
    try:
        return concept_service.as_options(concept_id)
    except concept_service.ConceptNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.delete("/{ontology_name}")
def remove(ontology_name: str, user: Dict[str, Any] = Depends(needs(ONTOLOGY_MANAGE))):
    """Drop an imported ontology. Forms keep the options they already pulled."""
    return importer.remove(ontology_name)
