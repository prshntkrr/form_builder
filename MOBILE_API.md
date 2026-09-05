# Mobile Developer API Guide

Everything a phone needs to **show → open → fill → submit**, and nothing else.

There is no mobile API. Every endpoint below is one the web application or MCDC
already calls: the same form definitions, the same permissions, the same
validation, the same submission service, the same tables. A phone is another
client of the Form Builder backend — if a rule changes there, it changes for the
phone on the same day, with no second implementation to keep in step.

Base URL: `{API}` = `https://your-server/api`

---

## 0. Authentication

Every call except login carries:

```
Authorization: Bearer <token>
Content-Type: application/json
```

The token is the *only* thing that says who the caller is. Nothing in a request
body — no `user_id`, `role`, `project_id` or `permissions` — is read for
authorization; sending them changes nothing, and a test asserts that.

| Status | Meaning |
|---|---|
| 401 | no token, or it has expired — sign in again |
| 403 | signed in, but this account's role cannot do this |
| 404 | the form or project is not reachable by this account (**this is what "forbidden" looks like for project resources** — it deliberately does not confirm the thing exists) |
| 409 | a conflict: the form is a draft, or this survey was already submitted |
| 422 | the answers were refused; `detail.errors` names the fields |
| 503 | storage is not configured on the server |

Errors are always `{"detail": ...}`. For 422, `detail` is
`{"errors": {"field_name": "what is wrong"}}`.

---

## 1. Sign in

```http
POST {API}/auth/login
{"email": "shrishti@example.org", "password": "..."}
```

```json
{ "token": "…", "user": { "user_id": "USR00012", "full_name": "Shrishti", "role": "surveyor" } }
```

`GET {API}/auth/me` returns the same user plus `capabilities` — flags the app can
use to hide sections. Treat them as hints; the server decides.

`POST {API}/auth/logout` ends the session.

---

## 2. The forms this account may fill

```http
GET {API}/mcdc/forms
GET {API}/mcdc/forms?project=PRJ00001      # one context only
```

```json
[
  { "form_id": "FRM00030",
    "form_title": "Farmer Registration",
    "form_description": "…",
    "field_count": 12,
    "version": 3,
    "form_status": "Active",
    "project_id": "PRJ00001",
    "project_name": "Mexico Maize" }
]
```

This is already narrowed by the server: project membership, form assignment, the
`project.forms.fill` permission, form status. **Do not fetch forms from anywhere
else and filter them on the phone.** A reviewer — who may read a project's forms
— receives `[]` here, because reading is not filling.

`GET {API}/forms/live/list` is the same list from the same function; use either.

---

## 3. The published form configuration

```http
GET {API}/forms/FRM00030/published
```

```json
{ "form_id": "FRM00030", "version": 3, "status": "published",
  "form_title": "Farmer Registration", "project_id": "PRJ00001",
  "published_at": "2026-09-04T10:00:00",
  "config": {
    "title": "Farmer Registration", "version": 3, "table_name": "farmer_registration",
    "sections": [ { "key": "farmer_details", "title": "Farmer details" } ],
    "fields": [
      { "name": "farmer_name", "label": "Farmer name", "type": "text",
        "required": true, "placeholder": "", "help_text": "", "default": null,
        "section": "farmer_details", "options": [], "validation": {}, "order": 1 },
      { "name": "main_crop", "label": "Main crop", "type": "select", "options": [],
        "options_from": { "source": "client_catalog", "catalog": "catalogue_crops" } },
      { "name": "farmer_photo", "label": "Farmer photo", "type": "image" }
    ],
    "rules": [
      { "conditions": [ { "field": "consent", "operator": "equals", "value": "yes" } ],
        "logic": "AND", "action": "show",
        "target": { "type": "field", "name": "village" } }
    ],
    "location": { "enabled": true, "required": false },
    "geofence": { "enabled": true, "polygon": [[-99.2, 19.4], …] },
    "relationship": { "type": "child", "parent_form_id": "FRM00029" }
  } }
```

**This is the frozen version, never a draft.** It is read from `form_version`, so
a form edited after you fetched it does not change under you — the edit becomes
version 4, and you get that next time you ask. A draft answers **409**.

### Rendering rules

- **Field order is the `fields` array.** `order` is present but is not the
  authority; render the array as given.
- `type` values: `text`, `textarea`, `number`, `decimal`, `date`, `time`,
  `datetime`, `select`, `multiselect`, `boolean`, `email`, `phone`, `location`,
  `image`, `audio`, `file`, `signature`. Anything unfamiliar: render as text.
