"""The canonical form-definition schema, plus the normalizer that every form
definition passes through before it is trusted.

An LLM is a helpful but unreliable author: it invents field types, emits
duplicate or SQL-hostile column names, and forgets options on a dropdown. Nothing
reaches Postgres until it has been through `normalize_form`.

Canonical shape:

{
  "title": "Farmer Registration",
  "description": "...",
  "table_name": "farmer_registration",
  "submit_label": "Submit",
  "success_message": "Thanks!",
  "sections": [{"key": "sec_1", "title": "Basic details", "description": ""}],
  "fields": [
    {
      "name": "farmer_name",          # snake_case -> Postgres column
      "label": "Farmer Name",
      "type": "text",
      "required": true,
      "placeholder": "",
      "help_text": "",
      "default": null,
      "section": "sec_1",
      "options": [{"label": "Yes", "value": "yes"}],
      "validation": {"min": null, "max": null, "min_length": null,
                     "max_length": null, "pattern": null, "step": null},
      "order": 1
    }
  ]
}

A field's "name" is the key its answer takes inside the `form_data` JSONB
column — it is not a column of its own. Every form table has the same six
envelope columns; see ENVELOPE_COLUMNS below.
"""
import re
from typing import Any, Dict, List, Optional

from app.modules.forms.constants import (
    MAX_DESCRIPTION,
    MAX_HELP_TEXT,
    MAX_LABEL,
    MAX_OPTION_LABEL,
    MAX_PLACEHOLDER,
    MAX_SECTION_TITLE,
)
from app.modules.forms.field_types import get_type, normalize_type
from app.modules.forms.translations import (
    DEFAULT_LANGUAGE,
    SUPPORTED_LANGUAGES,
    normalize_translations,
)

MAX_IDENTIFIER = 55  # leaves headroom under Postgres' 63-byte NAMEDATALEN limit

# How long a question's key may be.
#
# Longer than an identifier, because it is not one: a key is where the answer
# sits in the `form_data` JSONB, what a rule names, what the layout and the
# WhatsApp config point at, and what the mobile package sends back. None of
# those is a Postgres name, and none of them is bounded at 63 bytes.
#
# The one place a key did become a Postgres name is the flat `<form>_tabular`
# reporting mirror, which has one column per question. That is now a mapping
# (`tabular_service.column_for`) rather than the key itself: a key of 55
# characters or fewer is still its own column, exactly as before, and a longer
# one gets a shortened, deterministic column beside the full key in `form_data`.
MAX_FIELD_NAME = 150

# Field names that would read ambiguously next to the envelope columns — a
# `form_data ->> 'created_on'` sitting beside a real `created_on` column invites
# the wrong query.
RESERVED_FIELD_NAMES = {
    "survey_id", "form_id", "form_data", "created_on", "form_version", "created_by",
}

# Types whose answer is stored as text, so a regex `pattern` rule can be matched
# against it. On anything else a pattern is never applied.
PATTERN_TYPES = {"text", "textarea", "email", "phone", "url", "signature", "file"}

# Table names Postgres or this application already owns.
RESERVED_TABLE_NAMES = {
    "forms", "form_version", "user", "table", "select", "order", "group",
    "default", "check", "column", "constraint", "references", "values",
}

# Every generated form table has exactly these columns, mirroring the existing
# `survey_form_data` table. survey_id is the primary key; all answers live in
# form_data.
ENVELOPE_COLUMNS: List[tuple] = [
    ("survey_id", "VARCHAR(50)"),
    ("form_id", "VARCHAR(20)"),
    ("form_data", "JSONB"),
    ("created_on", "TIMESTAMP"),
    ("form_version", "INTEGER"),
    ("created_by", "VARCHAR(50)"),
]


# A child form's table carries one more envelope column: which submission of
# its parent form this row belongs to. It is not in ENVELOPE_COLUMNS because
# only a child form has it — an independent form's table is exactly what it
# always was — but it is reserved everywhere a field name is, so no answer can
# ever be stored under it.
PARENT_COLUMN = "parent_survey_id"

# Where a submission's own position is stored, for a form that collects one.
# Like PARENT_COLUMN: only forms that ask for it get the column, so every other
# form's table is exactly the shape it has always been.
LOCATION_COLUMN = "location"


class FormSchemaError(ValueError):
    """The definition is unusable even after normalization."""


# --------------------------------------------------------------------------- #
# identifiers
# --------------------------------------------------------------------------- #
def slugify_identifier(text: str, fallback: str = "field",
                       limit: int = MAX_IDENTIFIER) -> str:
    """Turn arbitrary text into a safe, lowercase identifier.

    `limit` is what this is going to be: a Postgres name (the default, 55) or a
    question's key (`MAX_FIELD_NAME`), which is a JSON key and may be longer.
    """
    ident = re.sub(r"[^a-z0-9]+", "_", str(text or "").strip().lower())
    ident = re.sub(r"_+", "_", ident).strip("_")
    if not ident:
        return fallback  # an empty fallback is the caller's way of saying "no value"
    if ident[0].isdigit():
        ident = f"f_{ident}"  # Postgres identifiers may not start with a digit
    return ident[:limit].rstrip("_") or fallback


