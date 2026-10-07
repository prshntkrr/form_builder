# Projects API

API documentation for the Projects module — organising forms, people and
submissions into projects.

Base URL: `{API}` = `https://<server>/api`

All endpoints require `Authorization: Bearer <token>` (see MOBILE_API.md §2).

---

## 1. Identifiers

| Entity | Format | Example |
|---|---|---|
| Project | `PRJ` + 5 digits | `PRJ00001` |
| Group | `PGP` + 5 digits | `PGP00003` |
| Member | auto-increment integer | `12` |
| Assignment | auto-increment integer | `7` |

---

## 2. Projects

### 2.1 List projects

```http
GET {API}/projects
```

Returns every project the authenticated user can reach — their own memberships,
or all projects for a system administrator.

**200 OK**

```json
{
  "projects": [
    {
      "project_id": "PRJ00001",
      "name": "Mexico Maize",
      "description": "Maize yield monitoring across Jalisco and Chiapas",
      "status": "Active",
      "created_by": "Admin",
      "created_on": "2026-08-01T09:00:00",
      "updated_on": "2026-09-18T10:12:40",
      "member_count": 5,
      "form_count": 3
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `status` | `Active` or `Archived` |
| `member_count` | How many people are in the project |
| `form_count` | Non-deleted forms belonging to this project |

### 2.2 Create project

**Permission:** `projects.manage`

```http
POST {API}/projects
Content-Type: application/json

{
  "name": "Nepal Rice Survey",
  "description": "Rice production survey across Terai districts"
}
```

**201 Created**

```json
{
  "project_id": "PRJ00002",
  "name": "Nepal Rice Survey",
  "description": "Rice production survey across Terai districts",
  "status": "Active",
  "created_by": "Piyush Gupta",
  "created_on": "2026-10-03T11:00:00",
  "updated_on": null,
  "member_count": 1,
  "form_count": 0
}
```

The creator is automatically added as a project manager, so the project has
someone who can administer it immediately.

| Field | Required | Rules |
|---|---|---|
| `name` | yes | 2–200 characters; letters, digits, spaces and `- _ . , ' & ( ) /` |
| `description` | yes | At least 5 characters |

**Errors (400)**

| `detail` | Cause |
|---|---|
| `A project needs a name.` | Empty or missing name |
| `A project name needs at least two characters.` | Too short |
| `A project name cannot contain …` | Disallowed punctuation |
| `A project needs a description.` | Empty or missing description |

### 2.3 List project roles

```http
GET {API}/projects/roles
```

Returns the roles available for project membership — any role that holds at
least one project-scoped permission. System-wide roles (like administrator) are
excluded.

**200 OK**

```json
{
  "roles": [
    {
      "role_id": "ROL00003",
      "name": "project_manager",
      "label": "Project Manager",
      "description": "Full control within a project",
      "permissions": ["project.forms.assign", "project.forms.view_all", "project.groups.manage", "project.members.manage", "project.view"]
    },
    {
      "role_id": "ROL00004",
      "name": "data_collector",
      "label": "Data Collector",
      "description": "Fills forms assigned to them",
      "permissions": ["project.view"]
    }
  ]
}
```

### 2.4 Project detail

**Permission:** `project.view` (scoped to this project)

```http
GET {API}/projects/PRJ00001
```

**200 OK**

```json
{
  "project_id": "PRJ00001",
  "name": "Mexico Maize",
  "description": "Maize yield monitoring across Jalisco and Chiapas",
  "status": "Active",
  "created_by": "Admin",
  "created_on": "2026-08-01T09:00:00",
  "updated_on": "2026-09-18T10:12:40",
  "member_count": 5,
  "form_count": 3,
  "your_permissions": [
    "project.forms.assign",
    "project.forms.view_all",
    "project.groups.manage",
    "project.members.manage",
    "project.view"
  ]
}
```

`your_permissions` lists what the authenticated user may do in this project,
so a screen can show or hide controls without trial and error.

### 2.5 Update project

**Permission:** `project.members.manage` (scoped to this project)

```http
PATCH {API}/projects/PRJ00001
Content-Type: application/json

{
  "name": "Mexico Maize 2026",
  "status": "Archived"
}
```

**200 OK** — the updated project (same shape as §2.4, without `your_permissions`).

All fields are optional; only those sent are changed.

| Field | Rules |
|---|---|
| `name` | Same rules as creation (§2.2) |
| `description` | At least 5 characters |
| `status` | `Active` or `Archived` |

---

## 3. Members

Project permissions are checked within the project — a user needs the right
permission in *this* project, not system-wide.

