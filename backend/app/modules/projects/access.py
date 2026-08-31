"""May this account do this, in this project?

Every project-scoped decision in the application comes through here. Routes ask
one question and get one answer; none of them tests a role name, and none of
them assembles its own rule out of memberships and assignments. When the rules
change they change once.

    @router.get("/projects/{project_id}/members")
    def members(project_id: str, user = Depends(needs_in_project(MEMBERS_MANAGE))):
        ...

The chain a request is judged on:

    account  ──▶ system-wide role      app_user.role_id
             │      may it create projects, see them all
             │
             └──▶ project membership   project_member.role_id
                    what it may do *here* — and if there is no row,
                    it may do nothing here at all

Two ways to hold a project permission. Ordinary: be a member, and hold it
through the role that membership carries. Exceptional: hold `projects.view_all`
system-wide, which an installation gives to administrators so a support account
can reach a project without being enrolled in it — that one is deliberately
narrow and is the only bypass in the file.
"""
import logging
from typing import Any, Dict, List, Optional, Set

from fastapi import Depends, HTTPException, Path

from app.core import auth_service
from app.core.database import transaction
from app.core.deps import current_user
from app.modules.projects.permissions import PROJECTS_VIEW_ALL

logger = logging.getLogger(__name__)

# What a request is told when it asks about a project it cannot reach.
#
# 404 rather than 403, and on purpose: to somebody outside a project, a project
# they are not in should be indistinguishable from one that does not exist.
# Answering 403 would confirm the id is real, which is a small leak but a real
# one — a member list is worth guessing at. Inside a project the answers are
# ordinary 403s, because there the resource is known to exist.
def _no_such_project(project_id: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"No project '{project_id}'")


def membership(user: Dict[str, Any], project_id: str) -> Optional[Dict[str, Any]]:
    """This account's place in one project, or None if it has none."""
    if not user or not project_id:
        return None

    with transaction() as cur:
        cur.execute(
            """
            SELECT m.member_id, m.project_id, m.user_id, m.role_id, m.status,
                   r.name AS role, r.label AS role_label
            FROM   project_member m
            JOIN   app_role r ON r.role_id = m.role_id
            WHERE  m.project_id = %s AND m.user_id = %s
            """,
            (project_id, user.get("user_id")),
        )
        row = cur.fetchone()

    return dict(row) if row else None


def permissions_in(user: Dict[str, Any], project_id: str) -> Set[str]:
    """Everything this account may do in one project.

    Empty for somebody who is not a member — which is the whole of project
    isolation in one line. A suspended membership is treated as no membership:
    the row is kept so their history reads back, but it grants nothing.
    """
    held: Set[str] = set()

    if auth_service.may(user, PROJECTS_VIEW_ALL):
        # An administrator reaching in from outside. They get what the project's
        # own roles could grant, so nothing here has to special-case them.
        held.update(_every_project_permission())

    place = membership(user, project_id)
    if place and place["status"] == "Active":
        with transaction() as cur:
            cur.execute(
                "SELECT permission FROM role_permission WHERE role_id = %s",
                (place["role_id"],),
            )
            held.update(row["permission"] for row in cur.fetchall())

    return held


def _every_project_permission() -> Set[str]:
    from app.modules.projects import permissions as catalogue
    return {p.key for p in catalogue.CATALOGUE}


def can(user: Dict[str, Any], permission: str, project_id: str) -> bool:
    """The question every route asks."""
    return permission in permissions_in(user, project_id)


def project_exists(project_id: str) -> bool:
    with transaction() as cur:
        cur.execute("SELECT 1 FROM project WHERE project_id = %s", (project_id,))
        return cur.fetchone() is not None


def require(user: Dict[str, Any], permission: str, project_id: str) -> None:
    """Raise unless this account may do this here.

    Not being a member and the project not existing are answered the same way,
    on purpose — see `_no_such_project`.
    """
    held = permissions_in(user, project_id)

    if not held:
        raise _no_such_project(project_id)

    if permission not in held:
        from app.core import permissions as catalogue
        entry = catalogue.BY_KEY.get(permission)
        raise HTTPException(
            status_code=403,
            detail=(
                f"Your role in this project cannot do this — it needs the "
                f"'{entry.label if entry else permission}' permission"
            ),
        )


