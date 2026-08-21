# e-Agrology AI Form Builder

Prompt → LLM → live form. A React frontend and a FastAPI (Python) backend that turn a
natural-language prompt into a complete form definition using an OpenAI model, persist it in
Postgres (`forms` + `form_version`), and **provision a dedicated data table per form** — every
table shaped exactly like `survey_form_data`, with the whole response stored as JSONB in
`form_data`.

```
e_agrology_new/
├── backend/
│   ├── app/
│   │   ├── config.py          # env settings
│   │   ├── database.py        # Postgres connection pool  <-- connection file
│   │   ├── field_types.py     # field type registry: validation + JSON coercion
│   │   ├── form_schema.py     # canonical form JSON schema + normalizer
│   │   ├── llm.py             # OpenAI form generation / refinement
│   │   ├── table_service.py   # dynamic CREATE TABLE per form
│   │   ├── form_service.py    # forms + form_version CRUD
│   │   ├── submission_service.py
│   │   ├── routers/
│   │   │   ├── forms.py
│   │   │   └── submissions.py
│   │   └── main.py
│   ├── schema.sql             # reference DDL for the 3 base tables
│   ├── requirements.txt
│   └── .env.example
└── frontend/                  # Vite + React
    └── src/
        ├── api.js
        ├── components/
        └── pages/
```

## 1. Backend setup

The virtualenv is already created at `backend/.venv` with dependencies installed.

```bash
cd backend
copy .env.example .env          # then fill in DB password + OPENAI_API_KEY
.venv\Scripts\python verify_setup.py     # end-to-end DB check (no OpenAI needed)
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

Docs: <http://localhost:8000/docs> · Health: <http://localhost:8000/api/health>

`verify_setup.py` saves a throwaway form, provisions its table, submits a row, reads it back and
adds a field — proving the whole persistence path before you touch the UI. Run it with
`--cleanup` afterwards to drop the test form and table.

`.env`:

```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=e_agrology
DB_USER=postgres
DB_PASSWORD=yourpassword
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

The three base tables (`forms`, `form_version`, `survey_form_data`) already exist in your DB.
`backend/schema.sql` reproduces them with `IF NOT EXISTS` for a fresh environment.

### Hiding a module

A module still being built stays out of a client's hands with one line:

```
DISABLED_MODULES=dashboards
```

Comma-separated, in `backend/.env`. A module named there is not loaded at all —
no routes, no permissions, no tables — and the UI hides its screens because the
server tells it which modules are live. Restart to apply; no rebuild needed.

### The first sign-in

Startup creates an administrator if no account can hand out roles yet. Choose its
password before that first run:

```
ADMIN_EMAIL=you@example.org
ADMIN_PASSWORD=something-long-and-yours
```

Leave `ADMIN_PASSWORD` blank and one is generated and printed to the log once —
the only time you will see it. Real environment variables win over `.env`, so a
container or service unit can supply it without the value touching a file:

```bash
ADMIN_PASSWORD='...' python -m uvicorn app.main:app          # Docker -e, systemd Environment=
```

This applies to the *first* run only. Afterwards the account exists and startup
leaves it alone, so use the CLI:

```bash
cd backend
python set_admin_password.py --from-env           # apply ADMIN_EMAIL / ADMIN_PASSWORD
python set_admin_password.py                      # prompts; ADMIN_EMAIL by default
python set_admin_password.py you@example.org
python set_admin_password.py you@example.org --grant-admin
echo 'new-password' | python set_admin_password.py --stdin
```

Use the venv's interpreter — `.venv/bin/python` on Linux,
`.venv/Scripts/python.exe` on Windows — so it reads the same `.env` as the server.

It creates the account if there is none, clears any lockout, and signs out every
existing session and reset link. `--grant-admin` also moves the account onto the
admin role, which is how you recover an installation where nobody can reach
Roles and Users any more.

## 2. Frontend setup

```bash
cd frontend
npm install            # already done
npm run dev            # http://localhost:5173
```

The dev server proxies `/api` to `http://localhost:8000`.

## 3. How it works

1. **Describe** the form in plain language (`/builder`). The backend sends your prompt plus a
   strict JSON contract to OpenAI and gets back a full form definition — sections, fields,
   labels, types, options, validation, and a suggested Postgres table name.
