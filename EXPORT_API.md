# Export API — sending a published form to MCDC

Configuration goes **out** through a connector. Collected answers come **back**
through the ordinary submission service. The two never share a path, and this
document is only about the first.

```
Form Builder → publish → frozen version → ExportConnector → MCDC
```

## Read this first: what is settled, and what is not

| | Status |
|---|---|
| **Form Builder behaviour** — the endpoint, permissions, publication, validation, idempotency, the `form_export` lifecycle, retries, what is and is not in the payload | **Confirmed.** Implemented, and covered by unit and integration tests |
| **The external MCDC contract** — the path, payload envelope, auth scheme, response shape, error meanings | **Proposed, unconfirmed.** No MCDC contract exists in this repository. What is below is our proposal, and the eight open questions at the end are what the MCDC team has to answer |
| **Mock MCDC** — `backend/tests/integration/mock_mcdc.py` | **Test-only.** A stand-in that speaks the proposal, so our half can be exercised over a real socket. It is not MCDC, it is never started by the application, and nothing outside `tests/` imports it |

Nothing here should be read as evidence that the integration works end to end
with a real MCDC. It has never been run against one.

---

## POST /api/forms/{form_id}/exports

Send this form's published configuration to a collection platform.

### Authentication

```
Authorization: Bearer <token>
Content-Type: application/json
```

### Permission

| Where the form lives | What is required |
|---|---|
| no project (system form) | the account permission **`forms.export`** |
| a project | **`project.forms.manage`** *in that project* |

Its own permission, deliberately: reading a form, or filling one in, is not
permission to hand its definition to another platform. `forms.export` is granted
at startup to every role that already has `forms.edit` (see
`bootstrap.ensure_export_permission`) — roles are seeded once, so a permission
added later otherwise reaches nobody. `mcdc.integrate`, which the collection
platform's own service account holds, does **not** include it.

A project this account cannot reach answers **404**, as everywhere else.

### Request

```json
{ "connector": "mcdc" }
```

| field | type | default | meaning |
|---|---|---|---|
| `connector` | string | `"mcdc"` | `mcdc`, or `echo` (records the export, sends nothing) |

Nothing else is read. The version is not a parameter — what is sent is whatever
is published now.

### Response — 201

```json
{
  "export_id": 42,
  "form_id": "FRM00030",
  "version": 3,
  "connector": "mcdc",
  "status": "EXPORTED",
  "already_exported": false,
  "external_id": "MCDC-77",
  "request_hash": "9f2c…64 hex chars",
  "response_metadata": { "http_status": 200 },
  "error_message": "",
  "exported_by": "Priya",
  "created_on": "2026-09-05T10:15:00",
  "updated_on": "2026-09-05T10:15:01"
}
```

`already_exported: true` means this version had already been delivered and
nothing was sent again. `request_hash` is a SHA-256 of exactly what was
delivered, so "is what they hold what we published?" can be answered without
asking them.

### Errors

| Status | When | Recorded as |
|---|---|---|
| 401 | no token | — |
| 403 | the account lacks `forms.export` (system form) | — |
| 404 | the form does not exist, or its project is out of reach | — |
| 409 | the form is a draft, or not live — there is no published version | — |
| 400 | no such connector | — |
| 422 | the published configuration is not valid (no questions, bad structure) | — |
| 502 | MCDC timed out, refused, or could not be reached | **FAILED** |

Every error is `{"detail": "one sentence"}`. No stack trace, no SQL, no
credential, and never MCDC's own response body — only which end refused and how.

### Retrying

A 502 leaves a **FAILED** record with `error_message`. Post the same request
again: it retries in the same row, under the same idempotency key. No second
row, no second id at the far end, and the published form is untouched either
way. A delivery that has succeeded is never repeated.

---

## GET /api/forms/{form_id}/exports

Same permission. Lists what has gone where and what can be sent to:

```json
{
  "form_id": "FRM00030",
  "connectors": [
    { "connector": "mcdc", "label": "MCDC (multi-channel collection)", "configured": true },
    { "connector": "echo", "label": "Echo (records the export, sends nothing)", "configured": true }
  ],
  "exports": [ { "export_id": 42, "version": 3, "status": "EXPORTED", … } ]
}
```

`configured: false` means this installation has no `MCDC_BASE_URL` — the button
is shown disabled rather than failing on click.

---

## GET /api/forms/{form_id}/published

