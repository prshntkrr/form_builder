"""ISO 3166-1: the country codes, as a standard among the others.

    seont/          what a field means
    icasa/          what it is officially called
    crop_ontology/  which crop-specific variable
    units/          the arithmetic between units
    iso3166/        which country                    MX · MEX · 484

A module like the rest, so `DISABLED_MODULES=iso3166` switches it off exactly
as it switches off any other.

It brings **no tables of its own**. The standards schema already says another
dictionary is another row in `data_standard` and the same three tables, and
that is where ISO 3166-1 lives — which is why there is no `schema_file` here
and no migration. `tables` lists what it needs so a missing one is reported by
`/api/health` like anything else.
"""
from app.core.registry import Module

from . import permissions  # noqa: F401  (importing registers them)
from .routers import iso3166
from .service import import_iso3166

MODULE = Module(
    name="iso3166",
    label="ISO 3166-1 countries",
    routers=[iso3166.router],
    # Owned by the icasa module, which creates them. Declared so that a
    # deployment missing them is visible, not so that this module makes them.
    tables=["data_standard", "standard_variable", "standard_variable_option"],
    migrations=[import_iso3166],
)
