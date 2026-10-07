# Forms API — Builder & Authoring Endpoints

API documentation for the Forms module: generating, editing, versioning and
publishing form definitions. Submission endpoints are covered separately.

Base URL: `{API}` = `https://<your-server>/api`

---

## 1. Authentication

Every endpoint requires a session token (see the auth documentation). Send it
as a cookie or `Authorization: Bearer <token>` header.

Permissions are checked in two tiers:

| Context | How it works |
|---|---|
| **System** | The account holds the permission directly (e.g. `forms.create`) |
| **Project** | The account holds a project role that carries the permission (e.g. `project.forms.manage`). A form inside a project is governed by that project's roles, not the account's system permissions. |

A form belonging to no project uses the system permission. A form inside a
project uses the project permission. A project the account cannot reach answers
**404**, not 403.

---

## 2. AI generation & validation

These endpoints touch no stored form. They are the builder's aids: draft a
definition, revise it, check it, test it, translate it.

**Permission**: the account must be able to build a form *somewhere* — either
`forms.create` on the account, or a project role that allows building forms.

### 2.1 Generate form from prompt

```http
POST {API}/forms/generate
Content-Type: application/json

{
  "prompt": "A household survey for rice farmers collecting plot size, irrigation method, varieties grown and expected yield",
  "language": "en"
}
```

`language` is optional (defaults to English).

**200 OK**

```json
{
  "form_json": {
    "title": "Rice Farmer Household Survey",
    "description": "Household-level survey for rice farming operations",
    "fields": [
      {
        "name": "plot_size_hectares",
        "label": "Plot size (hectares)",
        "type": "decimal",
        "required": true,
        "validation": { "min": 0.01, "max": 1000 }
      },
      {
        "name": "irrigation_method",
        "label": "Irrigation method",
        "type": "dropdown",
        "required": true,
        "options": [
          { "value": "rainfed", "label": "Rainfed" },
          { "value": "canal", "label": "Canal irrigation" },
          { "value": "tubewell", "label": "Tubewell" },
          { "value": "drip", "label": "Drip irrigation" }
        ]
      }
    ],
    "sections": [
      { "key": "plot_details", "label": "Plot Details", "fields": ["plot_size_hectares", "irrigation_method"] }
    ],
    "version": 1
  },
  "standards": [],
  "crop_ontology_id": null,
  "dynamic_options": [],
  "prompt": "A household survey for rice farmers collecting plot size, irrigation method, varieties grown and expected yield"
}
```

The returned `form_json` is already normalized. Pass it to `POST /forms` to
save it, or to `/forms/refine` to revise it.

| Error | Status | Meaning |
|---|---|---|
| Prompt refused | 422 | The prompt was rejected (too vague, off-topic) |
| LLM failure | 502 | The model could not produce a valid form |

### 2.2 Refine an existing form

```http
POST {API}/forms/refine
Content-Type: application/json

{
  "form_json": { "...existing definition..." },
  "instruction": "Add a GPS location field and make plot_size_hectares optional"
}
```

**200 OK**

```json
{
  "form_json": { "...revised, normalized definition..." },
  "prompt": "Add a GPS location field and make plot_size_hectares optional"
}
```

### 2.3 Validate a definition

```http
POST {API}/forms/validate
Content-Type: application/json

{ "form_json": { "...definition..." } }
```

**200 OK** (valid)

```json
{ "valid": true, "form_json": { "...normalized definition..." } }
```

**422 Unprocessable Entity** (invalid)

```json
{
  "detail": {
    "valid": false,
    "stage": "field_validation",
    "errors": [
      { "field": "irrigation_method", "error": "Dropdown field has no options" }
    ]
  }
}
```

### 2.4 Test a definition against sample data

Runs the same validation a real submission goes through, without saving
anything.

```http
POST {API}/forms/test-definition
Content-Type: application/json

{
  "form_json": { "...definition..." },
  "data": {
    "plot_size_hectares": 2.5,
    "irrigation_method": "canal"
  },
  "language": "en"
}
```

**200 OK** — returns the validation result (accepted values, coerced values,
errors) in the same shape as a real submission response.

### 2.5 Available languages

```http
GET {API}/forms/languages
```

