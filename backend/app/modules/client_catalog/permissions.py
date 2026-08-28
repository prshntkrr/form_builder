"""Permissions for client-controlled catalogs."""

from app.core.permissions import Permission, register

CATALOG_VIEW = "client_catalog.view"
CATALOG_MANAGE = "client_catalog.manage"

register(
    permissions=[
        Permission(
            CATALOG_VIEW,
            "Use client catalogs",
            "View client-controlled catalog values",
            "Client catalogs",
        ),
        Permission(
            CATALOG_MANAGE,
            "Manage client catalogs",
            "Import and update client-controlled catalogs",
            "Client catalogs",
        ),
    ],
    groups=["Client catalogs"],
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