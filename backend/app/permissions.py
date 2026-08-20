"""What there is to be allowed to do.

The catalogue is fixed in code, because a permission only means something if
something checks it — inventing one in the database would grant nothing. Roles
are the part that is user-defined: a role is a name plus a set of these.

Grouped only for the sake of the screen that assigns them.
"""
from dataclasses import dataclass
from typing import Dict, List, Sequence, Set

# --- forms ------------------------------------------------------------------
FORMS_VIEW = "forms.view"
FORMS_CREATE = "forms.create"
FORMS_EDIT = "forms.edit"
FORMS_DELETE = "forms.delete"

# --- responses (every column, plus export) ----------------------------------
RESPONSES_VIEW = "responses.view"
RESPONSES_EXPORT = "responses.export"
VIEW_CONFIGURE = "view.configure"

# --- records (the columns an admin chose to show) ---------------------------
RECORDS_VIEW = "records.view"
RECORDS_CREATE = "records.create"

# --- standard form library --------------------------------------------------
LIBRARY_VIEW = "library.view"
LIBRARY_MANAGE = "library.manage"

# --- administration ---------------------------------------------------------
USERS_MANAGE = "users.manage"
ROLES_MANAGE = "roles.manage"


@dataclass(frozen=True)
class Permission:
    key: str
    label: str
    detail: str
    group: str


CATALOGUE: List[Permission] = [
    Permission(RECORDS_VIEW, "See records",
               "Open a form and read the records, in the columns an admin has made visible",
               "Records"),
    Permission(RECORDS_CREATE, "Add records",
               "Fill in a live form and save a new record", "Records"),

    Permission(FORMS_VIEW, "See all forms",
               "The builder's list, with versions, tables and response counts", "Forms"),
    Permission(FORMS_CREATE, "Create forms",
               "Build a new form, by prompt or by hand, and publish it", "Forms"),
    Permission(FORMS_EDIT, "Edit forms",
               "Change questions, pause or resume a form, and roll back a version", "Forms"),
    Permission(FORMS_DELETE, "Remove forms",
               "Take a form out of the list. Collected records are kept", "Forms"),

    Permission(RESPONSES_VIEW, "See every answer",
               "Read responses in full, including columns hidden from other roles",
               "Responses"),
    Permission(RESPONSES_EXPORT, "Export responses",
               "Download the whole response set as CSV", "Responses"),
    Permission(VIEW_CONFIGURE, "Choose visible columns",
               "Decide which answers other roles can see", "Responses"),

    Permission(LIBRARY_VIEW, "Use standard forms",
               "Browse the library and start a form from one", "Standard forms"),
    Permission(LIBRARY_MANAGE, "Manage standard forms",
               "Offer a form as a standard, or withdraw one", "Standard forms"),

    Permission(USERS_MANAGE, "Manage users",
               "Add people, assign their role, and reset their password", "Administration"),
    Permission(ROLES_MANAGE, "Manage roles",
               "Create roles and choose what each one may do", "Administration"),
]

ALL: Set[str] = {p.key for p in CATALOGUE}
BY_KEY: Dict[str, Permission] = {p.key: p for p in CATALOGUE}

# The order groups should appear in, most-used first.
GROUPS: List[str] = ["Records", "Forms", "Responses", "Standard forms", "Administration"]


def clean(keys: Sequence[str]) -> List[str]:
    """Keep only permissions something actually checks, in catalogue order."""
    wanted = {str(k) for k in keys or []}
    return [p.key for p in CATALOGUE if p.key in wanted]


def unknown(keys: Sequence[str]) -> List[str]:
    return sorted({str(k) for k in keys or []} - ALL)


def as_catalogue() -> List[Dict[str, object]]:
    """For the screen that assigns them."""
    return [
        {
            "group": group,
            "permissions": [
                {"key": p.key, "label": p.label, "detail": p.detail}
                for p in CATALOGUE if p.group == group
            ],
        }
        for group in GROUPS
    ]


# The roles an installation starts with. `system` roles cannot be deleted, and
# the admin role cannot be stripped of the permissions that manage access —
# otherwise an installation can be locked out of itself.
BUILT_IN = {
    "admin": {
        "label": "Admin",
        "description": "Full access, including people and roles.",
        "permissions": sorted(ALL),
        "system": True,
        "locked": [USERS_MANAGE, ROLES_MANAGE],
    },
    "editor": {
        "label": "Editor",
        "description": "Builds forms and reads every response.",
        "permissions": [
            RECORDS_VIEW, RECORDS_CREATE,
            FORMS_VIEW, FORMS_CREATE, FORMS_EDIT, FORMS_DELETE,
            RESPONSES_VIEW, RESPONSES_EXPORT,
            LIBRARY_VIEW, LIBRARY_MANAGE,
        ],
        "system": True,
        "locked": [],
    },
    "field": {
        "label": "Field officer",
        "description": "Fills in live forms and reads the records shown to them.",
        "permissions": [RECORDS_VIEW, RECORDS_CREATE],
        "system": True,
        "locked": [],
    },
}
