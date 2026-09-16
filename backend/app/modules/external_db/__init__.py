"""External data: read another database, and copy a table out of it.

    external PostgreSQL / MySQL  ──> preview ──> a table in this database

A module like any other — its own permission, its own routes, no tables of its
own. `DISABLED_MODULES=external_db` switches it off, endpoint and screen
together.

It stores nothing. There is no connection table and no import history: a
connection lives for the length of the request that carried it, which is what
keeps a password out of this application's database. If an installation later
wants saved connections or an import log, that is a table and a decision about
where credentials live — not something to add by accident here.

Version one is a **one-time, whole-table load**. Not synchronisation, not
scheduling, not incremental replication.
"""
from app.core.registry import Module

from . import permissions  # noqa: F401  (importing registers them)
from .routers import external_db

MODULE = Module(
    name="external_db",
    label="External data",
    routers=[external_db.router],
    # No tables of its own: it reads somebody else's database and writes the
    # table the user names, which is created at import time.
    tables=[],
)
