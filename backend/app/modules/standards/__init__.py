"""Standards: somebody else's vocabulary, imported and held locally.

Four of them, and they are separate on purpose — a form field may carry any
combination, and none of them overrules another:

    seont/          what a field *means*            AGRO_00000325
    icasa/          what it is officially *called*  PHTD · 935 · m
    crop_ontology/  which crop-specific variable    CO_322:0000996 · cm
    units/          the arithmetic between units    150 cm -> 1.5 m

This package holds no module of its own. It is a container: the registry
descends into it and finds four modules, each with its own manifest, tables,
permissions and routes, exactly as when they sat directly under `modules/`.

**`client_catalog` is deliberately not here.** A client's controlled lists are
their data, not a standard — the whole point of that module is that no standard
and no model may replace one of its values. Filing it under `standards/` would
blur the one distinction the code most depends on.
"""

# Read by app/core/registry.py, which descends into this package rather than
# importing it as a module.
CONTAINER = True

# What DISABLED_MODULES called these before they moved here. An installation's
# .env keeps meaning exactly what it meant: `DISABLED_MODULES=standards` still
# switches ICASA off, and `ontology` still switches SEOnt off.
LEGACY_NAMES = {"icasa": "standards", "seont": "ontology"}
