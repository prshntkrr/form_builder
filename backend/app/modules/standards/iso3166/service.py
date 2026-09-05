"""ISO 3166-1, in the tables every other standard already uses.

The standards schema says what to do here, in its own words:

    "Deliberately not ICASA-shaped. ICASA is the first one loaded; another
     dictionary is another row in `data_standard` and the same three tables."

So ISO 3166-1 is a row in `data_standard`, three rows in `standard_variable` —
one per code type — and 249 rows in `standard_variable_option` under each:

    data_standard              ISO 3166-1, version 2020
      standard_variable        ISO3166-1:alpha_2   ISO3166-1:alpha_3   …:numeric
        …_option               MX / Mexico          MEX / Mexico        484 / Mexico

Every option carries the whole country in its `metadata`, so choosing one code
type never loses the others:

    {"alpha_2": "MX", "alpha_3": "MEX", "numeric": "484", "name": "Mexico"}

`UNIQUE (variable_id, code)` is already on that table, which is exactly the
uniqueness ISO requires — alpha-2 unique among alpha-2 codes, and so on. **No
schema change and no migration.**

This is a standard, not a catalogue. `client_catalog` holds a client's own
controlled lists — their municipalities, their collaborators — and a country
list belongs to the world rather than to one project. Nothing here writes to
those tables.
"""
import logging
import re
from typing import Any, Dict, List, Optional

from psycopg2.extras import Json

from app.core.database import table_exists, transaction
from app.modules.standards.iso3166.dataset import (
    COUNTRIES, SOURCE, STANDARD_NAME, VERSION,
)

logger = logging.getLogger(__name__)


class DatasetInvalid(ValueError):
    """The dataset would not survive contact with the standard it claims to be."""


# The three code types, as variables of the standard. `external_id` is what a
# saved form stores — a row id means nothing after a re-import.
CODE_TYPES = {
    "alpha_2": {"index": 0, "name": "Alpha-2 code",
                "definition": "Two-letter country code, ISO 3166-1 alpha-2."},
    "alpha_3": {"index": 1, "name": "Alpha-3 code",
                "definition": "Three-letter country code, ISO 3166-1 alpha-3."},
    "numeric": {"index": 2, "name": "Numeric-3 code",
                "definition": "Three-digit country code, ISO 3166-1 numeric. "
                              "A string: 004 is Afghanistan."},
}

DEFAULT_CODE_TYPE = "alpha_2"

SHAPES = {
    "alpha_2": re.compile(r"^[A-Z]{2}$"),
    "alpha_3": re.compile(r"^[A-Z]{3}$"),
    "numeric": re.compile(r"^[0-9]{3}$"),
}


def variable_id_for(code_type: str) -> str:
    return f"ISO3166-1:{code_type}"


# --------------------------------------------------------------------------- #
# the dataset, before it is trusted
# --------------------------------------------------------------------------- #
def validate_dataset(rows=COUNTRIES) -> List[Dict[str, str]]:
    """Every rule the standard imposes, checked before anything is written.

    A bad row stops the import. Skipping it quietly would leave a database that
    looks complete and is not, and a country that silently went missing is
    found months later by somebody who cannot submit a form.
    """
    problems: List[str] = []
    seen: Dict[str, set] = {code_type: set() for code_type in CODE_TYPES}
    countries: List[Dict[str, str]] = []

    for position, row in enumerate(rows, start=1):
        if not isinstance(row, (tuple, list)) or len(row) != 4:
            problems.append(f"row {position}: expected (alpha_2, alpha_3, numeric, name)")
            continue

        alpha_2, alpha_3, numeric, name = row
        country = {"alpha_2": alpha_2, "alpha_3": alpha_3, "numeric": numeric,
                   "name": name}

        for code_type, shape in SHAPES.items():
            value = country[code_type]
            if not isinstance(value, str):
                problems.append(f"row {position}: {code_type} must be a string "
                                f"(got {type(value).__name__})")
                continue
            if not shape.fullmatch(value):
                problems.append(f"row {position}: '{value}' is not a valid {code_type}")
                continue
            if value in seen[code_type]:
                problems.append(f"row {position}: {code_type} '{value}' is used twice")
            seen[code_type].add(value)

        if not isinstance(name, str) or not name.strip():
            problems.append(f"row {position}: a country needs a name")

        countries.append(country)

    if problems:
        raise DatasetInvalid("The ISO 3166-1 dataset is not usable: "
                             + "; ".join(problems[:10])
                             + (f" (and {len(problems) - 10} more)"
                                if len(problems) > 10 else ""))
    return countries


