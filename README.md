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
| `AWS_REGION` `AWS_S3_BUCKET` | where uploads go. The region must be the bucket's own — signing for another answers a browser PUT with a 307 it cannot follow |
| `AWS_ACCESS_KEY_ID` `AWS_SECRET_ACCESS_KEY` | optional; left empty, boto3 uses its own chain (an instance role, a profile, the environment), which is how a deployed server should do it |
| `S3_URL_SECONDS` `MEDIA_MAX_MB` | how long a signed link lasts, and how large one object may be |
| `MCDC_BASE_URL` `MCDC_API_KEY` `MCDC_TIMEOUT` | the collection platform a published form can be exported to. Without a base URL the connector says so rather than inventing an address; the key is sent as a header and never reaches a browser or a form definition |

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

## Media: photos, recordings and documents

Three field types — `image`, `audio`, `file` — collect a file. The file goes to
S3; Postgres keeps a row saying what and where. **No bytes are ever written to
`form_data`**, and the browser is never given an AWS credential.

```
ask     POST /api/forms/{form_id}/submissions/{survey_id}/media/upload-url
        { field_name, filename, content_type, file_size }
        → { media_id, s3_key, media_type, upload_url }

upload  the browser PUTs the bytes straight to `upload_url`

confirm POST .../media/{media_id}/complete   { file_size }

read    GET  .../media                       metadata for one submission
        GET  .../media/{media_id}/url        → a presigned GET, minutes long
```

`upload_url` is a presigned PUT good for one object, one method and
`S3_URL_SECONDS`. Objects are never public: the only way to one is the download
endpoint, which is behind the same check as the submission it belongs to.

### Object keys

```
projects/{project_id}/forms/{form_id}/{survey_id}/{image|audio|file}/{filename}
system/forms/{form_id}/{survey_id}/{image|audio|file}/{filename}

projects/PRJ00001/forms/FRM00029/000001/image/photo.jpg
```

`survey_id` is six digits — `000001`, `000002` — counted **per form**: every form
has its own table and its own sequence, so Farmer Register and Plot Register both
start at `000001`. Which form a submission belongs to is `form_id`, stored beside
it and already in the path.

ids, never names — a project renamed tomorrow does not strip the bucket of its
history. A form outside every project is filed under `system/`, keeping the two
halves as separate in the bucket as they are in the database.

### `form_media`

`media_id`, `project_id`, `form_id`, `survey_id`, `field_name`, `media_type`,
`s3_key`, `original_filename`, `content_type`, `file_size`, `uploaded_on`,
`created_by`, `created_on`.

Keyed by `survey_id` — the identifier a submitted record already has. There is
deliberately no second submission identity. A row without `uploaded_on` is an
upload that was started and never finished; it is not listed and not served.

### What is refused

The field must exist on the form, be a media field, and accept the content type;
the object must be within `MEDIA_MAX_MB`; and the caller must be allowed to fill
the form (to upload) or read its records (to download) — the existing checks,
unchanged. Allowed types live in `ALLOWED_TYPES` in
`app/modules/forms/media_service.py`.

## Geolocation and geo-fencing

Two separate settings on the form definition, so they version and roll back with
the rest of it:

```json
{ "location": { "enabled": true, "required": false },
  "geofence": { "enabled": true, "polygon": [[lng, lat], [lng, lat], [lng, lat]] } }
```

`[longitude, latitude]`, the GeoJSON order. A ring of fewer than three points
encloses nothing and normalizes away. A form that asks for neither carries
neither key, which is every form built before this existed.

The browser asks for a position **once** when the form opens and reports
latitude, longitude, accuracy and `captured_at`. It may show "this looks outside
the area" as a courtesy — **the backend decides**, from the polygon on the form,
on submission. A page that lies about it changes nothing.

Submission is refused when a required position is missing, when the coordinates
are not a place on Earth, or when the point is outside the ring:

```json
{ "detail": { "errors": { "_location": "You are outside the allowed location for this form." } } }
```

A form that collects a position gets a nullable `location` JSONB column on its
own table — only that form, exactly as `parent_survey_id` works for child forms.

## Export connectors and multi-channel collection

Answers are not always collected on this application's own form page. MCDC —
the multi-channel collection layer — reaches people on mobile, WhatsApp and IVR.
That splits into two problems which are kept deliberately apart.

```
CONFIGURATION OUT                        DATA IN

  Form Builder                             Mobile   WhatsApp   IVR
       │                                      │        │        │
    Draft ──edit──> Draft                     └────────┼────────┘
       │                                               │
    Publish                                     Channel adapter
       │                                               │
  Published version (frozen)                  canonical answers
       │                                               │
  Export connector                          COMMON DATA INGESTION
       │                                               │
     MCDC                                    Form Submission Service
                                                       │
                                          ┌────────────┼────────────┐
                                       Database       S3        Location
```

