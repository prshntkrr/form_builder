# AGENTS.md

Notes for an AI agent working in this repository. Read this before changing
anything — several of the designs here look wrong until you know why they are
that way, and a few of the rules below were learned by breaking them.

## What this is

An AI form builder for agriculture data collection. You describe a form in plain
language, an OpenAI model drafts it, you edit it, and publishing creates real
Postgres tables that collect the answers.

- `backend/` — FastAPI + psycopg2. No ORM, no migration tool (see *Schema changes*).
- `frontend/` — React + Vite, plain CSS. No component library.

## Running it

```bash
# backend  (venv already exists at backend/.venv)
cd backend
.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8000

# frontend
cd frontend && npm run dev            # proxies /api to :8000

# tests — 207 of them, most need Postgres and skip without it
cd backend && .venv/Scripts/python.exe -m pytest
```

`backend/.env` holds the database password and OpenAI key. It is gitignored;
`backend/.env.example` is the template. Tables and the first admin account are
created on first boot — see *Bootstrap*.

## The five ideas that explain the rest

### 1. A form's definition and its answers change at different speeds

The definition lives in `forms.form_json` (JSONB) and is versioned in
`form_version`. Answers live in a table named after the form, one row per
response, the whole response in a `form_data` JSONB column.

The answers table has **six fixed columns for its whole life** — `survey_id`,
`form_id`, `form_data`, `created_on`, `form_version`, `created_by`. Adding,
removing or retyping a question never alters it, which is why this project needs
no migration tool for the thing that actually changes.

### 2. There is a second, disposable table

`<form>_tabular` mirrors the same answers as ordinary typed columns, for
reporting. It *is* altered as the form changes. That is safe only because it is a
projection: `tabular_service.rebuild()` can reconstruct it from `form_data` at
any time.

**Columns are never dropped from it.** Delete a question and its column stays,
holding every answer collected while it was asked. This was a deliberate change
— do not "tidy it up".

### 3. `normalize_form` repairs, `config_validation` rejects

`form_schema.normalize_form()` is deliberately lenient: an LLM emits duplicate
keys, invented type names and option-less dropdowns, and the normalizer fixes
them rather than failing. `config_validation` is the strict pipeline that guards
persistence.

**The invariant, asserted by 13 parametrised tests:**

```python
validate_config(normalize_form(anything))   # never raises
```

If you add a validation rule, either the normalizer must already repair the
thing you are rejecting, or you must teach it to. Breaking this makes
LLM-generated forms unsaveable.

A related trap: the *incoming* config contract is broader than the canonical
one. `name` may arrive as `name`/`key`/`id`, options may be bare strings, the
payload may be wrapped in `{"form": …}`. I tightened the structural model twice
and broke real saved forms both times. Check `test_validation_pipeline.py`
before narrowing anything.

### 4. Rollback is a pointer, not a copy

`form_version` is append-only. Rolling back does **not** write a new version —
it points `forms.form_json` at an existing one. Which version is live is read
from the definition's own `version` key, so `version_no` (live) and
`latest_version` (highest) can differ. Do not assume `MAX(version_no)` is live.

### 5. Authorisation is by permission, never by role

Roles are rows users create (`app_role` + `role_permission`). Permissions are
fixed in `app/permissions.py` because only code can check them. Every endpoint
declares `Depends(needs(SOME_PERMISSION))`. **Never check a role name** — that
would defeat the point of letting an installation define its own roles.

Changing a role or a user's role deletes their sessions, so a revoked permission
applies immediately.

## Schema changes

There is no Alembic. `backend/schema.sql` is the desired state and is run at
startup when a required table is missing (`bootstrap.ensure_base_tables`).

For a change to an **existing** table, add an idempotent function to
`bootstrap.py` and call it from `main.py`'s lifespan — see `ensure_status_values`,
`ensure_library_snapshots`, `ensure_roles`. Each checks whether the work is
already done and returns early. Existing deployments migrate on their next boot.

`schema.sql` runs as a single batch, so one failing statement rolls back the
whole file. An index on a column a migration has not added yet will take the
entire schema with it — that happened; the fix was to create that index inside
the migration instead.

## Conventions

- **Dynamic SQL**: table and column names go through `psycopg2.sql.Identifier`,
  never string formatting. Field names are slugified by `form_schema` first.
- **Transactions**: `database.transaction()` commits on clean exit, rolls back on
  exception. Wrap a unit of work, not a statement.
- **Never raise inside a transaction whose writes must survive.** Recording a
  failed login attempt and then raising rolled the attempt back, so the lockout
  counter sat at zero forever. Decide the outcome inside, raise after the block.
  See `auth_service.login`.
- **Pure where possible**: `form_schema`, `field_types`, `permissions`,
  `config_validation`, `diff_service` take no database connection. Facts a rule
  needs are passed in (`BusinessContext`). Keep it that way — it is why those
  tests run without Postgres.
- **Comments explain why, not what.** The codebase leans on this heavily.
- Frontend: files containing JSX must be `.jsx`. Vite will not parse JSX in `.js`.

## Testing

`pytest` from `backend/`. Tests that need Postgres use
`pytest.mark.skipif(not ping(), ...)`. Every endpoint is behind authentication,
so API tests use the `editor_client` / `admin_client` fixtures in `conftest.py`.

Tests must clean up after themselves — drop the form's two tables, its sequence,
and its `forms` row. Copy the `cleanup` helper in `test_standard_forms_endpoint.py`.

## Local gotchas that cost real time

- **Two uvicorn processes on :8000.** One bound to `127.0.0.1` and one to
  `0.0.0.0` coexist on Windows, and the specific bind wins for localhost. Symptom
  is a 404 for an endpoint that exists. `netstat -ano | findstr :8000` — two
  LISTENING lines means this. `taskkill /PID <pid> /F`; `pkill` does not reliably
  kill native Windows processes.
- **`--reload` watches `.py`, not `.json`.** Editing library JSON needs a restart.
- **`psql` output is cp1252 here.** Em dashes in log or error strings render as
  `?` in the console. The API returns correct UTF-8; do not "fix" the string.

## Working on someone's live database

This repo is developed against a real database with the user's forms and
responses in it. Before running anything destructive, create a throwaway form or
a throwaway database. Never demonstrate a feature by deleting their data — I
dropped one of their forms to show a cascade, and it was not recoverable.
