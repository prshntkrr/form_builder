"""May this account use this dashboard permission — here, in this project?

The project-governs rule: when acting inside a project, the project role is the
sole authority for dashboard permissions. The account role (Standard User,
Editor, …) is irrelevant — what you can do in a project is decided by the role
you hold there (Reviewer, Surveyor, Project manager).

The account role applies only when there is no project context, or when the
projects module is switched off entirely.

Administrators (`projects.view_all`) bypass this naturally: `access.can` already
grants them every project permission, so the project-role check passes for them
without a special case here.

The project a request is judged against is never taken from the account — it is
the project the thing being acted on belongs to:

    a list / a new dashboard / an import   the project on the request
    an existing dashboard                  dashboard.project_id
    a data source                          the form's project, or the registry
"""
from typing import Any, Dict, Optional

from fastapi import Depends, HTTPException, Path, Query

from app.core import auth_service
from app.core.database import transaction
from app.core.deps import current_user

TABULAR_SUFFIX = "_tabular"


def _project_can(user: Dict[str, Any], permission: str, project_id: Optional[str]) -> bool:
    if not project_id:
        return False
    try:
        from app.modules.projects import access
    except Exception:
        # Projects module off: no project side to the rule.
        return False
    return access.can(user, permission, project_id)


def may(user: Dict[str, Any], permission: str, project_id: Optional[str] = None) -> bool:
    """Inside a project the project role decides; outside it the account role does."""
    if project_id:
        return _project_can(user, permission, project_id)
    return auth_service.may(user, permission)


def require(user: Dict[str, Any], permission: str, project_id: Optional[str] = None) -> None:
    if may(user, permission, project_id):
        return
    from app.core import permissions as catalogue
    entry = catalogue.BY_KEY.get(permission)
    raise HTTPException(
        status_code=403,
        detail=(
            f"Your role ({user.get('role_label') or user.get('role')}) cannot do "
            f"this — it needs the '{entry.label if entry else permission}' permission"
        ),
    )


def project_of_dashboard(dashboard_id: str) -> Optional[str]:
    with transaction() as cur:
        cur.execute(
            "SELECT project_id FROM dashboard WHERE dashboard_id = %s",
            (dashboard_id,),
        )
        row = cur.fetchone()
    return (row or {}).get("project_id")


def project_of_table(table_name: str) -> Optional[str]:
    """The project a `_tabular` data source belongs to.

    The registry answers for an Excel upload or an external import; a form table
    is resolved through the form that owns it. None when nothing claims it.
    """
    with transaction() as cur:
        cur.execute(
            "SELECT project_id FROM dashboard_data_source WHERE table_name = %s",
            (table_name,),
        )
        row = cur.fetchone()
        if row:
            return row["project_id"]

        if table_name.endswith(TABULAR_SUFFIX):
            base = table_name[: -len(TABULAR_SUFFIX)]
            cur.execute(
                """
                SELECT project_id FROM forms
                WHERE form_json->>'table_name' = %s
                  AND form_status <> 'Deleted'
                ORDER BY created_on
                LIMIT 1
                """,
                (base,),
            )
            row = cur.fetchone()
            if row:
                return row["project_id"]

    return None


# --------------------------------------------------------------------------- #
# dependencies
# --------------------------------------------------------------------------- #
def needs_in_query(permission: str):
    """Require the permission, judged against the `project_id` query parameter."""

    def dependency(
        project_id: Optional[str] = Query(None),
        user: Dict[str, Any] = Depends(current_user),
    ) -> Dict[str, Any]:
        require(user, permission, project_id)
        return user

    return dependency


def needs_for_dashboard(permission: str):
    """Require the permission in the project the dashboard in the path belongs to."""

    def dependency(
        dashboard_id: str = Path(...),
        user: Dict[str, Any] = Depends(current_user),
    ) -> Dict[str, Any]:
        require(user, permission, project_of_dashboard(dashboard_id))
        return user

    return dependency


def needs_for_table(permission: str):
    """Require the permission in the project the table in the path belongs to."""

    def dependency(
        table_name: str = Path(...),
        user: Dict[str, Any] = Depends(current_user),
    ) -> Dict[str, Any]:
        require(user, permission, project_of_table(table_name))
        return user

    return dependency


def nav_flags(user: Dict[str, Any]) -> Dict[str, bool]:
    """Whether the Dashboards section should appear at all for this account.

    For `/api/auth/me`: an account that can see dashboards only through a project
    it belongs to still needs the section in the nav. Only `view_dashboards` is
    widened here — enough to reveal the section. The per-action flags
    (build / edit / share / import) are deliberately left to the account's own
    role, so a button is shown precisely: the screen asks the project it is
    actually in, through `your_permissions`, which is true only there. Mirrors
    `build_any_forms`, which widens reachability without widening the account.
    """
    try:
        from app.modules.projects import access
        from app.modules.dashboards import permissions as dash
    except Exception:
        return {}

    try:
        return {
            "view_dashboards": bool(
                access.projects_where(user, dash.DASHBOARDS_VIEW)
            ),
        }
    except Exception:
        return {}
