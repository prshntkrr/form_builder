"""The CIMMYT Controlled Vocabulary workbook, as a standard this platform can use.

One common institutional model for Breeding, Agronomy and Socioeconomics. The
workbook has sixteen sheets; four of them carry what a form builder needs:

    03_Variables        what can be measured, of what type, in what unit
    06_Units            what a Unit ID means — `UNIT-HA` is `ha`
    04_Value_Catalogs   the coded lists, as metadata
    05_Catalog_Values   their permitted values, with Parent Code

The other twelve describe the vocabulary's own governance — domains, concepts,
predicates, relationships, issues. Real and useful, and none of it changes what
a question collects, so none of it is read here. `02_Concepts` is the one that
will matter next: it is the meaning layer, which is the ontology module's
question rather than this one's.

Where things land, and why:

    variables   `standard_variable`, under a `data_standard` row named CIMMYT_CV
                — the same three tables ICASA uses. A standard is a row, not a
                special case.

    catalogues  the **client catalogue** tables, not `standard_variable_option`.
                A catalogue is shared between variables and can be hierarchical
                (`Parent Code`), and the client catalogue system already does
                both, resolves them in forms, and ships them in the mobile
                package. Copying the values onto each variable instead would
                duplicate the list and lose the hierarchy.

Nothing here invents a value the workbook did not carry. A variable whose unit
or catalogue cannot be resolved keeps the raw id and is reported, rather than
being quietly given something plausible.
"""
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from psycopg2.extras import Json

from app.core.database import transaction

logger = logging.getLogger(__name__)

STANDARD_NAME = "CIMMYT_CV"

#: Every sheet in the template carries a title, a description and a blank line
#: before the header. Row 4 is the header; the data starts at row 5.
HEADER_ROW = 4

VARIABLES = "03_Variables"
UNITS = "06_Units"
CATALOGS = "04_Value_Catalogs"
CATALOG_VALUES = "05_Catalog_Values"

#: How the workbook's `Data Type` maps onto a question this platform can ask.
#: Only what the template actually uses plus the obvious neighbours; anything
#: unrecognised falls back to text, which is the type that loses nothing.
FIELD_TYPES = {
    "decimal": "decimal",
    "float": "decimal",
    "number": "decimal",
    "integer": "number",
    "int": "number",
    "count": "number",
    "code": "select",
    "categorical": "select",
    "boolean": "select",      # a Yes/No catalogue is a choice, not a checkbox
    "text": "text",
    "string": "text",
    "date": "date",
    "datetime": "datetime",
    "geospatial": "location",
}


class CvWorkbookProblem(ValueError):
    """The workbook cannot be read. The message says what is missing."""


def _text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.lower() in ("nan", "none", "-") else text


def _rows(workbook, sheet: str) -> List[Dict[str, str]]:
    """One sheet as dictionaries keyed by its own headings.

    A sheet the workbook does not have is empty rather than fatal: the optional
    modules are optional, and a template filled in for one domain may carry no
    catalogues at all.
    """
    if sheet not in workbook.sheetnames:
        return []

    rows = list(workbook[sheet].iter_rows(values_only=True))
    if len(rows) < HEADER_ROW:
        return []

    headers = [_text(cell) for cell in rows[HEADER_ROW - 1]]
    found: List[Dict[str, str]] = []

    for row in rows[HEADER_ROW:]:
        record = {
            header: _text(value)
            for header, value in zip(headers, row)
            if header
        }
        if any(record.values()):
            found.append(record)

    return found


def read_workbook(data: bytes) -> Dict[str, Any]:
    """The four sheets that describe what a question collects.

    Returns the variables, and the units and catalogues they refer to, already
    resolved — so the caller stores rows rather than chasing ids.
    """
    import io

    import openpyxl

    try:
        workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as exc:                       # openpyxl raises many shapes
        raise CvWorkbookProblem(
            "That file could not be read as an Excel workbook.") from exc

    try:
        variables = _rows(workbook, VARIABLES)
        units = _rows(workbook, UNITS)
        catalogs = _rows(workbook, CATALOGS)
        values = _rows(workbook, CATALOG_VALUES)
    finally:
        workbook.close()

    if not variables:
        raise CvWorkbookProblem(
            f"'{VARIABLES}' has no rows. This does not look like a CIMMYT "
            "Controlled Vocabulary workbook.")

    return {
        "variables": variables,
        "units": {u["Unit ID"]: u for u in units if u.get("Unit ID")},
        "catalogs": {c["Catalog ID"]: c for c in catalogs if c.get("Catalog ID")},
        "values": values,
        "counts": {
            "variables": len(variables), "units": len(units),
            "catalogs": len(catalogs), "catalog_values": len(values),
        },
    }