- `required`, `validation` (min/max/pattern), `help_text`, `placeholder`,
  `default` are per field.
- `section` matches a `sections[].key`. Fields with no section come first.
- Semantic references (`semantic_concept`, `data_standard`, crop-ontology ids)
  travel through untouched. Show them or ignore them — do not rewrite them.

### Conditional rules

`rules` is the canonical engine, shared with the web app. A rule has
`conditions[]` (`field`, `operator`, `value`), `logic` (`AND`/`OR`), `action`
(`show`/`hide`) and a `target` of `{type: "field", name}`, `{type: "section", key}`
or `{type: "form"}`. Operators: `equals`, `not_equals`, `greater_than`,
`less_than`, `contains`, `is_empty`, `is_not_empty`, `in`, `not_in`.

Evaluate them to decide what to *show*. **Do not send answers to questions the
rules hid** — the server evaluates the same rules on arrival and refuses an
answer to a question the form did not ask (422). Hiding a question is not making
it optional; it is not asking it.

---

## 4. Lists a question offers

A field with `options` filled in needs nothing further. A field with
`options_from` is backed by a live list:

**Client catalogue** — `options_from.source == "client_catalog"`:

```http
GET {API}/client-catalogs/{catalog}/options
GET {API}/client-catalogs/{catalog}/options?language=en
GET {API}/client-catalogs/{catalog}/options?parent_code=MX-JAL     # dependent lists
```
```json
[ { "value": "MAIZE", "label": "Maize" }, { "value": "WHEAT", "label": "Wheat" } ]
```

`{catalog}` is `options_from.catalog`. If the field carries `allowed_values`,
pass them as repeated `allowed=` parameters to get just that subset.
`options_from.depends_on` names another field: refetch with that field's answer
as `parent_code` whenever it changes. Withdrawn values are not offered.

**Crop ontology** — `options_from.source == "crop_ontology"`:

```http
GET {API}/crop-ontology/options?kind=crop
GET {API}/crop-ontology/options?kind=trait&depends_on_value=MAIZE
```

The stored answer is always the **value/code**, never the label. Labels change
with language; codes do not.

---

## 5. Looking up another form's records

A form whose config carries `relationship: {type: "child", parent_form_id}` is
answered against one submission of the parent form.

```http
GET {API}/forms/FRM00031/relationship
GET {API}/forms/FRM00031/parent-options?q=ramesh&limit=50
```
```json
{ "parent_form_id": "FRM00029", "parent_form_title": "Farmer Registration",
  "submissions": [ { "survey_id": "000001", "summary": "Ramesh · Jalisco",
                     "created_by": "Shrishti", "created_on": "…" } ] }
```

Present these as a picker and send the chosen `survey_id` as `parent_survey_id`
on submit. **Never offer a free-text box for a survey id** — the list is already
narrowed to records this account may attach to, and the server checks the choice
again anyway.

---

## 6. Submitting

### The simple case — no files

One call:

```http
POST {API}/forms/FRM00030/submissions
{ "data": { "farmer_name": "Ramesh", "main_crop": "MAIZE" },
  "form_version": 3,
  "language": "es",
  "location": { "latitude": 19.4326, "longitude": -99.1332,
                "accuracy": 12.4, "captured_at": "2026-09-05T10:15:00Z" },
  "parent_survey_id": "000001",
  "channel": "mobile" }
```

```json
{ "survey_id": "000002", "form_id": "FRM00030", "form_version": 3,
  "created_on": "…", "location": {…}, "parent_survey_id": "000001",
  "channel": "mobile" }
```

Only `data` is required. `form_version` is recommended: if the form has been
republished since you fetched it, you get a 422 telling you to refetch rather
than having your answers reinterpreted against a definition you never saw.

### With photos, recordings or documents

The survey id is issued when the user presses Submit, not when the form opens —
so opening a form and walking away leaves nothing behind.

```
1. POST {API}/forms/FRM00030/submissions/start
     → {"survey_id": "000003"}

2. POST {API}/forms/FRM00030/submissions/000003/media/upload-url
     {"field_name": "farmer_photo", "filename": "farmer.jpg",
      "content_type": "image/jpeg", "file_size": 482912}
     → {"media_id": "MED…", "upload_url": "https://…", "s3_key": "…",
        "media_type": "image"}

3. PUT <upload_url>            ← the file bytes, header Content-Type: image/jpeg
                                 (straight to storage; no Authorization header)

4. POST {API}/forms/FRM00030/submissions/000003/media/MED…/complete
     {"file_size": 482912}

5. POST {API}/forms/FRM00030/submissions
     {"survey_id": "000003",
      "data": {"farmer_name": "Ramesh", "farmer_photo": "MED…"}}
```

