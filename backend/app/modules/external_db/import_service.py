"""Copying one external table into this application's own database.

    external table ──read in batches──> local PostgreSQL table

A one-time, whole-table copy. Not a sync: nothing here watches the source, and
running it again against a table that exists is refused rather than merged.

What is copied is the data and a sensible column type for each column. What is
deliberately not copied: keys, indexes, constraints, defaults, triggers, views.
This is a load, not a replication of somebody else's schema — and a constraint
carried across that this application does not maintain would be a promise it
cannot keep.

The whole load is one local transaction: the table is created and filled
together, and a failure anywhere leaves the database as it was. There is no
half-built table to find later, which is the failure mode worth designing out.
"""
import logging
import re
import time
from typing import Any, Dict, List

from psycopg2 import sql
from psycopg2.extras import execute_values

from app.core.config import settings
from app.core.database import table_exists, transaction
from app.modules.external_db import connections
from app.modules.external_db.connections import ExternalDbError

logger = logging.getLogger(__name__)

# A destination name this application is willing to create. Lowercase letters,
# digits and underscores, starting with a letter or underscore — a PostgreSQL
# identifier that needs no quoting to be safe, quoted anyway when it is used.
DESTINATION = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")

# Names that already mean something in this database.
RESERVED_DESTINATIONS = {
    "forms", "form_version", "form_media", "form_export", "form_view",
    "app_user", "app_role", "role_permission", "user_session", "project",
    "project_member", "client_catalog", "client_catalog_value", "data_standard",
    "standard_variable", "standard_variable_option", "unit", "data_dictionary",
}

# Source type -> PostgreSQL type. Anything not here stops the import with the
# column named, rather than being guessed at and stored as the wrong thing.
POSTGRES_TYPES = {
    "smallint": "SMALLINT", "integer": "INTEGER", "bigint": "BIGINT",
    "numeric": "NUMERIC", "decimal": "NUMERIC", "real": "REAL",
    "double precision": "DOUBLE PRECISION", "money": "NUMERIC",
    "boolean": "BOOLEAN",
    "character varying": "TEXT", "character": "TEXT", "text": "TEXT",
    "citext": "TEXT", "name": "TEXT", "uuid": "UUID",
    "date": "DATE", "time without time zone": "TIME",
    "time with time zone": "TIMETZ",
    "timestamp without time zone": "TIMESTAMP",
    "timestamp with time zone": "TIMESTAMPTZ",
    "json": "JSONB", "jsonb": "JSONB",
    "interval": "INTERVAL", "inet": "TEXT", "bytea": "BYTEA",
}

MYSQL_TYPES = {
    "tinyint": "SMALLINT", "smallint": "SMALLINT", "mediumint": "INTEGER",
    "int": "INTEGER", "integer": "INTEGER", "bigint": "BIGINT",
    "decimal": "NUMERIC", "numeric": "NUMERIC", "float": "REAL",
    "double": "DOUBLE PRECISION", "bit": "BOOLEAN",
    "char": "TEXT", "varchar": "TEXT", "tinytext": "TEXT", "text": "TEXT",
    "mediumtext": "TEXT", "longtext": "TEXT", "enum": "TEXT", "set": "TEXT",
    "date": "DATE", "datetime": "TIMESTAMP", "timestamp": "TIMESTAMP",
    "time": "TIME", "year": "INTEGER",
    "json": "JSONB",
    "binary": "BYTEA", "varbinary": "BYTEA", "blob": "BYTEA",
    "tinyblob": "BYTEA", "mediumblob": "BYTEA", "longblob": "BYTEA",
}


class ImportRefused(ExternalDbError):
    """The import cannot start, or cannot finish. The message says why."""

    code = "IMPORT_FAILED"


def check_destination(name: str) -> str:
    """The local table name, or a refusal.

    Checked against a pattern first and quoted second. A name is never
    interpolated into a statement as text — `psycopg2.sql.Identifier` does the
    quoting — so this is the outer of two locks rather than the only one.
    """
    text = str(name or "").strip()
    if not DESTINATION.match(text):
        raise ImportRefused(
            f"'{text}' is not a usable table name. Use letters, digits and "
            "underscores, starting with a letter.", "VALIDATION_ERROR")
    if text.lower() in RESERVED_DESTINATIONS:
        raise ImportRefused(
            f"'{text}' is one of this application's own tables. Choose another name.",
            "VALIDATION_ERROR")
    return text