def field_type_for(data_type: str, catalog_id: str = "") -> str:
    """The question type a variable asks for.

    A variable with a catalogue is a choice whatever its declared type says —
    the permitted values are the point, and a decimal with a value list would
    be a free number that happens to have suggestions.
    """
    if catalog_id:
        return "select"
    return FIELD_TYPES.get(_text(data_type).lower(), "text")


def _unit_symbol(unit_id: str, units: Dict[str, Dict[str, str]]) -> str:
    """`UNIT-HA` → `ha`, or the id itself when the workbook never defined it."""
    if not unit_id:
        return ""
    row = units.get(unit_id)
    return (row or {}).get("Symbol") or (row or {}).get("Preferred Name") or unit_id


def _catalog_rows(catalog_id: str, values: List[Dict[str, str]]) -> List[Dict[str, str]]:
    return [v for v in values if v.get("Catalog ID") == catalog_id]


def _ensure_standard(cur, version: str = "") -> int:
    """The `data_standard` row, made or refreshed. Returns its id."""
    cur.execute(
        """
        INSERT INTO data_standard (name, version, source, description)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (name) DO UPDATE
            SET version = EXCLUDED.version,
                description = EXCLUDED.description,
                imported_on = CURRENT_TIMESTAMP
        RETURNING standard_id
        """,
        (STANDARD_NAME, version or "v1",
         "CIMMYT Controlled Vocabulary – Common Institutional Template",
         "One institutional model for Breeding, Agronomy and Socioeconomics: "
         "concepts, the variables that measure them, their units and coded values."),
    )
    return cur.fetchone()["standard_id"]


def _write_variable(cur, standard_id: int, row: Dict[str, str], unit: str,
                    origin: str) -> None:
    """One variable, keyed on the id it publishes — so a re-import updates it.

    Takes the workbook's own column names whether it came from the workbook or
    from the form on the CIMMYT page, because the two must produce rows that are
    indistinguishable downstream: the builder, the search and a saved form's
    mapping cannot care which way a variable arrived.
    """
    external_id = row["Variable ID"]
    catalog_id = row.get("Catalog ID", "")

    cur.execute(
        """
        INSERT INTO standard_variable
            (standard_id, external_id, code, name, label, definition,
             data_type, unit, category, metadata)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (standard_id, external_id) DO UPDATE
            SET code = EXCLUDED.code,
                name = EXCLUDED.name,
                label = EXCLUDED.label,
                definition = EXCLUDED.definition,
                data_type = EXCLUDED.data_type,
                unit = EXCLUDED.unit,
                category = EXCLUDED.category,
                metadata = EXCLUDED.metadata
        """,
        (standard_id, external_id, external_id,
         row.get("Preferred Variable Name") or external_id,
         row.get("Preferred Variable Name") or external_id,
         row.get("Operational Definition", ""),
         row.get("Data Type", ""),
         unit,
         row.get("Observation Entity", ""),
         Json({
             # What the builder needs to fill a question in.
             "field_type": field_type_for(row.get("Data Type", ""), catalog_id),
             "catalog_id": catalog_id,
             "unit_id": row.get("Unit ID", ""),
             # Which way it arrived. Only used to decide what may be deleted
             # here: a workbook row is CIMMYT's and is corrected by re-importing.
             "origin": origin,
             # What the vocabulary says about it, kept whole so nothing
             # is lost and a later screen can show it without a re-import.
             "concept_id": row.get("Concept ID", ""),
             "observation_entity": row.get("Observation Entity", ""),
             "measurement_role": row.get("Measurement Role", ""),
             "temporal_basis": row.get("Temporal Basis", ""),
             "reference_period": row.get("Default Reference Period", ""),
             "method": row.get("Collection / Calculation Method", ""),
             "derived": row.get("Derived?", ""),
             "formula_ref": row.get("Formula / Algorithm Ref.", ""),
             "sensitive": row.get("Sensitive Data Class", ""),
             "steward": row.get("Steward", ""),
             "status": row.get("Status", ""),
             "version": row.get("Version", ""),
             "notes": row.get("Notes", ""),
         })),
    )


