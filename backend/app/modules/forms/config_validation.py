"""Two-stage validation for a form definition — the config object of this app.

A form definition arrives from one of two places: an LLM (`/generate`,
`/refine`) or a client posting JSON directly. Before it is persisted it passes
through:

    incoming config
          │
          ▼
    stage 1  structural   Pydantic — shape, types, nesting, enums
          │
          ├── invalid ──▶ ConfigValidationError(type="structural")
          ▼
    stage 2  business     cross-field and cross-entity rules
          │
          ├── invalid ──▶ ConfigValidationError(type="business_rule")
          ▼
    validated config ──▶ normalize_form ──▶ persist

The two stages are deliberately separate: structural validation is about the
document, business validation is about whether the document describes a form
this application can actually run. Business rules never see a malformed
document, so they can assume every field is present and correctly typed.

Both stages are pure. Facts that need the database — which forms exist, for
instance — are gathered by the service layer and passed in as `BusinessContext`,
so this module is testable without one, in the same way `form_schema` and
`field_types` are.

Note the relationship with `form_schema.normalize_form`, which *repairs* a
definition rather than rejecting it. That leniency exists for LLM output and is
kept. The guarantee tying the two together, asserted in the tests, is:

    validate_config(normalize_form(anything))   always succeeds

so nothing this pipeline rejects can be produced by the normalizer.
"""
import re
from dataclasses import dataclass, field as dc_field
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from app.modules.forms.constants import FORM_STATUSES, FORM_TYPES
from app.modules.forms.field_types import get_type, resolve_type, SUPPORTED_TYPES
from app.modules.forms.form_schema import (
    MAX_IDENTIFIER,
    RESERVED_FIELD_NAMES,
    RESERVED_TABLE_NAMES,
    slugify_identifier,
)

STRUCTURAL = "structural"
BUSINESS_RULE = "business_rule"

# Column widths in `forms`; a definition that exceeds them cannot be stored.
MAX_TITLE = 200
MAX_SUBMIT_LABEL = 50
MAX_SUCCESS_MESSAGE = 200


# --------------------------------------------------------------------------- #
# errors
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ValidationIssue:
    """One thing wrong with a config, and which stage found it."""

    type: str          # STRUCTURAL | BUSINESS_RULE
    field: str         # dotted path into the config, e.g. "fields.2.options"
    message: str

    def as_dict(self) -> Dict[str, str]:
        return {"type": self.type, "field": self.field, "message": self.message}


class ConfigValidationError(ValueError):
    """Raised when a config fails either stage. Carries every issue found."""

    def __init__(self, issues: Sequence[ValidationIssue]):
        self.issues: List[ValidationIssue] = list(issues)
        super().__init__("; ".join(f"{i.field}: {i.message}" for i in self.issues))

    @property
    def stage(self) -> str:
        return self.issues[0].type if self.issues else STRUCTURAL

    def as_payload(self) -> Dict[str, Any]:
        """The response body shape used by the API."""
        return {"valid": False, "errors": [i.as_dict() for i in self.issues]}


# --------------------------------------------------------------------------- #
# stage 1 — structural
# --------------------------------------------------------------------------- #
class _Config(BaseModel):
    # Unknown keys are dropped rather than rejected, matching `normalize_form`
    # and the pydantic-settings usage in `config.py`.
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


class OptionConfig(_Config):
    label: str = Field(min_length=1)
    value: str = Field(min_length=1)

    @model_validator(mode="before")
    @classmethod
    def _accept_the_shorthands(cls, data: Any) -> Any:
        """`"Canal"` and `{"label": "Canal"}` are both an option, per
        `_normalize_options`. Whichever half is given supplies the other."""
        if isinstance(data, (str, int, float)) and not isinstance(data, bool):
            return {"label": str(data), "value": str(data)}
        if isinstance(data, dict):
            label = data.get("label") or data.get("text") or data.get("name") or data.get("value")
            value = data.get("value") if data.get("value") is not None else label
            return {"label": label, "value": value}
        return data