def map_type(db_type: str, column: Dict[str, Any]) -> str:
    """The PostgreSQL type for one source column, or a refusal naming it."""
    source = (column.get("source_type") or "").lower().strip()
    declared = (column.get("declared") or source).lower().strip()

    if db_type == connections.MYSQL:
        # tinyint(1) is how MySQL spells a boolean; tinyint(4) is a number.
        if source == "tinyint" and declared.startswith("tinyint(1)"):
            return "BOOLEAN"
        if source in ("tinyint", "bit") and declared.startswith("bit(1)"):
            return "BOOLEAN"
        found = MYSQL_TYPES.get(source)
    else:
        found = POSTGRES_TYPES.get(source)
        if found is None and source.startswith("timestamp"):
            found = "TIMESTAMPTZ" if "with time zone" in source else "TIMESTAMP"
        if found is None and source == "array":
            found = None            # an array of what? not guessed at

    if found is None:
        raise ImportRefused(
            f"Column '{column.get('name')}' uses unsupported type "
            f"'{source or 'unknown'}' and could not be imported.",
            "UNSUPPORTED_COLUMN_TYPE")
    return found


def plan(spec: Dict[str, Any], source_schema: str, source_table: str,
         destination: str) -> Dict[str, Any]:
    """Everything checked before a single row is read.

    Deliberately all of it up front: the destination name, the source's
    existence, every column's type, and whether the destination is free. An
    import that was going to fail on the last column fails here instead, having
    created nothing.
    """
    table = check_destination(destination)
    columns = connections.columns(spec, source_schema, source_table)
    if not columns:
        raise ImportRefused(
            f"'{source_schema}.{source_table}' has no columns to import.",
            "RESOURCE_NOT_FOUND")

    mapped = [{"name": c["name"], "source_type": c["source_type"],
               "local_type": map_type(spec["db_type"], c)} for c in columns]

    with transaction() as cur:
        if table_exists(cur, table):
            raise ImportRefused(
                f"A table called '{table}' already exists here. Choose another "
                "name — nothing is overwritten.", "CONFLICT")

    return {"destination": table, "columns": mapped}


def load(spec: Dict[str, Any], source_schema: str, source_table: str,
         destination: str, loaded_by: str = "") -> Dict[str, Any]:
    """Copy the table. One transaction, one result, no half-built table."""
    checked = connections.check_connection(spec)
    schema = connections.check_identifier(source_schema, "schema")
    table = connections.check_identifier(source_table, "table")

    prepared = plan(checked, schema, table, destination)
    into = prepared["destination"]
    columns = prepared["columns"]
    batch_size = max(50, int(settings.external_db_batch_size))

    started = time.monotonic()
    rows_loaded = 0

    create = sql.SQL("CREATE TABLE {} ({})").format(
        sql.Identifier(into),
        sql.SQL(", ").join(
            sql.SQL("{} {}").format(sql.Identifier(c["name"]), sql.SQL(c["local_type"]))
            for c in columns),
    )
    insert = sql.SQL("INSERT INTO {} ({}) VALUES %s").format(
        sql.Identifier(into),
        sql.SQL(", ").join(sql.Identifier(c["name"]) for c in columns),
    )

    try:
        # Create and fill together. A failure at any point rolls the whole thing
        # back, so there is never a table here holding part of somebody's data.
        with transaction() as cur:
            cur.execute(create)
            for batch in connections.rows(checked, schema, table, batch_size):
                execute_values(cur, insert, batch, page_size=batch_size)
                rows_loaded += len(batch)
    except ExternalDbError:
        raise
    except Exception as exc:
        logger.exception("Import failed: %s.%s -> %s", schema, table, into)
        raise ImportRefused(
            "The import could not be completed and nothing was written. "
            f"({type(exc).__name__})") from exc

    seconds = round(time.monotonic() - started, 2)
    logger.info(
        "external_db import ok: %s %s.%s -> %s rows=%s cols=%s in %ss by %s",
        checked["db_type"], schema, table, into, rows_loaded, len(columns),
        seconds, loaded_by or "-")

    return {
        "success": True,
        "source": {"schema": schema, "table": table, "db_type": checked["db_type"]},
        "destination": {"table": into},
        "rows_loaded": rows_loaded,
        "columns_loaded": len(columns),
        "columns": columns,
        "duration_seconds": seconds,
    }
