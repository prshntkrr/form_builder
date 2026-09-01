"""The dashboards module: compose widgets over collected data.

Manifest only — core discovers this directory, reads `MODULE`, and mounts what
it finds. Adding a router, a table or a migration means editing this file and
nothing outside this directory.
"""
from pathlib import Path

from app.core.registry import Module

from . import permissions  # noqa: F401  (importing registers the permissions)
from .routers import dashboards

MODULE = Module(
    name="dashboards",
    label="Dashboards",
    routers=[dashboards.router],
    # Add table names here as schema.sql grows. Listing one makes the schema file
    # run on a fresh database and reports it in /api/health when it is absent.
    tables=["dashboard"],
    schema_file=Path(__file__).resolve().parent / "schema.sql",
    migrations=[],
)
