"""Client-controlled catalogs.

These are controlled lists supplied by a client workbook.
They are deliberately separate from SEOnt, ICASA and Crop Ontology.

The client owns these values, so standards and the LLM must never replace them.
"""

from pathlib import Path

from app.core.registry import Module

from . import permissions  # noqa: F401
from .routers import catalogs

MODULE = Module(
    name="client_catalog",
    label="Client catalogs",
    routers=[catalogs.router],
    tables=["client_catalog", "client_catalog_value"],
    schema_file=Path(__file__).resolve().parent / "schema.sql",
    migrations=[],
)