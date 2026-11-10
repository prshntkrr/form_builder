"""Beneficiary types and master registry endpoints."""
import base64
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from app.core.deps import needs
from app.modules.beneficiaries import service
from app.modules.beneficiaries.permissions import (
    BENEFICIARIES_APPROVE,
    BENEFICIARIES_MANAGE,
    BENEFICIARIES_VIEW,
)

router = APIRouter(prefix="/api/beneficiaries", tags=["beneficiaries"])


# ── schemas ────────────────────────────────────────────────────────────────

class TypeCreate(BaseModel):
    type_id: str = Field(..., min_length=1, max_length=30)
    name: str = Field(..., min_length=1, max_length=200)
    prefix: str = Field(..., min_length=1, max_length=10)
    form_id: Optional[str] = None
    master_fields: List[str] = []
    id_pattern: str = "{prefix}-{seq}"


class TypeUpdate(BaseModel):
    name: Optional[str] = None
    prefix: Optional[str] = None
    form_id: Optional[str] = None
    master_fields: Optional[List[str]] = None
    id_pattern: Optional[str] = None
    is_active: Optional[bool] = None
    card_config: Optional[Dict[str, Any]] = None


class RegisterRequest(BaseModel):
    type_id: str
    data: Dict[str, Any] = {}
    voice_base64: Optional[str] = None
    project_id: Optional[str] = None
    source_survey_id: Optional[str] = None


class ReviewRequest(BaseModel):
    action: str = Field(..., pattern="^(approve|reject)$")


class BulkReviewRequest(BaseModel):
    ids: List[str] = Field(..., min_length=1)
    action: str = Field(..., pattern="^(approve|reject)$")


class MergeRequest(BaseModel):
    keep_id: str
    merge_ids: List[str] = Field(..., min_length=1)


# ── beneficiary types ──────────────────────────────────────────────────────

@router.get("/types")
def list_types(user: Dict[str, Any] = Depends(needs(BENEFICIARIES_VIEW))):
    return {"types": service.list_types(with_stats=True)}


@router.post("/types")
def create_type(req: TypeCreate, user: Dict[str, Any] = Depends(needs(BENEFICIARIES_MANAGE))):
    try:
        return service.create_type(
            req.type_id, req.name, req.prefix, req.form_id,
            req.master_fields, req.id_pattern, created_by=user.get("user_id"),
        )
    except service.DuplicateType as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/types/{type_id}")
def get_type(type_id: str, user: Dict[str, Any] = Depends(needs(BENEFICIARIES_VIEW))):
    try:
        return service.get_type(type_id)
    except service.UnknownType as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.put("/types/{type_id}")
def update_type(type_id: str, req: TypeUpdate, user: Dict[str, Any] = Depends(needs(BENEFICIARIES_MANAGE))):
    try:
        return service.update_type(type_id, **req.dict(exclude_unset=True))
    except service.UnknownType as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except service.FormAlreadyLinked as exc:
        raise HTTPException(status_code=409, detail=str(exc))


# ── master registry ────────────────────────────────────────────────────────

@router.get("/registry")
def list_registry(
    type_id: Optional[str] = None,
    status: Optional[str] = None,
    project_id: Optional[str] = None,
    limit: int = Query(100, le=500),
    offset: int = Query(0, ge=0),
    user: Dict[str, Any] = Depends(needs(BENEFICIARIES_VIEW)),
):
    return service.list_registry(type_id, status, project_id, limit, offset)


@router.get("/registry/search")
def search_registry(
    q: str = Query(..., min_length=1),
    type_id: Optional[str] = None,
    limit: int = Query(50, le=200),
    user: Dict[str, Any] = Depends(needs(BENEFICIARIES_VIEW)),
):
    return {"items": service.search_registry(q, type_id, limit)}


class FindDuplicatesRequest(BaseModel):
    pending_ids: Optional[List[str]] = None
    type_id: Optional[str] = None


@router.post("/registry/find-duplicates")
def find_duplicates(
    req: FindDuplicatesRequest,
    user: Dict[str, Any] = Depends(needs(BENEFICIARIES_VIEW)),
):
    return {"results": service.find_duplicates(req.type_id, req.pending_ids)}


@router.get("/registry/export")
def export_registry(
    type_id: Optional[str] = None,
    status: Optional[str] = None,
    user: Dict[str, Any] = Depends(needs(BENEFICIARIES_VIEW)),
):
    """Export all matching records as JSON (frontend converts to CSV)."""
    return {"items": service.export_registry(type_id, status)}


@router.post("/registry/bulk-review")
def bulk_review(req: BulkReviewRequest, user: Dict[str, Any] = Depends(needs(BENEFICIARIES_APPROVE))):
    return service.bulk_review(req.ids, req.action, reviewed_by=user.get("user_id"))


@router.post("/registry/merge")
def merge_beneficiaries(req: MergeRequest, user: Dict[str, Any] = Depends(needs(BENEFICIARIES_APPROVE))):
    try:
        return service.merge_beneficiaries(req.keep_id, req.merge_ids, reviewed_by=user.get("user_id"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/registry")
def register_beneficiary(req: RegisterRequest, user: Dict[str, Any] = Depends(needs(BENEFICIARIES_VIEW))):
    voice_bytes = None
    if req.voice_base64:
        try:
            voice_bytes = base64.b64decode(req.voice_base64)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid base64 voice data")
    try:
        return service.register_beneficiary(
            req.type_id, req.data, voice_bytes,
            req.project_id, req.source_survey_id,
            created_by=user.get("user_id"),
        )
    except service.UnknownType as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/registry/{beneficiary_id}")
def get_beneficiary(beneficiary_id: str, user: Dict[str, Any] = Depends(needs(BENEFICIARIES_VIEW))):
    try:
        return service.get_beneficiary(beneficiary_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/registry/{beneficiary_id}/card")
def beneficiary_card(
    beneficiary_id: str,
    user: Dict[str, Any] = Depends(needs(BENEFICIARIES_VIEW)),
):
    try:
        ben = service.get_beneficiary(beneficiary_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    if ben["status"] != "approved":
        raise HTTPException(status_code=400, detail="Card is available only for approved beneficiaries")
    try:
        btype = service.get_type(ben["type_id"])
    except service.UnknownType:
        btype = {"name": ben["type_id"], "master_fields": []}
    from app.modules.beneficiaries.card import generate_card_html
    html = generate_card_html(ben, btype)
    return HTMLResponse(content=html)


@router.post("/registry/{beneficiary_id}/review")
def review_beneficiary(
    beneficiary_id: str,
    req: ReviewRequest,
    user: Dict[str, Any] = Depends(needs(BENEFICIARIES_APPROVE)),
):
    try:
        return service.review_beneficiary(
            beneficiary_id, req.action, reviewed_by=user.get("user_id"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
