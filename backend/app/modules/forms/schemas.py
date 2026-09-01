"""Request and response models for the forms module."""
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
    # Which project this form belongs to. Optional: a form created without one
    # is a system-level form, reachable through the account-wide form
    # permissions exactly as every form was before projects existed.
    project_id: Optional[str] = None


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


class ViewConfigRequest(BaseModel):
    # The questions everyone who cannot edit may see.
    visible_fields: List[str] = Field(default_factory=list)
    # Go back to showing every question.
    show_all: bool = False


class SubmitRequest(BaseModel):
    data: Dict[str, Any]
    created_by: Optional[str] = None
    # Which language the form was filled in, so errors come back in it.
    language: Optional[str] = None
    # Which submission of the parent form this one belongs to, for a child form.
    # A claim, not a fact: `relationships.validate_parent` decides whether it is
    # a submission of the right form, in the right project, that this account may
    # read. Ignored — and refused — on a form that is not a child.
    parent_survey_id: Optional[str] = None


class DictionaryEntryRequest(BaseModel):
    """One agreed field: what it is called, what type it is, what it allows."""
    name: str
    label: str = ""
    field_type: str
    aliases: List[str] = Field(default_factory=list)
    validation: Dict[str, Any] = Field(default_factory=dict)
    options: List[Any] = Field(default_factory=list)
    help_text: str = ""
    placeholder: str = ""
    notes: str = ""


class UpdateDictionaryEntryRequest(BaseModel):
    """Only the parts being changed. The name is the entry's identity."""
    label: Optional[str] = None
    field_type: Optional[str] = None
    aliases: Optional[List[str]] = None
    validation: Optional[Dict[str, Any]] = None
    options: Optional[List[Any]] = None
    help_text: Optional[str] = None
    placeholder: Optional[str] = None
    notes: Optional[str] = None


class ApplyDictionaryRequest(BaseModel):
    form_json: Dict[str, Any]


class TestDefinitionRequest(BaseModel):
    """A dry run against a definition that is not saved anywhere."""
    form_json: Dict[str, Any]
    data: Dict[str, Any] = Field(default_factory=dict)
    language: Optional[str] = None


class SaveImportedFormRequest(BaseModel):
    """Save a workbook import into the library. Only sent when the user says so."""
    form_json: Dict[str, Any]
    title: Optional[str] = None
    category: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    summary: Optional[str] = None
    source: Optional[str] = None


class TranslateRequest(BaseModel):
    """Translate a form's wording into one language."""
    form_json: Dict[str, Any]
    language: str


class TestSubmissionRequest(BaseModel):
    """A dry run. `form_json` lets the builder test unsaved edits; without it the
    saved definition is used."""
    data: Dict[str, Any]
    form_json: Optional[Dict[str, Any]] = None
    language: Optional[str] = None


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