**200 OK**

```json
[
  { "code": "en", "name": "English" },
  { "code": "es", "name": "Spanish" },
  { "code": "fr", "name": "French" },
  { "code": "hi", "name": "Hindi" }
]
```

### 2.6 Translate a form

Translates the form's wording (labels, help text, options) into another
language. Field names and option values are identifiers and are never
translated.

```http
POST {API}/forms/translate
Content-Type: application/json

{
  "form_json": { "...definition..." },
  "language": "es"
}
```

**200 OK**

```json
{
  "language": "es",
  "translations": {
    "plot_size_hectares": { "label": "Tamaño de la parcela (hectáreas)" },
    "irrigation_method": {
      "label": "Método de riego",
      "options": {
        "rainfed": "De secano",
        "canal": "Riego por canal"
      }
    }
  }
}
```

| Error | Status | Meaning |
|---|---|---|
| Same as base language | 400 | Cannot translate a form into its own language |
| Unsupported language | 400 | Language code not in `/forms/languages` |
| LLM failure | 502 | The model did not return usable translations |

---

## 3. CRUD

### 3.1 Create a form

```http
POST {API}/forms
Content-Type: application/json

{
  "form_json": {
    "title": "Rice Farmer Household Survey",
    "fields": [ "..." ],
    "sections": [ "..." ]
  },
  "form_type": "parent",
  "form_status": "Active",
  "project_id": "PRJ00005",
  "whatsapp": {
    "number": "+254700000000",
    "keyword": "RICE"
  }
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `form_json` | object | **required** | The form definition |
| `form_type` | string | `"parent"` | `"parent"` or `"child"` |
| `parent_id` | string | `null` | Required when `form_type` is `"child"` |
| `form_status` | string | `"Active"` | `"Draft"` or `"Active"` |
| `project_id` | string | `null` | Assigns to a project; omit for a system form |
| `whatsapp` | object | `null` | `{ number, keyword }` for WhatsApp forms |

**Permission**: `forms.create` (system) or `project.forms.manage` (in the named
project). Both are checked: the account must be able to build *somewhere*
(`_could_build_somewhere`), and then must be able to build *in this project*
specifically.

**201 Created**

```json
{
  "form_id": "FRM00030",
  "form_title": "Rice Farmer Household Survey",
  "form_status": "Active",
  "form_type": "parent",
  "table_name": "rice_farmer_household_survey_frm00030",
  "version_no": 1,
  "field_count": 4,
  "created_on": "2026-10-03T08:15:22.451000",
  "created_by": "Piyush Gupta",
  "project_id": "PRJ00005"
}
```

| Error | Status | Meaning |
|---|---|---|
| Validation failed | 422 | `form_json` did not pass `config_validation` |
| Keyword taken | 400 | Another form already uses that WhatsApp keyword |
| Duplicate id | 409 | A form with that id already exists |
| Relationship error | 422 | Invalid parent reference for a child form |

### 3.2 List forms

```http
GET {API}/forms?status=Active&search=rice&limit=25&offset=0&project=PRJ00005
```

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `status` | string | all | `Draft`, `Active`, `Paused` |
| `search` | string | — | Searches title |
| `limit` | int | 100 | 1–500 |
| `offset` | int | 0 | For pagination |
| `project` | string | — | A project id, or `"none"` for system forms |

**Permission**: `forms.view`. With `project=none`, also needs `forms.system_view`.

**200 OK** — array of form summaries:

```json
[
  {
    "form_id": "FRM00030",
    "form_title": "Rice Farmer Household Survey",
    "form_description": "Household-level survey for rice farming operations",
    "form_status": "Active",
    "form_type": "parent",
    "parent_id": null,
    "table_name": "rice_farmer_household_survey_frm00030",
    "field_count": 4,
    "version_no": 3,
    "created_on": "2026-10-03T08:15:22.451000",
    "updated_on": "2026-10-03T10:42:18.112000",
    "created_by": "Piyush Gupta",
    "project_id": "PRJ00005"
  }
]
```

### 3.3 Get form detail

```http
GET {API}/forms/FRM00030
```

**Permission**: `forms.view` (system) or membership in the form's project.

**200 OK**

```json
{
  "form_id": "FRM00030",
  "form_title": "Rice Farmer Household Survey",
  "form_status": "Active",
  "form_type": "parent",
  "table_name": "rice_farmer_household_survey_frm00030",
  "field_count": 4,
  "version_no": 3,
  "created_on": "2026-10-03T08:15:22.451000",
  "updated_on": "2026-10-03T10:42:18.112000",
  "created_by": "Piyush Gupta",
  "form_json": {
    "title": "Rice Farmer Household Survey",
    "fields": [ "..." ],
    "sections": [ "..." ],
    "layout": { "..." },
    "version": 3
  }
}
```

### 3.4 Export form definition as Excel

```http
GET {API}/forms/FRM00030/export-excel
```

**Permission**: viewer + read access to the form.

**200 OK** — returns an `.xlsx` file as a binary download with
`Content-Disposition: attachment; filename="Rice_Farmer_Household_Survey_v3.xlsx"`.

### 3.5 Update a form

```http
PUT {API}/forms/FRM00030
Content-Type: application/json

