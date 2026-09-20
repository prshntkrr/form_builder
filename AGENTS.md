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

Both are split into `core/` (the platform) and `modules/` (forms, dashboards).
A module owns its permissions, tables, migrations, routes and screens, and joins
the app through a manifest that a registry discovers — so adding one edits
nothing shared. Read [docs/MODULES.md](docs/MODULES.md) before adding anything;
if you find yourself editing `main.py`, `App.jsx`, or core's permission
catalogue to add a feature, you are working against the design.

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
created on first boot.

`ADMIN_PASSWORD` applies **only** when no account can manage roles yet —
`ensure_admin_account` returns early otherwise. Afterwards, passwords are set
with `backend/set_admin_password.py`, not by editing `.env`.

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

Modules register their own permissions, so the catalogue is assembled on first
read rather than at import time — which is why `app/core/permissions.py` uses a
module-level `__getattr__`, and why `needs()` looks a label up at request time
and never at import time. A module is mid-import when it registers; anything
that reads the catalogue from module scope re-enters discovery and sees a
half-built registry.

## Channels (web, mobile, whatsapp, ivr)

**A form is built for exactly one channel**: `form_json.channel` is
`web_mobile`, `whatsapp` or `ivr` (a radio choice in the builder, never a set of
switches). Web / Mobile is one choice with one builder; WhatsApp has its own
builder (`components/WhatsAppBuilder.jsx`); IVR is a placeholder until its
builder exists. Rules:

- `channel` is the only stored choice. `normalize_form` *derives* the
  per-channel `channels` profile from it (`channels.profile_for`) so the
  submission path keeps one rule; never write the profile independently.
- **Legacy forms have no `channel`** (every form before this, and anything
  created through the API without one). They keep their old profile and
  behaviour and read as Web / Mobile (`channels.form_channel`). No data was
  migrated. Do not add `channel` to a legacy form: `channel_is_fixed` refuses it.
- **A saved form's channel never changes** (`channel_is_fixed`). Taking a form
  to another channel is a copy ("Copy as a … form" in the builder).
- **`channel_config.whatsapp`** — welcome/completion messages, `review`,
  `order`, and per-question `{prompt, interaction}` keyed by field name. It
  references questions, never copies them; unknown names and interactions a
  question cannot use are refused (`channel_config.whatsapp_problems`). Nothing
  else may be stored there — credentials belong to the future gateway.
- **How WhatsApp may ask a question** is `channel_capabilities.whatsapp_interactions`
  (mirrored in `channelCapabilities.js`, compared by a test). Buttons ≤ 3
  choices, list ≤ 10, catalogue questions numbered only.
- **Publishing**: the channel compatibility rule and "IVR cannot be published"
  apply when a form is Active — on save of a live form, on create-as-Active, and
  in `set_status('Active')` via `validate_publishable`. Drafts may hold a
  question their channel cannot ask; the WhatsApp builder shows it.
- Renaming or deleting a question in the builder moves or drops its WhatsApp
  settings in the same update (`whatsappConfig.renameInWhatsApp` /
  `removeFromWhatsApp`), exactly as layout references are handled.

One canonical form, answered on several channels. Read before touching any of it:

- **The mobile contract is `MOBILE_API.md`**: login → `GET /api/mcdc/forms`
  (`fillable_forms(..., channel="mobile")`) → `GET /api/forms/{id}/package`
  (`mobile_package.build`) → `POST /api/forms/{id}/submissions`. The package is
  the *published* version plus resolved option sets and a SHA-256
  `package_hash` (the ETag; excludes `published_at`). It is assembled from
  `publishing`, `translations` and the option resolvers — never a second
  definition — and whitelists `CONFIG_KEYS` so no table name or creator leaves.
  The app owns rendering, storage and offline; MCDC owns the definition and
  validates every answer.

- **The list lives in `forms/channels.py`** (`CHANNELS`, `ROUTED_CHANNELS`,
  `DEFAULTS`). `ingestion` and `routing` import it. `core/gateway.py` keeps a
  literal copy because core must load with forms switched off;
  `test_channels.py` fails if the two drift.
- **Which channels a form is open to is `form_json.channels`** — inside the
  versioned definition, so it publishes and rolls back with the questions.
  `normalize_form` keeps only the four channels and a boolean `enabled` (so no
  token can ride along into a published config); absent means no key at all,
  and a legacy form normalizes to the bytes it had.
- **Defaults: web and mobile on, whatsapp and ivr off** (`channels.enabled`).
  Enforcement at submission (`channels.refusal`, error key `_channel`) applies
  **only to forms that carry a profile**. A form without one keeps accepting
  every channel it accepted before — the MCDC ingest path sends WhatsApp/IVR to
  such forms today, and existing tests hold that. Do not "fix" this without a
  product decision; it would stop live forms taking answers.
- **What a channel can ask is `forms/channel_capabilities.py`**, keyed by the
  existing `field_types.FIELD_TYPES`. Every type needs a row for every channel
  (a test enforces it); unknown types are unsupported, never assumed.
  `frontend/src/modules/forms/channelCapabilities.js` mirrors the levels and a
  backend test compares the two line by line.
- **`channels_can_complete_the_form` is the one exception** to
  `validate_config(normalize_form(x))` never raising: an enabled channel that
  would reach a required question it cannot ask is refused, because the only
  "repair" would be silently switching the channel off. Reachability uses
  `conditions.hidden` by probing answer sets (see `reachable_fields`); an
  optional unaskable question is fine.
- **One validation implementation.** `submission_service._check_field` is the
  per-question check; `validate_payload` loops it, `validate_field` (for
  one-question-at-a-time channels) calls it once. Never copy the rules.
- **Idempotent submissions.** `client_submission_id` (or the `Idempotency-Key`
  header) → `submission_receipt`, primary key `(form_id, client_submission_id)`.
  Same id + same answers + same channel returns the original (200,
  `replayed: true`); anything else under that id is 409. The receipt, the
  answers row, the tabular mirror and the `submission_channel` note are written
  in **one transaction** (`submission_service._write`); a failure in any rolls
  back all of them. `record_channel` takes the caller's cursor for this — do not
  move it back outside the transaction.

## Schema changes

There is no Alembic. `backend/schema.sql` is the desired state and is run at
startup when a required table is missing (`bootstrap.ensure_base_tables`).

Each module owns a `schema.sql`; core owns `app/core/schema.sql`. For a change
to an **existing** table, add an idempotent function to that module's
`bootstrap.py` and list it in the module's `MODULE.migrations` — see
`ensure_status_values`, `ensure_library_snapshots`. Each checks whether the work
is already done and returns early. Existing deployments migrate on their next
boot. `main.py` does not change.

Each schema file runs as a single batch in its own transaction, so one failing
statement rolls back that whole file (but not the others). An index on a column a migration has not added yet will take the
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