def safe_field_name(raw: str, taken: set, fallback: str = "field") -> str:
    """Unique, non-reserved key for a field inside `form_data`.

    Bounded by `MAX_FIELD_NAME`, not by the Postgres identifier limit: this is a
    JSON key. Uniqueness is unchanged — a second question that would take the
    same key gets `_2`, `_3`, … and the base is shortened to make room.
    """
    name = slugify_identifier(raw, fallback, MAX_FIELD_NAME)
    if name in RESERVED_FIELD_NAMES:
        name = f"{name}_value"
    base, n = name, 2
    while name in taken:
        suffix = f"_{n}"
        name = f"{base[:MAX_FIELD_NAME - len(suffix)]}{suffix}"
        n += 1
    taken.add(name)
    return name


def derive_table_name(title: str, explicit: Optional[str] = None) -> str:
    """Table name for a form. An explicit name from the LLM wins if it is usable,
    otherwise the title is slugified: 'Survey Form Data' -> survey_form_data."""
    candidate = slugify_identifier(explicit or "", "") or slugify_identifier(title, "form")
    if candidate in RESERVED_TABLE_NAMES:
        candidate = f"{candidate}_form"
    return candidate


# --------------------------------------------------------------------------- #
# normalization
# --------------------------------------------------------------------------- #
def _normalize_options(raw: Any) -> List[Dict[str, str]]:
    """Accept ['A','B'] or [{'label':..,'value':..}] or {'A':'a'}; emit the
    canonical list of {label, value}."""
    if not raw:
        return []
    items: List[Any]
    if isinstance(raw, dict):
        items = [{"label": k, "value": v} for k, v in raw.items()]
    elif isinstance(raw, str):
        items = [p.strip() for p in re.split(r"[,\n|]", raw) if p.strip()]
    elif isinstance(raw, list):
        items = raw
    else:
        return []

    options: List[Dict[str, str]] = []
    seen = set()
    for item in items:
        if isinstance(item, dict):
            label = item.get("label") or item.get("text") or item.get("name") or item.get("value")
            value = item.get("value") if item.get("value") is not None else label
        else:
            label = value = item
        if label is None:
            continue
        label = str(label).strip()[:MAX_OPTION_LABEL]
        value = str(value).strip()[:MAX_OPTION_LABEL]
        if not label or not value or value in seen:
            continue
        seen.add(value)

        option = {"label": label, "value": value}
        if isinstance(item, dict):
            # An option pulled from an ontology carries the concept it came
            # from, so a stored answer can be traced back to a URI without
            # anything extra being written alongside the response.
            if item.get("ontology_uri"):
                option["ontology_uri"] = str(item["ontology_uri"]).strip()
            # `parent_code` is how a client's catalog nests one list under
            # another. Dropping it would lose a relationship this application
            # has no way to re-derive.
            if item.get("parent_code"):
                option["parent_code"] = str(item["parent_code"]).strip()
            if item.get("description"):
                option["description"] = str(item["description"]).strip()
        options.append(option)
    return options


def _normalize_validation(raw: Any, ftype: str) -> Dict[str, Any]:
    """Repair the rules on one field.

    A rule that cannot be applied is dropped rather than kept: an unsatisfiable
    range or an uncompilable pattern would otherwise be silently ignored at
    submission time, which looks like the rule working when it is not. Dropping
    it here is also what keeps `config_validation` able to reject the same
    things without rejecting anything the normalizer produces.
    """
    raw = raw if isinstance(raw, dict) else {}
    keys = ("min", "max", "min_length", "max_length", "pattern", "step")
    out: Dict[str, Any] = {}
    for key in keys:
        value = raw.get(key)
        if value in ("", None):
            continue
        if key in ("min", "max", "step"):
            try:
                out[key] = float(value) if "." in str(value) else int(value)
            except (TypeError, ValueError):
                continue
        elif key in ("min_length", "max_length"):
            try:
                length = int(value)
            except (TypeError, ValueError):
                continue
            if length >= 1:
                out[key] = length
        else:
            out[key] = str(value)

    if ftype == "rating":
        out.setdefault("min", 1)
        out.setdefault("max", int(out.get("max") or 5))

    spec = get_type(ftype)
    if spec.json_type != "number":
        # Value bounds only ever compare numbers.
        out.pop("min", None)
        out.pop("max", None)
        out.pop("step", None)
    if ftype not in PATTERN_TYPES:
        out.pop("pattern", None)
    if "pattern" in out:
        try:
            re.compile(out["pattern"])
        except re.error:
            out.pop("pattern")

    if out.get("min") is not None and out.get("max") is not None and out["min"] > out["max"]:
        out.pop("max")
    if (
        out.get("min_length") is not None
        and out.get("max_length") is not None
        and out["min_length"] > out["max_length"]
    ):
        out.pop("max_length")
    return out


