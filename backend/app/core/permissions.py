"""What there is to be allowed to do.

The catalogue is fixed in code, because a permission only means something if
something checks it — inventing one in the database would grant nothing. Roles
are the part that is user-defined: a role is a name plus a set of these.

Core owns only the permissions that guard the platform itself. **Every module
declares its own** and registers them from its manifest, which is why adding a
module never means editing this file:

    from app.core.permissions import Permission, register

    DASHBOARDS_VIEW = "dashboards.view"

    register(
        permissions=[Permission(DASHBOARDS_VIEW, "See dashboards", "...", "Dashboards")],
        groups=["Dashboards"],
        grants={"editor": [DASHBOARDS_VIEW]},
    )

The catalogue is assembled on first read, after every module has registered —
see `_ensure`.
"""
from dataclasses import dataclass
from typing import Dict, List, Mapping, Sequence, Set

# --- administration ---------------------------------------------------------
# The only permissions core owns. Everything else belongs to a module.
USERS_MANAGE = "users.manage"
USERS_DELETE = "users.delete"
ROLES_MANAGE = "roles.manage"


@dataclass(frozen=True)
class Permission:
    key: str
    label: str
    detail: str
    group: str


CORE_CATALOGUE: List[Permission] = [
    Permission(USERS_MANAGE, "Manage users",
               "Add people, assign their role, and reset their password", "Administration"),
    Permission(USERS_DELETE, "Delete accounts",
               "Remove an account and its project memberships. What it collected "
               "stays.", "Administration"),
    Permission(ROLES_MANAGE, "Manage roles",
               "Create roles and choose what each one may do", "Administration"),
]

# The roles an installation starts with. `system` roles cannot be deleted, and
# the admin role cannot be stripped of the permissions that manage access —
# otherwise an installation can be locked out of itself.
#
# Core gives each role only its platform permissions; modules add theirs through
# `grants`, so a role's meaning grows with what is installed.
# There are two **system** roles, and that is the whole of what an account is.
#
# What somebody may do *inside a project* is not here: it comes from the role
# their membership of that project carries, and an account with no membership
# has no standing in any project at all. Keeping the two apart is the point —
# "Project manager" is something you are in one project, never something you
# are on the installation.
#
# See app/modules/projects/permissions.py for the project roles, and
# projects/access.py for how the two are read.
CORE_ROLES: Dict[str, Dict[str, object]] = {
    "admin": {
        "label": "System Administrator",
        "description": "Runs the installation: accounts, roles, standards and "
                       "every project.",
        "permissions": [USERS_MANAGE, USERS_DELETE, ROLES_MANAGE],
        "system": True,
        "locked": [USERS_MANAGE, ROLES_MANAGE],
        "everything": True,          # admin holds whatever exists, module or not
    },
    # Kept because installations run on it: it builds forms and reads the
    # standards, and taking that away from the accounts already holding it would
    # be a surprise rather than a migration. It is **not offered** for a new
    # assignment — see role_migration.NOT_OFFERED — so the Users page shows the
    # two roles above and nothing else.
    "editor": {
        "label": "Editor (legacy)",
        "description": "Builds forms and reads the standards. Superseded by a "
                       "project role; kept for accounts already using it.",
        "permissions": [],
        "system": True,
        "locked": [],
    },
    "standard": {
        "label": "Standard User",
        "description": "Signs in, and does whatever the projects they belong to "
                       "allow. No project access on its own.",
        "permissions": [],
        "system": True,
        "locked": [],
    },
}

# Groups core knows about. Modules append theirs; Administration stays last.
CORE_GROUPS: List[str] = ["Administration"]


# --------------------------------------------------------------------------- #
# registration
# --------------------------------------------------------------------------- #
_registered: List[Permission] = []
_groups: List[str] = []
_grants: Dict[str, List[str]] = {}
_capabilities: Dict[str, str] = {}
_discovering = False
_discovered = False


