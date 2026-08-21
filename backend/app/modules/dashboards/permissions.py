"""What the dashboards module lets a role do.

Add a permission here, add it to CATALOGUE, and reference it from a route with
`Depends(needs(DASHBOARDS_VIEW))`. Nothing outside this directory changes.
"""
from app.core.permissions import Permission, register

DASHBOARDS_VIEW = "dashboards.view"
DASHBOARDS_CREATE = "dashboards.create"
DASHBOARDS_EDIT = "dashboards.edit"
DASHBOARDS_DELETE = "dashboards.delete"
DASHBOARDS_SHARE = "dashboards.share"

CATALOGUE = [
    Permission(DASHBOARDS_VIEW, "See dashboards",
               "Open a dashboard and explore it", "Dashboards"),
    Permission(DASHBOARDS_CREATE, "Create dashboards",
               "Build a new dashboard and publish it", "Dashboards"),
    Permission(DASHBOARDS_EDIT, "Edit dashboards",
               "Change widgets, filters and layout, and roll back a version", "Dashboards"),
    Permission(DASHBOARDS_DELETE, "Remove dashboards",
               "Take a dashboard out of the list", "Dashboards"),
    Permission(DASHBOARDS_SHARE, "Share dashboards",
               "Export to PDF or image, and issue a shareable link", "Dashboards"),
]

register(
    permissions=CATALOGUE,
    groups=["Dashboards"],
    grants={
        "editor": [DASHBOARDS_VIEW, DASHBOARDS_CREATE, DASHBOARDS_EDIT,
                   DASHBOARDS_DELETE, DASHBOARDS_SHARE],
        "field": [DASHBOARDS_VIEW],
    },
    # Flags for /api/auth/me. The frontend module gates its routes on these, so
    # the screen and the endpoint cannot disagree about what a role may do.
    capabilities={
        "view_dashboards": DASHBOARDS_VIEW,
        "build_dashboards": DASHBOARDS_CREATE,
    },
)
