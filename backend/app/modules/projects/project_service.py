"""Projects, their members, their groups, and who each form is for.

All the writing this module does. Routes call these; the rules about who may
call them live in access.py, so this file can be read as "what a project is"
without the authorization mixed through it.
"""
import logging
import re
from typing import Any, Dict, List, Optional

from app.core.database import transaction

logger = logging.getLogger(__name__)

PROJECT_ID_PREFIX = "PRJ"
GROUP_ID_PREFIX = "PGP"

PROJECT_STATUSES = ("Active", "Archived")
MEMBER_STATUSES = ("Active", "Suspended")
ASSIGNMENT_KINDS = ("everyone", "user", "group")


class ProjectError(ValueError):
    """The project, member, group or assignment cannot be saved as asked."""


class NotFound(LookupError):
    pass


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _next_id(cur, table: str, column: str, prefix: str) -> str:
    cur.execute(
        f"""
        SELECT COALESCE(MAX(CAST(SUBSTRING({column}, {len(prefix) + 1}) AS INTEGER)), 0) + 1
               AS next_no
        FROM {table} WHERE {column} ~ %s
        """,
        (f"^{prefix}[0-9]+$",),
    )
    return f"{prefix}{int(cur.fetchone()['next_no']):05d}"


# --------------------------------------------------------------------------- #
# projects
# --------------------------------------------------------------------------- #
def create_project(name: str, description: str = "", created_by: str = "") -> Dict[str, Any]:
    name = _text(name)
    if not name:
        raise ProjectError("A project needs a name.")

    with transaction() as cur:
        project_id = _next_id(cur, "project", "project_id", PROJECT_ID_PREFIX)
        cur.execute(
            """
            INSERT INTO project (project_id, name, description, created_by)
            VALUES (%s, %s, %s, %s)
            """,
            (project_id, name, _text(description), _text(created_by)),
        )

    logger.info("Created project %s (%s)", project_id, name)
    return get_project(project_id)


def get_project(project_id: str) -> Dict[str, Any]:
    with transaction() as cur:
        cur.execute(
            """
            SELECT p.*,
                   (SELECT COUNT(*) FROM project_member m
                    WHERE m.project_id = p.project_id) AS member_count,
                   (SELECT COUNT(*) FROM forms f
                    WHERE f.project_id = p.project_id
                      AND f.form_status <> 'Deleted')  AS form_count
            FROM   project p WHERE p.project_id = %s
            """,
            (project_id,),
        )
        row = cur.fetchone()

    if row is None:
        raise NotFound(f"No project '{project_id}'")
    return dict(row)


