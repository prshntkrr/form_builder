"""Roles: a name, a description, and a set of permissions.

Roles are created here; the permissions they can hold come from
`permissions.CATALOGUE`, which is fixed in code. Assigning a permission nothing
checks would grant nothing, so unknown keys are rejected rather than stored.

Two guards keep an installation reachable:

  * a built-in role cannot be deleted,
  * the admin role cannot lose the permissions that manage access, and the last
    role that can manage roles cannot lose that permission either.
"""
import logging
import re
from typing import Any, Dict, List, Optional, Sequence

from . import permissions
from .database import transaction

logger = logging.getLogger(__name__)

ROLE_ID_PREFIX = "ROL"
ADMIN_ROLE = "admin"


class RoleError(RuntimeError):
    """The role cannot be created, changed or removed as asked."""


class RoleNotFound(LookupError):
    pass


def _next_role_id(cur) -> str:
    cur.execute(
        f"""
        SELECT COALESCE(MAX(CAST(SUBSTRING(role_id, {len(ROLE_ID_PREFIX) + 1}) AS INTEGER)), 0) + 1
               AS next_no
        FROM app_role WHERE role_id ~ %s
        """,
        (f"^{ROLE_ID_PREFIX}[0-9]+$",),
    )
    return f"{ROLE_ID_PREFIX}{int(cur.fetchone()['next_no']):05d}"


def slug(text: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "_", str(text or "").strip().lower()).strip("_")
    return value[:50]


