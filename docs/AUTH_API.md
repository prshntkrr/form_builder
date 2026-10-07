# Authentication, Users & Roles API

API documentation for managing authentication, user accounts and custom roles.

Base URL: `{API}` = `https://<your-mcdc-server>/api`

---

## 1. Authentication (`/api/auth`)

### 1.1 Sign in

```http
POST {API}/auth/login
Content-Type: application/json

{ "email": "admin@example.org", "password": "correct-horse-battery" }
```

**200 OK**

```json
{
  "token": "sKq3…opaque, about 43 characters…",
  "expires_on": "2026-10-03T22:04:11.482913",
  "user": {
    "user_id": "USR00012",
    "email": "admin@example.org",
    "full_name": "Shrishti Rao",
    "role_id": "ROL00003",
    "role": "standard",
    "role_label": "Standard User",
    "permissions": ["records.create", "records.view"],
    "is_active": true,
    "last_login_on": "2026-10-03T10:04:11.482913",
    "created_on": "2026-08-01T09:00:00",
    "created_by": "Admin",
    "locked": false
  }
}
```

- **`token`** is opaque. Send it as `Authorization: Bearer <token>` on every
  authenticated call.
- **`expires_on`** is UTC without a timezone suffix. Sessions last 12 hours by
  default (configurable) and are **not** extended by activity. There is no
  refresh token — when a call returns 401, sign in again.
- Sessions also end early when the user's password is changed or reset, their
  account is deactivated, or their role (or its permissions) changes.

**Sign-in errors** — all **401**, `{"detail": "<message>"}`:

| `detail` | Why |
|---|---|
| `Email or password is incorrect` | Either one — deliberately the same message |
| `Too many attempts — try again in N minutes` | 5 wrong passwords lock the account for 15 minutes |
| `This account has been deactivated` | An administrator switched the account off |

### 1.2 Who am I

```http
GET {API}/auth/me
Authorization: Bearer <token>
```

**200 OK**

```json
{
  "user": {
    "user_id": "USR00012",
    "email": "admin@example.org",
    "full_name": "Shrishti Rao",
    "role_id": "ROL00003",
    "role": "standard",
    "role_label": "Standard User",
    "permissions": ["records.create", "records.view"],
    "is_active": true,
    "last_login_on": "2026-10-03T10:04:11.482913",
    "created_on": "2026-08-01T09:00:00",
    "created_by": "Admin",
    "locked": false
  },
  "permissions": ["records.create", "records.view"],
  "can": {
    "manage_forms": false,
    "view_records": true,
    "manage_users": false,
    "manage_roles": false
  },
  "modules": ["forms", "projects"]
}
```

| Field | Meaning |
|---|---|
| `user` | Same shape as the login response's `user` |
| `permissions` | Flat list of permission labels the caller holds |
| `can` | Boolean flags for web-application screens |
| `modules` | Enabled modules on this server |

### 1.3 Sign out

```http
POST {API}/auth/logout
Authorization: Bearer <token>
```

**200 OK**

```json
{ "signed_out": true }
```

Ends **this** session only; the same user stays signed in on other devices.
The token is useless afterwards (401).

### 1.4 Change password

```http
POST {API}/auth/change-password
Authorization: Bearer <token>
Content-Type: application/json

{ "current_password": "correct-horse-battery", "new_password": "new-strong-passphrase" }
```

**200 OK**

```json
{ "changed": true, "sign_in_again": true }
```

All of the user's sessions (including this one) are deleted. The caller must
sign in again with the new password.

**Errors:**

| Status | `detail` | Why |
|---|---|---|
| 400 | `Current password is incorrect` | Wrong `current_password` |
| 400 | `New password must be at least 8 characters` | Too short |

### 1.5 Forgot password

Initiates a password-reset flow. Always returns 200 regardless of whether
the email exists — this prevents account enumeration.

```http
POST {API}/auth/forgot-password
Content-Type: application/json

{ "email": "admin@example.org" }
```

**200 OK**

