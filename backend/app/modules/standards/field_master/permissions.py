from app.core.permissions import Permission, register

MANAGE_FIELD_MASTER = "field_master.manage"

CATALOGUE = [
    Permission(MANAGE_FIELD_MASTER, "Manage field standards",
               "Create, update and delete reusable standard field definitions",
               "Field Standards"),
]

register(
    permissions=CATALOGUE,
    groups=["Field Standards"],
    grants={},
    capabilities={"manage_field_master": MANAGE_FIELD_MASTER},
)
