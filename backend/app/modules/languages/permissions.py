from app.core.permissions import Permission, register

MANAGE_LANGUAGES = "languages.manage"

CATALOGUE = [
    Permission(MANAGE_LANGUAGES, "Manage language packs",
               "Create, update and delete UI translation packs", "Languages"),
]

register(
    permissions=CATALOGUE,
    groups=["Languages"],
    grants={},
    capabilities={"manage_languages": MANAGE_LANGUAGES},
)
