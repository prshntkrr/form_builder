"""Units of measure, and the arithmetic between them.

Deliberately its own module and not part of any standard. ICASA records plant
height in metres and Crop Ontology records it in centimetres; both are correct,
both stay as they are, and neither owns the conversion between them. A single
table of units and one deterministic calculation serve them all.

Nothing here is asked of a model. A conversion is a fact, and a wrong number
that looks right is worse than an error.
"""
from pathlib import Path

from app.core.registry import Module

from . import permissions  # noqa: F401  (importing registers them)
from .routers import units
from .service import seed_units

MODULE = Module(
    name="units",
    label="Units",
    routers=[units.router],
    tables=["unit"],
    schema_file=Path(__file__).resolve().parent / "schema.sql",
    migrations=[seed_units],
)
