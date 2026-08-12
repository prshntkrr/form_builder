"""Making sure the base tables exist.

`forms` and `form_version` are the only tables that have to be there before the
application can do anything; every form's own data table is created on demand.
Running `schema.sql` at startup means a fresh server needs no manual step, and
because the file is idempotent it is a no-op on an existing database.

Set AUTO_CREATE_TABLES=false to turn this off and apply `schema.sql` yourself —
useful where the application's database user is not allowed to run DDL.
"""
import logging
from pathlib import Path
from typing import List

from .config import settings
from .database import transaction
from .table_service import table_exists

logger = logging.getLogger(__name__)

SCHEMA_FILE = Path(__file__).resolve().parent.parent / "schema.sql"
REQUIRED_TABLES = ("forms", "form_version")

# The statuses the application writes. 'Deleted' is a soft delete: the form and
# every response it collected are kept, the form just leaves the list.
FORM_STATUSES = ("Active", "Inactive", "Deleted")
FORM_TYPES = ("parent", "child")


def missing_tables() -> List[str]:
    with transaction() as cur:
        return [t for t in REQUIRED_TABLES if not table_exists(cur, t)]


def ensure_base_tables() -> List[str]:
    """Create anything missing. Returns the tables that were absent beforehand."""
    missing = missing_tables()
    if not missing:
        return []

    if not settings.auto_create_tables:
        logger.warning(
            "Missing table(s): %s. AUTO_CREATE_TABLES is off — apply %s manually.",
            ", ".join(missing),
            SCHEMA_FILE.name,
        )
        return missing

    if not SCHEMA_FILE.exists():
        logger.error("Cannot create tables: %s not found", SCHEMA_FILE)
        return missing

    logger.info("Creating missing table(s): %s", ", ".join(missing))
    with transaction() as cur:
        cur.execute(SCHEMA_FILE.read_text(encoding="utf-8"))

    still_missing = missing_tables()
    if still_missing:
        logger.error("Still missing after running schema.sql: %s", ", ".join(still_missing))
    else:
        logger.info("Base schema ready")
    return missing


def ensure_status_values() -> bool:
    """Let `forms.form_status` hold every status the application writes.

    The table ships with a CHECK limited to Active/Inactive, but a form is
    soft-deleted by setting 'Deleted' — the row and its collected responses are
    kept, it just leaves the list. Without widening the constraint that write
    fails. Idempotent: a no-op once the constraint already allows all three.
    """
    from psycopg2 import sql

    try:
        with transaction() as cur:
            cur.execute(
                """
                SELECT conname, pg_get_constraintdef(oid) AS definition
                FROM   pg_constraint
                WHERE  conrelid = %s::regclass AND contype = 'c'
                  AND  pg_get_constraintdef(oid) ILIKE %s
                """,
                (f"{settings.db_schema}.forms", "%form_status%"),
            )
            row = cur.fetchone()
            if row and all(f"'{s}'" in row["definition"] for s in FORM_STATUSES):
                return False

            if row:
                cur.execute(
                    sql.SQL("ALTER TABLE {}.forms DROP CONSTRAINT {}").format(
                        sql.Identifier(settings.db_schema), sql.Identifier(row["conname"])
                    )
                )
            cur.execute(
                sql.SQL(
                    "ALTER TABLE {}.forms ADD CONSTRAINT forms_form_status_check "
                    "CHECK (form_status IN ({}))"
                ).format(
                    sql.Identifier(settings.db_schema),
                    sql.SQL(", ").join(sql.Literal(s) for s in FORM_STATUSES),
                )
            )
        logger.info("Widened forms_form_status_check to %s", ", ".join(FORM_STATUSES))
        return True
    except Exception as exc:
        logger.warning("Could not widen forms_form_status_check: %s", exc)
        return False


def ensure_relations() -> List[str]:
    """Declare the foreign keys on form tables created before they existed.

    A table with a `form_id` column but no constraint is not related to `forms`
    as far as Postgres — or an ERD tool — is concerned. Idempotent, and skips
    quietly if a table holds rows that would violate the constraint.
    """
    from .table_service import ensure_foreign_key, table_exists
    from .tabular_service import tabular_name

    linked: List[str] = []
    with transaction() as cur:
        cur.execute(
            "SELECT form_id, form_json ->> 'table_name' AS t FROM forms "
            "WHERE form_json ->> 'table_name' IS NOT NULL"
        )
        tables = {r["t"] for r in cur.fetchall() if r["t"]}

        for table in sorted(tables):
            if not table_exists(cur, table):
                continue
            if ensure_foreign_key(cur, table, "form_id", "forms", "form_id"):
                linked.append(f"{table}.form_id")

            mirror = tabular_name(table)
            if not table_exists(cur, mirror):
                continue
            if ensure_foreign_key(cur, mirror, "form_id", "forms", "form_id"):
                linked.append(f"{mirror}.form_id")
            if ensure_foreign_key(cur, mirror, "survey_id", table, "survey_id", "CASCADE"):
                linked.append(f"{mirror}.survey_id")

    if linked:
        logger.info("Declared %d missing relationship(s): %s", len(linked), ", ".join(linked))
    return linked
