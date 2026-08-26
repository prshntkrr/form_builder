"""The data dictionary: agreed types and limits for known field names."""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core import auth_service
from app.core.deps import needs
from app.modules.forms import dictionary_service
from app.modules.forms.form_schema import FormSchemaError, normalize_form
from app.modules.forms.permissions import DICTIONARY_MANAGE, DICTIONARY_VIEW
from app.modules.forms.schemas import (
    ApplyDictionaryRequest,
    DictionaryEntryRequest,
    UpdateDictionaryEntryRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/dictionary", tags=["dictionary"])


@router.get("")
def listing(
    search: Optional[str] = Query(None),
    user: Dict[str, Any] = Depends(needs(DICTIONARY_VIEW)),
):
    return dictionary_service.list_entries(search)


@router.post("", status_code=201)
def create(
    req: DictionaryEntryRequest,
    user: Dict[str, Any] = Depends(needs(DICTIONARY_MANAGE)),
):
    try:
        return dictionary_service.create_entry(
            name=req.name,
            label=req.label,
            field_type=req.field_type,
            aliases=req.aliases,
            validation=req.validation,
            options=req.options,
            help_text=req.help_text,
            placeholder=req.placeholder,
            notes=req.notes,
            updated_by=auth_service.display_name(user),
        )
    except dictionary_service.DictionaryError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/{entry_id}")
def detail(entry_id: str, user: Dict[str, Any] = Depends(needs(DICTIONARY_VIEW))):
    try:
        return dictionary_service.get_entry(entry_id)
    except dictionary_service.EntryNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.patch("/{entry_id}")
def update(
    entry_id: str,
    req: UpdateDictionaryEntryRequest,
    user: Dict[str, Any] = Depends(needs(DICTIONARY_MANAGE)),
):
    changes = req.model_dump(exclude_unset=True)
    try:
        return dictionary_service.update_entry(
            entry_id, updated_by=auth_service.display_name(user), **changes
        )
    except dictionary_service.EntryNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except dictionary_service.DictionaryError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/{entry_id}")
def remove(entry_id: str, user: Dict[str, Any] = Depends(needs(DICTIONARY_MANAGE))):
    try:
        return dictionary_service.delete_entry(entry_id)
    except dictionary_service.EntryNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/apply")
def apply(
    req: ApplyDictionaryRequest,
    user: Dict[str, Any] = Depends(needs(DICTIONARY_VIEW)),
):
    """Bring a draft into line with the dictionary, and say what changed.

    Nothing is saved — the caller gets the amended definition back and decides
    whether to keep it.
    """
    result = dictionary_service.apply_to_form(req.form_json)
    try:
        # Back through the normalizer, so a bad entry cannot leave a form in a
        # shape the rest of the application would refuse.
        result["form_json"] = normalize_form(result["form_json"])
    except FormSchemaError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return result