def field_name(field: Any) -> str:
    """The canonical name of a field, whatever key it arrived under.

    Everything saved through `create_form` is normalized, so `name` is always
    there. A definition written straight into Postgres — a seed, a fixture, a
    hand-edited row — may still carry `key` or `id`, which the input contract
    accepts. Read paths use this so one such row cannot 500 a page.
    """
    if not isinstance(field, dict):
        return ""
    for key in ("name", "key", "id"):
        value = field.get(key)
        if value:
            return str(value)
    label = field.get("label") or field.get("title") or field.get("question")
    return slugify_identifier(str(label), "field") if label else ""


def _normalize_field(raw: Any, index: int, taken: set) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None

    label = str(
        raw.get("label") or raw.get("title") or raw.get("question") or raw.get("name") or ""
    ).strip()
    name_source = raw.get("name") or raw.get("key") or raw.get("id") or label
    if not label and not name_source:
        return None

    ftype = normalize_type(raw.get("type") or raw.get("field_type") or raw.get("input_type"))
    spec = get_type(ftype)
    name = safe_field_name(str(name_source), taken, fallback=f"field_{index + 1}")
    label = label or name.replace("_", " ").title()

    options = _normalize_options(raw.get("options") or raw.get("choices") or raw.get("values"))
    options_from = _normalize_options_from(raw.get("options_from"))

    if spec.has_options and not options and not options_from:
        # A dropdown with no choices is unusable — degrade to free text rather
        # than shipping a broken control. Two exceptions: a field that names a
        # source, whose choices are read when the form is drawn; and one an
        # import says is a controlled list, where a text box would be a wrong
        # answer rather than a lesser one.
        if not declares_controlled_list(raw):
            ftype, spec = "text", get_type("text")

    default = raw.get("default") if raw.get("default") not in ("", None) else None
    if default is not None and options:
        # A default the field would reject on submission is worse than none.
        allowed = {o["value"] for o in options}
        chosen = default if isinstance(default, list) else [default]
        if any(str(v) not in allowed for v in chosen):
            default = None

    field: Dict[str, Any] = {
        "name": name,
        "label": _cut(label, MAX_LABEL),
        "type": ftype,
        "required": bool(raw.get("required") or raw.get("is_required")),
        "placeholder": _cut(raw.get("placeholder"), MAX_PLACEHOLDER),
        "help_text": _cut(
            raw.get("help_text") or raw.get("helpText") or raw.get("hint"), MAX_HELP_TEXT),
        "default": default,
        "section": slugify_identifier(raw.get("section") or "", "") or None,
        "options": options,
        "validation": _normalize_validation(raw.get("validation"), ftype),
        # Per-question settings, always present so every reader can ask without
        # checking first. A definition written before this existed has none,
        # and gets `hide: false` here — which is what it always meant.
        "config": _normalize_field_config(raw),
        "order": index + 1,
    }

    # Two optional, independent mappings. Both are separate from everything
    # above: a standard says what a field *is* or is *called*; the rules above
    # say how it must *behave*. A field with neither behaves exactly as before.
    #
    # Each records the standard's own identifier — a URI, a variable id — never a
    # database row id. This definition is versioned JSONB that outlives any
    # particular import, and re-importing renumbers rows but never identifiers.
    concept = _normalize_semantic_concept(raw)
    if concept:
        field["semantic_concept"] = concept

    standard = _normalize_data_standard(raw.get("data_standard"))
    if standard:
        field["data_standard"] = standard

    crop = _normalize_crop_ontology(raw.get("crop_ontology"))
    if crop:
        field["crop_ontology"] = crop

    if options_from:
        field["options_from"] = options_from

    # The unit answers are given in, when the form author says so outright.
    # Only ever what somebody wrote: nothing here guesses a unit, and where this
    # is absent the standardization step falls back to the Crop Ontology scale.
    input_unit = str(raw.get("input_unit") or "").strip()
    if input_unit:
        field["input_unit"] = input_unit

    # Where this field came from, when it was imported rather than written here.
    # Carried through untouched: it records the client's own variable id, their
    # catalog and their skip logic, and this application is not its author.
    source = raw.get("source")
    if isinstance(source, dict) and source:
        field["source"] = source

    source = str(raw.get("option_source") or "").strip().lower()
    if source in ("ontology", "standard") and (concept or standard):
        field["option_source"] = source

    # A polygon question carries its boundary in the definition.
    #
    # This function rebuilds every field from the fixed list above, so anything
    # not named here is dropped — which is exactly what happened to a ring
    # drawn in the builder: it saved, and came back gone. Only for a polygon
    # field, so no other type can smuggle a `coordinates` key into a form.
    if ftype == "polygon":
        ring = _normalize_ring(raw.get("coordinates"))
        if ring:
            field["coordinates"] = ring
        # Whether the person filling the form in may redraw it. Creator-defined
        # and read-only is the default: a boundary somebody drew is usually the
        # question, not the answer.
        field["editable"] = bool(raw.get("editable"))

    return field


