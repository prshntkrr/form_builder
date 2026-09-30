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
    # `manage_standards` is what the CIMMYT page asks before showing its import
    # and its editing. Without it the screens can only be read, which is the
    # right default for a vocabulary the whole installation maps questions to.
    capabilities={"use_standards": STANDARDS_VIEW,
                  "manage_standards": STANDARDS_MANAGE},
)
