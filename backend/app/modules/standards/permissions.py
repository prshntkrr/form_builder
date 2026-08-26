"""What the standards module lets a role do."""
from app.core.permissions import Permission, register

STANDARDS_VIEW = "standards.view"
STANDARDS_MANAGE = "standards.manage"

CATALOGUE = [
    Permission(STANDARDS_VIEW, "Use data standards",
               "Search standardised variables and attach one to a question", "Standards"),
    Permission(STANDARDS_MANAGE, "Import data standards",
               "Load a standard dictionary, and remove one no longer used", "Standards"),
]

register(
    permissions=CATALOGUE,
    groups=["Standards"],
    grants={"editor": [STANDARDS_VIEW]},
    capabilities={"use_standards": STANDARDS_VIEW},
)
