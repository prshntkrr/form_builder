"""Per-form Postgres tables.

Every saved form gets its own table, named after the form, with exactly the same
shape as the existing `survey_form_data` table:

    survey_id    VARCHAR(50)  NOT NULL PRIMARY KEY
    form_id      VARCHAR(20)  NOT NULL
    form_data    JSONB        NOT NULL
    created_on   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
    form_version INTEGER
    created_by   VARCHAR(50)

The answers themselves live in `form_data` as JSONB, keyed by field name. That
means adding, removing or retyping a field never requires a migration — the
table shape is fixed for the life of the form.

Table names are slugified by `form_schema` and every identifier reaches Postgres
through `psycopg2.sql.Identifier`, so no model or user text is concatenated into
DDL.
"""
import logging
from typing import Any, Dict, List, Optional

from psycopg2 import sql

from .config import settings
from .form_schema import ENVELOPE_COLUMNS, MAX_IDENTIFIER

logger = logging.getLogger(__name__)

# The envelope as declared at CREATE time, with constraints.
_ENVELOPE_DDL: List[tuple] = [
    ("survey_id", "VARCHAR(50) NOT NULL PRIMARY KEY"),
    ("form_id", "VARCHAR(20) NOT NULL"),
    ("form_data", "JSONB NOT NULL"),
    ("created_on", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
    ("form_version", "INTEGER"),
    ("created_by", "VARCHAR(50)"),
]


# --------------------------------------------------------------------------- #
# introspection
# --------------------------------------------------------------------------- #
def table_exists(cur, table_name: str) -> bool:
    cur.execute(
        """
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = %s AND table_name = %s
        """,
        (settings.db_schema, table_name),
    )
    return cur.fetchone() is not None


def existing_columns(cur, table_name: str) -> Dict[str, str]:
    cur.execute(
        """
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = %s AND table_name = %s
        ORDER BY ordinal_position
        """,
        (settings.db_schema, table_name),
    )
    return {r["column_name"]: r["data_type"] for r in cur.fetchall()}


def resolve_table_name(cur, desired: str, form_id: Optional[str] = None) -> str:
    """Give this form a table name no other form has already claimed.

    A physically existing table with the same name is fine — we adopt it (this is
    how a form called "Survey Form Data" lands in the `survey_form_data` table
    you already have).
    """
    base_sql = """
        SELECT form_json ->> 'table_name' AS table_name
        FROM forms
        WHERE form_json ->> 'table_name' IS NOT NULL
    """
    if form_id:
        cur.execute(base_sql + " AND form_id <> %s", (form_id,))
    else:
        cur.execute(base_sql)
    claimed = {r["table_name"] for r in cur.fetchall() if r["table_name"]}

    candidate, n = desired, 2
    while candidate in claimed:
        suffix = f"_{n}"
        candidate = f"{desired[:MAX_IDENTIFIER - len(suffix)]}{suffix}"
        n += 1
    return candidate


# --------------------------------------------------------------------------- #
# DDL
# --------------------------------------------------------------------------- #
def _qualified(table_name: str) -> sql.Composed:
    return sql.SQL("{}.{}").format(
        sql.Identifier(settings.db_schema), sql.Identifier(table_name)
    )


def _create_table(cur, table_name: str) -> None:
    columns = [
        sql.SQL("{} {}").format(sql.Identifier(name), sql.SQL(ddl))
        for name, ddl in _ENVELOPE_DDL
    ]
    cur.execute(
        sql.SQL("CREATE TABLE IF NOT EXISTS {} ({})").format(
            _qualified(table_name), sql.SQL(", ").join(columns)
        )
    )
    for column in ("form_id", "created_on"):
        cur.execute(
            sql.SQL("CREATE INDEX IF NOT EXISTS {} ON {} ({})").format(
                sql.Identifier(f"idx_{table_name}_{column}"[:MAX_IDENTIFIER]),
                _qualified(table_name),
                sql.Identifier(column),
            )
        )
    # A GIN index makes `form_data @> '{"crop": "Wheat"}'` fast once the table grows.
    cur.execute(
        sql.SQL("CREATE INDEX IF NOT EXISTS {} ON {} USING GIN (form_data)").format(
            sql.Identifier(f"idx_{table_name}_form_data"[:MAX_IDENTIFIER]),
            _qualified(table_name),
        )
    )
    logger.info("Created form table %s", table_name)


def sync_table(cur, form_json: Dict[str, Any]) -> Dict[str, Any]:
    """Create the form's table, or check that an adopted one has the envelope.

    Because answers live in `form_data`, editing a form never alters the table.
    The only thing that can need fixing is an adopted table missing part of the
    envelope.
    """
    table_name = form_json["table_name"]
    report: Dict[str, Any] = {
        "table_name": table_name,
        "created": False,
        "added_columns": [],
        "warnings": [],
    }

    if not table_exists(cur, table_name):
        _create_table(cur, table_name)
        report["created"] = True
        report["columns"] = [name for name, _ in ENVELOPE_COLUMNS]
        return report

    current = existing_columns(cur, table_name)
    for name, db_type in ENVELOPE_COLUMNS:
        if name not in current:
            cur.execute(
                sql.SQL("ALTER TABLE {} ADD COLUMN IF NOT EXISTS {} {}").format(
                    _qualified(table_name), sql.Identifier(name), sql.SQL(db_type)
                )
            )
            report["added_columns"].append(name)
            logger.info("Added missing envelope column %s.%s", table_name, name)

    report["columns"] = sorted(set(current) | set(report["added_columns"]))
    return report