def register(
    *,
    permissions: Sequence[Permission] = (),
    groups: Sequence[str] = (),
    grants: Mapping[str, Sequence[str]] = None,
    capabilities: Mapping[str, str] = None,
) -> None:
    """Called by a module's manifest, at import time.

    `grants` says which built-in roles get these permissions by default. It is a
    starting point only — an admin who narrows a role afterwards keeps their
    choice, because roles are seeded once and never re-seeded.

    `capabilities` maps a flag name to the permission behind it, for the `can`
    block in /api/auth/me. The frontend uses those flags to decide which whole
    sections to show, and core must not know that "build_forms" means
    `forms.view` — so the forms module says so itself.
    """
    known = {p.key for p in _registered}
    for p in permissions:
        if p.key in known:
            raise ValueError(f"Permission {p.key} is already registered")
        _registered.append(p)
    for g in groups:
        if g not in _groups:
            _groups.append(g)
    for role, keys in (grants or {}).items():
        _grants.setdefault(role, []).extend(keys)
    _capabilities.update(capabilities or {})


def _ensure() -> None:
    """Import every module once, so the catalogue is complete before it is read."""
    global _discovering, _discovered
    if _discovered or _discovering:
        return
    _discovering = True
    try:
        from app.core import registry
        registry.discover()
        _discovered = True
    finally:
        _discovering = False


def _catalogue() -> List[Permission]:
    return list(_registered) + CORE_CATALOGUE


def _group_order() -> List[str]:
    return [g for g in _groups if g not in CORE_GROUPS] + CORE_GROUPS


def _built_in() -> Dict[str, Dict[str, object]]:
    every = {p.key for p in _catalogue()}
    roles = {}
    for name, spec in CORE_ROLES.items():
        held = list(spec["permissions"]) + _grants.get(name, [])
        if spec.get("everything"):
            held = sorted(every)
        roles[name] = {
            "label": spec["label"],
            "description": spec["description"],
            "permissions": _clean(held),
            "system": spec["system"],
            "locked": list(spec["locked"]),
        }
    return roles


def _clean(keys: Sequence[str]) -> List[str]:
    wanted = {str(k) for k in keys or []}
    return [p.key for p in _catalogue() if p.key in wanted]


def __getattr__(name: str):
    """ALL, CATALOGUE, BY_KEY, GROUPS and BUILT_IN are assembled on first read.

    Deferred rather than computed at import time, because a module cannot
    register its permissions until it has been imported, and importing every
    module from here would be a cycle.
    """
    if name in ("ALL", "CATALOGUE", "BY_KEY", "GROUPS", "BUILT_IN"):
        _ensure()
        if name == "CATALOGUE":
            return _catalogue()
        if name == "ALL":
            return {p.key for p in _catalogue()}
        if name == "BY_KEY":
            return {p.key: p for p in _catalogue()}
        if name == "GROUPS":
            return _group_order()
        return _built_in()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def clean(keys: Sequence[str]) -> List[str]:
    """Keep only permissions something actually checks, in catalogue order."""
    _ensure()
    return _clean(keys)


def unknown(keys: Sequence[str]) -> List[str]:
    _ensure()
    every: Set[str] = {p.key for p in _catalogue()}
    return sorted({str(k) for k in keys or []} - every)


def capabilities(held: Sequence[str]) -> Dict[str, bool]:
    """The `can` block: every module's flags, resolved against what a role holds."""
    _ensure()
    have = set(held or [])
    flags = {
        "manage_users": USERS_MANAGE in have,
        # Its own flag: editing an account and removing one are different
        # things, and the Users page offers them separately.
        "delete_users": USERS_DELETE in have,
        "manage_roles": ROLES_MANAGE in have,
    }
    flags.update({name: key in have for name, key in _capabilities.items()})
    return flags


def as_catalogue() -> List[Dict[str, object]]:
    """For the screen that assigns them."""
    _ensure()
    cat = _catalogue()
    return [
        {
            "group": group,
            "permissions": [
                {"key": p.key, "label": p.label, "detail": p.detail}
                for p in cat if p.group == group
            ],
        }
        for group in _group_order()
    ]
