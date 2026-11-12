"""What the units module lets a role do."""
from app.core.permissions import Permission, register

UNITS_VIEW = "units.view"
UNITS_MANAGE = "units.manage"

CATALOGUE = [
    Permission(UNITS_VIEW, "Convert units",
               "List the known units and convert a measurement between two of them",
               "Units"),
    Permission(UNITS_MANAGE, "Manage units",
               "Add, edit and remove units of measure",
               "Units"),
]

register(
    permissions=CATALOGUE,
    groups=["Units"],
    grants={"standard": [UNITS_VIEW], "admin": [UNITS_VIEW, UNITS_MANAGE]},
    capabilities={"convert_units": UNITS_VIEW, "manage_units": UNITS_MANAGE},
)