```json
{ "sent": true, "message": "If that email is registered, a reset link has been sent." }
```

### 1.6 Reset password

Completes the reset using the token from the email link.

```http
POST {API}/auth/reset-password
Content-Type: application/json

{ "token": "abc123…from-the-email-link…", "password": "new-strong-passphrase" }
```

**200 OK**

```json
{ "reset": true, "email": "admin@example.org" }
```

All sessions for that account are deleted.

**Errors:**

| Status | `detail` | Why |
|---|---|---|
| 400 | `Invalid or expired reset token` | Token not found, already used, or expired |
| 400 | `New password must be at least 8 characters` | Too short |

### 1.7 Authentication errors on any endpoint

| Status | Body | Meaning |
|---|---|---|
| 401 | `{"detail": "Sign in to continue", "error": {"code": "AUTHENTICATION_REQUIRED", …}, "request_id": "…"}` | No token, expired, or signed out |
| 403 | `{"detail": "Your role (…) cannot do this — it needs the '…' permission"}` | Signed in, but missing the required permission |

---

## 2. Users (`/api/users`)

All endpoints require the `users.manage` permission unless noted otherwise.

### 2.1 List assignable roles

```http
GET {API}/users/roles
Authorization: Bearer <token>
```

**200 OK**

```json
[
  { "role_id": "ROL00001", "name": "admin", "label": "Administrator" },
  { "role_id": "ROL00003", "name": "standard", "label": "Standard User" },
  { "role_id": "ROL00005", "name": "field_officer", "label": "Field Officer" }
]
```

Use when building a role picker for user creation or editing.

### 2.2 List users

```http
GET {API}/users
Authorization: Bearer <token>
```

**200 OK**

```json
[
  {
    "user_id": "USR00001",
    "email": "admin@example.org",
    "full_name": "Piyush Gupta",
    "role_id": "ROL00001",
    "role": "admin",
    "role_label": "Administrator",
    "is_active": true,
    "locked": false,
    "last_login_on": "2026-10-03T08:12:00",
    "created_on": "2026-01-15T09:00:00",
    "created_by": "System"
  },
  {
    "user_id": "USR00012",
    "email": "surveyor@example.org",
    "full_name": "Shrishti Rao",
    "role_id": "ROL00003",
    "role": "standard",
    "role_label": "Standard User",
    "is_active": true,
    "locked": false,
    "last_login_on": "2026-10-02T14:30:00",
    "created_on": "2026-08-01T09:00:00",
    "created_by": "Piyush Gupta"
  }
]
```

### 2.3 Create a user

```http
POST {API}/users
Authorization: Bearer <token>
Content-Type: application/json

{
  "email": "new.surveyor@example.org",
  "password": "initial-password-123",
  "full_name": "Amit Kumar",
  "role": "ROL00003"
}
```

**201 Created**

```json
{
  "user_id": "USR00013",
  "email": "new.surveyor@example.org",
  "full_name": "Amit Kumar",
  "role_id": "ROL00003",
  "role": "standard",
  "role_label": "Standard User",
  "is_active": true,
  "locked": false,
  "last_login_on": null,
  "created_on": "2026-10-03T11:00:00",
  "created_by": "Piyush Gupta"
}
```

**Errors:**

| Status | `detail` | Why |
|---|---|---|
| 400 | `A user with this email already exists` | Duplicate email |
| 400 | `Password must be at least 8 characters` | Too short |
| 404 | `Role not found` | Invalid `role` id |

### 2.4 Update a user

Any combination of fields may be sent. Changing `role` deletes all of
the user's sessions (revoked permissions apply immediately).

```http
PATCH {API}/users/USR00012
Authorization: Bearer <token>
Content-Type: application/json

{ "role": "ROL00005", "full_name": "Shrishti Rao-Patil" }
```

**200 OK** — the updated user object (same shape as 2.2).

| Field | Effect |
|---|---|
| `role` | Reassigns the user's role; deletes their sessions |
| `full_name` | Updates the display name |
| `is_active` | `false` deactivates the account and deletes sessions |
| `unlock` | `true` clears a locked-out account immediately |