def _cut(text: Any, limit: int) -> str:
    """Text as it will be stored: stripped, and no longer than it may be.

    The normalizer repairs rather than refuses — `validate_config` is what tells
    somebody their question is too long, and it uses the same numbers (see
    `constants`). Cutting here is what keeps that promise for the definitions
    nobody types: an LLM's, an import's.
    """
    return str(text or "").strip()[:limit]


def _normalize_field_config(raw: Dict[str, Any]) -> Dict[str, Any]:
    """A question's settings: `{"hide": bool}`, however it was written.

    `config.hide` is where it belongs; a flat `hide` beside the label is taken
    too, because that is the shorter thing to write and both an import and a
    model reach for it.
    """
    given = raw.get("config")
    given = given if isinstance(given, dict) else {}
    hide = given.get("hide") if "hide" in given else raw.get("hide")
    return {"hide": bool(hide)}


def field_hidden(field: Any) -> bool:
    """Whether this question is hidden outright, whatever the answers are.

    The one place that reads the flag. Everything else — the form page, the
    submission service, what a channel can ask — goes through
    `conditions.hidden`, which folds this in with the rules.
    """
    if not isinstance(field, dict):
        return False
    config = field.get("config")
    if isinstance(config, dict) and "hide" in config:
        return bool(config["hide"])
    return bool(field.get("hide"))


