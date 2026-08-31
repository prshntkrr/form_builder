# e-Agrology

A platform for building agricultural data-collection forms and running them across projects.

Forms are described once, as JSON, and everything else follows from that description: the
Postgres table that holds the answers, the screens that draw the form, the rules that check a
submission, and the standards that say what each question means. A form can be drafted from a
prompt, built by hand, or imported from a spreadsheet the client already has.

## What it does

**Building forms**

- **Form builder** — a two-pane workspace: the questions on the left, an element inspector on
  the right with Field / Variable / Standards tabs.
- **Dynamic forms** — each form gets its own Postgres table plus a flat mirror for reporting.
- **Conditional logic** — show or hide a question, a section or the whole questionnaire based on
  earlier answers. Evaluated in the browser as it is filled in, and again on the server.
- **Multilingual forms** — one form, one data table, many languages. Field keys never change
  with the language, so answers given in Spanish and English land in the same column.
- **Standard forms** — a library to start from, and Excel import for the client's own workbooks
  (CIMMYT Controlled Vocabulary and the client "Edit view" format).
- **Data dictionary** — agree once what `age` or `plant_height` means, and every new form starts
  that way.

**Standards and reference data**

- **SEOnt** — what a field *means* (`AGRO_00000325`).
- **ICASA** — what it is officially *called* (`PHTD` · `935` · `m`).
- **Crop Ontology** — which crop-specific variable it measures (`CO_322:0000996` · `cm`).
- **Units** — deterministic conversion, so a height collected in centimetres is stored in the
  metres its standard uses.
- **Client catalogues** — the client's own controlled lists, including dependent lists
  (districts within a state). Their codes, their wording, never replaced by a standard.

**Running projects**

- **Projects** with members, roles and groups.
- **Project-level RBAC** — the same person can manage one project and enumerate in another.
- **Form assignment** — a form goes to everyone in a project, to named people, or to groups.
- **Submission workflow** — draft → submitted → under review → approved, or rejected and sent
  back.
- **Dashboards** — reporting over collected data.

## Architecture

```
React (Vite)
     │  REST, /api/*
     ▼
FastAPI
     ├── core/        database, auth, permissions, module registry
     └── modules/     projects · forms · standards · client_catalog · dashboards
     │
     ▼
PostgreSQL
```

A **module** is a directory under `app/modules/` with a `MODULE` manifest in its `__init__.py`
naming its routers, tables, schema file and migrations. Nothing registers it — no list to append
to, no import to add to `main.py`. Two people can add two modules in two branches without
touching the same line of anything, and `DISABLED_MODULES` in `.env` switches one off entirely:
its routes, permissions and tables never come into being.

Business logic lives in services; routers are thin and do not make authorization decisions of
their own.

## Project structure

```
backend/
├── app/
│   ├── main.py
│   ├── core/                    infrastructure every module may use
│   │   ├── auth_service.py      accounts, sessions, passwords
│   │   ├── permissions.py       the permission catalogue and built-in roles
│   │   ├── role_service.py      roles and what they hold
│   │   ├── registry.py          module discovery
│   │   ├── deps.py              needs(PERMISSION) and friends
│   │   ├── database.py          the connection pool
│   │   └── schema.sql           app_user · app_role · role_permission · sessions
│   │
│   └── modules/
│       ├── projects/            projects, membership, groups, assignment, review
│       │   ├── access.py            the only place a project question is answered
│       │   ├── project_service.py
│       │   ├── submission_workflow.py
│       │   └── routers/
│       │
│       ├── forms/               the builder, the renderer's contract, submissions
│       │   ├── form_schema.py       normalize any definition into the canonical shape
│       │   ├── config_validation.py two-stage validation
│       │   ├── conditions.py        the conditional-logic engine
│       │   ├── translations.py      multilingual wording
│       │   ├── submission_service.py
│       │   ├── standardization.py   unit conversion on submission
│       │   ├── excel_import.py      CIMMYT Controlled Vocabulary workbooks
│       │   ├── edit_view_import.py  the client "Edit view" workbook
│       │   └── routers/
│       │
│       ├── standards/           a container package, not a module of its own
│       │   ├── seont/               SEOnt concepts
│       │   ├── icasa/               ICASA variables and coded values
│       │   ├── crop_ontology/       crop traits, methods, scales, variables
│       │   └── units/               unit conversion
│       │
│       ├── client_catalog/      the client's own controlled lists
│       └── dashboards/
│
├── tests/                       mirrors app/modules/
├── import_ontology.py           CLI: load SEOnt
├── import_icasa.py              CLI: load ICASA
├── import_crop_ontology.py      CLI: load a crop ontology
├── import_client_catalog.py     CLI: load client catalogue workbooks
└── requirements.txt

frontend/
└── src/
    ├── core/                    shell, auth, routing, the module registry
    └── modules/forms/           the builder, renderer, catalogues, standards screens

data_dictionary/                 the standards themselves, as downloaded
├── seont.owl
├── icasa/
├── crop_ontology/
└── client_catalogs/             workbooks the deploy imports
```

