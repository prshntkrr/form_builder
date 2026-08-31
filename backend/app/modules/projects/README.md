# Projects

The unit of access. An account exists once; what it may do exists **per
project**, because the same person is a manager on one programme and an
enumerator on another.

```
account ──▶ membership ──▶ role held here ──▶ permissions ──▶ forms ──▶ submissions
```

## Files

| file | holds |
|---|---|
| `access.py` | **the only place a project question is answered.** `can()`, `require()`, `needs_in_project()` |
| `project_service.py` | projects, members, groups, form assignments |
| `submission_workflow.py` | the states a submission moves through, and who may move it |
| `permissions.py` | the catalogue, and the three roles a project starts with |
| `bootstrap.py` | `forms.project_id`, its foreign key, and seeding the project roles |

## Two levels of role, one role table

`app_user.role_id` keeps its old meaning — what an account may do **system-wide**
(manage accounts, create a project at all). `project_member.role_id` decides
everything **inside** a project.

Both point at `app_role` and draw on the same permission catalogue, so there is
one RBAC system rather than a second one beside the first. What changes is where
the role was found.

## Writing a project-scoped route

```python
@router.get("/{project_id}/members")
def members(project_id: str,
            user = Depends(access.needs_in_project(PROJECT_VIEW))):
    return project_service.list_members(project_id)
```

No route tests a role name, and no route assembles its own rule out of
memberships and assignments. If a rule changes it changes in `access.py`.

## Isolation

`permissions_in(user, project)` is empty for a non-member, which is the whole of
project isolation. A project somebody is not in answers **404**, the same as one
that does not exist — 403 would confirm the id is real.

Inside a project the answers are ordinary 403s, because there the resource is
known to exist.

Account-wide permissions are checked first and project membership second, so
reading a form you have no business reading gives 403 if your account cannot read
forms at all, and 404 if it can but the form is in someone else's project.

## Form visibility

A member sees a form when it was actually given to them:

- assigned to **everyone** in the project, or
- assigned to them **by name**, or
- assigned to a **group** they are in.

A form with no assignment is seen only by somebody holding
`project.forms.view_all`. A form nobody was given is not a form everybody gets.

Assignments are relationships — the form is never copied.

## Submission workflow

```
draft ──▶ submitted ──▶ under_review ──▶ approved
              │              │
              └──────────────┴────────▶ rejected ──▶ submitted
```

The transitions are a table in `submission_workflow.py` and every move goes
through `advance()`. There is deliberately **no** endpoint that sets a status:
the move is the URL (`/approve`, `/reject`), so a surveyor cannot post
`{"status": "approved"}` at their own work.

Review lives in `submission_review`, beside the response rather than inside it.
Every form has its own dynamically created table; putting workflow columns in
that envelope would mean migrating each one and rebuilding its flat mirror.