The **answer for a media field is its `media_id`**, never a path, never base64.
The upload URL is short-lived (~15 min) and good for one object; the phone never
holds a credential and never builds a storage URL. Limits (25 MB, allowed content
types) are enforced server-side — a rejected upload comes back 422 with a
readable reason. An id whose upload never completed is refused at submit.

To read a file back: `GET {API}/forms/{form_id}/submissions/{survey_id}/media`
lists what is attached, and `…/media/{media_id}/url` returns a short-lived link.

### Retrying

If step 5 fails validation, the survey stays in progress: **fix the answers and
post again with the same `survey_id`**. Do not call `start` again — that burns a
new id. Files already uploaded stay attached; do not re-upload them. Submitting
the same id twice is refused with 409/422.

---

## 7. Location

If `config.location.enabled`, capture the device position once and send it as
above. If `config.location.required`, a submission without one is refused (422,
`_location`). If `config.geofence.enabled`, the server checks the point against
`geofence.polygon` — GeoJSON order, `[longitude, latitude]`.

You may check the polygon yourself to warn the user early, but **the server
decides**: a payload claiming to be inside is checked again from the same ring.
WhatsApp and IVR cannot provide GPS at all, which is why a form that truly needs
a position is configured `required` rather than assumed.

---

## 8. Offline and resume

The server holds an **id**, not a partial answer set. `form_survey_progress`
records that a survey was started so the id survives a failed submit — there is
no server-side draft to fetch back.

So: **keep unfinished answers on the device**. When the phone comes back online,
run the submit sequence. If you had already called `start` and uploaded files,
reuse that `survey_id`; otherwise start fresh. If you need true server-side
resume, say so — it is a change to this backend, not something to build on the
phone against an API that does not exist.

---

## 9. Endpoints, in one table

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/login` | sign in, get a token |
| GET | `/api/auth/me` | who am I, what can I do |
| POST | `/api/auth/logout` | end the session |
| GET | `/api/mcdc/forms` | **the forms this account may fill** |
| GET | `/api/forms/{form_id}/published` | **the published configuration to render** |
| GET | `/api/client-catalogs/{catalog}/options` | values for a catalogue-backed field |
| GET | `/api/crop-ontology/options` | values for an ontology-backed field |
| GET | `/api/forms/{form_id}/relationship` | is this form a child, and of what |
| GET | `/api/forms/{form_id}/parent-options` | records to attach a child to |
| POST | `/api/forms/{form_id}/submissions/start` | take a survey id (only when uploading) |
| POST | `/api/forms/{id}/submissions/{survey_id}/media/upload-url` | where to PUT a file |
| POST | `/api/forms/{id}/submissions/{survey_id}/media/{media_id}/complete` | it landed |
| GET | `/api/forms/{id}/submissions/{survey_id}/media` | what is attached |
| GET | `/api/forms/{id}/submissions/{survey_id}/media/{media_id}/url` | a link to read one |
| POST | `/api/forms/{form_id}/submissions` | **submit** |

Optionally, `POST /api/forms/{form_id}/submissions/ingest` with
`{"channel": "mobile", "payload": {…}}` — the same pipeline, tagging the
submission as collected on mobile. Use it if you want the channel recorded;
`"channel": "mobile"` on the ordinary endpoint does the same thing.

### What mobile does **not** need

Creating, editing, publishing, deleting or assigning forms; managing users,
projects, members, roles or permissions; managing catalogues, standards or
channel routing; the records/review screens; exports. A fill-only account is
refused all of them (403), and it should stay that way.

---

## 10. Quick start

```
1.  POST /api/auth/login                      → token
2.  GET  /api/mcdc/forms                      → the list
3.  user picks FRM00030
4.  GET  /api/forms/FRM00030/published        → version 3 + config
5.  render sections and fields in array order
6.  for options_from fields → catalogue / crop-ontology options
7.  for a child form → parent-options picker
8.  evaluate rules as the user answers; omit hidden questions
9.  if the form records a position → capture it
10. files chosen? POST …/submissions/start, then upload-url → PUT → complete
11. POST /api/forms/FRM00030/submissions {survey_id?, form_version, data, location}
12. → {"survey_id": "000004"}   ← show it as the receipt
```

Golden rules: identity comes from the token; the configuration comes from
`/published` and nowhere else; the answer to a media question is a `media_id`;
hidden questions are not submitted; and the server has the last word on every
one of those.