**Errors:**

| Status | `detail` | Why |
|---|---|---|
| 404 | `User not found` | Invalid `user_id` |
| 404 | `Role not found` | Invalid `role` id |
| 400 | `Cannot deactivate your own account` | Self-deactivation prevented |

### 2.5 Deactivate a user

Convenience endpoint equivalent to `PATCH` with `{"is_active": false}`.

```http
POST {API}/users/USR00012/deactivate
Authorization: Bearer <token>
```

**200 OK** — the updated user object with `is_active: false`.

### 2.6 Delete a user

Requires the `users.delete` permission (stronger than `users.manage`).

```http
DELETE {API}/users/USR00012
Authorization: Bearer <token>
```

**200 OK**

```json
{ "deleted": true }
```

**Errors:**

| Status | `detail` | Why |
|---|---|---|
| 403 | `Your role (…) cannot do this — it needs the 'users.delete' permission` | Missing `users.delete` |
| 400 | `Cannot delete your own account` | Self-deletion prevented |
| 404 | `User not found` | Invalid `user_id` |

### 2.7 Generate a password-reset link

Creates a reset token for the user, suitable for sending manually.

```http
POST {API}/users/USR00012/reset-link
Authorization: Bearer <token>
```

**200 OK**

```json
{ "reset_url": "https://<server>/reset-password?token=abc123…" }
```

---

## 3. Roles (`/api/roles`)

All endpoints require the `roles.manage` permission.

Roles are user-created rows. Permissions are fixed in code and checked by
every endpoint with `Depends(needs(SOME_PERMISSION))`. **Never check a role
name** — authorisation is always by permission.

### 3.1 Permission catalogue

Returns every permission the system knows about, grouped by module.

```http
GET {API}/roles/permissions
Authorization: Bearer <token>
```

**200 OK**

```json
[
  {
    "module": "forms",
    "permissions": [
      { "name": "forms.create", "label": "Create forms", "description": "Create new form definitions" },
      { "name": "forms.edit", "label": "Edit forms", "description": "Edit existing form definitions" },
      { "name": "records.create", "label": "Submit records", "description": "Submit form responses" },
      { "name": "records.view", "label": "View records", "description": "View submitted responses" }
    ]
  },
  {
    "module": "core",
    "permissions": [
      { "name": "users.manage", "label": "Manage users", "description": "Create, edit and deactivate user accounts" },
      { "name": "users.delete", "label": "Delete users", "description": "Permanently delete user accounts" },
      { "name": "roles.manage", "label": "Manage roles", "description": "Create, edit and delete roles" }
    ]
  }
]
```

### 3.2 List roles

```http
GET {API}/roles
Authorization: Bearer <token>
```

**200 OK**

```json
[
  {
    "role_id": "ROL00001",
    "name": "admin",
    "label": "Administrator",
    "description": "Full access to all features",
    "permissions": ["forms.create", "forms.edit", "records.create", "records.view", "users.manage", "users.delete", "roles.manage"],
    "user_count": 2,
    "created_on": "2026-01-15T09:00:00"
  },
  {
    "role_id": "ROL00003",
    "name": "standard",
    "label": "Standard User",
    "description": "Can fill forms and view their own records",
    "permissions": ["records.create", "records.view"],
    "user_count": 8,
    "created_on": "2026-02-10T11:30:00"
  }
]
```

### 3.3 Create a role

```http
POST {API}/roles
Authorization: Bearer <token>
Content-Type: application/json

{
  "label": "Field Supervisor",
  "name": "field_supervisor",
  "description": "Can create forms and view all records",
  "permissions": ["forms.create", "forms.edit", "records.create", "records.view"]
}
```

- `name` is optional; if omitted, it is derived from `label` (lowercased, spaces
  to underscores). It must be unique among roles.
- `permissions` is a list of permission names from the catalogue (3.1).

