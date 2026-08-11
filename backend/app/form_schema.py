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

from .field_types import get_type, normalize_type

MAX_IDENTIFIER = 55  # leaves headroom under Postgres' 63-byte NAMEDATALEN limit

# Field names that would read ambiguously next to the envelope columns — a
# `form_data ->> 'created_on'` sitting beside a real `created_on` column invites
# the wrong query.
RESERVED_FIELD_NAMES = {
    "survey_id", "form_id", "form_data", "created_on", "form_version", "created_by",
}

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


class FormSchemaError(ValueError):
    """The definition is unusable even after normalization."""


# --------------------------------------------------------------------------- #
# identifiers
# --------------------------------------------------------------------------- #
def slugify_identifier(text: str, fallback: str = "field") -> str:
    """Turn arbitrary text into a safe, lowercase SQL identifier."""
    ident = re.sub(r"[^a-z0-9]+", "_", str(text or "").strip().lower())
    ident = re.sub(r"_+", "_", ident).strip("_")
    if not ident:
        return fallback  # an empty fallback is the caller's way of saying "no value"
    if ident[0].isdigit():
        ident = f"f_{ident}"  # Postgres identifiers may not start with a digit
    return ident[:MAX_IDENTIFIER].rstrip("_") or fallback


def safe_field_name(raw: str, taken: set, fallback: str = "field") -> str:
    """Unique, non-reserved key for a field inside `form_data`."""
    name = slugify_identifier(raw, fallback)
    if name in RESERVED_FIELD_NAMES:
        name = f"{name}_value"
    base, n = name, 2
    while name in taken:
        suffix = f"_{n}"
        name = f"{base[:MAX_IDENTIFIER - len(suffix)]}{suffix}"
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
        label, value = str(label).strip(), str(value).strip()
        if not label or value in seen:
            continue
        seen.add(value)
        options.append({"label": label, "value": value})
    return options


def _normalize_validation(raw: Any, ftype: str) -> Dict[str, Any]:
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
                out[key] = int(value)
            except (TypeError, ValueError):
                continue
        else:
            out[key] = str(value)
    if ftype == "rating":
        out.setdefault("min", 1)
        out.setdefault("max", int(out.get("max") or 5))
    return out


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
    if spec.has_options and not options:
        # A dropdown with no choices is unusable — degrade to free text rather
        # than shipping a broken control.
        ftype, spec = "text", get_type("text")

    field: Dict[str, Any] = {
        "name": name,
        "label": label,
        "type": ftype,
        "required": bool(raw.get("required") or raw.get("is_required")),
        "placeholder": str(raw.get("placeholder") or "").strip(),
        "help_text": str(raw.get("help_text") or raw.get("helpText") or raw.get("hint") or "").strip(),
        "default": raw.get("default") if raw.get("default") not in ("", None) else None,
        "section": slugify_identifier(raw.get("section") or "", "") or None,
        "options": options,
        "validation": _normalize_validation(raw.get("validation"), ftype),
        "order": index + 1,
    }
    return field


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
            {"key": key, "title": title, "description": str(item.get("description") or "").strip()}
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

    # The model fills this in when the prompt names an author ("created by admin").
    # It is only a suggestion — an explicit created_by on the request wins.
    author = str(raw.get("created_by") or raw.get("author") or "").strip()[:50]

    return {
        "title": title or fallback_title,
        "description": str(raw.get("description") or raw.get("form_description") or "").strip(),
        "table_name": derive_table_name(title, raw.get("table_name")),
        "created_by": author or None,
        "submit_label": str(raw.get("submit_label") or "Submit").strip()[:50],
        "success_message": str(
            raw.get("success_message") or "Your response has been recorded."
        ).strip()[:200],
        "sections": sections,
        "fields": fields,
    }