def needs_in_project(permission: str):
    """A dependency requiring one permission *in the project named in the path*.

    The project id is read from the route, never from a header or a body: what
    a request is judged against has to be the thing it is acting on.
    """

    def dependency(
        project_id: str = Path(...),
        user: Dict[str, Any] = Depends(current_user),
    ) -> Dict[str, Any]:
        require(user, permission, project_id)
        return user

    return dependency


# --------------------------------------------------------------------------- #
# which projects, and which forms
# --------------------------------------------------------------------------- #
def projects_for(user: Dict[str, Any]) -> List[str]:
    """The projects this account can reach at all."""
    if auth_service.may(user, PROJECTS_VIEW_ALL):
        with transaction() as cur:
            cur.execute("SELECT project_id FROM project ORDER BY name")
            return [row["project_id"] for row in cur.fetchall()]

    with transaction() as cur:
        cur.execute(
            """
            SELECT p.project_id
            FROM   project p
            JOIN   project_member m ON m.project_id = p.project_id
            WHERE  m.user_id = %s AND m.status = 'Active'
            ORDER  BY p.name
            """,
            (user.get("user_id"),),
        )
        return [row["project_id"] for row in cur.fetchall()]


def _assigned_form_ids(user: Dict[str, Any], project_id: str) -> List[str]:
    """The project's forms this account was actually given.

    The one query behind every "was this form given to them" question, so
    seeing and filling cannot drift apart in how they read an assignment:

        assigned to everyone in the project
        assigned to them by name
        assigned to a group they are in
    """
    with transaction() as cur:
        cur.execute(
            """
            SELECT DISTINCT f.form_id
            FROM   forms f
            JOIN   form_assignment a ON a.form_id = f.form_id
            LEFT   JOIN project_group_member gm
                   ON gm.group_id = a.group_id AND gm.user_id = %(user)s
            WHERE  f.project_id = %(project)s
              AND  (
                    a.kind = 'everyone'
                 OR (a.kind = 'user'  AND a.user_id = %(user)s)
                 OR (a.kind = 'group' AND gm.user_id IS NOT NULL)
              )
            """,
            {"user": user.get("user_id"), "project": project_id},
        )
        return [row["form_id"] for row in cur.fetchall()]


def visible_form_ids(user: Dict[str, Any], project_id: str) -> Optional[List[str]]:
    """The project's forms this account may *see*, or None for "all of them".

    None rather than a list when the account holds `forms.view_all`, so a caller
    can skip the filter entirely instead of building an IN clause of every id.

    Otherwise a form is visible when it was actually given to them. A form with
    no assignment is in nobody's list — a form nobody was given is not a form
    everybody gets.

    Seeing is not filling. Reviewing the project's work means reading every form
    in it, so a reviewer holds `forms.view_all`; that must not put those forms in
    their list of things to answer. What may be answered is
    `fillable_form_ids`, and the two are asked separately everywhere.
    """
    from app.modules.projects.permissions import FORMS_VIEW_ALL

    if can(user, FORMS_VIEW_ALL, project_id):
        return None

    return _assigned_form_ids(user, project_id)


def fillable_form_ids(user: Dict[str, Any], project_id: str) -> Optional[List[str]]:
    """The project's forms this account may *answer*, or None for "all of them".

    Two conditions, and both are required:

        `project.forms.fill`   the role held *in this project* says this account
                               is one of the people who collect data at all
        an assignment          and this particular form was given to them

    A role that can see every form but cannot fill any — a reviewer — gets an
    empty list however the forms are assigned, including an `everyone`
    assignment. `everyone` still means everyone in the project it is asked
    about; what changed is that being handed a form is no longer on its own a
    licence to answer it.

    None is returned only for somebody who may fill *and* may see every form in
    the project, which is the manager's case: they answer their own project's
    forms without having to assign the forms to themselves first.
    """
    from app.modules.projects.permissions import FORMS_FILL, FORMS_VIEW_ALL

    if not can(user, FORMS_FILL, project_id):
        return []

    if can(user, FORMS_VIEW_ALL, project_id):
        return None

    return _assigned_form_ids(user, project_id)


