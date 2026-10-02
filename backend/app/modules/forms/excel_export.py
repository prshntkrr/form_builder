"""
Export a form definition to an Edit View Excel workbook.

Produces .xlsx compatible with edit_view_import.py so the round trip
Form Builder → Export → Import recreates the same questionnaire.

The columns match what the importer reads:
VARIABLE, FIELD TYPE, REQUIRED, LABEL, OPTIONS, SECTION, LOGIC, HELP TEXT
"""

from __future__ import annotations

import io
import re
from typing import Any, Dict, List, Optional

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter


# Reverse of edit_view_import.TYPE_MAPPING — pick the canonical spelling
# that round-trips cleanly.
EXPORT_TYPE = {
    "text": "text",
    "textarea": "textarea",
    "number": "integer",
    "decimal": "decimal",
    "date": "date",
    "datetime": "datetime",
    "time": "time",
    "boolean": "boolean",
    "select": "select1",
    "multiselect": "select_multiple",
    "radio": "select1",
    "dropdown": "select1",
    "checkbox": "select_multiple",
    "location": "text",
    "file": "text",
    "image": "text",
    "range": "decimal",
    "rating": "integer",
}

HEADERS = [
    "VARIABLE",
    "LABEL",
    "FIELD TYPE",
    "REQUIRED",
    "OPTIONS",
    "SECTION",
    "LOGIC",
    "HELP TEXT",
    "CATALOG",
    "FATHER LIST",
]

HEADER_FILL = PatternFill(start_color="1E3A2F", end_color="1E3A2F", fill_type="solid")
HEADER_FONT = Font(name="Calibri", bold=True, color="FFFFFF", size=11)
CELL_FONT = Font(name="Calibri", size=11)
THIN_BORDER = Border(
    left=Side(style="thin", color="D9D9D9"),
    right=Side(style="thin", color="D9D9D9"),
    top=Side(style="thin", color="D9D9D9"),
    bottom=Side(style="thin", color="D9D9D9"),
)
WRAP = Alignment(vertical="top", wrap_text=True)


def _format_options(field: Dict[str, Any]) -> str:
    """Options as value:label pairs separated by |, matching _split_options."""
    options = field.get("options") or []
    if not options:
        return ""
    parts = []
    for opt in options:
        if isinstance(opt, str):
            parts.append(opt)
        elif isinstance(opt, dict):
            label = opt.get("label", "")
            value = opt.get("value", "")
            if value and label and value != label:
                parts.append(f"{value}:{label}")
            else:
                parts.append(label or value)
    return " | ".join(parts)


def _format_logic(rules: List[Dict[str, Any]], field_name: str) -> str:
    """Reconstruct SHOW IF / HIDE IF text from rules targeting this field."""
    for rule in rules:
        target = rule.get("target", {})
        if target.get("name") != field_name:
            continue
        action = rule.get("action", "show").upper()
        conditions = rule.get("conditions", [])
        if not conditions:
            continue
        c = conditions[0]
        op = c.get("operator", "equals")
        field_ref = c.get("field", "")
        value = c.get("value", "")
        if op == "equals":
            return f"{action} IF {field_ref} IS {value}"
        elif op == "not_equals":
            return f"{action} IF {field_ref} IS NOT {value}"
    return ""


def _section_title(sections: List[Dict[str, Any]], key: str) -> str:
    for s in sections:
        if s.get("key") == key:
            return s.get("title", "")
    return key if key and key != "default_section" else ""


def _field_type_label(field: Dict[str, Any]) -> str:
    """The source type if we have it, otherwise reverse-map our type."""
    source = field.get("source", {})
    if source.get("field_type"):
        return source["field_type"]
    return EXPORT_TYPE.get(field.get("type", "text"), "text")


def export_form(form_json: Dict[str, Any]) -> bytes:
    """Build an .xlsx workbook from a form definition and return the bytes."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Edit view"

    fields = form_json.get("fields") or []
    sections = form_json.get("sections") or []
    rules = form_json.get("rules") or []

    # -- Metadata sheet --
    meta_ws = wb.create_sheet("Metadata")
    meta_data = [
        ("Form Title", form_json.get("title", "")),
        ("Description", form_json.get("description", "")),
        ("Default Language", form_json.get("default_language", "en")),
        ("Version", form_json.get("version", "")),
    ]
    for r, (key, val) in enumerate(meta_data, 1):
        meta_ws.cell(row=r, column=1, value=key).font = Font(bold=True)
        meta_ws.cell(row=r, column=2, value=str(val) if val else "")
    meta_ws.column_dimensions["A"].width = 20
    meta_ws.column_dimensions["B"].width = 50

    # -- Header row --
    for col, header in enumerate(HEADERS, 1):
        cell = ws.cell(row=1, column=col, value=header)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.border = THIN_BORDER
        cell.alignment = Alignment(horizontal="center", vertical="center")

    # -- Data rows --
    sorted_fields = sorted(fields, key=lambda f: f.get("order", 0))

    unsupported = []

    for row_idx, field in enumerate(sorted_fields, 2):
        name = field.get("name", "")
        label = field.get("label", "")
        ftype = _field_type_label(field)
        required = "Yes" if field.get("required") else "No"
        options_text = _format_options(field)
        section_key = field.get("section", "")
        section_label = _section_title(sections, section_key)
        logic = _format_logic(rules, name)
        help_text = field.get("help_text", "") or ""

        # Source-based skip logic (preserved verbatim from import)
        source = field.get("source", {})
        if not logic and source.get("skip_logic"):
            logic = source["skip_logic"]

        catalog = ""
        father = ""
        options_from = field.get("options_from", {})
        if options_from:
            if options_from.get("source") == "client_catalog":
                catalog = options_from.get("catalog", "")
                father = options_from.get("depends_on", "")

        if not catalog and source.get("catalog_id"):
            catalog = source["catalog_id"]
        if not father and source.get("father_list"):
            father = source["father_list"]

        values = [name, label, ftype, required, options_text,
                  section_label, logic, help_text, catalog, father]

        for col, val in enumerate(values, 1):
            cell = ws.cell(row=row_idx, column=col, value=val)
            cell.font = CELL_FONT
            cell.border = THIN_BORDER
            cell.alignment = WRAP

        # Track features that can't be fully represented
        if field.get("validation") and any(field["validation"].values()):
            unsupported.append(f"{name}: validation rules")
        if field.get("default") is not None:
            unsupported.append(f"{name}: default value '{field['default']}'")

    # -- Column widths --
    widths = [25, 40, 14, 10, 35, 20, 35, 30, 18, 18]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w

    # Freeze header row
    ws.freeze_panes = "A2"

    # -- Warnings sheet (if unsupported features exist) --
    if unsupported:
        warn_ws = wb.create_sheet("Export Warnings")
        warn_ws.cell(row=1, column=1, value="Field").font = Font(bold=True)
        warn_ws.cell(row=1, column=2, value="Warning").font = Font(bold=True)
        for r, warning in enumerate(unsupported, 2):
            if ": " in warning:
                fname, msg = warning.split(": ", 1)
                warn_ws.cell(row=r, column=1, value=fname)
                warn_ws.cell(row=r, column=2, value=msg)
            else:
                warn_ws.cell(row=r, column=1, value=warning)
        warn_ws.column_dimensions["A"].width = 25
        warn_ws.column_dimensions["B"].width = 50

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