**The Form Builder is the source of truth.** Fields, rules, catalogue and
standards references, relationships, what media and what location a form
collects — all of it lives here, in one canonical form JSON. Nothing else
defines a form, and there is no second format: what is exported is the same
definition the renderer draws and the submission service validates against.

**Only published configurations leave.** A draft has none. What goes out is the
row in `form_version` for the version that is live, which is written once and
never updated: a platform collecting against version 3 cannot have version 3
changed underneath it. Editing produces version 4, and that is a new export.

    GET  /api/forms/{form_id}/published    the frozen configuration
    GET  /api/forms/{form_id}/exports      what has gone where
    POST /api/forms/{form_id}/exports      {"connector": "mcdc"}

**Connectors decouple the two.** `ExportConnector` has one method. `MCDCConnector`
POSTs the published configuration to `MCDC_BASE_URL/forms` with `MCDC_API_KEY`
as a bearer header; `EchoConnector` records an export and sends nothing, for an
installation with nothing to talk to yet. A second platform is another subclass
and a line in `CONNECTORS` — publishing, versioning and submission do not change.

Exports are idempotent on **form + version + connector**, recorded in
`form_export` as `PENDING` → `EXPORTED` | `FAILED`. Sending version 3 to MCDC
twice is one delivery; a retry after a dropped connection cannot leave a
platform holding two copies. A failed attempt is recorded with what went wrong
and retried in the same row — silence would have looked exactly like nobody
having tried. See [EXPORT_API.md](EXPORT_API.md).

**Every channel shares one pipeline.** There is no mobile submission service and
no WhatsApp one. A channel adapter turns what that channel sends into the answers
the form asks for, and stops there:

```
{"channel": "mobile",   "payload": {"farmer_name": "Ramesh", "main_crop": "MAIZE"}}
{"channel": "whatsapp", "payload": {"messages": ["Ramesh", "1"]}}
{"channel": "ivr",      "payload": {"digits":   ["Ramesh", "1"]}}
```

all become `{"farmer_name": "Ramesh", "main_crop": "MAIZE"}` and go through
`POST /api/forms/{form_id}/submissions/ingest` into the same
`submission_service.submit` as the form page — same permission, same project
isolation, same required-field and conditional-rule validation, same catalogue
check, same **per-form six-digit survey id**, same table.

An adapter never decides whether a field is required, evaluates a condition,
resolves a catalogue or touches a table. Three channels with three notions of
"required" is three products.

**Channel is metadata.** `submission_channel` records how one submission
arrived; it is not an answer, so it is not in `form_data`, and it changes nothing
about what is validated or how it is stored. A submission with no row there came
in through this application's own form page.

**Media and location are unchanged.** An upload from any channel goes through
the existing presigned S3 flow and `form_media`; nothing binary is ever written
to Postgres. A published configuration says *that* a form collects a position —
the coordinates belong to the submission. Mobile has GPS and WhatsApp and IVR do
not, so a form that merely records a position takes one when it is offered, and
a form that requires one refuses every channel that cannot provide it.

**Version mismatch is refused, not reinterpreted.** A submission may name the
version it was collected against. If that is no longer live, the answers are
refused with a message telling the channel to fetch the configuration again —
better than validating version 3 answers with version 4 field definitions.

**Credentials never travel.** The MCDC key is a header, set from the
environment, and appears in no configuration, no response, no log and no
browser. `forms.export` is its own permission: reading a form, or filling one
in, is not permission to hand its definition to another platform.

### Channel routing

A person on WhatsApp sends a word; a caller presses a key. Something has to say
which form that means — and, separately, whether they may use it.

```
"REGISTER FARMER" ─whatsapp─┐
"1"               ─ivr──────┼─> route ─> FRM00030 ─> published version
(an app account)  ─mobile───┘                │
                                       may_fill_form
                                             │
                                      start, or nothing
```

**Resolution and authorization are two steps and stay two steps.** A route is a
signpost: it says where a keyword points and grants nothing at all. Whether the
person behind it may go there is `may_fill_form` — the same call the form page
makes, so a keyword reaches exactly the forms that identity could have opened
and answered from the application itself. A caller who may not use a form is
told exactly what a caller with an unknown keyword is told, `{"matched": false}`,
because "that form exists but you may not use it" turns a keyword into a way to
enumerate what an installation collects.

**A phone number is not an account.** `channel_identity` maps a WhatsApp number
or caller id to an application account, and everything downstream authorizes
*that* account — its projects, its role there, its assignments. An unmapped
number is nobody.