## Backend setup

Python 3.10+.

```bash
cd backend
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env              # then edit it
python -m uvicorn app.main:app --reload --port 8000
```

On first run the admin password is generated and printed to the log unless `ADMIN_PASSWORD` is
set. To change it later:

```bash
python set_admin_password.py --email admin@example.org
```

Loading the standards is optional — the application runs with none of them, and the pickers
simply find nothing:

```bash
python import_ontology.py                     # SEOnt
python import_icasa.py                        # ICASA
python import_crop_ontology.py --crop CO_322  # one crop ontology
python import_client_catalog.py --directory   # every committed catalogue workbook
```

## Frontend setup

Node 20+.

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173, proxying /api to port 8000
npm run build      # production bundle into dist/
```

Set `API_PORT` if the backend is not on 8000.

## Environment variables

Copy `backend/.env.example` to `backend/.env`. Never commit real values.

| variable | what it is |
|---|---|
| `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` `DB_SCHEMA` | Postgres connection |
| `DB_POOL_MIN` `DB_POOL_MAX` | connection pool size |
| `AUTO_CREATE_TABLES` | run the schema files at startup; set false if the app's user may not run DDL |
| `OPENAI_API_KEY` `OPENAI_MODEL` `OPENAI_TIMEOUT` | drafting a form from a prompt |
| `CORS_ORIGINS` | comma-separated origins the API accepts |
| `DEFAULT_USER` | who a write is attributed to when nobody is signed in |
| `APP_URL` `SESSION_HOURS` `RESET_MINUTES` | auth and password reset |
| `ADMIN_EMAIL` `ADMIN_PASSWORD` | the first account; a blank password is generated and logged |
| `AUTH_EXPOSE_RESET_LINK` | local development only |
| `DISABLED_MODULES` | comma-separated modules to switch off entirely |
| `SMTP_*` | optional; without `SMTP_HOST`, reset links go to the log |

## Database

PostgreSQL. **There is no migration tool** — no Alembic, no version table.

The schema is applied at startup: core's `schema.sql` first, then each module's, then each
module's idempotent `ensure_*` migrations. Every one of them is safe to run repeatedly, so
starting the application brings an existing database forward without a separate step. Set
`AUTO_CREATE_TABLES=false` to apply the schema files by hand instead.

**Answers** live one table per form: a JSONB `form_data` column holding the whole validated
answer set, plus a `<form>_tabular` mirror with one column per question for reporting. The JSONB
is the record of truth; the mirror is rebuildable and its columns are never dropped.

Main tables:

| area | tables |
|---|---|
| accounts | `app_user` `app_role` `role_permission` `user_session` |
| projects | `project` `project_member` `project_group` `project_group_member` |
| forms | `forms` `form_version` `standard_form_library` `data_dictionary` `form_view` |
| access | `form_assignment` |
| review | `submission_review` |
| standards | `ontology_concept` `data_standard` `standard_variable` `crop_ontology` `crop_trait` `crop_variable` `unit` |
| client data | `client_catalog` `client_catalog_value` |

## RBAC

Authorization is **permission-based**. No code anywhere decides by role name — roles are data an
administrator can rename or replace, so a check against one would stop being true the moment
somebody did.

**System role** — what an account may do across the installation:

```
user ──▶ app_user.role_id ──▶ app_role ──▶ role_permission ──▶ permissions
```

**Project role** — what it may do inside one project:

```
user ──▶ project_member ──▶ role_id ──▶ app_role ──▶ role_permission ──▶ permissions
```

Both point at the **same** `app_role` table and draw on the same permission catalogue. There is
one RBAC system; what differs is where the role was found. The same account can hold
*Project manager* in one project and *Surveyor* in another.

Routes ask one question:

```python
@router.get("/{project_id}/members")
def members(project_id: str,
            user = Depends(access.needs_in_project(PROJECT_VIEW))):
