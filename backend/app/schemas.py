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


class RollbackRequest(BaseModel):
    version_no: int = Field(..., ge=1)
    updated_by: Optional[str] = None


class StartFromStandardRequest(BaseModel):
    # Rename it on the way out; the standard's own title is used otherwise.
    title: Optional[str] = Field(default=None, max_length=200)


class AddToLibraryRequest(BaseModel):
    form_id: str
    # Defaults to the form's live version.
    version_no: Optional[int] = Field(default=None, ge=1)
    # Defaults to a slug of the form title.
    standard_id: Optional[str] = Field(default=None, max_length=55)
    category: str = Field(default="General", max_length=50)
    tags: List[str] = Field(default_factory=list)
    summary: Optional[str] = None
    added_by: Optional[str] = Field(default=None, max_length=50)


class BorrowRequest(BaseModel):
    form_json: Dict[str, Any]
    # One section of the standard, or all of its fields when omitted.
    section: Optional[str] = None


class StatusRequest(BaseModel):
    form_status: str


# --------------------------------------------------------------------------- #
# auth
# --------------------------------------------------------------------------- #
class LoginRequest(BaseModel):
    email: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=8)


class ForgotPasswordRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    token: str
    password: str = Field(..., min_length=8)


class CreateUserRequest(BaseModel):
    email: str
    password: str = Field(..., min_length=8)
    full_name: Optional[str] = Field(default=None, max_length=120)
    # A role id or a role name.
    role: str = "field"


class CreateRoleRequest(BaseModel):
    label: str = Field(..., min_length=1, max_length=80)
    # Defaults to a slug of the label.
    name: Optional[str] = Field(default=None, max_length=50)
    description: Optional[str] = None
    permissions: List[str] = Field(default_factory=list)


class UpdateRoleRequest(BaseModel):
    label: Optional[str] = Field(default=None, max_length=80)
    description: Optional[str] = None
    # Omit to leave the permissions alone; send a list to replace them.
    permissions: Optional[List[str]] = None


class DeleteRoleRequest(BaseModel):
    # Where to move anyone still holding the role.
    reassign_to: Optional[str] = None


class UpdateUserRequest(BaseModel):
    role: Optional[str] = None
    full_name: Optional[str] = Field(default=None, max_length=120)
    is_active: Optional[bool] = None
    # Clear a lockout after too many failed sign-in attempts.
    unlock: bool = False


class ViewConfigRequest(BaseModel):
    # The questions everyone who cannot edit may see.
    visible_fields: List[str] = Field(default_factory=list)
    # Go back to showing every question.
    show_all: bool = False


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
