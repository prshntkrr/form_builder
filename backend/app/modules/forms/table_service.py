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

from app.core.config import settings
from app.core.database import table_exists  # noqa: F401  (re-exported)
from app.modules.forms.form_schema import (
    ENVELOPE_COLUMNS, LOCATION_COLUMN, MAX_IDENTIFIER, PARENT_COLUMN,
    collects_location, parent_form_id,
)

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


# --------------------------------------------------------------------------- #
# foreign keys
# --------------------------------------------------------------------------- #
def fk_name(table_name: str, column: str) -> str:
    return f"fk_{table_name}_{column}"[:MAX_IDENTIFIER]


def column_has_foreign_key(cur, table_name: str, column: str) -> bool:
    """Any FK already covering this column, whatever it is called."""
    cur.execute(
        """
        SELECT 1
        FROM   pg_constraint c
        JOIN   pg_class     t ON t.oid = c.conrelid
        JOIN   pg_namespace n ON n.oid = t.relnamespace
        WHERE  n.nspname = %s AND t.relname = %s AND c.contype = 'f'
          AND  EXISTS (
                 SELECT 1
                 FROM   unnest(c.conkey) AS k
                 JOIN   pg_attribute a ON a.attrelid = t.oid AND a.attnum = k
                 WHERE  a.attname = %s)
        """,
        (settings.db_schema, table_name, column),
    )
    return cur.fetchone() is not None


def ensure_foreign_key(
    cur,
    table_name: str,
    column: str,
    ref_table: str,
    ref_column: str,
    on_delete: Optional[str] = None,
) -> Optional[str]:
    """Declare the relationship if it isn't already there.

    Without these an ERD tool has nothing to draw — the columns line up, but
    nothing in the database says they are related. Returns the constraint name
    if one was added, None if it already existed or could not be applied.

    Wrapped in a savepoint: a table holding rows that violate the constraint
    would otherwise abort the whole transaction the caller is in.
    """
    if column_has_foreign_key(cur, table_name, column):
        return None

    name = fk_name(table_name, column)
    statement = sql.SQL(
        "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})"
    ).format(
        _qualified(table_name),
        sql.Identifier(name),
        sql.Identifier(column),
        _qualified(ref_table),
        sql.Identifier(ref_column),
    )
    if on_delete:
        statement = statement + sql.SQL(f" ON DELETE {on_delete}")

    cur.execute("SAVEPOINT add_fk")
    try:
        cur.execute(statement)
        cur.execute("RELEASE SAVEPOINT add_fk")
        logger.info("Linked %s.%s -> %s.%s", table_name, column, ref_table, ref_column)
        return name
    except Exception as exc:
        cur.execute("ROLLBACK TO SAVEPOINT add_fk")
        logger.warning(
            "Could not link %s.%s -> %s.%s: %s",
            table_name, column, ref_table, ref_column, str(exc).strip().splitlines()[0],
        )
        return None


# --------------------------------------------------------------------------- #
# survey numbering
# --------------------------------------------------------------------------- #
def sequence_name(table_name: str) -> str:
    return f"{table_name[:MAX_IDENTIFIER - 12]}_survey_seq"


def ensure_survey_sequence(cur, table_name: str) -> str:
    """A counter per form table, so survey ids run 1, 2, 3…

    A Postgres sequence rather than `MAX(...) + 1`, because `nextval` is atomic:
    two officers submitting at the same moment cannot be handed the same number.
    """
    seq = sequence_name(table_name)
    qualified = f"{settings.db_schema}.{seq}"

    cur.execute("SELECT to_regclass(%s) AS found", (qualified,))
    if cur.fetchone()["found"] is not None:
        return qualified

    cur.execute(
        sql.SQL("CREATE SEQUENCE IF NOT EXISTS {}.{}").format(
            sql.Identifier(settings.db_schema), sql.Identifier(seq)
        )
    )
    # An adopted table may already hold rows numbered some other way; start past
    # them so a new submission cannot collide with an existing survey_id.
    if table_exists(cur, table_name):
        cur.execute(
            sql.SQL("SELECT COUNT(*) AS n FROM {}").format(_qualified(table_name))
        )
        existing = int(cur.fetchone()["n"])
        if existing:
            cur.execute("SELECT setval(%s, %s)", (qualified, existing))
    logger.info("Created survey sequence %s", seq)
    return qualified


def next_survey_id(cur, form_id: str, table_name: str) -> str:
    """`000001`, `000002`, … — six digits, and nothing else.

    Counted per form, because every form has its own table and its own
    sequence: Farmer Register and Plot Register both start at `000001` and
    neither can reach the other's rows. Which form a submission belongs to is
    `form_id`, which is stored beside it; repeating it inside the id said the
    same thing twice.

    Zero-padded because `survey_id` is a VARCHAR: unpadded numbers would sort
    "10" before "2". Six digits is a million submissions per form; past that
    the number simply grows and keeps sorting correctly against its own width.
    """
    qualified = ensure_survey_sequence(cur, table_name)
    cur.execute("SELECT nextval(%s) AS n", (qualified,))
    return f"{int(cur.fetchone()['n']):06d}"