def _normalize_semantic_concept(raw: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """What this field means, as an ontology concept.

    Also accepts the flat `ontology_concept_uri` / `ontology_concept_label` this
    used to be written as, so a definition saved before the nested shape still
    reads correctly.
    """
    nested = raw.get("semantic_concept")
    if isinstance(nested, dict):
        uri = str(nested.get("uri") or "").strip()
        if uri:
            return {
                "standard": str(nested.get("standard") or "SEOnt").strip(),
                "uri": uri,
                "label": str(nested.get("label") or "").strip(),
            }
        return None

    uri = str(raw.get("ontology_concept_uri") or "").strip()
    if not uri:
        return None
    return {
        "standard": "SEOnt",
        "uri": uri,
        "label": str(raw.get("ontology_concept_label") or "").strip(),
    }


# Where a field's choices are read from, when the form does not carry them.
CROP_ONTOLOGY_SOURCE = "crop_ontology"
CLIENT_CATALOG_SOURCE = "client_catalog"
DATA_STANDARD_SOURCE = "data_standard"

# What a `data_standard` source may name. One entry per standard whose values a
# field can be drawn from — a name the caller sends is looked up here and never
# used to reach a module, so a field cannot ask for something arbitrary.
STANDARD_SOURCES = {
    "ISO_3166_1": {"label": "ISO 3166-1 (countries)",
                   "code_types": ("alpha_2", "alpha_3", "numeric"),
                   "default_code_type": "alpha_2"},
}

OPTION_SOURCES = (CROP_ONTOLOGY_SOURCE, CLIENT_CATALOG_SOURCE, DATA_STANDARD_SOURCE)


def _normalize_options_from(raw: Any) -> Optional[Dict[str, str]]:
    """A field whose choices are read when the form is drawn.

    Some answers are a list the application already holds — which crops exist,
    which traits belong to one, which municipalities the client recognises — and
    a form should not carry a stale copy of it.

    Three sources, each naming what to read:

        {"source": "crop_ontology",  "kind": "trait",  "depends_on": "crop"}
        {"source": "client_catalog", "catalog": "Municipios_mx_list",
                                     "depends_on": "rcl_estado_colaborador_c"}
        {"source": "data_standard",  "standard": "ISO_3166_1",
                                     "code_type": "alpha_2"}

    A `data_standard` field draws its choices from a published standard rather
    than from anybody's own list — ISO 3166-1's countries, for instance. Which
    standards may be named is `STANDARD_SOURCES` above, so the name is looked up
    rather than used to reach anything; `code_type` says which of the standard's
    code sets the answer is stored as, and for ISO 3166-1 that defaults to
    alpha-2, so choosing Mexico stores "MX".

    `depends_on` names another field on the same form. Crop traits are only
    meaningful once a crop is chosen, and a municipality only once a state is,
    so the list is fetched again whenever that answer changes.
    """
    if not isinstance(raw, dict):
        return None

    source = str(raw.get("source") or "").strip()
    if source not in OPTION_SOURCES:
        return None

    described: Dict[str, str] = {"source": source}

    if source == DATA_STANDARD_SOURCE:
        standard = str(raw.get("standard") or "").strip().upper()
        described_standard = STANDARD_SOURCES.get(standard)
        if described_standard is None:
            return None
        described["standard"] = standard

        code_type = str(raw.get("code_type") or "").strip()
        if code_type not in described_standard["code_types"]:
            code_type = described_standard["default_code_type"]
        described["code_type"] = code_type

    elif source == CLIENT_CATALOG_SOURCE:
        # The client's catalog id, exactly as their workbook spells it — it is
        # the key into their own tables, so it is never slugified.
        catalog = str(raw.get("catalog") or raw.get("catalog_id") or "").strip()
        if not catalog:
            return None
        described["catalog"] = catalog

        # Which of the catalogue's values this field offers, when it offers only
        # some. Codes, never labels: a code is what an answer stores and what
        # the client's systems recognise, so a label corrected tomorrow reaches
        # this field on its own. Absent means the whole list — which is what
        # every field written before this says, and what most say now.
        allowed = _normalize_allowed_values(raw.get("allowed_values"))
        if allowed:
            described["allowed_values"] = allowed
    else:
        kind = str(raw.get("kind") or "").strip()
        if not kind:
            return None
        described["kind"] = kind

    depends_on = slugify_identifier(raw.get("depends_on") or "", "")
    if depends_on:
        described["depends_on"] = depends_on
    return described


def _normalize_allowed_values(raw: Any) -> List[str]:
    """The subset of a catalogue a field offers, as stable codes.

    Order is the author's and is kept; duplicates are not, because a code twice
    is one value. An empty list normalizes away entirely rather than being
    stored — "offer none of them" is not a thing anybody means, and a field
    carrying it would be a dropdown nobody could answer.
    """
    if not isinstance(raw, (list, tuple)):
        return []

    seen = set()
    codes = []
    for value in raw:
        code = str(value if value is not None else "").strip()
        if code and code not in seen:
            seen.add(code)
            codes.append(code)
    return codes


def declares_controlled_list(raw: Any) -> bool:
    """Whether the field was imported as a controlled list we cannot yet see.

    A workbook can declare a field a dropdown and keep its permitted values
    somewhere this application has not been given — a catalog not imported yet.
    The honest reading is still a dropdown: turning it into a text box would
    silently accept anything, and inventing the missing values is worse.
    """
    if not isinstance(raw, dict):
        return False
    source = raw.get("source")
    return isinstance(source, dict) and bool(source.get("controlled_list"))


def _normalize_crop_ontology(raw: Any) -> Optional[Dict[str, str]]:
    """Which crop-specific variable this field measures.

    Crop Ontology's own identifiers throughout — `CO_322:0000996`, not a row id.
    `ontology_id` and `variable_id` must both be present: without the crop the
    variable is meaningless, since every crop has its own.
    """
    if not isinstance(raw, dict):
        return None

    ontology_id = str(raw.get("ontology_id") or "").strip()
    variable_id = str(raw.get("variable_id") or "").strip()
    if not ontology_id or not variable_id:
        return None

    def text(key: str) -> str:
        return str(raw.get(key) or "").strip()

    mapping = {
        "standard": text("standard") or "CropOntology",
        "ontology_id": ontology_id,
        "ontology_version": text("ontology_version"),
        "crop": text("crop"),
        "variable_id": variable_id,
        "variable_name": text("variable_name"),
    }
    # Trait, method and scale are the structure Crop Ontology is built on, but
    # a hand-written mapping may name only the variable.
    for key in ("trait_id", "trait_name", "method_id", "method_name",
                "scale_id", "scale_name", "scale_data_type"):
        value = text(key)
        if value:
            mapping[key] = value
    return mapping


def _normalize_data_standard(raw: Any) -> Optional[Dict[str, str]]:
    """Which standardised variable this field collects.

    `variable_id` is the standard's published identifier — ICASA's var_uid — and
    is the one part that must be there: without it the mapping cannot be looked
    up again after the dictionary is re-imported or re-versioned.
    """
    if not isinstance(raw, dict):
        return None

    variable_id = str(raw.get("variable_id") or "").strip()
    if not variable_id:
        return None

    return {
        "standard": str(raw.get("standard") or "").strip() or "ICASA",
        "standard_version": str(raw.get("standard_version") or "").strip(),
        "variable_id": variable_id,
        "variable_code": str(raw.get("variable_code") or "").strip(),
        "variable_name": str(raw.get("variable_name") or "").strip(),
        "unit": str(raw.get("unit") or "").strip(),
        "data_type": str(raw.get("data_type") or "").strip(),
    }


def _normalize_sections(raw: Any, fields: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    sections: List[Dict[str, Any]] = []
    seen = set()
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, str):
            item = {"title": item}
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or item.get("name") or "").strip()
        if not title:
            continue
        key = slugify_identifier(item.get("key") or title, "section")
        if key in seen:
            continue
        seen.add(key)
        sections.append(
            {"key": key, "title": title[:MAX_SECTION_TITLE],
             "description": str(item.get("description") or "").strip()[:MAX_DESCRIPTION]}
        )

    # Fields may reference a section by its title; re-point them at the key, and
    # drop references to sections that do not exist.
    by_key = {s["key"] for s in sections}
    for f in fields:
        if f["section"] and f["section"] not in by_key:
            f["section"] = None
    return sections