class ValidationRules(_Config):
    min: Optional[float] = None
    max: Optional[float] = None
    min_length: Optional[int] = Field(default=None, ge=1)
    max_length: Optional[int] = Field(default=None, ge=1)
    pattern: Optional[str] = None
    step: Optional[float] = None


class SectionConfig(_Config):
    key: Optional[str] = Field(default=None, max_length=MAX_IDENTIFIER)
    title: str = Field(min_length=1, validation_alias=AliasChoices("title", "name"))
    description: str = ""

    @model_validator(mode="before")
    @classmethod
    def _accept_a_bare_title(cls, data: Any) -> Any:
        return {"title": data} if isinstance(data, str) else data

    @model_validator(mode="after")
    def _key_defaults_to_the_title(self) -> "SectionConfig":
        if not self.key:
            self.key = slugify_identifier(self.title, "section")
        return self


class FieldConfig(_Config):
    """One question.

    The incoming contract is the one `normalize_form` already accepts: the key
    may arrive as `name`, `key` or `id`, and either the key or the label may be
    left out and derived from the other. What is *given* still has to be usable —
    an explicit key that is not a valid identifier is a client bug, not
    something to quietly slugify.
    """

    name: Optional[str] = Field(
        default=None, max_length=MAX_IDENTIFIER,
        validation_alias=AliasChoices("name", "key", "id"),
    )
    label: Optional[str] = Field(
        default=None, validation_alias=AliasChoices("label", "title", "question"))
    type: str = Field(
        default="text", validation_alias=AliasChoices("type", "field_type", "input_type"))
    required: bool = Field(
        default=False, validation_alias=AliasChoices("required", "is_required"))
    placeholder: str = ""
    help_text: str = Field(
        default="", validation_alias=AliasChoices("help_text", "helpText", "hint"))
    default: Any = None
    section: Optional[str] = None
    options: List[OptionConfig] = Field(
        default_factory=list, validation_alias=AliasChoices("options", "choices", "values"))
    validation: ValidationRules = Field(default_factory=ValidationRules)
    order: Optional[int] = None

    @field_validator("options", mode="before")
    @classmethod
    def _split_a_delimited_list(cls, data: Any) -> Any:
        """`"Canal, Borewell"` is a list of options, per `_normalize_options`."""
        if isinstance(data, str):
            return [p.strip() for p in re.split(r"[,\n|]", data) if p.strip()]
        if isinstance(data, dict):
            return [{"label": k, "value": v} for k, v in data.items()]
        return data or []

    @field_validator("name")
    @classmethod
    def _is_an_identifier(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not re.fullmatch(r"[a-z][a-z0-9_]*", value):
            raise ValueError(
                "must be lowercase snake_case, start with a letter, and contain "
                "only letters, digits and underscores"
            )
        return value

    @field_validator("type")
    @classmethod
    def _is_a_supported_type(cls, value: str) -> str:
        resolved = resolve_type(value)
        if resolved is None:
            raise ValueError(f"'{value}' is not a supported field type ({', '.join(SUPPORTED_TYPES)})")
        return resolved

    @model_validator(mode="after")
    def _resolve_identity(self) -> "FieldConfig":
        """Fill in whichever of key/label was left out, the same way the
        normalizer does, so every business rule can rely on both."""
        if not self.name and not self.label:
            raise ValueError("a question needs a name or a label")
        if not self.name:
            self.name = slugify_identifier(self.label, "field")
        if not self.label:
            self.label = self.name.replace("_", " ").title()
        return self


class FormConfig(_Config):
    """A whole form definition.

    Accepts exactly what `normalize_form` accepts — the same property aliases and
    the same wrapper keys — so a client written against the existing contract is
    not rejected by the addition of this pipeline.
    """

    # Optional because `normalize_form` supplies a default, as it does for a
    # form loaded from an older row that predates this pipeline.
    title: str = Field(
        default="Untitled Form", min_length=1, max_length=MAX_TITLE,
        validation_alias=AliasChoices("title", "form_title"))
    description: str = Field(
        default="", validation_alias=AliasChoices("description", "form_description"))
    table_name: Optional[str] = Field(default=None, max_length=MAX_IDENTIFIER)
    submit_label: str = Field(default="Submit", max_length=MAX_SUBMIT_LABEL)
    success_message: str = Field(default="", max_length=MAX_SUCCESS_MESSAGE)
    created_by: Optional[str] = Field(default=None, max_length=50)
    version: Optional[int] = Field(default=None, ge=1)
    # Provenance, when the form started from the standard form library.
    standard_id: Optional[str] = Field(default=None, max_length=MAX_IDENTIFIER)
    standard_version: Optional[int] = Field(default=None, ge=1)
    sections: List[SectionConfig] = dc_field(default_factory=list)
    fields: List[FieldConfig] = Field(
        min_length=1, validation_alias=AliasChoices("fields", "questions", "elements"))

    @model_validator(mode="before")
    @classmethod
    def _unwrap(cls, data: Any) -> Any:
        """Some models wrap the payload: {"form": {...}}."""
        if isinstance(data, dict) and "fields" not in data:
            for wrapper in ("form", "form_json", "schema", "definition"):
                inner = data.get(wrapper)
                if isinstance(inner, dict):
                    return inner
        return data

    @field_validator("sections", mode="before")
    @classmethod
    def _tolerate_a_missing_list(cls, data: Any) -> Any:
        return data or []


def _path(location: Iterable[Any]) -> str:
    parts = [str(p) for p in location if p != "__root__"]
    return ".".join(parts) or "config"


def validate_structure(raw: Any) -> FormConfig:
    """Stage 1. Shape, types, nesting and enums. Raises ConfigValidationError."""
    if not isinstance(raw, dict):
        raise ConfigValidationError(
            [ValidationIssue(STRUCTURAL, "config", "The form config must be a JSON object")]
        )

    try:
        return FormConfig.model_validate(raw)
    except ValidationError as exc:
        issues = [
            ValidationIssue(STRUCTURAL, _path(err["loc"]), err["msg"].replace("Value error, ", ""))
            for err in exc.errors()
        ]
        raise ConfigValidationError(issues) from exc


# --------------------------------------------------------------------------- #
# stage 2 — business rules
# --------------------------------------------------------------------------- #
@dataclass
class BusinessContext:
    """Facts a rule needs that the config cannot supply on its own.

    Populated by the service layer so this module stays free of database access.
    """

    form_id: Optional[str] = None
    form_type: str = "parent"
    parent_id: Optional[str] = None
    form_status: str = "Active"
    known_form_ids: Sequence[str] = ()
    # Standard form ids the library currently offers. Empty means "not checked",
    # so a caller that does not care need not load the library.
    known_standard_ids: Sequence[str] = ()


Rule = Callable[[FormConfig, BusinessContext], List[ValidationIssue]]



def _issue(field: str, message: str) -> ValidationIssue:
    return ValidationIssue(BUSINESS_RULE, field, message)


def unique_field_names(config: FormConfig, _: BusinessContext) -> List[ValidationIssue]:
    """Every answer is stored under its field name, so two fields sharing one
    would overwrite each other."""
    seen: Dict[str, int] = {}
    issues = []
    for i, f in enumerate(config.fields):
        if f.name in seen:
            issues.append(_issue(
                f"fields.{i}.name",
                f"Field names must be unique — '{f.name}' is already used by "
                f"question {seen[f.name] + 1}",
            ))
        else:
            seen[f.name] = i
    return issues


def field_names_are_not_reserved(config: FormConfig, _: BusinessContext) -> List[ValidationIssue]:
    """The response table owns these names; a field using one would be ambiguous
    in every query against it."""
    return [
        _issue(f"fields.{i}.name",
               f"'{f.name}' is reserved by the response table — choose another key")
        for i, f in enumerate(config.fields)
        if f.name in RESERVED_FIELD_NAMES
    ]


def choice_fields_have_options(config: FormConfig, _: BusinessContext) -> List[ValidationIssue]:
    """A dropdown with nothing to choose from cannot be answered."""
    issues = []
    for i, f in enumerate(config.fields):
        if get_type(f.type).has_options and not f.options:
            issues.append(_issue(
                f"fields.{i}.options",
                f"'{f.label}' is a {f.type} field and needs at least one option",
            ))
    return issues


def option_values_are_unique(config: FormConfig, _: BusinessContext) -> List[ValidationIssue]:
    """Answers are stored by option value, so duplicates are indistinguishable."""
    issues = []
    for i, f in enumerate(config.fields):
        seen = set()
        for j, option in enumerate(f.options):
            if option.value in seen:
                issues.append(_issue(
                    f"fields.{i}.options.{j}.value",
                    f"'{f.label}' has more than one option with the value '{option.value}'",
                ))
            seen.add(option.value)
    return issues


def default_is_an_available_option(config: FormConfig, _: BusinessContext) -> List[ValidationIssue]:
    """A default the field will reject on submission is worse than none."""
    issues = []
    for i, f in enumerate(config.fields):
        if not f.options or f.default in (None, "", []):
            continue
        allowed = {o.value for o in f.options}
        chosen = f.default if isinstance(f.default, list) else [f.default]
        missing = [str(v) for v in chosen if str(v) not in allowed]
        if missing:
            issues.append(_issue(
                f"fields.{i}.default",
                f"'{f.label}' defaults to '{missing[0]}', which is not one of its options",
            ))
    return issues


def sections_referenced_exist(config: FormConfig, _: BusinessContext) -> List[ValidationIssue]:
    """A field pointing at a section that was never declared would not render."""
    declared = {s.key for s in config.sections}
    return [
        _issue(f"fields.{i}.section",
               f"'{f.label}' refers to section '{f.section}', which is not declared")
        for i, f in enumerate(config.fields)
        if f.section and f.section not in declared
    ]


def section_keys_are_unique(config: FormConfig, _: BusinessContext) -> List[ValidationIssue]:
    seen = set()
    issues = []
    for i, s in enumerate(config.sections):
        if s.key in seen:
            issues.append(_issue(f"sections.{i}.key", f"Section key '{s.key}' is used twice"))
        seen.add(s.key)
    return issues


def ranges_are_ordered(config: FormConfig, _: BusinessContext) -> List[ValidationIssue]:
    """A range whose floor is above its ceiling can never be satisfied."""
    issues = []
    for i, f in enumerate(config.fields):
        rules = f.validation
        if rules.min is not None and rules.max is not None and rules.min > rules.max:
            issues.append(_issue(
                f"fields.{i}.validation",
                f"'{f.label}' has a smallest value ({rules.min:g}) above its "
                f"largest ({rules.max:g})",
            ))
        if (
            rules.min_length is not None
            and rules.max_length is not None
            and rules.min_length > rules.max_length
        ):
            issues.append(_issue(
                f"fields.{i}.validation",
                f"'{f.label}' has a minimum length ({rules.min_length}) above its "
                f"maximum ({rules.max_length})",
            ))
    return issues


def patterns_compile(config: FormConfig, _: BusinessContext) -> List[ValidationIssue]:
    """An uncompilable pattern is silently skipped at submission time, which
    looks like the rule working when it is not.

    Note what is deliberately *not* a rule here: a rule aimed at the wrong type,
    such as `min`/`max` on a phone field or a `pattern` on a number. Those are
    inert rather than wrong, `normalize_form` drops them, and real forms in this
    database contain them — rejecting them would make existing forms uneditable.
    """
    issues = []
    for i, f in enumerate(config.fields):
        pattern = f.validation.pattern
        if not pattern:
            continue
        try:
            re.compile(pattern)
        except re.error as exc:
            issues.append(_issue(
                f"fields.{i}.validation.pattern",
                f"'{f.label}' has an invalid pattern: {exc}",
            ))
    return issues


def table_name_is_usable(config: FormConfig, _: BusinessContext) -> List[ValidationIssue]:
    if not config.table_name:
        return []
    if config.table_name in RESERVED_TABLE_NAMES:
        return [_issue("table_name", f"'{config.table_name}' is a reserved table name")]
    if not re.fullmatch(r"[a-z][a-z0-9_]*", config.table_name):
        return [_issue(
            "table_name",
            f"'{config.table_name}' is not a valid table name — lowercase letters, "
            f"digits and underscores, starting with a letter",
        )]
    return []


def standard_reference_is_valid(config: FormConfig, ctx: BusinessContext) -> List[ValidationIssue]:
    """A form citing a standard it did not come from cannot be compared against
    one, and `diff_against_standard` would have nothing to diff."""
    if not config.standard_id:
        if config.standard_version is not None:
            return [_issue(
                "standard_version",
                "A standard version was given without naming the standard form it refers to",
            )]
        return []

    if ctx.known_standard_ids and config.standard_id not in ctx.known_standard_ids:
        return [_issue(
            "standard_id",
            f"'{config.standard_id}' is not in the standard form library",
        )]
    return []


def parent_reference_is_valid(config: FormConfig, ctx: BusinessContext) -> List[ValidationIssue]:
    """`forms.parent_id` is a foreign key to `forms.form_id`, and the form_type
    check constraint only allows parent/child."""
    issues = []
    if ctx.form_type not in FORM_TYPES:
        issues.append(_issue(
            "form_type", f"Form type must be one of {', '.join(FORM_TYPES)}"))
    if ctx.form_status not in FORM_STATUSES:
        issues.append(_issue(
            "form_status", f"Form status must be one of {', '.join(FORM_STATUSES)}"))

    if ctx.parent_id:
        if ctx.parent_id == ctx.form_id:
            issues.append(_issue("parent_id", "A form cannot be its own parent"))
        elif ctx.known_form_ids and ctx.parent_id not in ctx.known_form_ids:
            issues.append(_issue(
                "parent_id", f"Parent form '{ctx.parent_id}' does not exist"))
    elif ctx.form_type == "child":
        issues.append(_issue("parent_id", "A child form must name its parent form"))

    return issues


# Ordered so the most fundamental problems are reported first. Add a rule by
# writing a function above and listing it here.
BUSINESS_RULES: List[Rule] = [
    unique_field_names,
    field_names_are_not_reserved,
    choice_fields_have_options,
    option_values_are_unique,
    default_is_an_available_option,
    section_keys_are_unique,
    sections_referenced_exist,
    ranges_are_ordered,
    patterns_compile,
    table_name_is_usable,
    standard_reference_is_valid,
    parent_reference_is_valid,
]


def validate_business(
    config: FormConfig, context: Optional[BusinessContext] = None
) -> FormConfig:
    """Stage 2. Every rule runs, so one call reports every problem."""
    ctx = context or BusinessContext()
    issues: List[ValidationIssue] = []
    for rule in BUSINESS_RULES:
        issues.extend(rule(config, ctx))
    if issues:
        raise ConfigValidationError(issues)
    return config


# --------------------------------------------------------------------------- #
# the pipeline
# --------------------------------------------------------------------------- #
def validate_config(raw: Any, context: Optional[BusinessContext] = None) -> FormConfig:
    """Run both stages. Stage 2 only runs if stage 1 passed."""
    config = validate_structure(raw)
    return validate_business(config, context)
