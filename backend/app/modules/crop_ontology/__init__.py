"""The crop ontology module: crop-specific traits, methods, scales, variables.

Crop Ontology answers a narrower question than the other standards. SEOnt says
what a field means and ICASA what it is officially called; Crop Ontology says,
*for maize specifically*, which measured variable this is and by what method and
scale.

That makes crop context load-bearing rather than incidental — the same trait
exists in every crop under a different identifier — which is why this lives in
its own module rather than as another table in `standards`.

Not a variety or cultivar registry. Crop Ontology does not publish those, and
nothing here invents them.
"""
from pathlib import Path

from app.core.registry import Module

from . import permissions  # noqa: F401  (importing registers them)
from .routers import crop_ontology

MODULE = Module(
    name="crop_ontology",
    label="Crop ontology",
    routers=[crop_ontology.router],
    tables=["crop_ontology", "crop_trait", "crop_method", "crop_scale", "crop_variable"],
    schema_file=Path(__file__).resolve().parent / "schema.sql",
    migrations=[],
)
