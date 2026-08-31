"""What the units module lets a role do."""
from app.core.permissions import Permission, register

UNITS_VIEW = "units.view"

CATALOGUE = [
    Permission(UNITS_VIEW, "Convert units",
               "List the known units and convert a measurement between two of them",
               "Units"),
]

register(
    permissions=CATALOGUE,
    groups=["Units"],
    grants={"editor": [UNITS_VIEW], "standard": [UNITS_VIEW]},
    capabilities={"convert_units": UNITS_VIEW},
)