### 3.1 List members

**Permission:** `project.view`

```http
GET {API}/projects/PRJ00001/members
```

**200 OK**

```json
{
  "members": [
    {
      "member_id": 1,
      "user_id": "USR00001",
      "role_id": "ROL00003",
      "status": "Active",
      "added_on": "2026-08-01T09:00:00",
      "added_by": "Admin",
      "email": "manager@example.org",
      "full_name": "Piyush Gupta",
      "role": "project_manager",
      "role_label": "Project Manager"
    },
    {
      "member_id": 2,
      "user_id": "USR00012",
      "role_id": "ROL00004",
      "status": "Active",
      "added_on": "2026-08-05T10:30:00",
      "added_by": "Piyush Gupta",
      "email": "surveyor@example.org",
      "full_name": "Shrishti Rao",
      "role": "data_collector",
      "role_label": "Data Collector"
    }
  ]
}
```

### 3.2 Add member

**Permission:** `project.members.manage`

```http
POST {API}/projects/PRJ00001/members
Content-Type: application/json

{
  "user_id": "USR00015",
  "role_id": "ROL00004"
}
```

**201 Created**

```json
{
  "project_id": "PRJ00001",
  "user_id": "USR00015",
  "role_id": "ROL00004"
}
```

| Field | Required | Meaning |
|---|---|---|
| `user_id` | yes | An existing, active account |
| `role_id` | yes | The role this person holds *in this project* (from §2.3) |

**Errors (400)**

| `detail` | Cause |
|---|---|
| `There is no account '…'.` | Unknown user_id |
| `There is no role '…'.` | Unknown role_id |
| `That account is already in this project. …` | Duplicate — update the role instead |

### 3.3 Update member

**Permission:** `project.members.manage`

```http
PATCH {API}/projects/PRJ00001/members/2
Content-Type: application/json

{
  "role_id": "ROL00003",
  "status": "Suspended"
}
```

**200 OK**

```json
{
  "project_id": "PRJ00001",
  "member_id": 2,
  "role_id": "ROL00003",
  "status": "Suspended"
}
```

| Field | Rules |
|---|---|
| `role_id` | Must be a valid role |
| `status` | `Active` or `Suspended` |

**Safety guards:**

- You cannot suspend or demote yourself.
- You cannot remove or change the last person who can manage the project.

These return **400** with a clear `detail` explaining what to do instead.

### 3.4 Remove member

**Permission:** `project.members.manage`

```http
DELETE {API}/projects/PRJ00001/members/2
```

**200 OK**

```json
{
  "member_id": 2,
  "removed": true
}
```

The same safety guards apply: you cannot remove yourself, and the last manager
cannot be removed.

**404** — no member with that id in this project.

### 3.5 Candidates

**Permission:** `project.members.manage`

Returns active accounts that are *not already members* of this project — for a
"pick a person to add" UI.

```http
GET {API}/projects/PRJ00001/candidates?q=shri
```

**200 OK**

```json
{
  "candidates": [
    {
      "user_id": "USR00020",
      "email": "shrishti.new@example.org",
      "full_name": "Shrishti Kumari"
    }
  ]
}
```

| Query param | Default | Meaning |
|---|---|---|
| `q` | (none) | Search by name or email (case-insensitive substring match) |

Results are capped at 50.

---

## 4. Groups

Groups are teams within a project. A form can be assigned to a group so that
every member of that group can fill it.

### 4.1 List groups

**Permission:** `project.view`

```http
GET {API}/projects/PRJ00001/groups
```

**200 OK**

```json
{
  "groups": [
    {
      "group_id": "PGP00001",
      "project_id": "PRJ00001",
      "name": "Jalisco Field Team",
      "description": "Surveyors covering the Jalisco region",
      "created_by": "Piyush Gupta",
      "created_on": "2026-08-10T09:00:00",
      "member_count": 3
    }
  ]
}
```

### 4.2 Create group

**Permission:** `project.groups.manage`

```http
POST {API}/projects/PRJ00001/groups
Content-Type: application/json

{
  "name": "Chiapas Field Team",
  "description": "Surveyors covering Chiapas state"
}
```

**201 Created**

```json
{
  "group_id": "PGP00002",
  "project_id": "PRJ00001",
  "name": "Chiapas Field Team",
  "description": "Surveyors covering Chiapas state",
  "member_count": 0
}
```

| Field | Required | Rules |
|---|---|---|
| `name` | yes | Same rules as project names (§2.2); must be unique within the project |
| `description` | yes | At least 5 characters |

**Errors (400)**

