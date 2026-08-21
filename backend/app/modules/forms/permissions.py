"""What the forms module lets a role do.

Declared here, not in core, so that installing or removing this module changes
what an installation can grant without editing anything shared. `register` is
called from the module manifest at import time.
"""
from app.core.permissions import Permission, register

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

CATALOGUE = [
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
]

register(
    permissions=CATALOGUE,
    # Most-used first; core appends Administration after every module's groups.
    groups=["Records", "Forms", "Responses", "Standard forms"],
    # What the built-in roles get when an installation is first seeded. Narrowing
    # a role afterwards sticks — roles are seeded once, never re-seeded.
    grants={
        "editor": [
            RECORDS_VIEW, RECORDS_CREATE,
            FORMS_VIEW, FORMS_CREATE, FORMS_EDIT, FORMS_DELETE,
            RESPONSES_VIEW, RESPONSES_EXPORT,
            LIBRARY_VIEW, LIBRARY_MANAGE,
        ],
        "field": [RECORDS_VIEW, RECORDS_CREATE],
    },
    # Flags for /api/auth/me, so the frontend can hide whole sections without
    # knowing which permission each one rests on.
    capabilities={
        "build_forms": FORMS_VIEW,
        "use_library": LIBRARY_VIEW,
        "see_responses": RESPONSES_VIEW,
    },
)
