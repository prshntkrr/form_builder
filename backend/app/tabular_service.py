"""The flat `<form>_tabular` mirror.

Every form gets two tables:

    <form>            survey_id, form_id, form_data (JSONB), created_on, ...
    <form>_tabular    survey_id, form_id, created_on, ..., one column per question

The JSONB table is the record of truth — it holds every answer ever submitted,
in the shape it was submitted in. The tabular table is a *projection* of it,
built for people who want to point a reporting tool at a normal table:

    SELECT village, AVG(land_area) FROM farmer_registration_tabular GROUP BY village;

That relationship is what makes schema changes safe. When a question is removed
its column is dropped, and when a type changes the column is rebuilt — both
destroy nothing, because `rebuild` can reconstruct the whole mirror from
`form_data` at any time.
"""
import logging
from typing import Any, Dict, List, Optional, Tuple

from psycopg2 import sql
from psycopg2.extras import execute_batch

from .config import settings
from .field_types import coerce_value, flatten, pg_type_for
from .form_schema import MAX_IDENTIFIER
from .table_service import ensure_foreign_key, existing_columns, fk_name, table_exists

logger = logging.getLogger(__name__)

SUFFIX = "_tabular"

# Mirrors the JSONB table's envelope, minus form_data itself.
ENVELOPE: List[Tuple[str, str]] = [
    ("survey_id", "VARCHAR(50) NOT NULL PRIMARY KEY"),
    ("form_id", "VARCHAR(20) NOT NULL"),
    ("created_on", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
    ("form_version", "INTEGER"),
    ("created_by", "VARCHAR(50)"),
]
ENVELOPE_NAMES = {name for name, _ in ENVELOPE}


def tabular_name(table_name: str) -> str:
    """`farmer_registration` -> `farmer_registration_tabular`."""
    return f"{table_name[:MAX_IDENTIFIER - len(SUFFIX)]}{SUFFIX}"


def _q(table_name: str) -> sql.Composed:
    return sql.SQL("{}.{}").format(
        sql.Identifier(settings.db_schema), sql.Identifier(table_name)
    )


def _field_columns(form_json: Dict[str, Any]) -> List[Tuple[str, str]]:
    """(column, type) for each question, skipping any that would shadow the
    envelope — `form_schema` already keeps those names clear."""
    return [
        (f["name"], pg_type_for(f["type"]))
        for f in form_json.get("fields") or []
        if f["name"] not in ENVELOPE_NAMES
    ]


# --------------------------------------------------------------------------- #
# structure
# --------------------------------------------------------------------------- #
def create(cur, form_json: Dict[str, Any]) -> str:
    source = form_json["table_name"]
    name = tabular_name(source)
    columns = [
        sql.SQL("{} {}").format(sql.Identifier(c), sql.SQL(t)) for c, t in ENVELOPE
    ] + [
        sql.SQL("{} {}").format(sql.Identifier(c), sql.SQL(t))
        for c, t in _field_columns(form_json)
    ]

    # Two relationships, both declared so they show up in an ERD: every row
    # belongs to a form, and mirrors exactly one row of the JSONB table.
    columns.append(
        sql.SQL("CONSTRAINT {} FOREIGN KEY (form_id) REFERENCES {} (form_id)").format(
            sql.Identifier(fk_name(name, "form_id")), _q("forms")
        )
    )
    columns.append(
        sql.SQL(
            "CONSTRAINT {} FOREIGN KEY (survey_id) REFERENCES {} (survey_id) ON DELETE CASCADE"
        ).format(sql.Identifier(fk_name(name, "survey_id")), _q(source))
    )

    cur.execute(
        sql.SQL("CREATE TABLE IF NOT EXISTS {} ({})").format(
            _q(name), sql.SQL(", ").join(columns)
        )
    )
    cur.execute(
        sql.SQL("CREATE INDEX IF NOT EXISTS {} ON {} ({})").format(
            sql.Identifier(f"idx_{name}_form_id"[:MAX_IDENTIFIER]),
            _q(name),
            sql.Identifier("form_id"),
        )
    )
    logger.info("Created tabular mirror %s", name)
    return name


def sync(
    cur,
    form_json: Dict[str, Any],
    renames: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Bring the mirror in line with the current definition.

    Renames keep their data (`ALTER ... RENAME COLUMN`). New questions get a
    column. Removed questions lose theirs. A retyped question has its column
    replaced — safe, because the values are read back from `form_data`.
    """
    name = tabular_name(form_json["table_name"])
    report: Dict[str, Any] = {
        "name": name,
        "created": False,
        "added": [],
        "dropped": [],
        "renamed": [],
        "retyped": [],
        "warnings": [],
    }

    if not table_exists(cur, name):
        create(cur, form_json)
        report["created"] = True
        report["added"] = [c for c, _ in _field_columns(form_json)]
        return report

    # A mirror built before the relationships were declared gets them now.
    for column, ref, on_delete in (
        ("form_id", "forms", None),
        ("survey_id", form_json["table_name"], "CASCADE"),
    ):
        if ensure_foreign_key(cur, name, column, ref, column if column == "form_id" else "survey_id", on_delete):
            report.setdefault("linked", []).append(column)

    # Renames first, so the column is recognised as existing below.
    for old, new in (renames or {}).items():
        current = existing_columns(cur, name)
        if old in current and new not in current:
            cur.execute(
                sql.SQL("ALTER TABLE {} RENAME COLUMN {} TO {}").format(
                    _q(name), sql.Identifier(old), sql.Identifier(new)
                )
            )
            report["renamed"].append(f"{old} -> {new}")

    current = existing_columns(cur, name)
    wanted = _field_columns(form_json)
    wanted_names = {c for c, _ in wanted}

    for column, pg_type in wanted:
        if column not in current:
            cur.execute(
                sql.SQL("ALTER TABLE {} ADD COLUMN {} {}").format(
                    _q(name), sql.Identifier(column), sql.SQL(pg_type)
                )
            )
            report["added"].append(column)
        elif _base(current[column]) != _base(pg_type):
            # Replace rather than cast: a text column holding "n/a" cannot become
            # NUMERIC, and rebuild will repopulate it from form_data anyway.
            cur.execute(
                sql.SQL("ALTER TABLE {} DROP COLUMN {}").format(_q(name), sql.Identifier(column))
            )
            cur.execute(
                sql.SQL("ALTER TABLE {} ADD COLUMN {} {}").format(
                    _q(name), sql.Identifier(column), sql.SQL(pg_type)
                )
            )
            report["retyped"].append(f"{column} -> {pg_type}")

    for column in current:
        if column not in wanted_names and column not in ENVELOPE_NAMES:
            cur.execute(
                sql.SQL("ALTER TABLE {} DROP COLUMN {}").format(_q(name), sql.Identifier(column))
            )
            report["dropped"].append(column)

    if any(report[k] for k in ("added", "dropped", "renamed", "retyped")):
        logger.info(
            "Synced %s: +%d -%d ~%d renamed=%d",
            name,
            len(report["added"]),
            len(report["dropped"]),
            len(report["retyped"]),
            len(report["renamed"]),
        )
    return report


_ALIASES = {
    "character varying": "varchar",
    "timestamp without time zone": "timestamp",
    "time without time zone": "time",
    "integer": "int",
    "boolean": "bool",
    "double precision": "float8",
}


def _base(db_type: str) -> str:
    base = str(db_type).split("(")[0].strip().lower()
    return _ALIASES.get(base, base)


# --------------------------------------------------------------------------- #
# rows
# --------------------------------------------------------------------------- #
def _row_values(form_json: Dict[str, Any], form_data: Dict[str, Any]) -> Dict[str, Any]:
    """Project one stored response onto the mirror's columns."""
    out: Dict[str, Any] = {}
    for field in form_json.get("fields") or []:
        name = field["name"]
        if name in ENVELOPE_NAMES:
            continue
        raw = (form_data or {}).get(name)
        try:
            out[name] = flatten(coerce_value(field["type"], raw))
        except Exception:
            # A historic answer that no longer fits the current type leaves the
            # cell empty. form_data keeps the original, and revalidate reports it.
            out[name] = None
    return out


def insert(
    cur,
    form_json: Dict[str, Any],
    survey_id: str,
    form_id: str,
    form_version: int,
    created_by: str,
    form_data: Dict[str, Any],
) -> None:
    """Write one submission's flat copy, alongside the JSONB row."""
    name = tabular_name(form_json["table_name"])
    if not table_exists(cur, name):
        create(cur, form_json)

    present = set(existing_columns(cur, name))
    values = {k: v for k, v in _row_values(form_json, form_data).items() if k in present}

    columns = ["survey_id", "form_id", "form_version", "created_by"] + list(values)
    params = [survey_id, form_id, form_version, created_by] + list(values.values())

    cur.execute(
        sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
            _q(name),
            sql.SQL(", ").join(sql.Identifier(c) for c in columns),
            sql.SQL(", ").join(sql.Placeholder() * len(columns)),
        ),
        params,
    )


def rebuild(cur, form_json: Dict[str, Any], form_id: str) -> Dict[str, Any]:
    """Repopulate the whole mirror from the JSONB table.

    Used after columns are added or retyped, and to fill in a mirror for a form
    whose responses predate it.
    """
    source = form_json["table_name"]
    name = tabular_name(source)
    if not table_exists(cur, name):
        create(cur, form_json)

    cur.execute(
        sql.SQL(
            "SELECT survey_id, form_data, created_on, form_version, created_by "
            "FROM {} WHERE form_id = %s"
        ).format(_q(source)),
        (form_id,),
    )
    rows = [dict(r) for r in cur.fetchall()]
    if not rows:
        return {"rebuilt": 0}

    present = set(existing_columns(cur, name))
    field_columns = [c for c, _ in _field_columns(form_json) if c in present]
    columns = ["survey_id", "form_id", "created_on", "form_version", "created_by"] + field_columns

    statement = sql.SQL(
        "INSERT INTO {} ({}) VALUES ({}) "
        "ON CONFLICT (survey_id) DO UPDATE SET {}"
    ).format(
        _q(name),
        sql.SQL(", ").join(sql.Identifier(c) for c in columns),
        sql.SQL(", ").join(sql.Placeholder() * len(columns)),
        sql.SQL(", ").join(
            sql.SQL("{} = EXCLUDED.{}").format(sql.Identifier(c), sql.Identifier(c))
            for c in columns[1:]
        ),
    )

    batch = []
    for row in rows:
        values = _row_values(form_json, row["form_data"] or {})
        batch.append(
            [row["survey_id"], form_id, row["created_on"], row["form_version"], row["created_by"]]
            + [values.get(c) for c in field_columns]
        )

    execute_batch(cur, statement, batch, page_size=200)
    logger.info("Rebuilt %s from %d rows", name, len(batch))
    return {"rebuilt": len(batch)}