What actually gets sent, and what MCDC fetches for itself later. Readable by
anyone who may see *or* fill the form. A draft answers 409. Full shape in
[MOBILE_API.md](MOBILE_API.md#3-the-published-form-configuration).

---

## The record

`form_export`, one row per **form + version + connector**:

| column | |
|---|---|
| `export_id` | primary key |
| `form_id`, `form_version`, `connector` | what was delivered, and where |
| `idempotency_key` | `FRM00030:3:mcdc` — unique index; this is what makes a retry safe |
| `status` | `PENDING` → `EXPORTED` \| `FAILED` |
| `request_hash` | SHA-256 of the payload |
| `external_id` | MCDC's own name for what it stored |
| `response_metadata` | what the far end said about the delivery |
| `error_message` | why it failed, in the words the caller was given |
| `exported_by`, `created_on`, `updated_on` | |

`PENDING` is written **before** the attempt, so a process that dies mid-flight
leaves a record rather than silence.

---

## Configuration

| variable | default | |
|---|---|---|
| `MCDC_BASE_URL` | *(empty)* | e.g. `https://mcdc.example.org/api`. Empty ⇒ the connector refuses with a message naming this variable, rather than inventing an address |
| `MCDC_API_KEY` | *(empty)* | sent as `Authorization: Bearer …`. Backend-only |
| `MCDC_TIMEOUT` | `20` | seconds |

Each request also carries `Idempotency-Key: {form_id}:{version}:{connector}` —
this end already refuses to send a version twice, and saying so lets the far end
refuse as well. Whether MCDC honours it, and under what header name, is open
question 6.

The key never appears in a form definition, an API response, a log line or a
browser. Tests assert this.

---

## What the payload looks like

`POST {MCDC_BASE_URL}/forms`, `Authorization: Bearer <MCDC_API_KEY>`:

```json
{
  "form_id": "FRM00030",
  "version": 3,
  "status": "published",
  "form_title": "Farmer Registration",
  "form_description": "…",
  "form_type": "parent",
  "parent_id": null,
  "project_id": "PRJ00001",
  "published_at": "2026-09-04T10:00:00",
  "config": {
    "title": "Farmer Registration", "version": 3,
    "table_name": "farmer_registration", "default_language": "en",
    "sections": [ { "key": "farmer_details", "title": "Farmer details" } ],
    "fields": [
      { "name": "consent", "label": "Consent", "type": "select",
        "options": ["yes", "no"], "required": false, "order": 1 },
      { "name": "farmer_name", "label": "Farmer name", "type": "text",
        "required": true, "section": "farmer_details", "order": 2 },
      { "name": "main_crop", "label": "Main crop", "type": "select", "options": [],
        "options_from": { "source": "client_catalog", "catalog": "crops_list" } },
      { "name": "variety", "label": "Variety", "type": "select",
        "options_from": { "source": "crop_ontology", "kind": "trait",
                          "depends_on": "main_crop" } },
      { "name": "farmer_photo", "label": "Farmer photo", "type": "image" }
    ],
    "rules": [
      { "conditions": [ { "field": "consent", "operator": "equals", "value": "yes" } ],
        "logic": "AND", "action": "show",
        "target": { "type": "section", "key": "farmer_details" } }
    ],
    "location": { "enabled": true, "required": true },
    "geofence": { "enabled": true, "polygon": [[-99.2, 19.4], [-99.1, 19.4], [-99.1, 19.5]] },
    "relationship": { "type": "child", "parent_form_id": "FRM00029" }
  }
}
```

What is preserved, and asserted by
`test_the_configuration_reaches_mcdc_intact`: field order (the array, not
`order`), sections, required flags, conditional rules verbatim, catalogue and
crop-ontology references **as references** (`options_from`, never a copy of the
values), media field types, location, geofence, form relationships, and semantic
metadata carried on fields.

What is **never** in it: credentials of any kind, S3 keys, bucket names,
database details, and any collected answer — no `survey_id`, no `form_data`.
Three tests assert each of those.

---

---

## Integration testing against the mock

`backend/tests/integration/` holds a small FastAPI service that speaks the
proposed contract, plus the tests that drive it. It runs on a free port in the
test process, over real HTTP: real headers, a real JSON body, and a real socket
held open long enough to prove a real timeout.

```bash
cd backend
python -m pytest tests/integration/ -v
```

It answers whatever a test tells it to — 200, 400, 401, 403, 409, 500, 503, or a
delay that outlives the connector's timeout — and records every request it
receives, headers included, so a test can ask what was *actually* sent rather
than what we believe was sent.

What that proves: the whole published configuration arrives intact (order,
sections, rules, references as references, media, location, geofence); no
collected answer is ever in the payload; the credentials and idempotency key are
on the request; a good answer becomes `EXPORTED`; every bad one becomes `FAILED`
with a message; a timeout is retried into `EXPORTED` in the same record; a
delivered version is never sent twice; a draft never reaches the wire.

What it does **not** prove: anything at all about MCDC.

---

## ⚠ What needs the MCDC team

The connector is written; the contract at the far end is assumed. Everything
below is one file — `MCDCConnector` in
`backend/app/modules/forms/connectors.py`, about 50 lines — and nothing else in
the application changes when it is corrected.

1. **The endpoint.** We POST to `{MCDC_BASE_URL}/forms`. Is that the path? Is
   creating a new version a `POST`, or a `PUT` to `/forms/{form_id}`?
2. **The payload.** We send the envelope above. Does MCDC want the canonical
   form JSON at the top level instead of nested under `config`? Does it want a
   wrapper of its own?
3. **Authentication.** We send `Authorization: Bearer <key>`. Is it a bearer
   token, an `X-API-Key` header, OAuth client credentials, or mTLS? Does the
   credential expire, and if so, how is it refreshed?
4. **The response.** We read `id` or `form_id` from a JSON object as
   `external_id`. What does MCDC actually return, and what is its identifier
   for a stored configuration?
5. **Versioning at their end.** Does MCDC keep versions, or replace? If we send
   version 4 of a form it already holds at version 3, what happens to sessions
   in flight against 3?
6. **Idempotency.** We guarantee we send each version once, and we send
   `Idempotency-Key: {form_id}:{version}:mcdc` with every request. Does MCDC
   honour that header? Under that name? Or does it expect its own scheme?
7. **Errors.** Which status codes mean "retry" and which mean "this
   configuration will never be accepted"? We currently treat all 4xx as the
   latter and all 5xx as the former.
8. **Deletion / unpublishing.** When a form is taken out of circulation here,
   should MCDC be told? There is no such call today.

Until those answers exist, use `"connector": "echo"` — it exercises permission,
publication, validation, idempotency, persistence and the API contract, and
sends nothing anywhere. It is not a fake success in production code: it is a
connector that honestly claims to deliver nowhere, and MCDC with no
`MCDC_BASE_URL` refuses rather than pretending.
