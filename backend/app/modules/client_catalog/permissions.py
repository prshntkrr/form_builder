"""Permissions for client-controlled catalogs."""

from app.core.permissions import Permission, register

CATALOG_VIEW = "client_catalog.view"
CATALOG_MANAGE = "client_catalog.manage"

register(
    permissions=[
        Permission(
            CATALOG_VIEW,
            "Use CIMMYT Catalogue",
            "View the values in the CIMMYT Catalogue",
            "CIMMYT Catalogue",
        ),
        Permission(
            CATALOG_MANAGE,
            "Manage CIMMYT Catalogue",
            "Import and update client-controlled catalogs",
            "CIMMYT Catalogue",
        ),
    ],
    groups=["CIMMYT Catalogue"],
    grants={
        "editor": [CATALOG_VIEW],
    },
    capabilities={
        "use_client_catalogs": CATALOG_VIEW,
        # What the Catalogue Builder shows read-only and what it lets somebody
        # change. Declared here beside the permission, so the gate on the screen
        # and the gate on the endpoint cannot drift apart.
        "manage_client_catalogs": CATALOG_MANAGE,
    },
)