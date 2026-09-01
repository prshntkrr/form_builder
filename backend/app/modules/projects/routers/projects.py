"""Projects, their members, their groups, and who each form is for.

Thin on purpose. Every route asks `access` one question and then calls a
service; there is no authorization decision written out here, and no route
tests a role name.
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import auth_service
from app.core.deps import current_user, needs
from app.modules.projects import access, project_service
from app.modules.projects.permissions import (
    FORMS_ASSIGN,
    FORMS_VIEW_ALL,
    PROJECT_GROUPS_MANAGE,
    PROJECT_MEMBERS_MANAGE,
    PROJECT_VIEW,
    PROJECTS_MANAGE,
)

router = APIRouter(prefix="/api/projects", tags=["projects"])


class CreateProjectRequest(BaseModel):
    name: str
    description: str = ""


class UpdateProjectRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None


class AddMemberRequest(BaseModel):
    user_id: str
    role_id: str = Field(..., description="The role this account holds *in this project*")


class UpdateMemberRequest(BaseModel):
    role_id: Optional[str] = None
    status: Optional[str] = None


class CreateGroupRequest(BaseModel):
    name: str
    description: str = ""


class GroupMemberRequest(BaseModel):
    user_id: str


class AssignRequest(BaseModel):
    kind: str = Field(..., description="everyone, user or group")
    user_id: Optional[str] = None
    group_id: Optional[str] = None


def _sent(req: BaseModel) -> Dict[str, Any]:
    return req.model_dump(exclude_unset=True)


def _handle(exc: Exception):
    if isinstance(exc, project_service.NotFound):
        raise HTTPException(status_code=404, detail=str(exc))
    raise HTTPException(status_code=400, detail=str(exc))


# --------------------------------------------------------------------------- #
# projects
# --------------------------------------------------------------------------- #
@router.get("")
def index(user: Dict[str, Any] = Depends(current_user)):
    """The projects this account can reach — its own, and no others."""
    return {"projects": project_service.list_projects(access.projects_for(user))}


@router.post("", status_code=201)
def create(req: CreateProjectRequest, user: Dict[str, Any] = Depends(needs(PROJECTS_MANAGE))):
    """A new project. Whoever makes it becomes its manager.

    Otherwise the project would exist with nobody able to open it: creating one
    is a system-wide permission, but everything *inside* it is earned by
    membership, and the creator has none yet.
    """
    try:
        project = project_service.create_project(
            req.name, req.description, created_by=auth_service.display_name(user))
    except project_service.ProjectError as exc:
        _handle(exc)

    from app.core.database import transaction
    with transaction() as cur:
        cur.execute("SELECT role_id FROM app_role WHERE name = 'project_manager'")
        role = cur.fetchone()

    if role:
        project_service.add_member(
            project["project_id"], user["user_id"], role["role_id"],
            added_by=auth_service.display_name(user))

    return project_service.get_project(project["project_id"])


@router.get("/roles")
def project_roles(user: Dict[str, Any] = Depends(current_user)):
    """The roles a project membership can carry.

    Derived, not listed: a role qualifies by holding at least one permission
    from the projects catalogue. So an installation that invents "Field
    supervisor" and gives it project permissions gets it here without anybody
    editing this file, and nothing hard-codes the three seeded names.

    Names and labels only — the same catalogue `/api/auth/me` already reports.
    """
    from app.core.database import transaction
    from app.modules.projects import permissions as catalogue

    with transaction() as cur:
        cur.execute(
            """
            SELECT r.role_id, r.name, r.label, r.description,
                   ARRAY_AGG(rp.permission ORDER BY rp.permission) AS permissions
            FROM   app_role r
            JOIN   role_permission rp ON rp.role_id = r.role_id
            GROUP  BY r.role_id, r.name, r.label, r.description
            ORDER  BY r.label
            """
        )
        roles = [dict(row) for row in cur.fetchall()]

    # Only roles that mean nothing outside a project. The administrator holds
    # every permission there is, project ones included, and belongs on the
    # Users page rather than in a membership dropdown.
    return {"roles": [r for r in roles if catalogue.is_project_role(r["permissions"])]}


@router.get("/{project_id}")
def detail(project_id: str,
           user: Dict[str, Any] = Depends(access.needs_in_project(PROJECT_VIEW))):
    project = project_service.get_project(project_id)
    project["your_permissions"] = sorted(access.permissions_in(user, project_id))
    return project


@router.patch("/{project_id}")
def update(project_id: str, req: UpdateProjectRequest,
           user: Dict[str, Any] = Depends(access.needs_in_project(PROJECT_MEMBERS_MANAGE))):
    try:
        return project_service.update_project(project_id, _sent(req))
    except (project_service.ProjectError, project_service.NotFound) as exc:
        _handle(exc)


# --------------------------------------------------------------------------- #
# members
# --------------------------------------------------------------------------- #
@router.get("/{project_id}/members")
def members(project_id: str,
            user: Dict[str, Any] = Depends(access.needs_in_project(PROJECT_VIEW))):
    return {"members": project_service.list_members(project_id)}


@router.post("/{project_id}/members", status_code=201)
def add_member(project_id: str, req: AddMemberRequest,
               user: Dict[str, Any] = Depends(
                   access.needs_in_project(PROJECT_MEMBERS_MANAGE))):
    try:
        return project_service.add_member(
            project_id, req.user_id, req.role_id,
            added_by=auth_service.display_name(user))
    except (project_service.ProjectError, project_service.NotFound) as exc:
        _handle(exc)


@router.patch("/{project_id}/members/{member_id}")
def update_member(project_id: str, member_id: int, req: UpdateMemberRequest,
                  user: Dict[str, Any] = Depends(
                      access.needs_in_project(PROJECT_MEMBERS_MANAGE))):
    try:
        return project_service.update_member(project_id, member_id, _sent(req))
    except (project_service.ProjectError, project_service.NotFound) as exc:
        _handle(exc)


@router.delete("/{project_id}/members/{member_id}")
def remove_member(project_id: str, member_id: int,
                  user: Dict[str, Any] = Depends(
                      access.needs_in_project(PROJECT_MEMBERS_MANAGE))):
    if not project_service.remove_member(project_id, member_id):
        raise HTTPException(status_code=404, detail=f"No member {member_id} in {project_id}")
    return {"member_id": member_id, "removed": True}


@router.get("/{project_id}/candidates")
def candidates(
    project_id: str,
    q: Optional[str] = None,
    user: Dict[str, Any] = Depends(access.needs_in_project(PROJECT_MEMBERS_MANAGE)),
):
    """Accounts that could be added to this project.

    Somebody has to be nameable before they can be added, and listing accounts
    is otherwise `users.manage` — which a project manager has no reason to hold.
    So the list is gated on managing *this project's* members instead, and
    carries only what is needed to pick a person.

    Already-members are left out: adding one twice is refused anyway, and
    offering it is offering a mistake.
    """
    from app.core.database import transaction

    wanted = f"%{(q or '').strip().lower()}%"

    with transaction() as cur:
        cur.execute(
            """
            SELECT u.user_id, u.email, u.full_name
            FROM   app_user u
            WHERE  u.is_active
              AND  NOT EXISTS (SELECT 1 FROM project_member m
                               WHERE m.project_id = %s AND m.user_id = u.user_id)
              AND  (%s = '%%%%' OR lower(u.email) LIKE %s OR lower(u.full_name) LIKE %s)
            ORDER  BY u.full_name, u.email
            LIMIT  50
            """,
            (project_id, wanted, wanted, wanted),
        )
        return {"candidates": [dict(row) for row in cur.fetchall()]}


# --------------------------------------------------------------------------- #
# groups
# --------------------------------------------------------------------------- #
@router.get("/{project_id}/groups")
def groups(project_id: str,
           user: Dict[str, Any] = Depends(access.needs_in_project(PROJECT_VIEW))):
    return {"groups": project_service.list_groups(project_id)}


@router.post("/{project_id}/groups", status_code=201)
def create_group(project_id: str, req: CreateGroupRequest,
                 user: Dict[str, Any] = Depends(
                     access.needs_in_project(PROJECT_GROUPS_MANAGE))):
    try:
        return project_service.create_group(
            project_id, req.name, req.description,
            created_by=auth_service.display_name(user))
    except (project_service.ProjectError, project_service.NotFound) as exc:
        _handle(exc)


@router.get("/{project_id}/groups/{group_id}/members")
def group_members(project_id: str, group_id: str,
                  user: Dict[str, Any] = Depends(access.needs_in_project(PROJECT_VIEW))):
    return {"members": project_service.group_members(project_id, group_id)}


@router.post("/{project_id}/groups/{group_id}/members", status_code=201)
def add_to_group(project_id: str, group_id: str, req: GroupMemberRequest,
                 user: Dict[str, Any] = Depends(
                     access.needs_in_project(PROJECT_GROUPS_MANAGE))):
    try:
        return project_service.add_to_group(project_id, group_id, req.user_id)
    except (project_service.ProjectError, project_service.NotFound) as exc:
        _handle(exc)


@router.delete("/{project_id}/groups/{group_id}/members/{user_id}")
def remove_from_group(project_id: str, group_id: str, user_id: str,
                      user: Dict[str, Any] = Depends(
                          access.needs_in_project(PROJECT_GROUPS_MANAGE))):
    if not project_service.remove_from_group(project_id, group_id, user_id):
        raise HTTPException(status_code=404, detail="That account is not in this group")
    return {"group_id": group_id, "user_id": user_id, "removed": True}


# --------------------------------------------------------------------------- #
# the project's forms
# --------------------------------------------------------------------------- #
@router.get("/{project_id}/forms")
def forms(project_id: str,
          user: Dict[str, Any] = Depends(access.needs_in_project(PROJECT_VIEW))):
    """The project's forms, as this account may see them.

    Somebody holding `forms.view_all` sees the project's forms; anybody else
    sees the ones actually given to them, by name, by group, or to everyone.

    `assignment_count` comes back with each form: a published form nobody has
    been given reaches nobody, and there is no way to tell that from the form
    itself. It is a count, not who — that is `GET /api/forms/{id}/assignments`,
    behind the permission to assign.
    """
    from app.core.database import transaction

    visible = access.visible_form_ids(user, project_id)

    columns = """
        SELECT f.form_id, f.form_title, f.form_description, f.form_status,
               f.updated_on,
               (SELECT COUNT(*) FROM form_assignment a
                WHERE a.form_id = f.form_id) AS assignment_count,
               -- Read from the definition where the relationship already lives.
               -- Nothing here configures one; a screen listing forms just needs
               -- to be able to say which are children of which.
               f.form_json -> 'relationship' ->> 'parent_form_id' AS parent_form_id
        FROM   forms f
    """

    with transaction() as cur:
        if visible is None:
            cur.execute(
                columns + """
                WHERE  f.project_id = %s AND f.form_status <> 'Deleted'
                ORDER  BY f.updated_on DESC NULLS LAST
                """,
                (project_id,),
            )
        elif not visible:
            return {"forms": [], "everything": False}
        else:
            cur.execute(
                columns + """
                WHERE  f.project_id = %s AND f.form_status <> 'Deleted'
                  AND  f.form_id = ANY(%s)
                ORDER  BY f.updated_on DESC NULLS LAST
                """,
                (project_id, visible),
            )
        found = [dict(row) for row in cur.fetchall()]

    return {"forms": found, "everything": visible is None}


# --------------------------------------------------------------------------- #
# assignments
# --------------------------------------------------------------------------- #
assignments_router = APIRouter(prefix="/api/forms", tags=["form assignments"])


def _may_assign(form_id: str, user: Dict[str, Any], permission: str) -> str:
    """The project a form is in, once this account is allowed to act on it."""
    project_id = project_service.project_of_form(form_id)
    if not project_id:
        raise HTTPException(
            status_code=404,
            detail=f"Form '{form_id}' does not belong to a project",
        )
    access.require(user, permission, project_id)
    return project_id


@assignments_router.get("/{form_id}/assignments")
def assignments(form_id: str, user: Dict[str, Any] = Depends(current_user)):
    _may_assign(form_id, user, FORMS_VIEW_ALL)
    return {"assignments": project_service.list_assignments(form_id)}


@assignments_router.post("/{form_id}/assignments", status_code=201)
def assign(form_id: str, req: AssignRequest, user: Dict[str, Any] = Depends(current_user)):
    _may_assign(form_id, user, FORMS_ASSIGN)
    try:
        return project_service.assign_form(
            form_id, req.kind, req.user_id, req.group_id,
            assigned_by=auth_service.display_name(user))
    except (project_service.ProjectError, project_service.NotFound) as exc:
        _handle(exc)


@assignments_router.delete("/{form_id}/assignments/{assignment_id}")
def unassign(form_id: str, assignment_id: int, user: Dict[str, Any] = Depends(current_user)):
    _may_assign(form_id, user, FORMS_ASSIGN)
    if not project_service.unassign_form(form_id, assignment_id):
        raise HTTPException(status_code=404, detail=f"No assignment {assignment_id}")
    return {"assignment_id": assignment_id, "removed": True}
