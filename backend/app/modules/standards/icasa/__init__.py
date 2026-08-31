"""The standards module: is there an official variable for this field?

Holds standardised variable dictionaries — ICASA first — and the layer that
attaches them to a drafted form without anybody asking.

Separate from the ontology module on purpose. An ontology says what a field
*means*; a standard dictionary says what it is officially *called*, in what unit
and of what type. A field may carry either, both or neither, and how it must
*behave* remains the application's own data dictionary's business.
"""
from pathlib import Path

from app.core.registry import Module

from . import permissions  # noqa: F401  (importing registers them)
from .routers import standards

MODULE = Module(
    name="standards",
    label="Data standards",
    routers=[standards.router],
    tables=["data_standard", "standard_variable", "standard_variable_option"],
    schema_file=Path(__file__).resolve().parent / "schema.sql",
    migrations=[],
)
