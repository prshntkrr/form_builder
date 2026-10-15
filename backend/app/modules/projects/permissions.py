"""What a role may do, inside a project and about projects themselves.

Two levels, and keeping them apart is the point of this file.

**System-wide** — `projects.view_all` and `projects.manage` sit on
`app_user.role_id` like every permission before them. They answer "may this
account see the whole installation, and may it create projects at all".

**Inside one project** — everything else is read from
`project_member.role_id`: the role somebody holds *in that project*. The same
account can manage one project and enumerate in another, so these can never be
answered from the account alone.

There is one catalogue and one role table for both. A permission is a string
either way; what changes is where the role holding it was found. See access.py.
"""
from app.core.permissions import Permission, register

# System-wide.
PROJECTS_VIEW_ALL = "projects.view_all"
PROJECTS_MANAGE = "projects.manage"

# Within a project.
PROJECT_VIEW = "project.view"
PROJECT_MEMBERS_MANAGE = "project.members.manage"
PROJECT_GROUPS_MANAGE = "project.groups.manage"

FORMS_VIEW_ALL = "project.forms.view_all"
FORMS_MANAGE = "project.forms.manage"
FORMS_ASSIGN = "project.forms.assign"
FORMS_FILL = "project.forms.fill"

SUBMISSIONS_VIEW_ALL = "project.submissions.view_all"
SUBMISSIONS_REVIEW = "project.submissions.review"
SUBMISSIONS_DELETE = "project.submissions.delete"

PROJECT_API_KEYS = "project.api_keys"

GROUP = "Projects"

CATALOGUE = [
    Permission(PROJECTS_VIEW_ALL, "See every project",
               "See and open every project on this installation, joined or not", GROUP),
    Permission(PROJECTS_MANAGE, "Create and archive projects",
               "Create a project, rename it, and archive it", GROUP),

    Permission(PROJECT_VIEW, "Open a project",
               "See a project this account is a member of", GROUP),
    Permission(PROJECT_MEMBERS_MANAGE, "Manage project members",
               "Add and remove people, and set the role they hold here", GROUP),
    Permission(PROJECT_GROUPS_MANAGE, "Manage project groups",
               "Create teams inside the project and decide who is in them", GROUP),

    Permission(FORMS_VIEW_ALL, "See every form in the project",
               "See the project's forms whether or not they were assigned to you", GROUP),
    Permission(FORMS_MANAGE, "Build the project's forms",
               "Create, edit, publish and archive forms in this project", GROUP),
    Permission(FORMS_ASSIGN, "Assign forms",
               "Decide which people and groups a form is for", GROUP),
    Permission(FORMS_FILL, "Fill in assigned forms",
               "Answer the forms this account has been given", GROUP),

    Permission(SUBMISSIONS_VIEW_ALL, "See every submission in the project",
               "Read submissions from anybody, not only this account's own", GROUP),
    Permission(SUBMISSIONS_REVIEW, "Review submissions",
               "Take a submission under review, approve it, or reject it", GROUP),
    Permission(SUBMISSIONS_DELETE, "Delete submissions",
               "Remove a submission from the project", GROUP),

    Permission(PROJECT_API_KEYS, "Manage API keys",
               "Create, view, revoke and rotate data API keys for external access", GROUP),
]

# The roles a project starts with. Held per project, so somebody can be a
# manager here and a surveyor next door. `role_service.ensure_built_in` creates
# them once; an admin may then change what each one holds.
PROJECT_ROLES = {
    "project_manager": {
        "label": "Project manager",
        "description": "Runs one project: its people, its forms and its submissions.",
        "permissions": [
            PROJECT_VIEW, PROJECT_MEMBERS_MANAGE, PROJECT_GROUPS_MANAGE,
            FORMS_VIEW_ALL, FORMS_MANAGE, FORMS_ASSIGN, FORMS_FILL,
            SUBMISSIONS_VIEW_ALL, SUBMISSIONS_REVIEW, SUBMISSIONS_DELETE,
            PROJECT_API_KEYS,
        ],
    },
    "surveyor": {
        "label": "Surveyor",
        "description": "Fills in the forms they have been given, and sees their own answers.",
        # No view_all: a surveyor sees the forms assigned to them and the
        # submissions they made, and nothing else.
        "permissions": [PROJECT_VIEW, FORMS_FILL],
    },
    "reviewer": {
        "label": "Reviewer",
        "description": "Reads the project's submissions and approves or rejects them.",
        "permissions": [
            PROJECT_VIEW, FORMS_VIEW_ALL,
            SUBMISSIONS_VIEW_ALL, SUBMISSIONS_REVIEW,
        ],
    },
}

register(
    permissions=CATALOGUE,
    groups=[GROUP],
    # Only the system-wide pair is granted on an account's own role. Everything
    # else is earned by being a member of a project.
    grants={"editor": [PROJECTS_MANAGE]},
    capabilities={
        "use_projects": PROJECT_VIEW,
        "manage_projects": PROJECTS_MANAGE,
        "see_every_project": PROJECTS_VIEW_ALL,
    },
)


# The two permissions above that are answered from the *account* — creating a
# project at all, and reaching every one. Everything else in the catalogue only
# means something inside one project.
SYSTEM_WIDE = {PROJECTS_VIEW_ALL, PROJECTS_MANAGE}

PROJECT_SCOPED = {p.key for p in CATALOGUE} - SYSTEM_WIDE


SYSTEM_ROLE_NAMES = {"admin", "standard", "editor"}


def is_project_role(held, role_name: str = None) -> bool:
    """Whether a role belongs on the project side (is a project sub-role).

    Core system roles ('admin', 'standard') belong strictly to the account level.
    All other roles (built-in subroles 'project_manager', 'surveyor', 'reviewer',
    and any custom subroles created by administrators like 'field_advisor')
    belong on the project side and can be allocated to members within projects.
    """
    if isinstance(held, dict):
        role_name = held.get("name") or held.get("role") or role_name
        held = held.get("permissions") or []

    if role_name:
        if str(role_name).lower().strip() in SYSTEM_ROLE_NAMES:
            return False
        return True

    from app.core import permissions as core

    held = set(held or [])
    admin_system_perms = {
        core.USERS_MANAGE,
        core.USERS_DELETE,
        core.ROLES_MANAGE,
        PROJECTS_VIEW_ALL,
        PROJECTS_MANAGE,
    }
    if held and (admin_system_perms & held):
        return False

    return True