| `detail` | Cause |
|---|---|
| `This project already has a group called '…'.` | Duplicate name (case-insensitive) |

### 4.3 List group members

**Permission:** `project.view`

```http
GET {API}/projects/PRJ00001/groups/PGP00001/members
```

**200 OK**

```json
{
  "members": [
    {
      "user_id": "USR00012",
      "added_on": "2026-08-12T10:00:00",
      "email": "surveyor@example.org",
      "full_name": "Shrishti Rao"
    }
  ]
}
```

### 4.4 Add to group

**Permission:** `project.groups.manage`

The user must already be a member of the project.

```http
POST {API}/projects/PRJ00001/groups/PGP00001/members
Content-Type: application/json

{
  "user_id": "USR00015"
}
```

**201 Created**

```json
{
  "group_id": "PGP00001",
  "user_id": "USR00015"
}
```

**Errors (400)**

| `detail` | Cause |
|---|---|
| `That account is not in this project …` | Must be a project member first |

Adding someone who is already in the group is silently ignored (no error, no
duplicate).

### 4.5 Remove from group

**Permission:** `project.groups.manage`

```http
DELETE {API}/projects/PRJ00001/groups/PGP00001/members/USR00015
```

**200 OK**

```json
{
  "group_id": "PGP00001",
  "user_id": "USR00015",
  "removed": true
}
```

**404** — that user is not in this group.

---

## 5. Forms & Assignments

A form belongs to at most one project. Assignments control which users can fill
which forms: by individual user, by group, or open to everyone in the project.

### 5.1 List forms in project

**Permission:** `project.view`

```http
GET {API}/projects/PRJ00001/forms
```

**200 OK**

```json
{
  "forms": [
    {
      "form_id": "FRM00030",
      "form_title": "Farmer Registration",
      "form_description": "Register a farmer and their main plot",
      "form_status": "Active",
      "updated_on": "2026-09-18T10:12:40",
      "assignment_count": 2,
      "parent_form_id": null,
      "channel": "web_mobile"
    }
  ],
  "everything": true
}
```

| Field | Meaning |
|---|---|
| `assignment_count` | How many assignments point to this form (a published form with 0 reaches nobody) |
| `parent_form_id` | If this is a child form, the form it is a child of; otherwise `null` |
| `channel` | `web_mobile`, `whatsapp` or `ivr` |
| `everything` | `true` if the user sees all forms (holds `project.forms.view_all`); `false` if they see only their assigned ones |

A user with `project.forms.view_all` sees every non-deleted form in the
project. Anyone else sees only forms assigned to them — by name, by group, or
to everyone.

### 5.2 List assignments

**Permission:** `project.forms.view_all`

```http
GET {API}/forms/FRM00030/assignments
```

**200 OK**

```json
{
  "assignments": [
    {
      "assignment_id": 1,
      "kind": "everyone",
      "user_id": null,
      "group_id": null,
      "assigned_on": "2026-09-01T08:00:00",
      "assigned_by": "Piyush Gupta",
      "email": null,
      "full_name": null,
      "group_name": null
    },
    {
      "assignment_id": 2,
      "kind": "user",
      "user_id": "USR00012",
      "group_id": null,
      "assigned_on": "2026-09-02T10:00:00",
      "assigned_by": "Piyush Gupta",
      "email": "surveyor@example.org",
      "full_name": "Shrishti Rao",
      "group_name": null
    },
    {
      "assignment_id": 3,
      "kind": "group",
      "user_id": null,
      "group_id": "PGP00001",
      "assigned_on": "2026-09-03T10:00:00",
      "assigned_by": "Piyush Gupta",
      "email": null,
      "full_name": null,
      "group_name": "Jalisco Field Team"
    }
  ]
}
```

### 5.3 Assign form

**Permission:** `project.forms.assign`

The form must belong to a project.

```http
POST {API}/forms/FRM00030/assignments
Content-Type: application/json

{
  "kind": "group",
  "group_id": "PGP00001"
}
```

**201 Created**

```json
{
  "form_id": "FRM00030",
  "kind": "group",
  "user_id": null,
  "group_id": "PGP00001",
  "assignment_id": 4
}
```

| Field | Required | Rules |
|---|---|---|
| `kind` | yes | `everyone`, `user` or `group` |
| `user_id` | when `kind` is `user` | Must be a member of this form's project |
| `group_id` | when `kind` is `group` | Must be a group in this form's project |

Duplicate assignments are silently ignored (`assignment_id` is `null` in that
case).

**Errors (400/404)**

| `detail` | Cause |
|---|---|
| `Form '…' does not belong to a project` | The form is outside every project |
| `That account is not in this form's project …` | Assigning to a non-member |
| `That group is not in this form's project.` | Group from another project |