def import_workbook(data: bytes, version: str = "") -> Dict[str, Any]:
    """Load the workbook. Idempotent: re-importing updates in place.

    Keyed on the ids the workbook publishes — `VAR-000001`, `CAT-YESNO` — so a
    re-import after CIMMYT revises the vocabulary updates the rows a saved form
    already points at, rather than making a second set beside them.

    One transaction: a workbook is a version of a vocabulary, and half of one
    is not a thing anybody should be left with.
    """
    read = read_workbook(data)
    variables = read["variables"]
    units = read["units"]

    catalogues_made: List[str] = []
    unresolved: List[str] = []

    with transaction() as cur:
        standard_id = _ensure_standard(cur, version)

        # ── the coded lists, as client catalogues ────────────────────────────
        for catalog_id, catalog in read["catalogs"].items():
            rows = _catalog_rows(catalog_id, read["values"])
            if not rows:
                continue

            cur.execute(
                """
                INSERT INTO client_catalog
                    (catalog_id, name, description, version, status, source)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (catalog_id) DO UPDATE
                    SET name = EXCLUDED.name,
                        description = EXCLUDED.description,
                        version = EXCLUDED.version,
                        status = EXCLUDED.status,
                        updated_on = CURRENT_TIMESTAMP
                """,
                (catalog_id,
                 catalog.get("Catalog Name") or catalog_id,
                 catalog.get("Definition", ""),
                 catalog.get("Version", ""),
                 catalog.get("Status", ""),
                 f"{STANDARD_NAME} {VARIABLES}"),
            )

            for order, value in enumerate(rows, start=1):
                code = value.get("Code")
                if not code:
                    continue
                cur.execute(
                    """
                    INSERT INTO client_catalog_value
                        (catalog_id, code, label, definition, parent_code,
                         display_order, status, valid_from, valid_to)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (catalog_id, code) DO UPDATE
                        SET label = EXCLUDED.label,
                            definition = EXCLUDED.definition,
                            parent_code = EXCLUDED.parent_code,
                            display_order = EXCLUDED.display_order,
                            status = EXCLUDED.status,
                            valid_from = EXCLUDED.valid_from,
                            valid_to = EXCLUDED.valid_to,
                            updated_on = CURRENT_TIMESTAMP
                    """,
                    (catalog_id, code,
                     value.get("Preferred Label EN", ""),
                     value.get("Definition", ""),
                     value.get("Parent Code") or None,
                     int(value.get("Display Order") or order),
                     value.get("Status", ""),
                     value.get("Valid From", ""),
                     value.get("Valid To", "")),
                )

            catalogues_made.append(catalog_id)

        # ── the variables ────────────────────────────────────────────────────
        kept = 0
        for row in variables:
            external_id = row.get("Variable ID")
            if not external_id:
                continue

            catalog_id = row.get("Catalog ID", "")
            unit_id = row.get("Unit ID", "")
            unit = _unit_symbol(unit_id, units)

            if unit_id and unit == unit_id:
                unresolved.append(f"{external_id}: unit {unit_id}")
            if catalog_id and catalog_id not in read["catalogs"]:
                unresolved.append(f"{external_id}: catalogue {catalog_id}")

            _write_variable(cur, standard_id, row, unit, "workbook")
            kept += 1

    logger.info("Imported %s: %s variables, %s catalogues",
                STANDARD_NAME, kept, len(catalogues_made))

    return {
        "standard": STANDARD_NAME,
        "version": version or "v1",
        "variables": kept,
        "catalogues": catalogues_made,
        "counts": read["counts"],
        # Named rather than swallowed: a unit or catalogue the workbook refers
        # to but never defines is a gap in the workbook, and saying so is more
        # use than inventing a value for it.
        "unresolved": unresolved,
    }