# --------------------------------------------------------------------------- #
# importing it
# --------------------------------------------------------------------------- #
def import_iso3166(rows=COUNTRIES, version: str = VERSION) -> Dict[str, Any]:
    """Put ISO 3166-1 in the standards tables. Idempotent.

    Run at every startup from the module manifest, like every other seed here.
    Running it twice writes the same rows twice and creates nothing new: the
    standard is matched by name, each variable by `(standard, external_id)`, and
    each country by `(variable, code)`.

    A label that has changed is updated in place — ISO renames a country now and
    then, and a stale label is a display bug. A **code** is never rewritten: the
    code is what answers are stored as, and moving one would change what an
    existing submission means.
    """
    countries = validate_dataset(rows)

    with transaction() as cur:
        if not table_exists(cur, "data_standard"):
            # The tables belong to the ICASA module. Switched off, there is
            # nowhere to put this, and saying so is better than creating a
            # parallel home for it.
            logger.warning(
                "ISO 3166-1 not imported: the standards tables are not present "
                "(is the 'icasa' module disabled?)")
            return {"imported": False, "reason": "standards tables absent"}

        cur.execute(
            """
            INSERT INTO data_standard (name, version, source, description)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (name) DO UPDATE
               SET version = EXCLUDED.version,
                   source = EXCLUDED.source,
                   description = EXCLUDED.description
            RETURNING standard_id
            """,
            (STANDARD_NAME, version, SOURCE,
             "Codes for the representation of names of countries and their "
             "subdivisions — Part 1: Country codes. Alpha-2, alpha-3 and "
             "numeric-3. Country level only; ISO 3166-2 and ISO 3166-3 are not "
             "included."),
        )
        standard_id = cur.fetchone()["standard_id"]

        written = 0
        for code_type, described in CODE_TYPES.items():
            cur.execute(
                """
                INSERT INTO standard_variable
                    (standard_id, external_id, code, name, label, definition,
                     data_type, category, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, 'code', 'Country codes', %s)
                ON CONFLICT (standard_id, external_id) DO UPDATE
                   SET name = EXCLUDED.name,
                       label = EXCLUDED.label,
                       definition = EXCLUDED.definition,
                       metadata = EXCLUDED.metadata
                RETURNING variable_id
                """,
                (standard_id, variable_id_for(code_type), code_type,
                 described["name"], described["name"], described["definition"],
                 Json({"code_type": code_type, "iso_part": "ISO 3166-1"})),
            )
            variable_id = cur.fetchone()["variable_id"]

            for country in countries:
                cur.execute(
                    """
                    INSERT INTO standard_variable_option
                        (variable_id, code, label, description, metadata)
                    VALUES (%s, %s, %s, '', %s)
                    ON CONFLICT (variable_id, code) DO UPDATE
                       SET label = EXCLUDED.label,
                           metadata = EXCLUDED.metadata
                    """,
                    (variable_id, country[code_type], country["name"],
                     Json(country)),
                )
                written += 1

    logger.info("ISO 3166-1 %s: %s countries across %s code types",
                version, len(countries), len(CODE_TYPES))
    return {"imported": True, "standard": STANDARD_NAME, "version": version,
            "countries": len(countries), "options": written}


# --------------------------------------------------------------------------- #
# reading it back
# --------------------------------------------------------------------------- #
def _rows(where: str = "", values: tuple = (), limit: Optional[int] = None) -> List[Dict[str, Any]]:
    """Countries, read once from the alpha-2 variable.

    One code type is read rather than three: every option carries the whole
    country in its metadata, so alpha-2 is as good a place to read Mexico from
    as numeric is, and joining three lists to rebuild one country would be work
    to undo work.
    """
    sql = """
        SELECT o.code, o.label, o.metadata, s.version
        FROM   standard_variable_option o
        JOIN   standard_variable v ON v.variable_id = o.variable_id
        JOIN   data_standard s ON s.standard_id = v.standard_id
        WHERE  s.name = %s AND v.external_id = %s
    """
    params: tuple = (STANDARD_NAME, variable_id_for(DEFAULT_CODE_TYPE))

    if where:
        sql += f" AND ({where})"
        params += values

    sql += " ORDER BY o.label"
    if limit:
        sql += " LIMIT %s"
        params += (limit,)

    with transaction() as cur:
        if not table_exists(cur, "standard_variable_option"):
            return []
        cur.execute(sql, params)
        return [_shown(dict(r)) for r in cur.fetchall()]