### 5.4 Remove assignment

**Permission:** `project.forms.assign`

```http
DELETE {API}/forms/FRM00030/assignments/4
```

**200 OK**

```json
{
  "assignment_id": 4,
  "removed": true
}
```

**404** — no assignment with that id on this form.

---

## 6. Submissions

### 6.1 Project submissions

Returns submissions across all forms in the project, scoped by the user's
access level.

```http
GET {API}/projects/PRJ00001/submissions
GET {API}/projects/PRJ00001/submissions?status=Submitted&form_id=FRM00030&limit=100
```

**200 OK**

```json
{
  "submissions": [
    {
      "form_id": "FRM00030",
      "form_title": "Farmer Registration",
      "survey_id": "000042",
      "created_on": "2026-09-19T10:15:03",
      "created_by": "Shrishti Rao",
      "status": "Submitted",
      "reviewed_by": "",
      "rejection_reason": ""
    },
    {
      "form_id": "FRM00030",
      "form_title": "Farmer Registration",
      "survey_id": "000041",
      "created_on": "2026-09-18T14:30:00",
      "created_by": "Shrishti Rao",
      "status": "Approved",
      "reviewed_by": "Piyush Gupta",
      "rejection_reason": ""
    }
  ],
  "everything": true,
  "filters": {
    "form_id": "FRM00030",
    "status": null
  }
}
```

| Query param | Default | Rules |
|---|---|---|
| `status` | (none) | Filter by submission state (e.g. `Submitted`, `Approved`, `Rejected`) |
| `form_id` | (none) | Show only submissions of this form (must be in this project) |
| `limit` | `50` | 1–500 |

| Response field | Meaning |
|---|---|
| `everything` | `true` if the user sees all submissions (holds the view-all permission); `false` if they see only their own |
| `filters` | The filters that were actually applied, so a screen can distinguish "nothing here" from "nothing matches" |
| `status` | The review state: `Submitted` (default, before any action), `Approved`, `Rejected`, etc. |
| `reviewed_by` | Who last acted on it (empty if nobody has) |
| `rejection_reason` | The reason given when rejecting (empty otherwise) |

Results are ordered by `created_on` descending (newest first).

---

## 7. Common errors

These apply to all project endpoints.

| Status | Meaning |
|---|---|
| 401 | Not authenticated — sign in again |
| 403 | The user's role does not hold the required permission |
| 404 | Project, member, group or assignment not found |
| 400 | Validation failure — `detail` explains what is wrong |

---

## 8. Endpoint reference

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/projects` | any authenticated | List projects the user can see |
| POST | `/api/projects` | `projects.manage` | Create a project |
| GET | `/api/projects/roles` | any authenticated | List project-eligible roles |
| GET | `/api/projects/{project_id}` | `project.view` | Project detail |
| PATCH | `/api/projects/{project_id}` | `project.members.manage` | Update a project |
| GET | `/api/projects/{project_id}/members` | `project.view` | List members |
| POST | `/api/projects/{project_id}/members` | `project.members.manage` | Add a member |
| PATCH | `/api/projects/{project_id}/members/{member_id}` | `project.members.manage` | Update a member |
| DELETE | `/api/projects/{project_id}/members/{member_id}` | `project.members.manage` | Remove a member |
| GET | `/api/projects/{project_id}/candidates` | `project.members.manage` | Users who can be added |
| GET | `/api/projects/{project_id}/groups` | `project.view` | List groups |
| POST | `/api/projects/{project_id}/groups` | `project.groups.manage` | Create a group |
| GET | `/api/projects/{project_id}/groups/{group_id}/members` | `project.view` | Group members |
| POST | `/api/projects/{project_id}/groups/{group_id}/members` | `project.groups.manage` | Add to group |
| DELETE | `/api/projects/{project_id}/groups/{group_id}/members/{user_id}` | `project.groups.manage` | Remove from group |
| GET | `/api/projects/{project_id}/forms` | `project.view` | Forms in project |
| GET | `/api/forms/{form_id}/assignments` | `project.forms.view_all` | List assignments |
| POST | `/api/forms/{form_id}/assignments` | `project.forms.assign` | Assign a form |
| DELETE | `/api/forms/{form_id}/assignments/{assignment_id}` | `project.forms.assign` | Remove assignment |
| GET | `/api/projects/{project_id}/submissions` | scoped by access | Project submissions |

All project-scoped permissions (those starting with `project.`) are checked
within the project context — the user must hold that permission through their
role *in that project*, not system-wide.