#: Ids for variables typed in here rather than published by CIMMYT. A separate
#: prefix, so a later workbook import can never collide with one and silently
#: overwrite it — the workbook owns `VAR-`, this installation owns `CVAR-`.
MANUAL_PREFIX = "CVAR-"

#: What the form on the CIMMYT page sends, and which workbook column it is. The
#: manual path writes the same row shape as the import, so nothing downstream
#: can tell the two apart.
MANUAL_FIELDS = {
    "name": "Preferred Variable Name",
    "definition": "Operational Definition",
    "data_type": "Data Type",
    "catalog_id": "Catalog ID",
    "observation_entity": "Observation Entity",
    "measurement_role": "Measurement Role",
    "concept_id": "Concept ID",
    "method": "Collection / Calculation Method",
    "status": "Status",
    "version": "Version",
}


def _next_manual_id(cur, standard_id: int) -> str:
    cur.execute(
        """
        SELECT external_id FROM standard_variable
        WHERE  standard_id = %s AND external_id LIKE %s
        ORDER BY length(external_id) DESC, external_id DESC
        LIMIT 1
        """,
        (standard_id, MANUAL_PREFIX + "%"),
    )
    last = cur.fetchone()
    highest = int((last["external_id"][len(MANUAL_PREFIX):] or 0)) if last else 0
    return f"{MANUAL_PREFIX}{highest + 1:06d}"


def save_variable(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Add or edit one variable by hand.

    The other half of `import_workbook`: a vocabulary an institution publishes
    is loaded from its workbook, and the variable this installation needs that
    CIMMYT has not published yet is typed in. Both write the same row.

    Editing is passing `external_id` back — including a `VAR-` one, because
    correcting a workbook variable locally is legitimate. It is worth knowing
    that the next import of that workbook will put CIMMYT's version back.
    """
    name = _text(payload.get("name"))
    if not name:
        raise CvWorkbookProblem("A variable needs a name.")

    unit = _text(payload.get("unit"))
    row = {column: _text(payload.get(key)) for key, column in MANUAL_FIELDS.items()}

    with transaction() as cur:
        standard_id = _ensure_standard(cur)

        external_id = _text(payload.get("external_id"))
        origin = "manual"
        if external_id:
            cur.execute(
                "SELECT metadata FROM standard_variable"
                " WHERE standard_id = %s AND external_id = %s",
                (standard_id, external_id),
            )
            held = cur.fetchone()
            if held:
                # An edited workbook variable stays a workbook variable: it is
                # still CIMMYT's, and re-importing still owns it.
                origin = (held["metadata"] or {}).get("origin") or "workbook"
        else:
            external_id = _next_manual_id(cur, standard_id)

        row["Variable ID"] = external_id
        _write_variable(cur, standard_id, row, unit, origin)

    logger.info("Saved %s variable %s", STANDARD_NAME, external_id)
    return {"external_id": external_id, "origin": origin}


def delete_variable(external_id: str) -> None:
    """Remove a variable that was typed in here.

    A workbook variable is not deletable: it would come back on the next import,
    so the delete would look like it worked and then quietly undo itself. What
    CIMMYT publishes is corrected in the workbook.
    """
    with transaction() as cur:
        cur.execute(
            """
            DELETE FROM standard_variable v
            USING  data_standard s
            WHERE  s.standard_id = v.standard_id
              AND  s.name = %s
              AND  v.external_id = %s
              AND  v.metadata ->> 'origin' = 'manual'
            """,
            (STANDARD_NAME, external_id),
        )
        if not cur.rowcount:
            raise CvWorkbookProblem(
                f"{external_id} is not a variable that was added here. "
                "Variables from the workbook are changed in the workbook.")


def import_file(path: Path, version: str = "") -> Dict[str, Any]:
    """The workbook from disk — for a one-off load or a migration."""
    return import_workbook(Path(path).read_bytes(), version=version)