def list_projects(project_ids: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """The named projects, or every project when `project_ids` is None.

    Callers pass what `access.projects_for` gave them, so this never has to
    decide who may see what.
    """
    if project_ids is not None and not project_ids:
        return []

    clause = "" if project_ids is None else "WHERE p.project_id = ANY(%s)"
    params = [] if project_ids is None else [project_ids]

    with transaction() as cur:
        cur.execute(
            f"""
            SELECT p.*,
                   (SELECT COUNT(*) FROM project_member m
                    WHERE m.project_id = p.project_id) AS member_count,
                   (SELECT COUNT(*) FROM forms f
                    WHERE f.project_id = p.project_id
                      AND f.form_status <> 'Deleted')  AS form_count
            FROM   project p
            {clause}
            ORDER  BY p.status, p.name
            """,
            params,
        )
        return [dict(row) for row in cur.fetchall()]


def update_project(project_id: str, changes: Dict[str, Any]) -> Dict[str, Any]:
    get_project(project_id)

    sets, params = [], []

    if "name" in changes:
        name = _text(changes["name"])
        if not name:
            raise ProjectError("A project needs a name.")
        sets.append("name = %s")
        params.append(name)

    if "description" in changes:
        sets.append("description = %s")
        params.append(_text(changes["description"]))

    if "status" in changes:
        status = _text(changes["status"])
        if status not in PROJECT_STATUSES:
            raise ProjectError(f"Status must be one of: {', '.join(PROJECT_STATUSES)}")
        sets.append("status = %s")
        params.append(status)

    if not sets:
        return get_project(project_id)

    sets.append("updated_on = CURRENT_TIMESTAMP")
    params.append(project_id)

    with transaction() as cur:
        cur.execute(f"UPDATE project SET {', '.join(sets)} WHERE project_id = %s", params)

    return get_project(project_id)


# --------------------------------------------------------------------------- #
# members
# --------------------------------------------------------------------------- #
def list_members(project_id: str) -> List[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute(
            """
            SELECT m.member_id, m.user_id, m.role_id, m.status, m.added_on, m.added_by,
                   u.email, u.full_name, r.name AS role, r.label AS role_label
            FROM   project_member m
            JOIN   app_user u ON u.user_id = m.user_id
            JOIN   app_role r ON r.role_id = m.role_id
            WHERE  m.project_id = %s
            ORDER  BY u.full_name, u.email
            """,
            (project_id,),
        )
        return [dict(row) for row in cur.fetchall()]


def add_member(project_id: str, user_id: str, role_id: str,
               added_by: str = "") -> Dict[str, Any]:
    """Put somebody in a project, with the role they hold there.

    The same account in another project is a separate row with its own role —
    that is the whole reason roles are not on the account.
    """
    with transaction() as cur:
        cur.execute("SELECT 1 FROM project WHERE project_id = %s", (project_id,))
        if not cur.fetchone():
            raise NotFound(f"No project '{project_id}'")

        cur.execute("SELECT 1 FROM app_user WHERE user_id = %s", (user_id,))
        if not cur.fetchone():
            raise ProjectError(f"There is no account '{user_id}'.")

        cur.execute("SELECT 1 FROM app_role WHERE role_id = %s", (role_id,))
        if not cur.fetchone():
            raise ProjectError(f"There is no role '{role_id}'.")

        cur.execute(
            "SELECT 1 FROM project_member WHERE project_id = %s AND user_id = %s",
            (project_id, user_id),
        )
        if cur.fetchone():
            raise ProjectError(
                "That account is already in this project. Change the role it holds "
                "rather than adding it again."
            )

        cur.execute(
            """
            INSERT INTO project_member (project_id, user_id, role_id, added_by)
            VALUES (%s, %s, %s, %s)
            """,
            (project_id, user_id, role_id, _text(added_by)),
        )

    return {"project_id": project_id, "user_id": user_id, "role_id": role_id}


def update_member(project_id: str, member_id: int, changes: Dict[str, Any]) -> Dict[str, Any]:
    with transaction() as cur:
        cur.execute(
            "SELECT 1 FROM project_member WHERE project_id = %s AND member_id = %s",
            (project_id, member_id),
        )
        if not cur.fetchone():
            raise NotFound(f"No member {member_id} in {project_id}")

        sets, params = [], []

        if "role_id" in changes:
            cur.execute("SELECT 1 FROM app_role WHERE role_id = %s", (changes["role_id"],))
            if not cur.fetchone():
                raise ProjectError(f"There is no role '{changes['role_id']}'.")
            sets.append("role_id = %s")
            params.append(changes["role_id"])

        if "status" in changes:
            status = _text(changes["status"])
            if status not in MEMBER_STATUSES:
                raise ProjectError(f"Status must be one of: {', '.join(MEMBER_STATUSES)}")
            sets.append("status = %s")
            params.append(status)

        if sets:
            params.extend([project_id, member_id])
            cur.execute(
                f"UPDATE project_member SET {', '.join(sets)} "
                f"WHERE project_id = %s AND member_id = %s",
                params,
            )

    return {"project_id": project_id, "member_id": member_id, **changes}


def remove_member(project_id: str, member_id: int) -> bool:
    with transaction() as cur:
        cur.execute(
            "DELETE FROM project_member WHERE project_id = %s AND member_id = %s",
            (project_id, member_id),
        )
        return cur.rowcount > 0


# --------------------------------------------------------------------------- #
# groups
# --------------------------------------------------------------------------- #
def list_groups(project_id: str) -> List[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute(
            """
            SELECT g.*,
                   (SELECT COUNT(*) FROM project_group_member m
                    WHERE m.group_id = g.group_id) AS member_count
            FROM   project_group g
            WHERE  g.project_id = %s
            ORDER  BY g.name
            """,
            (project_id,),
        )
        return [dict(row) for row in cur.fetchall()]


def create_group(project_id: str, name: str, description: str = "",
                 created_by: str = "") -> Dict[str, Any]:
    name = _text(name)
    if not name:
        raise ProjectError("A group needs a name.")

    with transaction() as cur:
        cur.execute("SELECT 1 FROM project WHERE project_id = %s", (project_id,))
        if not cur.fetchone():
            raise NotFound(f"No project '{project_id}'")

        cur.execute(
            "SELECT 1 FROM project_group WHERE project_id = %s AND lower(name) = lower(%s)",
            (project_id, name),
        )
        if cur.fetchone():
            raise ProjectError(f"This project already has a group called '{name}'.")

        group_id = _next_id(cur, "project_group", "group_id", GROUP_ID_PREFIX)
        cur.execute(
            """
            INSERT INTO project_group (group_id, project_id, name, description, created_by)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (group_id, project_id, name, _text(description), _text(created_by)),
        )

    return {"group_id": group_id, "project_id": project_id, "name": name,
            "description": _text(description), "member_count": 0}


def group_members(project_id: str, group_id: str) -> List[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute(
            """
            SELECT m.user_id, m.added_on, u.email, u.full_name
            FROM   project_group_member m
            JOIN   app_user u ON u.user_id = m.user_id
            JOIN   project_group g ON g.group_id = m.group_id
            WHERE  g.project_id = %s AND m.group_id = %s
            ORDER  BY u.full_name, u.email
            """,
            (project_id, group_id),
        )
        return [dict(row) for row in cur.fetchall()]


def add_to_group(project_id: str, group_id: str, user_id: str) -> Dict[str, Any]:
    """A group is a team inside a project, so only members of it can join.

    Otherwise a form assigned to a group could reach somebody who is not in the
    project at all, which is the boundary this whole module exists to keep.
    """
    with transaction() as cur:
        cur.execute(
            "SELECT 1 FROM project_group WHERE group_id = %s AND project_id = %s",
            (group_id, project_id),
        )
        if not cur.fetchone():
            raise NotFound(f"No group '{group_id}' in {project_id}")

        cur.execute(
            "SELECT 1 FROM project_member WHERE project_id = %s AND user_id = %s",
            (project_id, user_id),
        )
        if not cur.fetchone():
            raise ProjectError(
                "That account is not in this project, so it cannot be in one of its "
                "groups. Add it to the project first."
            )

        cur.execute(
            """
            INSERT INTO project_group_member (group_id, user_id) VALUES (%s, %s)
            ON CONFLICT (group_id, user_id) DO NOTHING
            """,
            (group_id, user_id),
        )

    return {"group_id": group_id, "user_id": user_id}


def remove_from_group(project_id: str, group_id: str, user_id: str) -> bool:
    with transaction() as cur:
        cur.execute(
            """
            DELETE FROM project_group_member m
            USING  project_group g
            WHERE  g.group_id = m.group_id AND g.project_id = %s
              AND  m.group_id = %s AND m.user_id = %s
            """,
            (project_id, group_id, user_id),
        )
        return cur.rowcount > 0


# --------------------------------------------------------------------------- #
# form assignments
# --------------------------------------------------------------------------- #
def list_assignments(form_id: str) -> List[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute(
            """
            SELECT a.assignment_id, a.kind, a.user_id, a.group_id,
                   a.assigned_on, a.assigned_by,
                   u.email, u.full_name, g.name AS group_name
            FROM   form_assignment a
            LEFT   JOIN app_user u ON u.user_id = a.user_id
            LEFT   JOIN project_group g ON g.group_id = a.group_id
            WHERE  a.form_id = %s
            ORDER  BY a.kind, g.name, u.full_name
            """,
            (form_id,),
        )
        return [dict(row) for row in cur.fetchall()]


def assign_form(form_id: str, kind: str, user_id: Optional[str] = None,
                group_id: Optional[str] = None, assigned_by: str = "") -> Dict[str, Any]:
    """Give a form to everyone in its project, to one person, or to one group.

    An assignment is a relationship. The form is never copied, so correcting it
    corrects what everybody sees at once.
    """
    kind = _text(kind).lower()
    if kind not in ASSIGNMENT_KINDS:
        raise ProjectError(f"Kind must be one of: {', '.join(ASSIGNMENT_KINDS)}")

    with transaction() as cur:
        cur.execute("SELECT project_id FROM forms WHERE form_id = %s", (form_id,))
        row = cur.fetchone()
        if row is None:
            raise NotFound(f"No form '{form_id}'")

        project_id = row["project_id"]
        if not project_id:
            raise ProjectError(
                "This form does not belong to a project, so there is nobody to assign "
                "it to. Move it into a project first."
            )

        if kind == "user":
            if not user_id:
                raise ProjectError("Assigning to a person needs that person.")
            cur.execute(
                "SELECT 1 FROM project_member WHERE project_id = %s AND user_id = %s",
                (project_id, user_id),
            )
            if not cur.fetchone():
                raise ProjectError(
                    "That account is not in this form's project, so the form cannot "
                    "be given to it."
                )
            group_id = None

        elif kind == "group":
            if not group_id:
                raise ProjectError("Assigning to a group needs that group.")
            cur.execute(
                "SELECT 1 FROM project_group WHERE group_id = %s AND project_id = %s",
                (group_id, project_id),
            )
            if not cur.fetchone():
                raise ProjectError("That group is not in this form's project.")
            user_id = None

        else:
            user_id = group_id = None

        cur.execute(
            """
            INSERT INTO form_assignment (form_id, kind, user_id, group_id, assigned_by)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
            RETURNING assignment_id
            """,
            (form_id, kind, user_id, group_id, _text(assigned_by)),
        )
        made = cur.fetchone()

    return {"form_id": form_id, "kind": kind, "user_id": user_id, "group_id": group_id,
            "assignment_id": made["assignment_id"] if made else None}


def unassign_form(form_id: str, assignment_id: int) -> bool:
    with transaction() as cur:
        cur.execute(
            "DELETE FROM form_assignment WHERE form_id = %s AND assignment_id = %s",
            (form_id, assignment_id),
        )
        return cur.rowcount > 0


def project_of_form(form_id: str) -> Optional[str]:
    with transaction() as cur:
        cur.execute("SELECT project_id FROM forms WHERE form_id = %s", (form_id,))
        row = cur.fetchone()
    return (row or {}).get("project_id")


def set_form_project(form_id: str, project_id: Optional[str]) -> None:
    """Move a form into a project, or out of every project.

    Out is what a form built before projects existed already is; it stays
    reachable through the system-wide form permissions.
    """
    with transaction() as cur:
        if project_id:
            cur.execute("SELECT 1 FROM project WHERE project_id = %s", (project_id,))
            if not cur.fetchone():
                raise NotFound(f"No project '{project_id}'")

        cur.execute("UPDATE forms SET project_id = %s WHERE form_id = %s",
                    (project_id, form_id))
