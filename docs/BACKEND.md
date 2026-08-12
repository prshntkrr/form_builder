# Backend — how it works

A FastAPI service that turns a sentence into a working data-collection form, stores the
definition in Postgres, gives the form its own table, and collects responses into it.

Everything here is plain Python over `psycopg2`. There is no ORM and no migration tool, because
the one thing that would normally need migrating — the shape of a form — is deliberately kept out
of the schema.

---

## 1. The central idea

A form has two halves that change at different speeds:

| | Changes | Lives in |
| --- | --- | --- |
| **Definition** — the questions, types, options, rules | Often. Every edit is a new version. | `forms.form_json`, `form_version.form_json` |
| **Responses** — what people answered | Never, once written | `<form_name>.form_data` (JSONB) |

Keeping the canonical answers in JSONB rather than in one column per question is what makes the
rest simple. Adding a question, removing one, changing a type — none of it can lose data, because
the JSONB table is never altered. It is created once and keeps the same six columns for life.

A second table, `<form_name>_tabular`, mirrors those answers as ordinary typed columns for
reporting. It *is* altered on every version — but only ever as a projection that can be rebuilt
from the JSONB, so nothing there is precious. See §3.

---

## 2. Shape of the system

```
   React                 FastAPI                        Postgres
 ─────────            ─────────────                  ──────────────

  builder  ──POST /forms/generate──▶  llm.py ──▶ OpenAI
                                        │
                                   form_schema.py          ← normalize / repair
                                        │
           ──POST /forms──────────▶ form_service.py ──┬──▶  forms
                                        │            └──▶  form_version
                                   table_service.py ─────▶  CREATE TABLE <form_name>
                                   tabular_service.py ────▶  CREATE TABLE <form_name>_tabular
                                        │
  live form ─POST /{id}/submissions─▶ submission_service.py ─┬─▶ <form_name>.form_data
                                        │                    └─▶ <form_name>_tabular
                                        │
  editor    ─PUT  /forms/{id}──────▶ migration_service.py ──▶  UPDATE form_data (renames)
                                   tabular_service.py ────▶  ALTER TABLE + rebuild
```

Each layer has one job and hands off:

