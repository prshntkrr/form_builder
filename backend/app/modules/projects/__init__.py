"""Projects: who is in one, what they may do there, and what belongs to it.

The unit of access in this application. An account exists once; what it may do
exists per project, because the same person is a manager on one programme and an
enumerator on another.

    account ──▶ membership ──▶ role held here ──▶ permissions ──▶ forms ──▶ submissions

Three things live here because they are all the same question asked at
different depths:

  access.py               may this account do this, in this project
  project_service.py      projects, members, groups, form assignments
  submission_workflow.py  where a submission has got to, and who may move it

`app_user.role_id` keeps its old meaning — what an account may do system-wide,
such as managing accounts or creating a project at all. `project_member.role_id`
decides everything inside a project. Both point at `app_role`, so there is one
role table and one permission catalogue rather than a second RBAC system beside
the first.
"""
from pathlib import Path

from app.core.registry import Module

from . import bootstrap
from . import permissions  # noqa: F401  (importing registers them)
from .routers import projects, review

MODULE = Module(
    name="projects",
    label="Projects",
    routers=[
        projects.router,
        projects.assignments_router,
        review.router,
        review.queue_router,
    ],
    tables=[
        "project", "project_member", "project_group", "project_group_member",
        "form_assignment", "submission_review",
    ],
    schema_file=Path(__file__).resolve().parent / "schema.sql",
    # Order matters: the column, then the tables (schema.sql), then the key that
    # joins them, then the roles that need the permission catalogue loaded.
    migrations=[
        bootstrap.ensure_form_project,
        bootstrap.ensure_form_project_key,
        bootstrap.ensure_project_roles,
    ],
)