2. **Preview & refine.** Tweak fields inline, or send a follow-up prompt ("add a GPS field,
   make phone required") to have the model revise the existing JSON.
3. **Save.** The backend:
   - inserts into `forms` (`form_id` like `FRM00001`, `form_json` = the definition),
   - inserts version 1 into `form_version`,
   - runs `CREATE TABLE IF NOT EXISTS <table_name>` with exactly the `survey_form_data` shape:

     ```
     survey_id    VARCHAR(50)  NOT NULL PRIMARY KEY
     form_id      VARCHAR(20)  NOT NULL
     form_data    JSONB        NOT NULL
     created_on   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
     form_version INTEGER
     created_by   VARCHAR(50)
     ```

   - and a second table, `<table_name>_tabular`, with the same envelope minus `form_data` **plus
     one typed column per question** — a normal table for reporting.

   A form titled *Survey Form Data* lands in `survey_form_data` + `survey_form_data_tabular`;
   *Farmer Registration* in `farmer_registration` + `farmer_registration_tabular`.
4. **Live.** The form is immediately fillable at `/f/<form_id>`. Each submission writes one row to
   each table, in the same transaction — the whole response as JSONB, and the same answers spread
   across typed columns.
5. **Edit later.** Saving changes bumps `version_no` and appends a row to `form_version`. The
   JSONB table is never altered, so nothing can be lost. The `_tabular` mirror follows the new
   definition — columns added, dropped, renamed or retyped — and is rebuilt from `form_data`
   where needed. Submissions made under older versions stay readable; `form_version` on each row
   records which definition they match.

## 4. Field types → what lands in `form_data`

`backend/app/field_types.py` is the single source of truth; the frontend reads it from
`GET /api/field-types`. Answers are validated, coerced, then normalized into JSON — so a
`decimal` field posted as the string `"12.5"` is stored as the number `12.5`.

| Field types | Stored in `form_data` as |
| --- | --- |
| `text`, `textarea`, `email`, `phone`, `url`, `select`, `radio`, `file`, `signature` | string |
| `number`, `decimal`, `rating` | number |
| `boolean` | boolean |
| `date` | string, `YYYY-MM-DD` |
| `datetime` / `time` | string, ISO 8601 / `HH:MM:SS` |
| `multiselect` | array of strings |
| `location` | object `{lat, lng}` |

Example row:

```json
{
  "farmer_name": "Ramesh Kumar",
  "visit_date":  "2026-07-29",
  "land_area":   12.5,
  "irrigation":  ["Canal", "Borewell"],
  "is_verified": true
}
```

Field names the model produces are slugified to snake_case, de-duplicated, and renamed if they
collide with an envelope column (`created_on` becomes `created_on_value`) so a query never has to
guess between the column and the JSON key. Table names reach Postgres only through
`psycopg2.sql.Identifier` — no model output is ever concatenated into DDL.

Because `form_data` is JSONB with a GIN index, it stays queryable:

```sql
SELECT form_data ->> 'farmer_name', form_data -> 'land_area'
FROM   farmer_registration
WHERE  form_data @> '{"irrigation": ["Canal"]}';
```

## 5. Editing a form after it is live

The table shape is fixed for the life of the form, so editing never runs a migration. Add a
question, remove one, change a type — only `form_json` and `form_version` change.

Two cases involve data that already exists:

- **Renaming a field.** The key its answers are stored under changes, so the update carries a
  `renames` map and the backend moves every stored answer across in the same transaction. A
  rename that would overwrite another field's answers is rejected outright.
- **Changing a type, options, or requiredness.** Existing answers may no longer fit. **Check
  responses** in the editor (or `POST /api/forms/{id}/revalidate`) reports exactly which rows and
  why, and can re-coerce the ones it safely can. It never deletes an answer.

Older submissions keep the shape they were captured in; `form_version` on each row records which
definition to read it against.

Because every revision stores a complete definition, the **History** tab compares any two of them —
what was added, removed, retyped, renamed, or reordered — with no separate change log to maintain.
A field renamed across several versions is followed through the chain, so it reads as one changed
field rather than a removal plus an addition.

The same tab lists every version, marks which one is **Live**, and offers **Roll back** on the
rest. Rolling back writes no new version — the form simply points at that version's stored
definition, so the history is untouched and you can roll anywhere else afterwards. Answers already
collected move to the keys that version uses. Editing while rolled back appends as normal.

For the full picture — module map, request lifecycles, safety model — see
[docs/BACKEND.md](docs/BACKEND.md). For what is built, what is missing, and the
order the remaining features want to be done in, see
[docs/ROADMAP.md](docs/ROADMAP.md). For how the code is split into modules and
how two people work in it without conflicts, see [docs/MODULES.md](docs/MODULES.md).

## 6. Attribution (`created_by`)

`forms.created_by` and each submission row's `created_by` are resolved in this order:

1. what the request sends (`created_by` in the POST body — the **Created by** box in the builder,
   **Submitting as** on the live form; both remembered in `localStorage`),
2. an author the prompt named and the model picked up — *"a plot survey form created by admin"*
   sets `created_by` to `admin` and prefills the box,
3. `DEFAULT_USER` from `.env`, which ships as `system`.

Editing a form never rewrites the original author; the editor is recorded as `updated_by` inside
the versioned `form_json` instead, since the `forms` table has no such column.

## 7. API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/forms/generate` | prompt → form JSON (not persisted) |
| `POST` | `/api/forms/refine` | existing JSON + prompt → revised JSON |
| `POST` | `/api/forms` | save form, create version 1, provision table |
| `GET` | `/api/forms` | list forms |
| `GET` | `/api/forms/{form_id}` | one form + version info |
| `PUT` | `/api/forms/{form_id}` | update → new version, moving answers for renamed fields |
| `POST` | `/api/forms/{form_id}/revalidate` | check stored responses against the current definition (`fix: true` re-coerces) |
| `POST` | `/api/forms/{form_id}/rebuild-tabular` | repopulate the flat `<form>_tabular` mirror from the JSONB table |
| `PATCH` | `/api/forms/{form_id}/status` | Active / Inactive |
| `DELETE` | `/api/forms/{form_id}` | soft delete (status = Deleted) |
| `GET` | `/api/forms/{form_id}/versions` | version history |
| `GET` | `/api/forms/{form_id}/diff?from=1&to=3` | what changed between two versions (defaults to latest vs previous) |
| `POST` | `/api/forms/{form_id}/rollback` | make an existing version live (writes no new version) |
| `POST` | `/api/forms/{form_id}/submissions` | submit a filled form |
| `GET` | `/api/forms/{form_id}/submissions` | paginated submissions |
| `GET` | `/api/forms/{form_id}/submissions/export` | CSV export |

## 8. Deploying to a server

### Database

Only two tables need to exist: `forms` and `form_version`. **Every form's own data table is
created by the application**, so there is nothing per-form to prepare.

```bash
createdb -h <host> -U <user> e_agrology        # or CREATE DATABASE e_agrology;
```

That's usually all. On first start the app runs `backend/schema.sql` itself and creates anything
missing — the file is idempotent, so it's a no-op on an existing database.

If the app's database user isn't allowed to run DDL, apply it yourself and switch the automatic
step off:

```bash
psql -h <host> -U <user> -d e_agrology -f backend/schema.sql
# then in .env:
AUTO_CREATE_TABLES=false
```

Note that the user still needs `CREATE` on the schema at runtime, because saving a form issues a
`CREATE TABLE`. Grant it with:

```sql
GRANT CREATE, USAGE ON SCHEMA public TO <user>;
```

If your policy forbids that outright, this design won't fit without changes — per-form tables are
the core of it.

### Backend

```bash
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # fill in DB_* and OPENAI_API_KEY
.venv/bin/python verify_setup.py            # end-to-end check, then --cleanup
.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4
```

Drop `--reload` in production and run it under systemd (or a container). A minimal unit:

```ini
[Unit]
Description=e-Agrology form builder API
After=network.target postgresql.service

[Service]
WorkingDirectory=/srv/e_agrology/backend
EnvironmentFile=/srv/e_agrology/backend/.env
ExecStart=/srv/e_agrology/backend/.venv/bin/python -m uvicorn app.main:app \
          --host 127.0.0.1 --port 8000 --workers 4
Restart=always
User=eagrology

[Install]
WantedBy=multi-user.target
```

`WorkingDirectory` matters — `.env` is read relative to it.

### Frontend

```bash
cd frontend
npm ci && npm run build       # outputs dist/
```

Serve `dist/` from nginx alongside the API. Because the app uses client-side routing, unknown
paths must fall back to `index.html` or a refresh on `/f/FRM00001` returns 404:

```nginx
server {
    listen 80;
    server_name forms.example.org;
    root /srv/e_agrology/frontend/dist;

    location / {
        try_files $uri $uri/ /index.html;    # required for client-side routes
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Served this way the frontend and API share an origin, so no CORS setup is needed. If you put the
API on a different host, build with `VITE_API_BASE=https://api.example.org` and add the frontend's
origin to `CORS_ORIGINS` in `.env`.

### Check it came up

```bash
curl https://forms.example.org/api/health
```

`status: ok` means the database is reachable, the base tables exist and an OpenAI key is loaded.
`missing_tables` lists anything the app expected and could not find.