def _shown(row: Dict[str, Any]) -> Dict[str, Any]:
    country = row["metadata"] or {}
    return {
        "name": row["label"],
        "alpha_2": country.get("alpha_2", ""),
        "alpha_3": country.get("alpha_3", ""),
        "numeric": country.get("numeric", ""),
    }


def countries(search: str = "", limit: Optional[int] = None) -> List[Dict[str, Any]]:
    """Every country, or the ones matching a search.

    Matched in the database, case-insensitively, against the name and all three
    codes — so `mexico`, `MX`, `mex` and `484` all find Mexico. Searching in the
    database rather than in the browser because the list is one place and the
    index is here.
    """
    wanted = (search or "").strip()
    if not wanted:
        return _rows(limit=limit)

    return _rows(
        """
        lower(o.label) LIKE %s
        OR lower(o.metadata ->> 'alpha_2') = %s
        OR lower(o.metadata ->> 'alpha_3') = %s
        OR o.metadata ->> 'numeric' = %s
        """,
        (f"%{wanted.lower()}%", wanted.lower(), wanted.lower(), wanted),
        limit=limit,
    )


def lookup(code: str) -> Optional[Dict[str, Any]]:
    """One country, by any of its three codes. Case-insensitive."""
    wanted = (code or "").strip()
    if not wanted:
        return None

    found = _rows(
        """
        lower(o.metadata ->> 'alpha_2') = %s
        OR lower(o.metadata ->> 'alpha_3') = %s
        OR o.metadata ->> 'numeric' = %s
        """,
        (wanted.lower(), wanted.lower(), wanted),
        limit=1,
    )
    return found[0] if found else None


def options(code_type: str = DEFAULT_CODE_TYPE,
            search: str = "") -> List[Dict[str, str]]:
    """The choices for a field, in the shape every other option source uses.

    `{"value": ..., "label": ...}` — the same as the client catalogue and the
    crop ontology, so the renderer needs no special case. The value is the code
    of the type the field asked for; the label is the country's name.
    """
    if code_type not in CODE_TYPES:
        code_type = DEFAULT_CODE_TYPE

    return [{"value": country[code_type], "label": country["name"]}
            for country in countries(search)]


def is_valid(code_type: str, value: Any) -> bool:
    """Whether one answer is a country code of the type a field asked for.

    Used by the submission service, for fields that explicitly say they are ISO
    3166-1 and for no others. Nothing is inferred from a label: a field called
    "Country" that does not reference the standard is not checked against it.
    """
    if code_type not in CODE_TYPES:
        return False

    wanted = str(value or "").strip()
    if not wanted:
        return False

    column = "o.metadata ->> %s"
    with transaction() as cur:
        if not table_exists(cur, "standard_variable_option"):
            # A standard that cannot be read refuses nothing: a switched-off
            # module must not make an existing form unanswerable.
            return True
        cur.execute(
            f"""
            SELECT 1
            FROM   standard_variable_option o
            JOIN   standard_variable v ON v.variable_id = o.variable_id
            JOIN   data_standard s ON s.standard_id = v.standard_id
            WHERE  s.name = %s AND v.external_id = %s
              AND  ({column} = %s
                    OR ({column} = upper(%s) AND %s <> 'numeric'))
            LIMIT 1
            """,
            (STANDARD_NAME, variable_id_for(code_type), code_type, wanted,
             code_type, wanted, code_type),
        )
        return cur.fetchone() is not None


def summary() -> Dict[str, Any]:
    """What is loaded, for the API and for anybody checking after an import."""
    with transaction() as cur:
        if not table_exists(cur, "data_standard"):
            return {"loaded": False}
        cur.execute("SELECT version, imported_on FROM data_standard WHERE name = %s",
                    (STANDARD_NAME,))
        row = cur.fetchone()

    if row is None:
        return {"loaded": False}
    return {"loaded": True, "standard": STANDARD_NAME, "version": row["version"],
            "imported_on": row["imported_on"], "countries": len(_rows()),
            "code_types": list(CODE_TYPES)}