- **routers/** — HTTP only. Parse, call a service, map exceptions to status codes.
- **services** — the actual work. They own transactions and know nothing about HTTP.
- **form_schema / field_types** — pure functions. No database, no network, fully testable.
- **database.py** — the only place that knows how to get a connection.

---

## 3. Two tables per form

Saving a form creates a pair:

```
farmer_registration              farmer_registration_tabular
─────────────────────            ───────────────────────────
survey_id      PK                survey_id      PK
form_id                          form_id
form_data      JSONB   ◀── the    created_on
created_on           record of    form_version
form_version         truth        created_by
created_by                        farmer_name    VARCHAR(255)  ┐
                                  land_area      NUMERIC(18,4) │ one per
                                  visit_date     DATE          │ question
                                  irrigation     TEXT          ┘
```

The JSONB table holds every answer ever submitted, in the shape it was submitted in. The
`_tabular` table is a **projection** of it — a normal table you can point a reporting tool at:

```sql
SELECT village, AVG(land_area) FROM farmer_registration_tabular GROUP BY village;
```

That direction of dependency is the whole trick. Because the mirror can be rebuilt from
`form_data` at any time, schema changes to it are cheap and reversible: a dropped column loses
nothing, and a retyped column is simply dropped and re-added rather than cast.

Both tables are written in the same transaction on submission, so the mirror can never be missing
a response the JSONB table has.

### How a mirror column is derived

| Field type | Column | Notes |
| --- | --- | --- |
| `text`, `email`, `select`, `radio` | `VARCHAR(255)` | |
| `textarea`, `url`, `file`, `signature` | `TEXT` | |
| `phone` | `VARCHAR(20)` | |
| `number`, `rating` | `INTEGER` | |
| `decimal` | `NUMERIC(18,4)` | |
| `date` / `datetime` / `time` | `DATE` / `TIMESTAMP` / `TIME` | |
| `boolean` | `BOOLEAN` | |
| `multiselect` | `TEXT` | flattened to `Canal, Borewell` |
| `location` | `TEXT` | flattened to `26.9,75.8` |

The last two are the only lossy part, and only in the mirror — `form_data` keeps the array and the
object. If you need them split (`plot_lat`, `plot_lng`) that is a change to `_field_columns` in
`tabular_service.py`.

### What a new version does to it

| Change to the form | Mirror |
| --- | --- |
| Question added | `ADD COLUMN`, then rebuild so history is filled in |
| Question removed | `DROP COLUMN` — the answers stay in `form_data` |
| Question renamed | `RENAME COLUMN` — values move with it |
| Type changed | column dropped and re-added, then rebuilt from `form_data` |

`POST /api/forms/{id}/rebuild-tabular` does it on demand — needed only for a form whose responses
predate the mirror.

## 4. Where things are stored

**`forms`** — one row per form. `form_json` holds the current definition; `form_id` is a
generated `FRM00001`-style key.

**`form_version`** — one row per saved revision, append-only. Every edit writes a new
`version_no` with a full copy of the definition, so any historical response can be read back
against the definition it was captured under.

**One table per form** — named after the form title (`Farmer Registration` →
`farmer_registration`), created on first save with exactly this shape:

```sql
survey_id    VARCHAR(50)  NOT NULL PRIMARY KEY
form_id      VARCHAR(20)  NOT NULL
form_data    JSONB        NOT NULL     -- the whole response
created_on   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
form_version INTEGER                   -- which definition this answer matches
created_by   VARCHAR(50)
```

Plus indexes on `form_id`, `created_on`, and a GIN index on `form_data`.

### survey_id

Each form table gets a Postgres sequence, `<table>_survey_seq`, and ids run
`FRM00007-000001`, `FRM00007-000002`, … A sequence rather than `MAX(...) + 1` because `nextval`
is atomic — two officers submitting at the same moment cannot be handed the same number, and no
retry loop is needed.

The number is zero-padded because `survey_id` is a `VARCHAR(50)`: unpadded, `"10"` would sort
before `"2"`. The form-id prefix keeps an id meaningful once it has been exported away from its
table. When a table is adopted with rows already in it, the sequence is set past them so a new
submission cannot collide with an existing id.

If a table of that name already exists it is **adopted**, not replaced — which is how a form
titled *Survey Form Data* lands in the pre-existing `survey_form_data` table. Two forms can never
claim the same table; the second gets a `_2` suffix.

---

## 5. The form definition

One JSON document, the contract between the model, the database, and the React renderer:

```json
{
  "title": "Farmer Registration",
  "description": "Baseline details for new farmers",
  "table_name": "farmer_registration",
  "created_by": "admin",
  "submit_label": "Submit",
  "success_message": "Thanks — that's recorded.",
  "sections": [{ "key": "basics", "title": "Basic details", "description": "" }],
  "fields": [
    {
      "name": "land_area",          // key inside form_data
      "label": "Land (acres)",
      "type": "decimal",
      "required": true,
      "placeholder": "", "help_text": "", "default": null,
      "section": "basics",
      "options": [],
      "validation": { "min": 0, "max": null, "min_length": null,
                      "max_length": null, "pattern": null, "step": null },
      "order": 3
    }
  ]
}
```

**Nothing reaches the database until it has been through `normalize_form`.** A language model is
a useful author but an unreliable one: it invents type names, emits duplicate keys, forgets the
options on a dropdown. The normalizer is the trust boundary and it repairs rather than rejects:

| What comes in | What comes out |
| --- | --- |
| `"type": "Multi-Select"` / `"currency"` / `"geopoint"` | `multiselect` / `decimal` / `location` |
| two fields both named `farmer_name` | `farmer_name`, `farmer_name_2` |
| a field named `created_on` | `created_on_value` (the envelope owns that name) |
| `"name": "1_score"` | `f_1_score` |
| a dropdown with no options | demoted to `text` — a broken control never ships |
| `"options": ["Canal", "Borewell"]` | `[{label, value}, …]` |
| a form with no usable fields | `FormSchemaError` → HTTP 422 |

---

## 6. Field types

`field_types.py` is a small registry — one entry per type, holding a coercion function and how
the value appears in JSON. It is the single source of truth; the frontend reads it from
`GET /api/field-types`.

Coercion runs twice, for different reasons:

- **On submission** — validate. A bad value raises `FieldValueError`, collected into a 422 with
  per-field messages.
- **Before storage** — normalize. `"12.5"` becomes `12.5`, `"true"` becomes `true`, a date
  becomes an ISO string. This is what keeps `form_data` worth querying:

  ```sql
  SELECT form_data ->> 'farmer_name'
  FROM   farmer_registration
  WHERE  form_data @> '{"irrigation": ["Canal"]}'
     AND (form_data ->> 'land_area')::numeric > 10;
  ```

### Validation rules

Each field may carry `min`, `max`, `min_length`, `max_length`, `pattern` and `step`.

`min`/`max` bound a number's **value**; `min_length`/`max_length` bound its **length**, and what
they count depends on the type:

| Field type | `max_length: 12` means |
| --- | --- |
| `number`, `decimal`, `rating`, `phone` | at most 12 digits |
| any other text type | at most 12 characters |

Which one applies is the `counts_digits` flag on the type registry entry. Counting digits is what
lets a fixed-width identifier be bounded without `max: 999999999999`, and it means separators
don't eat into a phone number's limit — `98765 43210`, `98765-43210` and `(98765) 43210` all count
as 10. A country code does count, so a form accepting `+91…` needs its limit set accordingly.

The message names the unit: *"National ID must be at most 12 digits"* vs *"Village must be at most
5 characters."*

---

## 7. What happens on each request

### Creating a form

```
POST /api/forms/generate   prompt ─▶ OpenAI ─▶ normalize_form ─▶ definition   (nothing saved)
POST /api/forms            definition ─▶ one transaction:
                             1. next form_id           FRM00007
                             2. resolve table name     no other form may claim it
                             3. INSERT forms
                             4. INSERT form_version    version 1
                             5. CREATE TABLE           the six envelope columns
```

All five steps share a transaction. A failure at step 5 rolls back the form row too — there is no
state where a form exists without its table.

### Submitting a response

```
POST /api/forms/{id}/submissions
    load form ─▶ status must be Active
              ─▶ validate_payload: required, options, type, min/max, length, pattern
              ─▶ json_safe(...) normalizes every value
              ─▶ INSERT (survey_id, form_id, form_data, form_version, created_by)
```

Validation failures come back as `422 {"detail": {"errors": {"land_area": "…"}}}` so the UI can
mark the individual field.

### Editing a form

```
PUT /api/forms/{id}   { form_json, renames: { "farmer": "farmer_name" } }
    1. normalize the new definition
    2. keep the original table_name and created_by — an edit never moves data or rewrites history
    3. validate_renames — before anything is written
    4. record renamed_from on the definition (new key -> old key)
    5. version_no + 1, INSERT form_version; UPDATE forms
    6. apply_renames: UPDATE <table> SET form_data = (form_data - 'farmer')
                                        || jsonb_build_object('farmer_name', form_data -> 'farmer')
```

Renames are validated before any write: the old key must exist in the saved version, the new key
must exist in the new definition, nothing may be renamed onto a key already in use, and two fields
cannot be renamed onto the same key. Any of these raises `MigrationError` → 422, and because it is
all one transaction, a rejected rename rejects the whole edit — no orphan version is left behind.

### Checking responses after an edit

```
POST /api/forms/{id}/revalidate   { "fix": false }
```

Walks every stored response and reports what no longer fits the current definition — a value that
can't be read as the new type, a choice that has since been removed, a newly-required field left
empty, a key from a deleted question. With `"fix": true` it also re-coerces the values it can (a
`"12.5"` string becomes `12.5` after that field is switched to decimal).

It never deletes an answer. Anything it can't repair is reported and left alone.

### Comparing two versions

```
GET /api/forms/{id}/diff?from=1&to=3      # omit both for latest vs previous
```

Because `form_version` stores a complete definition per revision, a diff needs no separate change
log — it is a comparison of two JSON documents (`diff_service.py`). It reports form-level changes
(title, description, sections, button text), fields added and removed, per-field changes to label,
type, requiredness, hints, choices and validation rules, and which questions moved.

The one thing naive JSON comparison gets wrong is a renamed field: it reads as one field removed
and another added. That is why each version records the renames that produced it. To compare v1
with v3, `trace_names` walks a field's name backwards through v3 and v2 until it finds what it was
called in v1:

```
primary_farmer  ──v3 renamed_from──▶  farmer_name  ──v2 renamed_from──▶  farmer
```

So a rename across any number of versions reads as a single changed field, with the old and new
storage keys shown.

---

## 8. Safety

**No SQL is ever built from model or user text.** Table names are slugified by `form_schema` and
reach Postgres only through `psycopg2.sql.Identifier`; every value is a bound parameter. The only
dynamic SQL in the system is the table name and the fixed envelope column list.

**Field names cannot collide with the envelope.** `created_on` as a question becomes
`created_on_value`, so `form_data ->> 'created_on'` can never be confused with the column.

**Transactions wrap units of work, not statements.** `database.transaction()` commits on clean
exit and rolls back on any exception. Every multi-step service call takes one.

**The pool is opened once at startup.** If Postgres is unreachable the app still boots so
`GET /api/health` can say why, rather than crash-looping.

---

## 9. Modules

| File | Owns |
| --- | --- |
| `config.py` | Settings from `.env`, via pydantic-settings |
| `database.py` | Connection pool, `transaction()`, `ping()` |
| `field_types.py` | Type registry: coercion, JSON representation, options/multi flags |
| `form_schema.py` | The definition contract, `normalize_form`, identifier slugifying, `ENVELOPE_COLUMNS` |
| `llm.py` | OpenAI calls — generate and refine. Returns raw JSON; trusts nothing |
| `table_service.py` | `CREATE TABLE`, adoption, table-name resolution |
| `form_service.py` | `forms` + `form_version` CRUD, form ids, response counts |
| `submission_service.py` | Validation, insert, listing, CSV export |
| `migration_service.py` | Key renames, `revalidate` |
| `tabular_service.py` | The flat `<form>_tabular` mirror: create, sync, insert, rebuild |
| `diff_service.py` | Comparing two versions, tracing renames across the gap |
| `routers/forms.py` | Authoring and management endpoints |
| `routers/submissions.py` | Render, submit, list, export |
| `main.py` | App wiring, CORS, `/api/health`, `/api/field-types` |

---

## 10. Configuration

All from `backend/.env` (see `.env.example`):

```
DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_SCHEMA DB_POOL_MIN DB_POOL_MAX
OPENAI_API_KEY OPENAI_MODEL OPENAI_TIMEOUT
CORS_ORIGINS DEFAULT_USER
```

`GET /api/health` reports whether the database is reachable and whether an OpenAI key is present.

---

## 11. Errors

| Status | Means |
| --- | --- |
| 404 | No such form |
| 409 | The form has no data table (a `forms` row created outside this app) |
| 422 | The definition is unusable, a rename is invalid, or a submission failed validation |
| 500 | Something unexpected — logged with a traceback |
| 502 | OpenAI is unreachable, unconfigured, or returned unparseable JSON |

---

## 12. Extending it

**A new field type** — add one `FieldType` to `_TYPES` in `field_types.py` with a coercion
function, list its aliases, and name it in the LLM prompt's supported-types line. Add a `case` to
`FieldInput.jsx`. Nothing else changes; no migration, because the value just goes into `form_data`.

**Real file uploads** — `file` currently stores the filename. Add an upload endpoint that writes
to object storage and store the returned URL in the same string field.

**Per-form reporting views** — build them over `form_data` and let the GIN index do the work:

```sql
CREATE VIEW v_farmer_registration AS
SELECT survey_id,
       created_on,
       form_data ->> 'farmer_name'            AS farmer_name,
       (form_data ->> 'land_area')::numeric   AS land_area
FROM   farmer_registration;
```

**Authentication** — `created_by` is currently whatever the client sends, falling back to
`DEFAULT_USER`. Replace that argument with the authenticated principal in the two service calls
that take it and nothing else needs to change.