def normalize_form(raw: Any, fallback_title: str = "Untitled Form") -> Dict[str, Any]:
    """Validate + repair a form definition. Raises FormSchemaError if hopeless."""
    if not isinstance(raw, dict):
        raise FormSchemaError("Form definition must be a JSON object")

    # Some models wrap the payload: {"form": {...}} / {"schema": {...}}
    for wrapper in ("form", "form_json", "schema", "definition"):
        if wrapper in raw and isinstance(raw[wrapper], dict) and "fields" not in raw:
            raw = raw[wrapper]
            break

    raw_fields = raw.get("fields") or raw.get("questions") or raw.get("elements") or []
    if not isinstance(raw_fields, list) or not raw_fields:
        raise FormSchemaError("Form definition must contain at least one field")

    taken: set = set()
    fields: List[Dict[str, Any]] = []
    for i, item in enumerate(raw_fields):
        normalized = _normalize_field(item, i, taken)
        if normalized:
            normalized["order"] = len(fields) + 1
            fields.append(normalized)

    if not fields:
        raise FormSchemaError("No usable fields could be read from the form definition")

    title = str(raw.get("title") or raw.get("form_title") or fallback_title).strip()[:200]
    sections = _normalize_sections(raw.get("sections"), fields)

    # Which questions apply, given the answers so far. Cleaned here so a
    # definition can never carry a rule the renderer would choke on; a form with
    # none — every form built before this existed — is unaffected.
    from app.modules.forms import conditions
    rules = conditions.normalize_rules(raw.get("rules"))

    # The words this form can be shown in. The field names never change with the
    # language, so a translated form still writes to the same columns.
    # An imported form is written in whatever language the client wrote it in,
    # and that is never changed here.
    declared = str(raw.get("default_language") or "").strip().lower()
    default_language = declared if declared in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE

    translated_words = normalize_translations(raw.get("translations"), default_language)
    languages = _normalize_languages(
        raw.get("languages"), translated_words, default_language
    )

    # The model fills this in when the prompt names an author ("created by admin").
    # It is only a suggestion — an explicit created_by on the request wins.
    author = str(raw.get("created_by") or raw.get("author") or "").strip()[:50]

    # Where this definition came from, if it started life in the standard form
    # library. Carried through every edit so drift can be measured later.
    standard_id = slugify_identifier(raw.get("standard_id") or "", "") or None
    try:
        standard_version = int(raw["standard_version"]) if standard_id else None
    except (KeyError, TypeError, ValueError):
        standard_version = None

    form = {
        "title": title or fallback_title,
        "description": _cut(raw.get("description") or raw.get("form_description"),
                            MAX_DESCRIPTION),
        "table_name": derive_table_name(title, raw.get("table_name")),
        "created_by": author or None,
        "standard_id": standard_id,
        "standard_version": standard_version,
        "submit_label": str(raw.get("submit_label") or "Submit").strip()[:50],
        "success_message": str(
            raw.get("success_message") or "Your response has been recorded."
        ).strip()[:200],
        "sections": sections,
        "fields": fields,
        "rules": rules,
        "languages": languages,
        "default_language": default_language,
        "translations": translated_words,
    }

    imported = raw.get("import_source")
    if isinstance(imported, dict) and imported:
        # Which file and which profile this definition was read from.
        form["import_source"] = imported

    # Absent for an independent form, so a definition saved before this existed
    # normalizes to exactly the bytes it had before.
    relationship = _normalize_relationship(raw.get("relationship"))
    if relationship:
        form["relationship"] = relationship

    # Same rule for both: a form that does not ask carries neither key.
    location = _normalize_location(raw.get("location"))
    if location:
        form["location"] = location

    geofence = _normalize_geofence(raw.get("geofence"))
    if geofence:
        form["geofence"] = geofence

    # Where each question sits on the page. Absent for a form nobody has laid
    # out — every form built before this existed — so those definitions
    # normalize to exactly the bytes they had before.
    layout = _normalize_layout(raw.get("layout"), fields)
    if layout:
        form["layout"] = layout

    # Which channels this form is open to. Absent for a form that never said —
    # every form built before this existed — so it normalizes to the bytes it
    # had and takes the defaults (web and mobile open, whatsapp and ivr closed).
    # Only known channels and a boolean `enabled` survive: nothing arbitrary
    # rides along in a definition that is published and handed to phones.
    #
    # A form built for one channel (`channel`: web_mobile, whatsapp or ivr)
    # carries the profile that choice implies, derived here every time so the
    # two can never disagree. A legacy form — no `channel` — keeps its profile
    # exactly as it was.
    from app.modules.forms import channel_config
    from app.modules.forms.channels import (
        normalize_form_channel, normalize_profile, profile_for,
    )
    built_for = normalize_form_channel(raw.get("channel"))
    if built_for:
        form["channel"] = built_for
        form["channels"] = profile_for(built_for)
    else:
        channels = normalize_profile(raw.get("channels"))
        if channels:
            form["channels"] = channels

    # How the form is presented on its channel. Kept whatever the channel, so
    # nothing configured is ever lost; it only has an effect on its own channel.
    presented = channel_config.normalize(raw.get("channel_config"))
    if presented:
        form["channel_config"] = presented

    return form