{
  "form_json": { "...revised definition..." },
  "form_status": "Draft",
  "renames": {
    "old_field_name": "new_field_name"
  },
  "whatsapp": {
    "number": "+254700000000",
    "keyword": "RICE"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `form_json` | object | The full revised definition |
| `form_status` | string | Optional status change with the save |
| `renames` | object | `{ "old_key": "new_key" }` — stored answers are moved |
| `whatsapp` | object | Optional routing update for WhatsApp forms |

**Permission**: `forms.edit` (system) or `project.forms.manage`.

**200 OK** — the updated form detail (same shape as GET).

| Error | Status | Meaning |
|---|---|---|
| Not found | 404 | No form with that id |
| Validation failed | 422 | Definition or migration rejected |
| Keyword taken | 400 | WhatsApp keyword conflict |
| Relationship unsafe | 409 | Changing parent when submissions exist |

### 3.6 Delete a form (soft)

```http
DELETE {API}/forms/FRM00030
```

**Permission**: `forms.delete` (system) or `project.forms.manage`.

Sets the form's status to `Deleted`. The data table and its rows are left
untouched.

**200 OK**

```json
{
  "form_id": "FRM00030",
  "form_status": "Deleted"
}
```

---

## 4. Status & versioning

### 4.1 Change status

```http
PATCH {API}/forms/FRM00030/status
Content-Type: application/json

{ "form_status": "Active" }
```

**Permission**: `forms.edit` or `project.forms.manage`.

Valid transitions: `Draft` -> `Active` -> `Paused` -> `Active`. Setting
`Active` publishes the form; setting `Paused` suspends collection; `Draft`
reopens it for editing. Going Active validates that every enabled channel can
complete the form.

**200 OK** — the updated form.

| Error | Status | Meaning |
|---|---|---|
| Channel incompatibility | 422 | An enabled channel cannot ask a required question |
| Invalid transition | 400 | e.g. `Deleted` -> `Active` |

### 4.2 Rollback to an earlier version

Rollback is a pointer, not a copy: the form's `form_json` is pointed at an
existing stored version. No new version row is written. The history is
untouched, so rolling anywhere else undoes it.

```http
POST {API}/forms/FRM00030/rollback
Content-Type: application/json

{ "version_no": 2 }
```

**Permission**: `forms.edit` or `project.forms.manage`.

**200 OK** — the form detail, now showing version 2's definition.

| Error | Status | Meaning |
|---|---|---|
| Version not found | 404 | No version with that number |
| Rollback refused | 400 | e.g. attempting to roll back a Deleted form |
| Migration error | 422 | The tabular mirror could not be reconciled |

### 4.3 Revalidate submissions

Check stored responses against the current definition. Useful after hand-editing
a definition.

```http
POST {API}/forms/FRM00030/revalidate
Content-Type: application/json

{ "fix": true }
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `fix` | bool | `false` | `false` reports only; `true` also re-coerces values |

**Permission**: `forms.edit` or `project.forms.manage`.

**200 OK** — a report of what was checked and what was fixed.

### 4.4 Rebuild tabular mirror

Reconstructs the flat `<form>_tabular` table from the JSONB `form_data` column.
Happens automatically when columns change; call this for a form whose responses
were collected before the mirror existed.

```http
POST {API}/forms/FRM00030/rebuild-tabular
```

**Permission**: `forms.edit` or `project.forms.manage`.

**200 OK**

```json
{ "form_id": "FRM00030", "rows_rebuilt": 142 }
```

### 4.5 Version history

```http
GET {API}/forms/FRM00030/versions?include_json=false
```

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `include_json` | bool | `false` | Include the full `form_json` for each version |

**Permission**: `forms.view` or `project.forms.view_all`.

**200 OK**

```json
[
  { "version_id": 45, "form_id": "FRM00030", "version_no": 3, "title": "Rice Farmer Household Survey", "field_count": 4 },
  { "version_id": 38, "form_id": "FRM00030", "version_no": 2, "title": "Rice Farmer Household Survey", "field_count": 3 },
  { "version_id": 31, "form_id": "FRM00030", "version_no": 1, "title": "Rice Farmer Survey", "field_count": 2 }
]
```

### 4.6 Diff between versions

```http
GET {API}/forms/FRM00030/diff?from=2&to=3
```

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `from` | int | second-latest | The earlier version |
| `to` | int | latest | The later version |

Defaults to the newest version against the one before it. Renamed fields are
followed, so a rename reads as a change rather than a removal and an addition.

**Permission**: `forms.view` or `project.forms.view_all`.

**200 OK**

```json
{
  "from_version": 2,
  "to_version": 3,
  "changes": {
    "fields_added": [
      { "name": "expected_yield_kg", "label": "Expected yield (kg)", "type": "integer" }
    ],
    "fields_removed": [],
    "fields_changed": [
      {
        "name": "plot_size_hectares",
        "changes": { "required": { "from": true, "to": false } }
      }
    ]
  }
}
```

### 4.7 Published configuration

The immutable version that is live. Read from `form_version`, not from the
form's current JSON. A draft has none.

```http
GET {API}/forms/FRM00030/published
```

**Permission**: anyone who may open the form — to manage it or to fill it in
(view or fill permission, including project membership).

**200 OK** — the published `form_json` plus metadata.

**409 Conflict** — this form has no published version (it is still a draft).

### 4.8 Compare to standard

How far this form has drifted from the standard library form it was created
from.

```http
GET {API}/forms/FRM00030/standard-diff
```

**Permission**: `forms.view` or `project.forms.view_all`.

**200 OK** — same diff shape as version diff.

**404 Not Found** — this form did not start from a standard.

---

## 5. Public sharing

A public link lets anyone with the URL fill in the form without an account.

**Permission** for all three endpoints: `forms.export` (system) or
`project.forms.manage`.

### 5.1 Get sharing state

```http
GET {API}/forms/FRM00030/public-share
```

**200 OK**

```json
{
  "enabled": true,
  "token": "a1b2c3d4e5f6",
  "url": "https://<server>/api/public/forms/a1b2c3d4e5f6",
  "expires_on": "2027-01-01T00:00:00",
  "allow_multiple": true,
  "shared_by": "Piyush Gupta",
  "shared_on": "2026-10-03T09:00:00"
}
```

```json
{ "enabled": false }
```

### 5.2 Enable public sharing

```http
POST {API}/forms/FRM00030/public-share
Content-Type: application/json

{
  "regenerate": false,
  "expires_on": "2027-01-01T00:00:00",
  "allow_multiple": true
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `regenerate` | bool | `false` | `true` issues a new token, breaking the old URL |
| `expires_on` | datetime | `null` | When the link stops working; `null` means never |
| `allow_multiple` | bool | `true` | Whether one browser may submit more than once |

**200 OK** — the sharing state (same shape as GET).

### 5.3 Disable public sharing

```http
DELETE {API}/forms/FRM00030/public-share
```

**200 OK** — every copy of the link stops working immediately.

---

## 6. Export to connectors

Export a form's published configuration to an external collection platform.

**Permission**: `forms.export` (system) or `project.forms.manage`.

### 6.1 Export history

```http
GET {API}/forms/FRM00030/exports
```

**200 OK**

```json
{
  "form_id": "FRM00030",
  "connectors": [
    { "id": "mcdc", "label": "MCDC Mobile" },
    { "id": "echo", "label": "Echo (dry run)" }
  ],
  "exports": [
    {
      "connector": "mcdc",
      "version_no": 3,
      "status": "EXPORTED",
      "exported_by": "Piyush Gupta",
      "exported_on": "2026-10-03T11:00:00"
    }
  ]
}
```

### 6.2 Export to a connector

```http
POST {API}/forms/FRM00030/exports
Content-Type: application/json

{ "connector": "mcdc" }
```

Idempotent on form + version + connector: sending version 3 to MCDC twice is
one delivery.

**201 Created**

```json
{
  "connector": "mcdc",
  "version_no": 3,
  "status": "EXPORTED",
  "already_exported": false
}
```

| Error | Status | Meaning |
|---|---|---|
| Unknown connector | 400 | `connector` not in `connectors.available()` |
| No published version | 409 | The form is still a draft |
| Config rejected | 422 | The published configuration is not valid for this connector |
| Remote failure | 502 | The far end refused or timed out (recorded as FAILED, retry safe) |

---

## 7. Public forms (no authentication)

These endpoints require no session. The form is identified by an opaque token
issued through the public-sharing endpoints above.

### 7.1 Get a publicly shared form

```http
GET {API}/public/forms/{token}?language=es
```

| Parameter | Type | Notes |
|---|---|---|
| `language` | string | Optional; falls back to the form's default language |

**200 OK**

```json
{
  "form_json": {
    "title": "Rice Farmer Household Survey",
    "description": "...",
    "fields": [ "..." ],
    "sections": [ "..." ],
    "layout": { "..." },
    "translations": { "..." }
  },
  "language": "es",
  "languages": [
    { "code": "en", "name": "English" },
    { "code": "es", "name": "Spanish" }
  ],
  "version_no": 3,
  "allow_multiple": true
}
```

The returned `form_json` is whitelisted: it contains only the fields needed to
render the form (title, description, fields, sections, layout, translations,
languages, submit_label, success_message). No form id, table name, creator or
internal metadata is exposed.

| Error | Status | Meaning |
|---|---|---|
| Invalid/expired/disabled | 404 | "This link is not valid." (deliberately vague) |
| Form asks for file upload | 409 | Cannot upload files without an account |

### 7.2 Submit to a publicly shared form

```http
POST {API}/public/forms/{token}/submissions
Content-Type: application/json

{
  "data": {
    "plot_size_hectares": 2.5,
    "irrigation_method": "canal"
  },
  "language": "en"
}
```

| Field | Type | Notes |
|---|---|---|
| `data` | object | **required** — the answers |
| `language` | string | Optional; for localized error messages |

**201 Created**

```json
{ "survey_id": "SRV00145" }
```

Only the survey id is returned. A public caller cannot read back the stored row.

The submission goes through the same validation and storage path as every other
channel. It is attributed to `"Public (link)"` rather than to a person, and
recorded with the channel `public_web`.

---

## 8. Design notes

- **`form_id` format**: `FRM00030` — a prefix and a zero-padded sequence.

- **`form_json`** is a JSONB definition containing `fields`, `sections`,
  `rules`, `layout`, `translations`, `channels`, `channel_config` and metadata.

- **`normalize_form`** repairs LLM output (duplicate keys, invented type names,
  option-less dropdowns); **`config_validation`** rejects bad configuration.
  The invariant: `validate_config(normalize_form(anything))` never raises.

- **Rollback** is a pointer, not a copy. `version_no` (live) and
  `latest_version` (highest) can differ. Never assume `MAX(version_no)` is live.

- **A form's channel is fixed after creation** (`web_mobile`, `whatsapp`, or
  `ivr`). Taking a form to another channel is a copy operation in the builder.

- **Status transitions**: `Draft` -> `Active` -> `Paused` -> `Active`;
  `Active` -> `Draft` for editing. `Deleted` is a soft delete (data preserved).

- **Tabular mirror**: `<form>_tabular` has typed columns for reporting. Columns
  are never dropped. A question's key over 55 characters is shortened with a
  digest; use `tabular_service.column_for()` to map keys to columns.
