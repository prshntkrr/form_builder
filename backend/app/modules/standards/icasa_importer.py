"""Reading the ICASA Data Dictionary into the database.

Source: https://github.com/DSSAT/ICASA-Dictionary, the `CSV/` directory,
vendored unmodified under `data_dictionary/icasa/`.

Five sheets hold variables and share one 20-column header. One sheet holds the
coded values, and links them to a variable through its `Code_Display` column —
which sometimes names several variables at once ("IROP, IAME"), so one code list
can belong to more than one.

Everything the importer stores is read from the files. Nothing about ICASA is
assumed: the units, the data types and the codes are whatever the sheets say.

Re-running is safe. Variables are matched on `var_uid`, the only identifier in
the dictionary that is actually unique — `Code_Display` and `Variable_Name` both
repeat.
"""
import csv
import io
import logging
from pathlib import Path
from typing import Any, Dict, List, Tuple

from psycopg2.extras import Json

from app.core.database import transaction

logger = logging.getLogger(__name__)

STANDARD_NAME = "ICASA"
SOURCE_URL = "https://github.com/DSSAT/ICASA-Dictionary"

# The sheets holding variables. All five share the same header.
VARIABLE_SHEETS = (
    "Measured_data",
    "Management_info",
    "Soils_data",
    "Weather_data",
    "Metadata",
)

# The sheet holding coded values, and the column naming the variable(s) each
# code belongs to. Only Management_codes uses the shape the importer can follow;
# the crop and pest sheets are catalogues in their own right, with their own
# columns, and are left alone.
CODE_SHEET = "Management_codes"
CODE_LINK_COLUMN = "Code_Display"

# A variable whose Unit_or_type says "code" is the kind that has a value list.
CODE_VALUED = "code"


class ImportProblem(RuntimeError):
    """The dictionary could not be read."""


def _read_csv(path: Path) -> List[Dict[str, str]]:
    if not path.exists():
        raise ImportProblem(f"Missing {path.name} — expected in {path.parent}")
    # utf-8-sig: the published files carry a byte-order mark.
    with io.open(path, encoding="utf-8-sig", newline="") as handle:
        return [row for row in csv.DictReader(handle)]


def _clean(value: Any) -> str:
    text = str(value or "").strip()
    # The sheets use a bare "." to mean "nothing here".
    return "" if text == "." else text


def read_directory(directory: Path) -> Tuple[List[Dict[str, Any]], Dict[str, List[Dict[str, str]]]]:
    """Parse the CSVs and return (variables, codes keyed by variable code).

    No database work, so this is the part that can be tested on its own.
    """
    if not directory.exists():
        raise ImportProblem(f"No ICASA directory at {directory}")

    variables = []
    for sheet in VARIABLE_SHEETS:
        for row in _read_csv(directory / f"{sheet}.csv"):
            external_id = _clean(row.get("var_uid"))
            name = _clean(row.get("Variable_Name"))
            if not external_id or not name:
                continue

            variables.append({
                "external_id": external_id,
                "code": _clean(row.get("Code_Display")),
                "name": name,
                # The dictionary has no separate display label, so the variable
                # name in words is the closest honest thing.
                "label": name.replace("_", " "),
                "definition": _clean(row.get("Description")),
                "data_type": _clean(row.get("Data_type")),
                "unit": _clean(row.get("Unit_or_type")),
                "category": " / ".join(
                    p for p in (_clean(row.get("Group")), _clean(row.get("SubGroup"))) if p
                ),
                "metadata": {
                    "sheet": sheet,
                    "dataset": _clean(row.get("Dataset")),
                    "subset": _clean(row.get("Subset")),
                    "code_query": _clean(row.get("Code_Query")),
                    "dssat_synonym": _clean(row.get("DSSAT_synon")),
                    # Published bounds. Recorded, never applied — the rules a
                    # form enforces belong to the application's data dictionary.
                    "min_value": _clean(row.get("MinVal")),
                    "max_value": _clean(row.get("MaxVal")),
                    "version_note": _clean(row.get("Version_or_questions")),
                },
            })

    codes: Dict[str, List[Dict[str, str]]] = {}
    for row in _read_csv(directory / f"{CODE_SHEET}.csv"):
        code = _clean(row.get("Code"))
        if not code:
            continue

        # One code list can serve several variables: "IROP, IAME".
        for variable_code in _clean(row.get(CODE_LINK_COLUMN)).split(","):
            variable_code = variable_code.strip()
            if not variable_code:
                continue
            codes.setdefault(variable_code, []).append({
                "code": code,
                "label": _clean(row.get("Description")) or code,
                "description": _clean(row.get("Usage")),
                "metadata": {
                    "group": _clean(row.get("Group/Topic")),
                    "comment": _clean(row.get("Comment")),
                    "icasa_standard": _clean(row.get("ICASA_standard")),
                },
            })

    return variables, codes