# --------------------------------------------------------------------------- #
# layout
# --------------------------------------------------------------------------- #
#: Twelve columns, so a width reads as a fraction of the row: 6 is half, 4 is a
#: third, 12 is all of it.
LAYOUT_COLUMNS = 12


def _layout_width(raw: Any) -> int:
    """A width as a whole number of columns, 1 to 12. Anything else is 12."""
    if isinstance(raw, bool):
        return LAYOUT_COLUMNS
    try:
        width = int(float(raw))
    except (TypeError, ValueError):
        return LAYOUT_COLUMNS
    return max(1, min(LAYOUT_COLUMNS, width))


def _layout_id(raw: Any, fallback: str, taken: set) -> str:
    """A stable, unique id for a section or a row.

    Kept to letters, digits, `-` and `_`, because it becomes a React key and a
    DOM attribute; made unique by suffix, because two rows with one id would be
    one row to anything that reads them back.
    """
    text = "".join(
        ch if (ch.isalnum() or ch in "-_") else "-"
        for ch in str(raw or "").strip()
    )[:64].strip("-")
    base = text or fallback

    candidate, n = base, 2
    while candidate in taken:
        candidate = f"{base}-{n}"
        n += 1

    taken.add(candidate)
    return candidate


def _normalize_layout(raw: Any, fields: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Where each question sits: sections, holding rows, holding fields.

        {"sections": [
            {"id": "farmer", "title": "Farmer Information", "description": "",
             "containers": [
                 {"id": "farmer-row-1",
                  "fields": [{"fieldId": "farmer_name", "width": 6},
                             {"fieldId": "mobile", "width": 6}]}]}]}

    The layout *references* questions by their `name` — the same key their
    answers are stored under — and never carries a copy of one. So a question
    has one definition, in `fields`, however it is laid out.

    Lenient on shape, strict on meaning. Anything that is not the right kind of
    thing is skipped rather than refusing the whole form; a reference to a
    question this form does not have is dropped; and a question placed twice
    keeps its first place only. Order is kept exactly as given.

    A question the layout does not mention is **not** removed. It stays in
    `fields`, and the renderer shows it after everything that was placed —
    leaving a question out of the layout must never be a way to lose it.
    """
    if not isinstance(raw, dict):
        return None

    raw_sections = raw.get("sections")
    if not isinstance(raw_sections, list):
        return None

    names = {field["name"] for field in fields}
    placed: set = set()
    section_ids: set = set()
    container_ids: set = set()
    sections: List[Dict[str, Any]] = []

    for s_index, raw_section in enumerate(raw_sections):
        if not isinstance(raw_section, dict):
            continue

        section_id = _layout_id(
            raw_section.get("id"), f"section-{s_index + 1}", section_ids)

        containers: List[Dict[str, Any]] = []
        raw_containers = raw_section.get("containers")

        for c_index, raw_container in enumerate(
                raw_containers if isinstance(raw_containers, list) else []):
            if not isinstance(raw_container, dict):
                continue

            cells: List[Dict[str, Any]] = []
            raw_cells = raw_container.get("fields")

            for raw_cell in raw_cells if isinstance(raw_cells, list) else []:
                if not isinstance(raw_cell, dict):
                    continue

                name = str(raw_cell.get("fieldId") or "").strip()
                if name not in names or name in placed:
                    continue

                placed.add(name)
                cells.append({"fieldId": name,
                              "width": _layout_width(raw_cell.get("width"))})

            # An empty row is kept: it is somewhere to drop a question, and the
            # designer that makes one expects to find it again.
            containers.append({
                "id": _layout_id(raw_container.get("id"),
                                 f"{section_id}-row-{c_index + 1}", container_ids),
                "fields": cells,
            })

        section: Dict[str, Any] = {
            "id": section_id,
            "title": str(raw_section.get("title") or "").strip()[:200],
            "containers": containers,
        }

        description = str(raw_section.get("description") or "").strip()
        if description:
            section["description"] = description[:1000]

        sections.append(section)

    if not sections:
        return None

    layout: Dict[str, Any] = {"sections": sections}

    # Whether the builder derived this layout from the form's own sections
    # rather than somebody arranging it. A derived one is rebuilt when the
    # sections change; an arranged one is left alone. Absent means arranged,
    # which is what every layout saved before this was.
    if raw.get("auto") is True:
        layout["auto"] = True

    return layout


RELATIONSHIP_TYPES = ("independent", "child")


def _normalize_location(raw: Any) -> Optional[Dict[str, bool]]:
    """Whether this form asks where it was filled in.

        {"enabled": true, "required": false}

    Absent for a form that does not ask — which is every form built before this
    existed. Collecting a position and *fencing* it are two different things and
    are stored separately; see `_normalize_geofence`.
    """
    if not isinstance(raw, dict) or not raw.get("enabled"):
        return None

    return {"enabled": True, "required": bool(raw.get("required"))}


def _ring_points(raw: Any) -> List[List[float]]:
    """The valid [longitude, latitude] pairs in whatever was given.

    Lenient on purpose — a point that is not a pair of numbers, or is off the
    globe, is dropped rather than refusing the whole definition. Callers decide
    what too few points means: a geofence normalizes away, and a polygon field
    keeps no coordinates at all.
    """
    points: List[List[float]] = []

    for point in raw or []:
        try:
            lng, lat = float(point[0]), float(point[1])
        except (TypeError, ValueError, IndexError):
            continue
        if -180 <= lng <= 180 and -90 <= lat <= 90:
            points.append([lng, lat])

    return points


def _normalize_ring(raw: Any) -> Optional[List[List[float]]]:
    """A polygon field's own boundary, as drawn in the builder.

    Three points at the least, and closed — the last repeats the first — so
    whatever draws or measures it afterwards does not have to close it itself.
    """
    points = _ring_points(raw)

    if len(points) < 3:
        return None

    if points[0] != points[-1]:
        points.append(list(points[0]))

    return points


def _normalize_geofence(raw: Any) -> Optional[Dict[str, Any]]:
    """The area a submission has to be inside, if there is one.

        {"enabled": true, "polygon": [[lng, lat], [lng, lat], [lng, lat]]}

    `[longitude, latitude]`, the GeoJSON order, so the ring can be handed to
    anything that reads GeoJSON without being flipped first.

    A ring of fewer than three points encloses nothing, so it normalizes away:
    a fence nobody can be inside would refuse every submission.
    """
    if not isinstance(raw, dict) or not raw.get("enabled"):
        return None

    ring = _ring_points(raw.get("polygon"))

    if len(ring) < 3:
        return None

    # Deliberately not closed here. A fence is read by `point_in_ring`, which
    # treats the ring as closed whether or not its last point repeats its
    # first — and every fence already stored is open, so closing them now
    # would rewrite definitions that work.
    return {"enabled": True, "polygon": ring}


def collects_location(form_json: Any) -> bool:
    """Whether this form asks where it was filled in."""
    if not isinstance(form_json, dict):
        return False
    return bool((form_json.get("location") or {}).get("enabled"))


def location_required(form_json: Any) -> bool:
    if not isinstance(form_json, dict):
        return False
    return bool((form_json.get("location") or {}).get("required"))


def geofence_of(form_json: Any) -> Optional[Dict[str, Any]]:
    """The ring a submission has to be inside, or None."""
    if not isinstance(form_json, dict):
        return None
    fence = form_json.get("geofence")
    if isinstance(fence, dict) and fence.get("enabled") and fence.get("polygon"):
        return fence
    return None


def _normalize_relationship(raw: Any) -> Optional[Dict[str, str]]:
    """Whether this form's submissions hang off another form's.

        {"type": "child", "parent_form_id": "FRM00001"}

    None for an independent form, which is every form built before this existed
    and every form nobody has said otherwise about. Stored in the definition
    beside `rules` and `standard_id` rather than in a table of its own: it is
    part of what the form *is*, it is versioned with the rest of the definition,
    and a rollback should take it with everything else.

    Only the shape is checked here. Whether that parent exists, is reachable,
    and does not close a loop is `forms/relationships.py` — those need the
    database and the account asking, and normalization has neither.
    """
    if not isinstance(raw, dict):
        return None

    kind = str(raw.get("type") or raw.get("relationship") or "").strip().lower()
    parent = str(raw.get("parent_form_id") or raw.get("parent") or "").strip()

    if kind != "child" or not parent:
        # "independent", nothing, or a child with no parent named — all of which
        # mean the same thing: this form stands on its own.
        return None

    return {"type": "child", "parent_form_id": parent}


def is_child(form_json: Any) -> bool:
    """Whether this definition says its submissions belong to another form's."""
    return bool(parent_form_id(form_json))


def parent_form_id(form_json: Any) -> Optional[str]:
    """The form this one's submissions hang off, or None."""
    if not isinstance(form_json, dict):
        return None
    relationship = form_json.get("relationship")
    if not isinstance(relationship, dict):
        return None
    if str(relationship.get("type") or "").lower() != "child":
        return None
    return str(relationship.get("parent_form_id") or "").strip() or None


def _normalize_languages(raw: Any, translations: Dict[str, Any],
                         default: str = DEFAULT_LANGUAGE) -> List[str]:
    """The languages a form offers, default first and no duplicates.

    A language that has translations is always included, even if nobody listed
    it — otherwise a translation somebody added would be invisible.
    """
    languages = [default]

    if isinstance(raw, list):
        for code in raw:
            if code in SUPPORTED_LANGUAGES and code not in languages:
                languages.append(code)

    for code in translations:
        if code not in languages:
            languages.append(code)

    return languages
