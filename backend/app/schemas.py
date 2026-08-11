"""Request/response models for the HTTP layer."""
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=3, max_length=5000)
    language: Optional[str] = None


class RefineRequest(BaseModel):
    form_json: Dict[str, Any]
    instruction: str = Field(..., min_length=2, max_length=5000)


class ValidateRequest(BaseModel):
    form_json: Dict[str, Any]


class GeneratedForm(BaseModel):
    form_json: Dict[str, Any]
    prompt: Optional[str] = None


class CreateFormRequest(BaseModel):
    form_json: Dict[str, Any]
    created_by: Optional[str] = None
    form_type: str = "parent"
    parent_id: Optional[str] = None
    form_status: str = "Active"


class UpdateFormRequest(BaseModel):
    form_json: Dict[str, Any]
    updated_by: Optional[str] = None
    form_status: Optional[str] = None
    # old field key -> new field key, for fields renamed by hand. Stored answers
    # are moved with them so existing responses keep matching the definition.
    renames: Optional[Dict[str, str]] = None


class RevalidateRequest(BaseModel):
    # False reports what no longer fits; True also re-coerces what it can.
    fix: bool = False


class StatusRequest(BaseModel):
    form_status: str


class SubmitRequest(BaseModel):
    data: Dict[str, Any]
    created_by: Optional[str] = None


class FormSummary(BaseModel):
    form_id: str
    form_title: str
    form_description: Optional[str] = None
    form_status: Optional[str] = None
    form_type: Optional[str] = None
    parent_id: Optional[str] = None
    table_name: Optional[str] = None
    field_count: int = 0
    version_no: Optional[int] = None
    created_on: Optional[Any] = None
    updated_on: Optional[Any] = None
    created_by: Optional[str] = None


class FormDetail(FormSummary):
    form_json: Dict[str, Any]
    table: Optional[Dict[str, Any]] = None


class VersionEntry(BaseModel):
    version_id: int
    form_id: str
    version_no: int
    title: Optional[str] = None
    field_count: int = 0
    form_json: Optional[Dict[str, Any]] = None


class SubmissionList(BaseModel):
    table_name: Optional[str]
    columns: List[Dict[str, Any]]
    total: int
    limit: Optional[int] = None
    offset: Optional[int] = None
    rows: List[Dict[str, Any]]