**201 Created** — the role object (same shape as 3.2, with `user_count: 0`).

**Errors:**

| Status | `detail` | Why |
|---|---|---|
| 400 | `A role with this name already exists` | Duplicate `name` |
| 400 | `At least one permission is required` | Empty `permissions` |
| 400 | `Unknown permission: '…'` | A permission not in the catalogue |

### 3.4 Role detail

```http
GET {API}/roles/ROL00003
Authorization: Bearer <token>
```

**200 OK** — the role object (same shape as 3.2).

### 3.5 Update a role

Any combination of fields may be sent. Changing `permissions` deletes
sessions for every user who holds this role, so the new permissions apply
immediately.

```http
PATCH {API}/roles/ROL00003
Authorization: Bearer <token>
Content-Type: application/json

{
  "label": "Standard User (updated)",
  "permissions": ["records.create", "records.view", "forms.edit"]
}
```

**200 OK** — the updated role object.

**Errors:**

| Status | `detail` | Why |
|---|---|---|
| 404 | `Role not found` | Invalid `role_id` |
| 400 | `Unknown permission: '…'` | A permission not in the catalogue |

### 3.6 Delete a role

```http
DELETE {API}/roles/ROL00003
Authorization: Bearer <token>
Content-Type: application/json

{ "reassign_to": "ROL00005" }
```

- `reassign_to` is the role to move the deleted role's users to. Required when
  the role has users; optional (ignored) when it has none.

**200 OK**

```json
{ "deleted": true, "users_reassigned": 8 }
```

**Errors:**

| Status | `detail` | Why |
|---|---|---|
| 404 | `Role not found` | Invalid `role_id` |
| 400 | `Cannot delete this role while it has users — provide reassign_to` | Role has users and no `reassign_to` given |
| 404 | `Reassignment role not found` | Invalid `reassign_to` id |

---

## 4. Key design notes

- **Sessions last 12 hours** by default (configurable). No refresh token. Any
  401 means "sign in again".
- **5 wrong passwords lock the account for 15 minutes.** The lockout counter
  resets on a successful login.
- **Changing a role's permissions or a user's role deletes their sessions.**
  Revoked permissions apply immediately — the next request from that user
  returns 401.
- **Authorisation is by permission, never by role name.** Roles are
  user-created groupings of permissions; the code checks only the permission.
- **ID formats:** user IDs are `USR00012`, role IDs are `ROL00003`.
- **Modules register their own permissions**, so the catalogue (3.1) grows as
  modules are enabled. Permissions are fixed in code; only roles are editable.

---

## 5. Endpoint reference

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | — | Sign in |
| POST | `/api/auth/logout` | Bearer token | End this session |
| GET | `/api/auth/me` | Bearer token | Current user, permissions and modules |
| POST | `/api/auth/change-password` | Bearer token | Change own password |
| POST | `/api/auth/forgot-password` | — | Request a password-reset email |
| POST | `/api/auth/reset-password` | — | Complete a password reset |
| GET | `/api/users/roles` | `users.manage` | Roles available for assignment |
| GET | `/api/users` | `users.manage` | List all users |
| POST | `/api/users` | `users.manage` | Create a user |
| PATCH | `/api/users/{user_id}` | `users.manage` | Update a user |
| POST | `/api/users/{user_id}/deactivate` | `users.manage` | Deactivate a user |
| DELETE | `/api/users/{user_id}` | `users.delete` | Delete a user |
| POST | `/api/users/{user_id}/reset-link` | `users.manage` | Generate a reset link |
| GET | `/api/roles/permissions` | `roles.manage` | All permissions, grouped by module |
| GET | `/api/roles` | `roles.manage` | List all roles |
| POST | `/api/roles` | `roles.manage` | Create a role |
| GET | `/api/roles/{role_id}` | `roles.manage` | Role detail |
| PATCH | `/api/roles/{role_id}` | `roles.manage` | Update a role |
| DELETE | `/api/roles/{role_id}` | `roles.manage` | Delete a role |