```

Seeded project roles: **Project manager**, **Surveyor**, **Reviewer**.

**Isolation.** `access.permissions_in(user, project)` is empty for a non-member, which is the
whole of it. A project you are not in answers **404**, not 403 — a 403 would confirm the id is
real. Inside a project the answers are ordinary 403s, because there the resource is known to
exist. One deliberate bypass, `projects.view_all`, lets an administrator reach a project without
joining it; it is a permission like any other.

Account-wide permissions are checked first and project membership second: reading a form you
have no business reading gives 403 if your account cannot read forms at all, and 404 if it can
but the form belongs to someone else's project.

## Project hierarchy

```
Organization / System
├── Users
├── Global roles
└── Projects
      ├── Project members ──▶ project role
      ├── Project groups  ──▶ group members
      ├── Forms           ──▶ form assignments
      └── Submissions     ──▶ review workflow
```

## Form assignment

```
project ──▶ form ──▶ assignment
```

Three kinds — **everyone** in the project, a named **user**, or a **group** — and an assignment
is a relationship. The form is never copied, so correcting it corrects what everybody sees at
once.

A member sees a form when it was actually given to them. A form with **no** assignment is seen
only by somebody holding `project.forms.view_all`: a form nobody was given is not a form
everybody gets.

Forms with `project_id = NULL` predate projects. They are untouched and keep the system-wide
form permissions they always had.

## Submission workflow

```
draft ──▶ submitted ──▶ under_review ──▶ approved
              │              │
              └──────────────┴────────▶ rejected ──▶ submitted
```

The transitions are a table in `submission_workflow.py` and every move goes through `advance()`.
There is deliberately **no** endpoint that accepts a status: the move is the URL
(`POST /api/submissions/{form}/{survey}/approve`), so a surveyor cannot post
`{"status": "approved"}` at their own work. Approving and rejecting need
`project.submissions.review`; rejection requires a reason.

Review state lives in `submission_review`, beside the response rather than inside it. Every form
has its own dynamically created table, so workflow columns in that envelope would mean migrating
each one and rebuilding its mirror.

## Standards

```
modules/standards/
├── seont/           what a field means
├── icasa/           what it is officially called
├── crop_ontology/   which crop-specific variable it measures
└── units/           the arithmetic between units
```

`standards/` is a **container package**: it holds no module of its own, and the registry descends
into it to find four independent modules, each with its own tables, permissions and routes. A
field may carry any combination of the three mappings, and none overrules another — plant height
is ICASA's `PHTD` in metres *and* Crop Ontology's `CO_322:0000996` in centimetres, and `units/`
reconciles them on submission.

**`client_catalog/` is deliberately outside `standards/`.** A client's controlled lists are their
data, not a standard — the whole point of that module is that no standard and no model may
replace one of its values. Filing it under `standards/` would blur the one distinction the code
most depends on.

## Testing

```bash
cd backend && pytest              # needs Postgres; tests skip cleanly without it
cd frontend && npm test           # vitest, jsdom
cd frontend && npm run build
```

## API documentation

With the backend running, FastAPI serves interactive documentation:

- `http://localhost:8000/docs` — Swagger UI
- `http://localhost:8000/redoc` — ReDoc
- `http://localhost:8000/openapi.json` — the schema
- `http://localhost:8000/api/health` — reachability, and which tables are missing

## Development guidelines

- **Keep business logic in services.** Routers should read as a list of what a request is allowed
  to do, not how it is done.
- **Never decide by role name.** Ask for a permission.
- **Never duplicate authorization.** Project questions go through `projects/access.py`.
- **Preserve project isolation.** A resource in another project answers 404.
- **The field array is the order.** Nothing sorts a form's fields — the builder writes the list,
  `normalize_form` renumbers `order` from position, and every renderer reads the list.
- **Don't duplicate a module.** Two implementations of the same idea will disagree eventually.
- **Write tests for new behaviour**, including the case where somebody calls the API directly.
