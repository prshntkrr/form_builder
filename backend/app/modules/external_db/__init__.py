"""External data: read another database, and copy a table out of it.

    external PostgreSQL / MySQL / Databricks ──> preview ──> a table in this database

A module like any other — its own permission, its own routes, one table of its
own. `DISABLED_MODULES=external_db` switches it off, endpoint and screen
together.

It never stores a credential in the clear. A typed-in connection — its password
or access token included — lives for the length of the request that carried it.

A connection may instead be **saved**, in `external_connection`. Its password
or access token is sealed there by `app/core/secrets.py` with a key from the
environment (`SECRET_KEY`) — never in the clear, never returned by any route,
never logged. A browser that uses a saved connection sends its id and nothing
else.

Also kept is `external_import`, one row per import attempt:
where from (a label with no secret in it), where to, the outcome and the row
count. That is the "Imported tables" list.

Version one is a **one-time, whole-table load**. Not synchronisation, not
scheduling, not incremental replication.
"""
from pathlib import Path

from app.core.registry import Module

from . import permissions  # noqa: F401  (importing registers them)
from .bootstrap import ensure_import_connection
from .import_service import mark_interrupted
from .routers import external_db

MODULE = Module(
    name="external_db",
    label="External data",
    routers=[external_db.router],
    # Its one table is the import history. The imported tables themselves are
    # created at import time, under the name the user chose.
    tables=["external_connection", "external_import"],
    schema_file=Path(__file__).resolve().parent / "schema.sql",
    migrations=[ensure_import_connection, mark_interrupted],
)