```
GET  /api/mcdc/whatsapp/routes?keyword=REGISTER%20FARMER&identity=%2B52...
GET  /api/mcdc/ivr/routes?menu=1&identity=%2B52...
GET  /api/mcdc/forms                    the forms an account may fill
CRUD /api/mcdc/routes                   which keyword means what
POST /api/mcdc/identities               which account a number is
```

Resolution answers with a **reference** — `form_id`, `version`, `status` — and
never a definition. MCDC then fetches the canonical published configuration from
`/api/forms/{id}/published`, which is the one copy.

Keywords match with case and surrounding space forgiven, and nothing fuzzier: a
keyword that nearly matches starts the wrong form and nobody downstream can
tell. One live route per keyword per scope, enforced by a partial unique index —
a duplicate is refused when it is configured, not guessed at while somebody is
waiting. IVR keys must be what a keypad can send.

Routes are **project-scoped, with global routes supported**: a project's own
route wins over a global one, and a keyword meaning two things to one caller is
a 409 to fix rather than a coin to toss. The route names the form, never a
version — republishing moves every keyword with it.

Disabling or deleting a route never touches the form; taking a form out of
circulation makes its routes stop resolving.

**The service account.** MCDC authenticates as itself with `mcdc.integrate`,
plus `records.view` and `records.create` — not as an employee, and not as an
administrator. It resolves routes for callers it can name, and sends in what
they answered via `channel_identity` on the ingest endpoint; the submission is
then authorized *and attributed* as that caller's account, never as the
platform. `mcdc.manage` — deciding which keyword reaches which form — is a
separate permission the platform does not hold.

## Testing

```bash
cd backend && pytest              # needs Postgres; tests skip cleanly without it
cd frontend && npm test           # vitest, jsdom
cd frontend && npm run build

# just the two newest features
cd backend && pytest tests/modules/forms/test_media_and_location.py
cd frontend && npx vitest run src/modules/forms/mediaAndLocation.test.jsx
```

S3 is stubbed in the tests — no bucket or credentials are needed to run them.

### Trying media and location by hand

1. Build a form with a photo, a document and a recording, and tick **Collect
   the user's location**. The AI builder understands "collect the farmer's
   photo, identity document and interview audio, and record the GPS location".
2. Publish it and open it. The browser asks for location once; allow it.
3. Fill it in, submit, then attach the files — uploads are keyed by the
   `survey_id` the submission just got.
4. Check the row: `SELECT * FROM form_media WHERE survey_id = '…'`, and
   `SELECT location FROM <the form's table> WHERE survey_id = '…'`.
5. In S3, the object is at
   `projects/{project_id}/forms/{form_id}/{survey_id}/image/…`.
6. As an account outside the project, every media endpoint for it answers 404.

For geo-fencing, draw a small ring around somewhere you are not and submit: the
answer is *"You are outside the allowed location for this form."*

### S3

Without `AWS_S3_BUCKET` the media endpoints answer 503 and everything else works
as before. The key and secret are optional: left empty, boto3 uses its usual
chain — an instance role, a profile, the environment — which is what a deployed
server should be doing.

```
AWS_REGION=us-east-1
AWS_S3_BUCKET=e-agrology-media
AWS_ACCESS_KEY_ID=            # optional; prefer an instance role
AWS_SECRET_ACCESS_KEY=        # optional
S3_URL_SECONDS=900            # how long an upload or download link lives
MEDIA_MAX_MB=25               # largest single object
```

## API documentation

With the backend running, FastAPI serves interactive documentation:

- `http://localhost:8000/docs` — Swagger UI
- `http://localhost:8000/redoc` — ReDoc
- `http://localhost:8000/openapi.json` — the schema
- `http://localhost:8000/api/health` — reachability, and which tables are missing

**[STANDARDS_ISO3166.md](STANDARDS_ISO3166.md)** is the country codes: where
ISO 3166-1 lives in the standards tables, how it is imported and versioned, and
why it is a standard rather than a client catalogue.

**[MCDC_GATEWAY.md](MCDC_GATEWAY.md)** is the boundary channel traffic crosses:
the route allowlist, request validation, per-principal throttling, request ids,
the error contract, and what has to change before running more than one instance.

**[EXPORT_API.md](EXPORT_API.md)** is the export contract: `POST /api/forms/{id}/exports`,
the payload MCDC receives, the `form_export` lifecycle, and the list of things
the MCDC team still has to confirm before the last hop is real.

**[MOBILE_API.md](MOBILE_API.md)** is the guide for a mobile developer: sign in,
list the forms this account may fill, fetch the published configuration, render
it, upload media, submit. Every endpoint in it already exists and is shared with
the web application — there is no mobile API, no mobile form definition and no
mobile submission path.

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