def may_see_form(user: Dict[str, Any], form_id: str) -> bool:
    """Whether this account may reach one form, wherever it lives.

    The check behind `GET /api/forms/{id}`, `/render` and the submission
    routes. Two entirely separate answers:

        no project    an account permission, `forms.system.view`
        a project     membership of *that* project, and what it was assigned to

    Neither reaches the other. A Project Manager holds project permissions in
    one project and no system permission at all, so a system form is as closed
    to them as another project's is.
    """
    with transaction() as cur:
        cur.execute("SELECT project_id FROM forms WHERE form_id = %s", (form_id,))
        row = cur.fetchone()

    if row is None:
        return False

    project_id = row["project_id"]

    if not project_id:
        # A system form: it belongs to no project, so no project membership has
        # anything to say about it. It takes an account permission of its own —
        # being a manager of one project is not a way in here.
        from app.core import auth_service
        return auth_service.may(user, "forms.system.view")

    visible = visible_form_ids(user, project_id)
    if visible is None:
        return bool(permissions_in(user, project_id))
    return form_id in visible


def may_fill_form(user: Dict[str, Any], form_id: str) -> bool:
    """Whether this account may open one form to answer it, and submit it.

    The check behind `/render` and `POST /submissions`, and the same answer the
    fillable list is built from — so a form that is not offered cannot be
    reached by typing its URL either.

    Separate from `may_see_form` on purpose. Reading a form and adding to its
    data are different things, and a project role granting the first must never
    quietly grant the second.
    """
    with transaction() as cur:
        cur.execute("SELECT project_id FROM forms WHERE form_id = %s", (form_id,))
        row = cur.fetchone()

    if row is None:
        return False

    project_id = row["project_id"]

    if not project_id:
        # A system form, under the account permission it always had. Projects
        # have nothing to say about it in either direction.
        return auth_service.may(user, "forms.system.view")

    fillable = fillable_form_ids(user, project_id)
    # None means every form in this project — and it is only returned to
    # somebody who holds the fill permission here, so there is nothing else to
    # check.
    return True if fillable is None else form_id in fillable


# --------------------------------------------------------------------------- #
# which submissions
#
# The third of the three questions, and deliberately its own pair of functions.
# Seeing a form, filling it in and reviewing what came back are three different
# things, and one helper answering all three is how a reviewer came to be
# offered forms to fill.
#
#     visible_form_ids     what may be SEEN
#     fillable_form_ids    what may be FILLED
#     submission_scope     whose answers may be READ, and may they be judged
# --------------------------------------------------------------------------- #
SCOPE_ALL = "all"
SCOPE_OWN = "own"


def submission_scope(user: Dict[str, Any], project_id: str) -> Optional[str]:
    """Whose submissions this account may read in one project.

    `all` for somebody holding `project.submissions.view_all` — a reviewer or a
    manager. `own` for anybody else in the project, which is the surveyor
    reading their own work back. None for somebody who is not in the project at
    all, and the caller answers that 404.
    """
    from app.modules.projects.permissions import SUBMISSIONS_VIEW_ALL

    held = permissions_in(user, project_id)
    if not held:
        return None
    return SCOPE_ALL if SUBMISSIONS_VIEW_ALL in held else SCOPE_OWN


def may_review_submissions(user: Dict[str, Any], project_id: str) -> bool:
    """Whether this account may move submissions through review here.

    Separate from reading them: a manager may read every submission in the
    project whether or not the installation left them the review permission,
    and a surveyor reads their own without ever being able to judge one.
    """
    from app.modules.projects.permissions import SUBMISSIONS_REVIEW

    return SUBMISSIONS_REVIEW in permissions_in(user, project_id)


def projects_where(user: Dict[str, Any], permission: str) -> List[str]:
    """The projects in which this account holds one permission.

    For `/api/auth/me`, which has to say what somebody can do *somewhere*
    without being able to say where: the account's own role knows nothing about
    project membership, and asking it would make a project permission into a
    system one.
    """
    return [project_id for project_id in projects_for(user)
            if can(user, permission, project_id)]