def _create_table(cur, table_name: str) -> None:
    columns = [
        sql.SQL("{} {}").format(sql.Identifier(name), sql.SQL(ddl))
        for name, ddl in _ENVELOPE_DDL
    ]
    # Declared up front so the table joins the ERD from the moment it exists.
    columns.append(
        sql.SQL("CONSTRAINT {} FOREIGN KEY (form_id) REFERENCES {} (form_id)").format(
            sql.Identifier(fk_name(table_name, "form_id")), _qualified("forms")
        )
    )
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


def ensure_parent_column(cur, table_name: str, form_json: Dict[str, Any]) -> bool:
    """Give a child form's table the column that says which parent it belongs to.

    Only a child form gets it. An independent form's table is exactly the shape
    it has always been, which is what keeps every existing form and every
    existing row untouched.

    Nullable, and left nullable on purpose: rows collected before a form became
    a child have no parent, and `NOT NULL` would make adding the column fail on
    exactly the tables that already hold data. What a *new* submission must
    carry is decided in `relationships.validate_parent`, where the answer can be
    explained.
    """
    if not parent_form_id(form_json):
        return False

    if PARENT_COLUMN in existing_columns(cur, table_name):
        return False

    cur.execute(
        sql.SQL("ALTER TABLE {} ADD COLUMN IF NOT EXISTS {} VARCHAR(50)").format(
            _qualified(table_name), sql.Identifier(PARENT_COLUMN)
        )
    )
    cur.execute(
        sql.SQL("CREATE INDEX IF NOT EXISTS {} ON {} ({})").format(
            sql.Identifier(f"idx_{table_name}_{PARENT_COLUMN}"[:MAX_IDENTIFIER]),
            _qualified(table_name),
            sql.Identifier(PARENT_COLUMN),
        )
    )
    logger.info("Added %s.%s for a child form", table_name, PARENT_COLUMN)
    return True


def ensure_location_column(cur, table_name: str, form_json: Dict[str, Any]) -> bool:
    """Give a form that records where it was filled in somewhere to put it.

    The same rule as `ensure_parent_column`: only a form that asks gets the
    column, so every other form's table is untouched. Nullable, because a form
    can start collecting positions after it already holds answers, and those
    rows have none.

    JSONB rather than two numeric columns: what is stored is one reading —
    where, how sure, and when — and splitting it across columns would invite
    half of it being written.
    """
    if not collects_location(form_json):
        return False

    if LOCATION_COLUMN in existing_columns(cur, table_name):
        return False

    cur.execute(
        sql.SQL("ALTER TABLE {} ADD COLUMN IF NOT EXISTS {} JSONB").format(
            _qualified(table_name), sql.Identifier(LOCATION_COLUMN)
        )
    )
    logger.info("Added %s.%s for a form that records its location",
                table_name, LOCATION_COLUMN)
    return True


def _parent_table(cur, form_json: Dict[str, Any]) -> Optional[str]:
    """The table the parent form's submissions live in, if it has one yet."""
    parent = parent_form_id(form_json)
    if not parent:
        return None

    cur.execute("SELECT form_json FROM forms WHERE form_id = %s", (parent,))
    row = cur.fetchone()
    if not row:
        return None

    table = ((row["form_json"] or {}).get("table_name") or "").strip()
    return table if table and table_exists(cur, table) else None


def link_to_parent_table(cur, table_name: str, parent_table: str) -> Optional[str]:
    """Declare the relationship to the database, where it can be declared.

    RESTRICT, never CASCADE: deleting a parent submission that still has
    children must fail loudly rather than take the children with it.

    `ensure_foreign_key` is savepoint-guarded and returns None when the
    constraint cannot be applied — a table already holding a row that would
    violate it, say. That is deliberate: the relationship is enforced in
    `relationships.validate_parent` on the way in, and this only tells the
    database what the application already guarantees.
    """
    return ensure_foreign_key(cur, table_name, PARENT_COLUMN,
                              parent_table, "survey_id", "RESTRICT")


def sync_table(cur, form_json: Dict[str, Any]) -> Dict[str, Any]:
    """Create the form's table, or check that an adopted one has the envelope.

    Because answers live in `form_data`, editing a form never alters the table.
    The only things that can need fixing are an adopted table missing part of
    the envelope, and a form that has become a child of another one.
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
        ensure_survey_sequence(cur, table_name)
        report["created"] = True
        report["columns"] = [name for name, _ in ENVELOPE_COLUMNS]
        if ensure_parent_column(cur, table_name, form_json):
            report["added_columns"].append(PARENT_COLUMN)
            report["columns"].append(PARENT_COLUMN)
            parent_table = _parent_table(cur, form_json)
            if parent_table and link_to_parent_table(cur, table_name, parent_table):
                report["linked_to_parent"] = parent_table
        if ensure_location_column(cur, table_name, form_json):
            report["added_columns"].append(LOCATION_COLUMN)
            report["columns"].append(LOCATION_COLUMN)
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

    if ensure_parent_column(cur, table_name, form_json):
        report["added_columns"].append(PARENT_COLUMN)
        parent_table = _parent_table(cur, form_json)
        if parent_table and link_to_parent_table(cur, table_name, parent_table):
            report["linked_to_parent"] = parent_table

    if ensure_location_column(cur, table_name, form_json):
        report["added_columns"].append(LOCATION_COLUMN)

    if ensure_foreign_key(cur, table_name, "form_id", "forms", "form_id"):
        report["linked"] = True

    report["columns"] = sorted(set(current) | set(report["added_columns"]))
    return report
