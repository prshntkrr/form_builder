"""The ontology module: what a field means, in somebody else's vocabulary.

Holds a flat copy of an ontology's named concepts and their subclass links, so
a form field can say which concept it collects and can offer that concept's
children as standardised answers.

Deliberately separate from the forms module. Swapping SEOnt for AgrO, or adding
a second ontology beside it, is an import — not a change to how forms work. And
what a field *means* is a different question from how it must *behave*, which
stays with the data dictionary.
"""
from pathlib import Path

from app.core.registry import Module

from . import permissions  # noqa: F401  (importing registers them)
from .routers import ontology

MODULE = Module(
    name="ontology",
    label="Ontology",
    routers=[ontology.router],
    tables=["ontology_concept", "ontology_relation"],
    schema_file=Path(__file__).resolve().parent / "schema.sql",
    migrations=[],
)
