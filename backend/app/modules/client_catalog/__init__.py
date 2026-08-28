"""Client-controlled catalogs.

Controlled lists the client maintains — collaborator types, states and their
districts, approved varieties. Built in the Catalogue Builder or imported from
their workbook; the same two tables either way.

Deliberately separate from SEOnt, ICASA and Crop Ontology. Those are somebody
else's authoritative vocabulary and are managed by their own modules; these
values belong to the client, so no standard and no model may replace one.
"""

from pathlib import Path

from app.core.registry import Module

from . import bootstrap
from . import permissions  # noqa: F401
from .routers import catalogs

MODULE = Module(
    name="client_catalog",
    label="Client catalogs",
    routers=[catalogs.router],
    tables=["client_catalog", "client_catalog_value"],
    schema_file=Path(__file__).resolve().parent / "schema.sql",
    migrations=[bootstrap.ensure_catalog_columns],
)