def import_directory(directory: Path, version: str = "") -> Dict[str, Any]:
    """Read the dictionary and bring the database in line with it."""
    variables, codes = read_directory(directory)

    if not variables:
        raise ImportProblem(f"{directory} parsed, but held no variables.")

    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO data_standard (name, version, source, description)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (name) DO UPDATE
                -- Keep the recorded version when this import did not state one.
                -- A plain re-import must not erase which release is loaded:
                -- a saved form's mapping is only interpretable against it.
                SET version = COALESCE(NULLIF(EXCLUDED.version, ''), data_standard.version),
                    source = EXCLUDED.source,
                    imported_on = CURRENT_TIMESTAMP
            RETURNING standard_id
            """,
            (STANDARD_NAME, version, SOURCE_URL,
             "Standardised variables for agricultural field experiments."),
        )
        standard_id = cur.fetchone()["standard_id"]

        cur.execute("SELECT COUNT(*) AS n FROM standard_variable WHERE standard_id = %s",
                    (standard_id,))
        before = int(cur.fetchone()["n"])

        by_code: Dict[str, List[int]] = {}
        for variable in variables:
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
                RETURNING variable_id
                """,
                (standard_id, variable["external_id"], variable["code"][:100],
                 variable["name"][:200], variable["label"][:300], variable["definition"],
                 variable["data_type"][:50], variable["unit"][:100],
                 variable["category"][:200], Json(variable["metadata"])),
            )
            variable_row_id = cur.fetchone()["variable_id"]

            # Only a code-valued variable gets a value list, even if its code
            # appears in the codes sheet for some other reason.
            if variable["unit"].lower() == CODE_VALUED and variable["code"]:
                by_code.setdefault(variable["code"], []).append(variable_row_id)

        cur.execute(
            "SELECT COUNT(*) AS n FROM standard_variable WHERE standard_id = %s",
            (standard_id,),
        )
        after = int(cur.fetchone()["n"])

        options_written = 0
        for variable_code, row_ids in by_code.items():
            for option in codes.get(variable_code, []):
                for row_id in row_ids:
                    cur.execute(
                        """
                        INSERT INTO standard_variable_option
                            (variable_id, code, label, description, metadata)
                        VALUES (%s, %s, %s, %s, %s)
                        ON CONFLICT (variable_id, code) DO UPDATE
                            SET label = EXCLUDED.label,
                                description = EXCLUDED.description,
                                metadata = EXCLUDED.metadata
                        """,
                        (row_id, option["code"][:100], option["label"][:300],
                         option["description"], Json(option["metadata"])),
                    )
                    options_written += 1

        cur.execute(
            """
            SELECT COUNT(*) AS n FROM standard_variable_option o
            JOIN standard_variable v ON v.variable_id = o.variable_id
            WHERE v.standard_id = %s
            """,
            (standard_id,),
        )
        options_total = int(cur.fetchone()["n"])

    summary = {
        "standard": STANDARD_NAME,
        "version": version,
        "variables_in_files": len(variables),
        "variables_added": after - before,
        "code_valued_variables": len(by_code),
        "options_written": options_written,
        "options_total": options_total,
    }

    logger.info(
        "Imported %s: %d variables (%d new), %d code-valued, %d options",
        STANDARD_NAME, summary["variables_in_files"], summary["variables_added"],
        summary["code_valued_variables"], options_total,
    )
    return summary


def loaded() -> List[Dict[str, Any]]:
    """Which standards are in the database, and how big each one is."""
    with transaction() as cur:
        cur.execute(
            """
            SELECT s.standard_id, s.name, s.version, s.source, s.imported_on,
                   COUNT(v.variable_id) AS variables
            FROM   data_standard s
            LEFT JOIN standard_variable v ON v.standard_id = s.standard_id
            GROUP BY s.standard_id
            ORDER BY s.name
            """
        )
        return [dict(row) for row in cur.fetchall()]


def remove(name: str) -> Dict[str, Any]:
    """Drop a standard. Its variables and options go with it, through the
    cascade. Forms keep whatever they already recorded."""
    with transaction() as cur:
        cur.execute("DELETE FROM data_standard WHERE name = %s", (name,))
        removed = cur.rowcount
    logger.info("Removed standard %s", name)
    return {"standard": name, "removed": removed}