def _row(cur, role_id: str) -> Optional[Dict[str, Any]]:
    cur.execute(
        """
        SELECT r.*,
               COALESCE(
                   (SELECT array_agg(p.permission ORDER BY p.permission)
                    FROM role_permission p WHERE p.role_id = r.role_id),
                   ARRAY[]::varchar[]
               ) AS permissions,
               (SELECT COUNT(*) FROM app_user u
                 WHERE u.role_id = r.role_id AND u.is_active) AS user_count
        FROM app_role r WHERE r.role_id = %s
        """,
        (role_id,),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def _public(row: Dict[str, Any]) -> Dict[str, Any]:
    built_in = permissions.BUILT_IN.get(row["name"], {})
    return {
        "role_id": row["role_id"],
        "name": row["name"],
        "label": row["label"],
        "description": row.get("description") or "",
        "is_system": bool(row.get("is_system")),
        "permissions": permissions.clean(list(row.get("permissions") or [])),
        "locked_permissions": list(built_in.get("locked") or []),
        "user_count": int(row.get("user_count") or 0),
        "created_by": row.get("created_by"),
    }


def list_roles() -> List[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute(
            """
            SELECT r.*,
                   COALESCE(
                       (SELECT array_agg(p.permission ORDER BY p.permission)
                        FROM role_permission p WHERE p.role_id = r.role_id),
                       ARRAY[]::varchar[]
                   ) AS permissions,
                   (SELECT COUNT(*) FROM app_user u
                     WHERE u.role_id = r.role_id AND u.is_active) AS user_count
            FROM app_role r
            ORDER BY r.is_system DESC, r.label
            """
        )
        return [_public(dict(r)) for r in cur.fetchall()]


def get_role(role_id: str) -> Dict[str, Any]:
    with transaction() as cur:
        row = _row(cur, role_id)
        if not row:
            raise RoleNotFound(f"No role {role_id}")
        return _public(row)


def get_by_name(name: str) -> Optional[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute("SELECT role_id FROM app_role WHERE name = %s", (slug(name),))
        row = cur.fetchone()
        return _public(_row(cur, row["role_id"])) if row else None


def _set_permissions(cur, role_id: str, keys: Sequence[str]) -> List[str]:
    wanted = permissions.clean(keys)
    cur.execute("DELETE FROM role_permission WHERE role_id = %s", (role_id,))
    for key in wanted:
        cur.execute(
            "INSERT INTO role_permission (role_id, permission) VALUES (%s, %s)",
            (role_id, key),
        )
    return wanted


def _roles_that_manage_roles(cur, excluding: Optional[str] = None) -> int:
    """How many other roles can still manage roles *and* have someone in them."""
    cur.execute(
        """
        SELECT COUNT(DISTINCT r.role_id) AS n
        FROM   app_role r
        JOIN   role_permission p ON p.role_id = r.role_id AND p.permission = %s
        JOIN   app_user u ON u.role_id = r.role_id AND u.is_active
        WHERE  (%s IS NULL OR r.role_id <> %s)
        """,
        (permissions.ROLES_MANAGE, excluding, excluding),
    )
    return int(cur.fetchone()["n"])


def create_role(
    label: str,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    permission_keys: Optional[Sequence[str]] = None,
    created_by: Optional[str] = None,
) -> Dict[str, Any]:
    label = str(label or "").strip()[:80]
    if not label:
        raise RoleError("A role needs a name")

    resolved = slug(name or label)
    if not resolved:
        raise RoleError("That name cannot be used")

    unknown = permissions.unknown(permission_keys or [])
    if unknown:
        raise RoleError(f"Unknown permission(s): {', '.join(unknown)}")

    with transaction() as cur:
        cur.execute("SELECT 1 FROM app_role WHERE name = %s", (resolved,))
        if cur.fetchone():
            raise RoleError(f"A role called '{resolved}' already exists")

        role_id = _next_role_id(cur)
        cur.execute(
            """
            INSERT INTO app_role (role_id, name, label, description, is_system, created_by)
            VALUES (%s, %s, %s, %s, FALSE, %s)
            """,
            (role_id, resolved, label, (description or "").strip() or None, created_by),
        )
        _set_permissions(cur, role_id, permission_keys or [])
        created = _row(cur, role_id)

    logger.info("Created role '%s' with %d permission(s)",
                resolved, len(created["permissions"]))
    return _public(created)


def update_role(
    role_id: str,
    *,
    label: Optional[str] = None,
    description: Optional[str] = None,
    permission_keys: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    with transaction() as cur:
        existing = _row(cur, role_id)
        if not existing:
            raise RoleNotFound(f"No role {role_id}")

        if permission_keys is not None:
            unknown = permissions.unknown(permission_keys)
            if unknown:
                raise RoleError(f"Unknown permission(s): {', '.join(unknown)}")

            wanted = set(permissions.clean(permission_keys))
            locked = set(permissions.BUILT_IN.get(existing["name"], {}).get("locked") or [])
            missing = locked - wanted
            if missing:
                raise RoleError(
                    f"The {existing['label']} role must keep: {', '.join(sorted(missing))}"
                )

            # Somebody must always be able to hand out roles.
            losing = (permissions.ROLES_MANAGE in (existing["permissions"] or [])
                      and permissions.ROLES_MANAGE not in wanted)
            if losing and _roles_that_manage_roles(cur, excluding=role_id) == 0:
                raise RoleError(
                    "This is the only role that can manage roles — give another role "
                    "that permission first"
                )

            _set_permissions(cur, role_id, permission_keys)

        cur.execute(
            """
            UPDATE app_role
               SET label       = COALESCE(%s, label),
                   description = COALESCE(%s, description),
                   updated_on  = CURRENT_TIMESTAMP
             WHERE role_id = %s
            """,
            (str(label).strip()[:80] if label else None,
             description.strip() if description is not None else None,
             role_id),
        )
        updated = _row(cur, role_id)

        # A changed role changes what its holders may do, right now.
        cur.execute(
            "DELETE FROM user_session WHERE user_id IN "
            "(SELECT user_id FROM app_user WHERE role_id = %s)",
            (role_id,),
        )

    logger.info("Updated role '%s'", updated["name"])
    return _public(updated)


def delete_role(role_id: str, reassign_to: Optional[str] = None) -> Dict[str, Any]:
    """Remove a role. Anyone holding it must be moved to another one first."""
    with transaction() as cur:
        existing = _row(cur, role_id)
        if not existing:
            raise RoleNotFound(f"No role {role_id}")
        if existing["is_system"]:
            raise RoleError(f"'{existing['label']}' is a built-in role and cannot be deleted")

        cur.execute(
            "SELECT COUNT(*) AS n FROM app_user WHERE role_id = %s", (role_id,))
        holders = int(cur.fetchone()["n"])

        if holders and not reassign_to:
            raise RoleError(
                f"{holders} account(s) still have this role — choose a role to move them to"
            )

        if holders:
            target = _row(cur, reassign_to)
            if not target:
                raise RoleNotFound(f"No role {reassign_to}")
            cur.execute(
                "UPDATE app_user SET role_id = %s, updated_on = CURRENT_TIMESTAMP "
                "WHERE role_id = %s",
                (reassign_to, role_id),
            )
            cur.execute(
                "DELETE FROM user_session WHERE user_id IN "
                "(SELECT user_id FROM app_user WHERE role_id = %s)",
                (reassign_to,),
            )

        cur.execute("DELETE FROM app_role WHERE role_id = %s", (role_id,))

    logger.info("Deleted role '%s' (%d account(s) reassigned)", existing["name"], holders)
    return {"role_id": role_id, "deleted": True, "reassigned": holders}


def ensure_built_in(created_by: str = "setup") -> List[str]:
    """Create the roles an installation starts with, once.

    Only ever adds. An admin who has narrowed a built-in role keeps their choice.
    """
    made: List[str] = []
    with transaction() as cur:
        for name, spec in permissions.BUILT_IN.items():
            cur.execute("SELECT role_id FROM app_role WHERE name = %s", (name,))
            if cur.fetchone():
                continue

            role_id = _next_role_id(cur)
            cur.execute(
                """
                INSERT INTO app_role (role_id, name, label, description, is_system, created_by)
                VALUES (%s, %s, %s, %s, TRUE, %s)
                """,
                (role_id, name, spec["label"], spec["description"], created_by),
            )
            _set_permissions(cur, role_id, spec["permissions"])
            made.append(name)

    if made:
        logger.info("Created built-in role(s): %s", ", ".join(made))
    return made
