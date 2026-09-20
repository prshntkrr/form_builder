# MCDC Mobile API — Developer Handoff

For the team building the mobile data-collection app. Everything needed to
integrate is in this document; no knowledge of how MCDC is built is required.

Base URL: `{API}` = `https://<your-mcdc-server>/api`

---

## 1. Purpose and architecture

MCDC is the backend. The mobile app is yours.

```
 Mobile app (yours)                        MCDC (server)
 ──────────────────                        ─────────────
 1. sign in                     ────────▶  POST /api/auth/login
 2. fetch the list of forms     ────────▶  GET  /api/mcdc/forms
 3. download each form, keep it ────────▶  GET  /api/forms/{form_id}/package
 4. render the form, collect answers,
    store drafts, queue submissions
    while offline                           (nothing — this is the app's job)
 5. send each completed form    ────────▶  POST /api/forms/{form_id}/submissions
                                                     │
                                            validated and stored exactly as
                                            answers from every other channel
```

| MCDC provides | The mobile app is responsible for |
|---|---|
| Sign-in and sessions | Storing the token securely |
| Which forms this user may fill on mobile | Showing the list, refreshing it |
| One complete, published definition per form | Storing it on the device |
| Every value list a form needs (catalogues, crop ontology, countries) | Rendering the form from the stored definition |
| Validation of every submission — the final word | Checking answers locally for a good experience |
| Storing answers, receipts, duplicate protection | Drafts, the offline queue, retries, synchronisation |

MCDC does **not** render any mobile screen, keep drafts, hold partial answers,
queue anything for the device, or push changes to it.

---

## 2. Authentication

There is one sign-in system; mobile uses the same one as the MCDC web
application.

### 2.1 Sign in

```http
POST {API}/auth/login
Content-Type: application/json

{ "email": "surveyor@example.org", "password": "…" }
```

**200 OK**

```json
{
  "token": "sKq3…opaque, about 43 characters…",
  "expires_on": "2026-09-19T22:04:11.482913",
  "user": {
    "user_id": "USR00012",
    "email": "surveyor@example.org",
    "full_name": "Shrishti Rao",
    "role_id": "ROL00003",
    "role": "standard",
    "role_label": "Standard User",
    "permissions": ["records.create", "records.view"],
    "is_active": true,
    "last_login_on": "2026-09-19T10:04:11.482913",
    "created_on": "2026-08-01T09:00:00",
    "created_by": "Admin",
    "locked": false
  }
}
```

- **`token`** is opaque. Send it on every other call (2.2). Store it in the
  platform's secure storage.
- **`expires_on`** is in **UTC, without a timezone suffix**. The session lasts a
  fixed time from sign-in — 12 hours by default (the operator can change it) —
  and is **not** extended by activity. There is no refresh token: when a call
  answers 401, sign in again.
- Other things end a session early: the user's password being changed or reset,
  their account being deactivated, or their role or its permissions changing.
  Treat any 401 the same way — sign in again.

**Sign-in failures** — all **401**, `{"detail": "<message>"}`:

| `detail` | Why |
|---|---|
| `Email or password is incorrect` | Either one — deliberately the same message |
| `Too many attempts — try again in N minutes` | Five wrong passwords lock the account for 15 minutes |
| `This account has been deactivated` | An administrator switched the account off |

### 2.2 Authenticated requests

```
Authorization: Bearer <token>
Content-Type: application/json          (on requests with a body)
X-Request-ID: <your id>                 (optional; echoed back — quote it when reporting a problem)
Idempotency-Key: <id>                   (optional, on submissions — see 6.5)
```

The token is the only thing that identifies the caller. Nothing in a request
body (`user_id`, `role`, `project_id`, `permissions`) is used for authorisation.

### 2.3 Who am I

```http
GET {API}/auth/me
```

```json
{
  "user": { "user_id": "USR00012", "full_name": "Shrishti Rao", "…": "same as login" },
  "permissions": ["records.create", "records.view"],
  "can": { "…": "true/false flags for the MCDC web screens" },
  "modules": ["forms", "projects", "…"]
}
```

Useful to confirm a stored token still works. `permissions` and `can` describe
the MCDC web application's screens; the mobile app does not need them — the
server decides every request.

### 2.4 Sign out

```http
POST {API}/auth/logout
```

`{"signed_out": true}`. Ends **this** session only; the same user stays signed
in on other devices. The token is useless afterwards (401).

### 2.5 Authentication errors on any endpoint

| Status | Body | Meaning |
|---|---|---|
| 401 | `{"detail": "Sign in to continue", "error": {"code": "AUTHENTICATION_REQUIRED", …}, "request_id": "…"}` | No token, a token that is not one, expired, or signed out |
| 403 | `{"detail": "Your role (…) cannot do this — it needs the '…' permission"}` | Signed in, but this account may not do this at all |

---

## 3. Form discovery

```http
GET {API}/mcdc/forms
GET {API}/mcdc/forms?project=PRJ00001      # one project's forms only
GET {API}/mcdc/forms?project=none          # only forms outside every project
```

**200 OK** — an array (possibly empty):

```json
[
  {
    "form_id": "FRM00030",
    "form_title": "Farmer Registration",
    "form_description": "Register a farmer and their main plot",
    "field_count": 7,
    "version": 3,
    "form_status": "Active",
    "channel": "web_mobile",
    "default_language": "en",
    "languages": ["en", "es"],
    "updated_on": "2026-09-18T10:12:40.118211",
    "package_url": "/api/forms/FRM00030/package",
    "project_id": "PRJ00001",
    "project_name": "Mexico Maize"
  }
]
```

| Field | Meaning |
|---|---|
| `form_id` | The form's identifier. Use it in every other call |
| `form_title`, `form_description` | For display |
| `field_count` | How many questions |
| `version` | The **published** version. If it differs from the package you hold, download again |
| `form_status` | Always `Active` in this list |
| `channel` | Always `web_mobile` in this list (see 6.3) |
| `default_language`, `languages` | Languages the form can be shown in (codes such as `en`, `es`, `hi`) |
| `updated_on` | When the form was last changed or its status last changed (UTC) |
| `package_url` | Where to download it — prefix with your server's origin: `https://<server>` + `package_url` |
| `project_id`, `project_name` | The project the form belongs to; `null` for a form outside every project |

**The server has already filtered this list.** Show it as it is. A form is listed
only when all of these hold:

- the user may fill it — for a project form: they are a member of the project,
  their role there may fill forms, and the form was assigned to them (by name,
  through a group, or to everyone in the project); for a form outside every
  project: their account may use such forms;
- it is **published** — never a draft;
- it is a **Web / Mobile** form that is open on mobile.

| Not listed | Why |
|---|---|
| Draft forms | Not published yet |
| Paused forms | Taken out of circulation; answers are not being collected |
| Deleted forms | Gone |
| WhatsApp or IVR forms | Built for another channel |
| Forms with mobile switched off | Web-only |
| Forms the user cannot fill | Not assigned, not a member, or a role that only reviews |

A form that disappears from the list should be removed from the device. A
user who may read forms but not fill them receives `[]`.

---

## 4. Form package

```http
GET {API}/forms/{form_id}/package
GET {API}/forms/{form_id}/package?language=es
If-None-Match: "<package_hash you already hold>"         (optional)
```

One download gives everything needed to render the form and check answers with
no further requests: the **published** definition, its wording in the chosen
language (plus every other language), and the values behind every question whose
choices come from a list maintained in MCDC.

| Status | Meaning |
|---|---|
| **200** | The package; `ETag` header set |
| **304** | Your `If-None-Match` matched — what you hold is current. No body |
| **401** | Not signed in |
| **403** | This account may not fill forms at all |
| **404** | No such form, or not one this user may fill (the same answer on purpose) |
| **409** | Not downloadable; `detail` says why (below) |

**409 `detail` values**

| `detail` | When |
|---|---|
| `This form has not been published, so there is nothing to download yet.` | A draft |
| `This form is paused and is not collecting answers.` | Paused |
| `This form is no longer available.` | Deleted |
| `This form is not answered on mobile (WhatsApp).` — or `(IVR)`, `(Web / Mobile)` | Built for another channel, or mobile switched off |

### 4.1 Only published forms

The package is always the version that is **published**, read from the form's
version history. Unsaved or unpublished edits never appear in it. When a form is
taken back to draft for editing it stops being available (409, and it leaves the
list) until it is published again — then the new version is served. If an
administrator rolls a form back to an earlier version, that version is served.

### 4.2 Language

- `language` chooses the wording. The chosen code is returned as `language`.
- A code the form does not offer (or none) falls back to the form's
  `default_language`.
- Every language's wording is in `config.translations`, so the app can switch
  language offline (see 5.8) — or download again with another `language`, which
  also returns catalogue labels in that language.
- Each language is a different package with a different `package_hash`.

### 4.3 A complete package

A realistic three-question-group farmer registration. Every key is explained
below it.

```json
{
  "package_version": 1,
  "form_id": "FRM00030",
  "form_title": "Farmer Registration",
  "form_description": "Register a farmer and their main plot",
  "version": 3,
  "status": "published",
  "channel": "web_mobile",
  "project_id": "PRJ00001",
  "language": "en",
  "languages": [
    { "code": "en", "name": "English" },
    { "code": "es", "name": "Español" }
  ],
  "published_at": "2026-09-18T10:12:40",
  "config": {
    "title": "Farmer Registration",
    "description": "Register a farmer and their main plot",
    "version": 3,
    "channel": "web_mobile",
    "default_language": "en",
    "languages": ["en", "es"],
    "submit_label": "Submit",
    "success_message": "Your response has been recorded.",
    "sections": [
      { "key": "farmer", "title": "Farmer", "description": "" },
      { "key": "plot", "title": "Main plot", "description": "Where most of the crop is grown" }
    ],
    "fields": [
      { "name": "consent", "label": "Does the farmer agree to take part?", "type": "radio",
        "required": true, "section": "farmer", "order": 1, "placeholder": "", "help_text": "",
        "default": null, "validation": {},
        "options": [ { "label": "Yes", "value": "yes" }, { "label": "No", "value": "no" } ] },
      { "name": "farmer_name", "label": "Farmer name", "type": "text",
        "required": true, "section": "farmer", "order": 2, "placeholder": "Full name",
        "help_text": "As written on the ID card", "default": null, "options": [],
        "validation": { "min_length": 2, "max_length": 120 } },
      { "name": "mobile_number", "label": "Mobile number", "type": "phone",
        "required": false, "section": "farmer", "order": 3, "placeholder": "", "help_text": "",
        "default": null, "options": [],
        "validation": { "min_length": 10, "max_length": 10, "pattern": "^[0-9 ]+$" } },
      { "name": "state", "label": "State", "type": "select",
        "required": true, "section": "plot", "order": 4, "placeholder": "", "help_text": "",
        "default": null, "validation": {}, "options": [],
        "options_from": { "source": "client_catalog", "catalog": "Estados_mx_list" } },
      { "name": "municipality", "label": "Municipality", "type": "select",
        "required": true, "section": "plot", "order": 5, "placeholder": "", "help_text": "",
        "default": null, "validation": {}, "options": [],
        "options_from": { "source": "client_catalog", "catalog": "Municipios_mx_list",
                          "depends_on": "state" } },
      { "name": "area_ha", "label": "Plot area", "type": "decimal",
        "required": true, "section": "plot", "order": 6, "placeholder": "", "help_text": "Hectares",
        "default": null, "options": [], "input_unit": "ha",
        "validation": { "min": 0, "max": 500 } },
      { "name": "plot_photo", "label": "Photo of the plot", "type": "image",
        "required": false, "section": "plot", "order": 7, "placeholder": "", "help_text": "",
        "default": null, "options": [], "validation": {} }
    ],
    "rules": [
      { "conditions": [ { "field": "consent", "operator": "equals", "value": "yes" } ],
        "logic": "AND", "action": "show",
        "target": { "type": "section", "key": "plot" } }
    ],
    "layout": {
      "sections": [
        { "id": "farmer", "title": "Farmer", "containers": [
          { "id": "farmer-row-1", "fields": [ { "fieldId": "consent", "width": 12 } ] },
          { "id": "farmer-row-2", "fields": [ { "fieldId": "farmer_name", "width": 6 },
                                              { "fieldId": "mobile_number", "width": 6 } ] } ] },
        { "id": "plot", "title": "Main plot", "containers": [
          { "id": "plot-row-1", "fields": [ { "fieldId": "state", "width": 6 },
                                            { "fieldId": "municipality", "width": 6 } ] },
          { "id": "plot-row-2", "fields": [ { "fieldId": "area_ha", "width": 4 },
                                            { "fieldId": "plot_photo", "width": 8 } ] } ] }
      ]
    },
    "location": { "enabled": true, "required": true },
    "geofence": { "enabled": true,
                  "polygon": [[-103.50, 20.50], [-103.20, 20.50], [-103.20, 20.80], [-103.50, 20.80]] },
    "translations": {
      "es": {
        "title": "Registro de productor",
        "sections": { "farmer": { "title": "Productor" }, "plot": { "title": "Parcela principal" } },
        "fields": {
          "farmer_name": { "label": "Nombre del productor", "help_text": "Como en la identificación" },
          "consent": { "label": "¿Acepta participar?",
                       "options": { "yes": "Sí", "no": "No" } }
        }
      }
    }
  },
  "option_sets": {
    "state": {
      "source": "client_catalog", "catalog": "Estados_mx_list",
      "options": [
        { "label": "Jalisco", "value": "MX-JAL", "parent_code": null },
        { "label": "Chiapas", "value": "MX-CHP", "parent_code": null }
      ]
    },
    "municipality": {
      "source": "client_catalog", "catalog": "Municipios_mx_list", "depends_on": "state",
      "options": [
        { "label": "Zapopan", "value": "14120", "parent_code": "MX-JAL" },
        { "label": "Tlaquepaque", "value": "14098", "parent_code": "MX-JAL" },
        { "label": "Tuxtla Gutiérrez", "value": "07101", "parent_code": "MX-CHP" }
      ]
    }
  },
  "package_hash": "4f0c2a1d9e7b6c5a4f3e2d1c0b9a8f7e6d5c4b3a29181716151413121110a0b1"
}
```

### 4.4 Top-level keys

| Key | Meaning |
|---|---|
| `package_version` | The format of this document, currently `1`. Refuse a value your app was not built for |
| `form_id`, `form_title`, `form_description` | Identity and display text |
| `version` | The published version this package is. Send it back as `form_version` (6.2) |
| `status` | Always `published` |
| `channel` | Always `web_mobile` |
| `project_id` | Project, or `null` |
| `language`, `languages` | The language `config` is worded in, and every language on offer |
| `published_at` | When the form's status last changed. Informational only; not part of the hash |
| `config` | The form definition — section 5 |
| `option_sets` | Values for questions whose choices come from a list — 4.5 |
| `package_hash` | SHA-256 of the package — 4.6 |

### 4.5 `option_sets` — catalogue, crop ontology and country lists

A question whose choices live in a list maintained in MCDC has
`options_from` instead of `options`. Its values are in `option_sets`, keyed by
the question's `name`. The stored answer is always the `value` (a code), never
the label.

| `source` | Contents | For a dependent list (`depends_on` is set) |
|---|---|---|
| `client_catalog` | `options: [{label, value, parent_code}]` — every value the question may take (`parent_code` is `null` for a top-level list) | Offer only the values whose `parent_code` equals the current answer to the `depends_on` question. With no answer there, offer nothing |
| `crop_ontology` | `options: [{label, value}]`, **or** — when `depends_on` is set — `by_parent: {"<parent value>": [{label, value}], …}` | Offer `by_parent[<answer to depends_on>]` |
| `data_standard` (countries, ISO 3166-1) | `options: [{label, value}]` | — |

When the answer to a `depends_on` question changes, clear the dependent answer.

An entry with `"unavailable": true` and empty `options` means that list could
not be read when the package was built (a service temporarily switched off). The
question can still be answered; MCDC checks the value when it arrives.

### 4.6 `package_hash`, ETag and 304

- `package_hash` is a **SHA-256** hex digest of the package's content, computed
  with keys in sorted order, so identical content always produces the identical
  hash.
- It covers the definition, the chosen language and every `option_sets` value.
  It excludes `published_at` and itself.
- It therefore changes when a new version is published, when you request a
  different language, **and when a catalogue's values change even though the
  form's `version` did not**.
- The response's `ETag` header is the hash in quotes: `"4f0c…a0b1"`.
- Send it back to check for changes without downloading:

```http
GET {API}/forms/FRM00030/package?language=es
If-None-Match: "4f0c2a1d…a0b1"
```

| Answer | Do |
|---|---|
| `304 Not Modified` (no body, same `ETag`) | Keep the package you hold |
| `200 OK` with a new package | Replace the stored package |

The response carries `Cache-Control: private, no-cache` — keep the package, but
ask before relying on it again.

### 4.7 What a package never contains

Storage details (how or where answers are kept), who created the form, where it
was imported from, internal channel settings, other channels' configuration
(WhatsApp), and any credential, key or server setting. A package describes what
to ask — nothing else.

---

## 5. Rendering a form

The app renders from `config` and `option_sets` alone.

### 5.1 Order and grouping

- **Ask questions in the order of `config.fields`.** (`order` repeats it and is
  informational.)
- `config.sections` are the groups, each `{key, title, description}`. A field's
  `section` names one. Fields with no `section` come before the first group.
- **`config.layout`** (present only if the form was laid out) is how the form is
  arranged on a 12-column grid: `sections` → rows (`containers`) → cells
  `{fieldId, width}`, where `fieldId` is a field's `name` and `width` is 1–12
  columns. Honouring it is optional; stacking one question per row on a phone is
  always correct. A field the layout does not place is still asked — after
  everything placed.

### 5.2 Each question

| Key | Use |
|---|---|
| `name` | The answer's key in `data`. Never change or translate it |
| `label` | The question text |
| `type` | How to show and answer it — 5.3 |
| `required` | Must be answered, **unless a rule hides it** (5.5) |
| `help_text` | Guidance shown under the question |
| `placeholder` | Hint text inside an empty box |
| `default` | A suggested starting value, or `null` |
| `options` | Fixed choices `[{label, value}]` |
| `options_from` | Choices come from `option_sets[name]` — 4.5 |
| `validation` | Limits — 5.4 |
| `section` | The group it belongs to |
| `input_unit` | When present, the unit the answer is entered in (e.g. `ha`); show it beside the box |

Other keys may be present (for example standards references). Ignore what you
do not use; never remove anything when storing the package.

### 5.3 Field types

| `type` | Show as | Send in `data` | Example |
|---|---|---|---|
| `text` | one-line text box | string | `"Ramesh Patil"` |
| `textarea` | multi-line text box | string | `"Two lines\nof text"` |
| `email` | email keyboard | string | `"r@example.org"` |
| `phone` | phone keyboard | string (length limits count digits only) | `"9876543210"` |
| `url` | URL keyboard | string | `"https://example.org"` |
| `number` | numeric keyboard, whole numbers | number | `3` |
| `decimal` | numeric keyboard with a decimal point | number | `2.5` |
| `rating` | a row of stars | whole number | `4` |
| `date` | date picker | `"YYYY-MM-DD"` | `"2026-09-19"` |
| `datetime` | date and time picker | ISO 8601 | `"2026-09-19T10:15:00"` |
| `time` | time picker | `"HH:MM:SS"` | `"10:15:00"` |
| `boolean` | yes / no switch | `true` / `false` | `true` |
| `select` | dropdown | one option `value` | `"MX-JAL"` |
| `radio` | radio buttons | one option `value` | `"yes"` |
| `multiselect` | checkboxes | list of option `value`s | `["MAIZE", "RICE"]` |
| `image` | camera / gallery | a `media_id` (6.8) | `"MED…"` |
| `audio` | recorder | a `media_id` (6.8) | `"MED…"` |
| `file` | document picker | a `media_id` (6.8) | `"MED…"` |
| `signature` | a text box where the signer types their name | string | `"Ramesh Patil"` |
| `location` | a "use my position" button (or latitude/longitude boxes) | `{"lat": …, "lng": …}` | `{"lat": 20.62, "lng": -103.38}` |
| `polygon` | a map to draw a boundary on | list of `[longitude, latitude]` points, at least 3; MCDC closes the ring | `[[-103.4, 20.6], [-103.3, 20.6], [-103.3, 20.7]]` |

Treat an unrecognised `type` as `text`. For `rating`, show 1 up to
`validation.max`; the MCDC web form shows 5 stars when no `max` is set (the
server only enforces `min`/`max` when they are present).

### 5.4 Validation

`required` and `validation` are the same rules MCDC applies on arrival. Check
them on the device for a good experience; MCDC checks them again regardless.

| `validation` key | Applies to | Rule |
|---|---|---|
| `min`, `max` | `number`, `decimal`, `rating` | inclusive numeric bounds |
| `min_length`, `max_length` | text-like types | length in characters; for `phone` and numbers, in **digits** |
| `pattern` | text-like types | a regular expression the whole answer must match (from its start) |

Choice answers must be one of the offered values (5.3, 4.5).

### 5.5 Conditional rules (`config.rules`)

Rules decide which questions and groups apply, given the answers so far.

```json
{ "conditions": [ { "field": "consent", "operator": "equals", "value": "yes" } ],
  "logic": "AND", "action": "show",
  "target": { "type": "section", "key": "plot" } }
```

- `target`: `{"type": "field", "name": …}`, `{"type": "section", "key": …}` (every
  question in that group), or `{"type": "form"}` (the whole form).
- `logic`: `AND` — all conditions must hold; `OR` — any one.
- `action`: a `show` rule hides its target **until** its conditions hold; a
  `hide` rule hides its target **while** they hold. When several rules target
  the same thing, it is hidden if any one of them hides it.
- A question that a rule reads is never hidden (so the form can always progress).
- Operators: `equals`, `not_equals`, `greater_than`, `greater_than_or_equal`,
  `less_than`, `less_than_or_equal`, `contains`, `not_contains`, `is_empty`,
  `is_not_empty`. Comparisons are made as text (`"18"` equals `18`); a
  multi-select answer "equals" a value it contains; an unknown operator never
  holds.
- Re-evaluate after every answer.
- **Hidden questions are not asked, not required, and must not be sent.**
  MCDC evaluates the same rules and refuses an answer to a hidden question (422).

### 5.6 Location and area settings

- `config.location` — `{"enabled": true, "required": false}` when the form records
  where it was filled in. Absent when it does not. Capture the device position
  and send it with the submission (6.7).
- `config.geofence` — `{"enabled": true, "polygon": [[longitude, latitude], …]}`
  when submissions must come from inside an area. You may warn the user early;
  MCDC decides.

### 5.7 Relationship (child forms)

`config.relationship` — present only on a form whose answers each belong to a
record of another form: `{"type": "child", "parent_form_id": "FRM00029"}`. The
records to choose from are **not** in the package; see 6.9.

### 5.8 Translations

`config` already carries the chosen language. `config.translations` holds every
language as a block of replacements over the default wording; anything a block
does not mention keeps its default. A block may contain:

```json
{ "title": "…", "description": "…", "submit_label": "…", "success_message": "…",
  "sections": { "<section key>": { "title": "…", "description": "…" } },
  "fields": { "<field name>": { "label": "…", "help_text": "…", "placeholder": "…",
                                "options": { "<option value>": "<translated label>" } } } }
```

Translations change wording only — never `name`, `value` or any rule.

### 5.9 Submit button

`config.submit_label` is the button text; `config.success_message` is what to
show after MCDC accepts the answers.

---

## 6. Submission

### 6.1 A complete request

```http
POST {API}/forms/FRM00030/submissions
Authorization: Bearer <token>
Content-Type: application/json

{
  "data": {
    "consent": "yes",
    "farmer_name": "Ramesh Patil",
    "mobile_number": "9876543210",
    "state": "MX-JAL",
    "municipality": "14120",
    "area_ha": 2.5
  },
  "channel": "mobile",
  "form_version": 3,
  "language": "es",
  "client_submission_id": "7f3c9e2a-5b1d-4e8a-9c0f-2d6b8a1e4f70",
  "location": {
    "latitude": 20.62,
    "longitude": -103.38,
    "accuracy": 12.4,
    "captured_at": "2026-09-19T10:15:00Z"
  }
}
```

**201 Created**

```json
{
  "survey_id": "000042",
  "created_on": "2026-09-19T10:15:03.215044",
  "form_id": "FRM00030",
  "form_version": 3,
  "table_name": "farmer_registration",
  "parent_survey_id": null,
  "location": { "latitude": 20.62, "longitude": -103.38, "accuracy": 12.4,
                "captured_at": "2026-09-19T10:15:00Z" },
  "client_submission_id": "7f3c9e2a-5b1d-4e8a-9c0f-2d6b8a1e4f70",
  "replayed": false,
  "channel": "mobile"
}
```

`survey_id` is the receipt — show it to the user. `table_name` is internal;
ignore it. `client_submission_id` and `replayed` appear only when you sent an id.

| Field | Required | Meaning |
|---|---|---|
| `data` | **yes** | `{question name: answer}`; answers as in 5.3. Leave out unanswered and hidden questions. Unknown names are ignored |
| `channel` | recommended | Always `"mobile"` — 6.3 |
| `form_version` | recommended | The package `version` — 6.2 |
| `language` | no | The language error messages come back in |
| `client_submission_id` | **strongly recommended** | Your id for this submission — 6.5 |
| `location` | when the form asks | The device position — 6.7 |
| `survey_id` | only with uploads | From `/start` — 6.8 |
| `parent_survey_id` | child forms only | The chosen parent record — 6.9 |

### 6.2 `form_version`

Send the package's `version` as a **whole number** (`3`, not `"3"` — a string
is refused with 400). If a newer version has been published since the package
was downloaded, MCDC refuses the answers with 422 `_form_version` rather than
reinterpreting them against a definition the user never saw: download the
package again and have the user review. Without `form_version` the answers are
checked against whatever is published when they arrive.

### 6.3 Channel mapping

| Where | Value | Means |
|---|---|---|
| A **form's** `channel` (list, package, `config`) | `web_mobile` | This form is built for the web and the mobile app |
| A **submission's** `channel` (what you send) | `mobile` | These answers were collected in the mobile app |

- Always send `"channel": "mobile"`. `web_mobile` is not a submission channel
  (400). If `channel` is omitted the answers are recorded as coming from the web.
- A form built for WhatsApp or IVR, or with mobile switched off, refuses
  `"channel": "mobile"` with 422 `_channel`.

### 6.4 What happens on arrival

Every submission — from the app, the web, WhatsApp or IVR — goes through the same
steps: duplicate check → version check → parent check (child forms) → channel
check → validation (required, types, choices and list values, limits, patterns,
conditional rules) → unit standardisation → stored, together with its receipt,
in one step. There is no separate mobile path, and nothing is stored if any step
refuses.

### 6.5 Retrying safely: `client_submission_id`

Create an id when the user presses Submit — a UUID is ideal — store it with the
queued answers, and send the **same** id on **every** attempt. Either in the
body as `client_submission_id` or as the `Idempotency-Key` header; they are the
same thing (if you send both, they must match, or the request is refused with 422).

| Attempt | Answer |
|---|---|
| First time | **201** — stored; `"replayed": false` |
| Same id, same `data`, same `channel` | **200** — nothing new stored; the **original** `survey_id` and `created_on`; `"replayed": true` |
| Same id, different `data` or `channel` | **409** — that id already names a different submission; use a new id for new answers |
| Same id on a different form | Independent — ids are scoped to one form |

- "Same `data`" means the same keys and values; key order does not matter.
- A retry is recognised before anything else is checked, so it still returns the
  original receipt after the form was republished, paused or changed.
- Two copies arriving at the same moment are resolved on the server: one is
  stored and both calls return it.
- An id is 1–64 characters of `A–Z a–z 0–9 . _ : -` (otherwise 422).

A replay (200) has the same shape as 6.1 except that it has no `location` or
`parent_survey_id`.

### 6.6 Submission errors

| Status | Body | Meaning / what to do |
|---|---|---|
| 400 | `{"error": {"code": "INVALID_REQUEST", "message": …}, "request_id": …}` | Malformed request: not JSON, `data` not an object, unknown `channel`, `form_version` not a whole number, badly formed `survey_id`. Fix the request |
| 401 | see 2.5 | Sign in again; keep the queued submission |
| 403 | see 2.5 | This account may not submit at all |
| 404 | `{"detail": "No form '…'"}` | No such form, or not one this user may fill. Drop it from the device |
| 409 | `{"detail": "'…' was already used for a different submission of this form. …"}` | Conflicting `client_submission_id` (6.5) |
| 413 | `{"error": {"code": "REQUEST_TOO_LARGE", …}}` | Body over 5 MB — files go through the upload flow |
| 422 | `{"detail": {"errors": {"<name>": "<message>", …}}}` | Answers refused — every problem at once. Show each message against its question; the rest are fine |
| 429 | `{"error": {"code": "RATE_LIMITED", …}}` + `Retry-After` | Too many requests (by default 120 per 60 seconds per user). Wait `Retry-After` seconds |

**422 keys that are not question names:**

| Key | Meaning |
|---|---|
| `_form_version` | A newer version is published — download the package again |
| `_channel` | This form does not take answers from mobile |
| `_location` | The position is missing (and required), not a real coordinate, or outside the allowed area |
| `_form` | The form is not accepting answers (paused or no longer available), or the `survey_id` was already submitted or never started — if it was already submitted, the answers arrived: resend with the `client_submission_id` to get the receipt |
| `client_submission_id` | Badly formed id, or it differs from `Idempotency-Key` |

Error messages are in the `language` sent, where a translation exists (English
otherwise).

### 6.7 Device location

When `config.location.enabled`, send the device position as `location`:

```json
{ "latitude": 20.62, "longitude": -103.38, "accuracy": 12.4, "captured_at": "2026-09-19T10:15:00Z" }
```

- `latitude` and `longitude` are required inside it; `accuracy` (metres) and
  `captured_at` are optional. Other keys are dropped.
- When `config.location.required` is true and no position is sent: 422 `_location`.
- When `config.geofence.enabled`, the point must be inside `geofence.polygon`
  (`[longitude, latitude]` pairs), or 422 `_location`.
- For a form that does not record location, a sent `location` is ignored.

This is different from a **`location` question** (5.3), whose answer is
`{"lat", "lng"}` inside `data`.

### 6.8 Photos, recordings and documents

Media questions are answered with a `media_id`, obtained by uploading the file
first. The file goes straight to storage; MCDC never receives the bytes.

```
1. Take a survey id (once per submission):
   POST {API}/forms/FRM00030/submissions/start
   → 201 {"survey_id": "000043"}

2. For each file, ask where to put it:
   POST {API}/forms/FRM00030/submissions/000043/media/upload-url
   {"field_name": "plot_photo", "filename": "plot.jpg",
    "content_type": "image/jpeg", "file_size": 482912}
   → 200 {"media_id": "MEDa1b2…", "s3_key": "…", "media_type": "image",
          "upload_url": "https://…"}

3. Upload the bytes:
   PUT <upload_url>
   Content-Type: image/jpeg            ← exactly the content_type from step 2
   (no Authorization header)

4. Report it done:
   POST {API}/forms/FRM00030/submissions/000043/media/MEDa1b2…/complete
   {"file_size": 482912}
   → 200 {"media_id": "MEDa1b2…", "field_name": "plot_photo", "media_type": "image", …}

5. Submit, with the same survey_id:
   POST {API}/forms/FRM00030/submissions
   {"survey_id": "000043", "data": {…, "plot_photo": "MEDa1b2…"},
    "channel": "mobile", "form_version": 3, "client_submission_id": "…"}
```

- The upload URL is valid for about **15 minutes** and for one file. Ignore
  `s3_key`; it is internal.
- Limits: **25 MB** per file. Accepted content types:

| Question type | `content_type` |
|---|---|
| `image` | `image/jpeg`, `image/png`, `image/webp`, `image/heic` |
| `audio` | `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/webm`, `audio/mp4` |
| `file` | `application/pdf`, `application/msword`, `.docx` (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`), `application/vnd.ms-excel`, `.xlsx` (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`), `text/csv`, `text/plain` |

- Step 2 answers **422** with a readable reason for a wrong type, an oversized
  file, or a question that takes no upload; **503** when file storage is not
  configured on the server; **502** if storage could not be reached.
- A `media_id` whose upload was never completed is refused at step 5 (422 on
  that question).
- **If step 5 is refused**, fix the answers and repeat step 5 with the **same**
  `survey_id` — do not call `start` again (that makes a new id) and do not
  re-upload files that already completed.
- Without files, skip steps 1–4 and send no `survey_id`.

### 6.9 Child forms and live lists

These are **not** in the package, because they change as records are collected:

- **Parent records** for a child form (5.7):

  ```http
  GET {API}/forms/FRM00031/parent-options?q=ramesh&limit=50
  ```

  ```json
  { "parent_form_id": "FRM00029", "parent_form_title": "Farmer Registration",
    "submissions": [ { "survey_id": "000001", "summary": "Ramesh Patil · Jalisco",
                       "created_by": "Shrishti Rao", "created_on": "2026-09-10T08:00:00" } ] }
  ```

  `q` narrows the list, `limit` is 1–200 (default 50). Offer them as a picker —
  never a free-text box — and send the chosen `survey_id` as `parent_survey_id`.
  The list contains only records this user may attach to, and MCDC checks the
  choice again (422 `parent_survey_id` otherwise). This needs a connection.

- Catalogue and ontology values **are** in the package (`option_sets`). The
  individual list endpoints the MCDC web application uses are not needed.

---

## 7. Integration checklist

**Sign-in and token**
- [ ] Sign in with `POST /api/auth/login`; store `token` in secure storage.
- [ ] Send `Authorization: Bearer <token>` on every call.
- [ ] On any 401: prompt to sign in again. Keep drafts and the submission queue.
- [ ] Sign out with `POST /api/auth/logout` and delete the stored token.

**Form list**
- [ ] Fetch `GET /api/mcdc/forms` after sign-in and when online.
- [ ] Remove forms from the device that are no longer listed (keep any unsent
      submissions for them until they are sent or refused).
- [ ] Compare each item's `version` with the stored package.

**Packages**
- [ ] Download `package_url` for each listed form, in the user's language.
- [ ] Store the whole response and its `ETag`.
- [ ] Re-check with `If-None-Match`: keep on 304, replace on 200.
- [ ] Refuse a `package_version` the app was not built for.

**Rendering**
- [ ] Render from `config` and `option_sets` only; ask in `fields` order.
- [ ] Support every type in 5.3; treat unknown types as text.
- [ ] Filter dependent lists by `parent_code` / `by_parent`; clear a dependent
      answer when its parent changes.
- [ ] Re-evaluate `rules` after each answer; never send hidden questions.
- [ ] Show `help_text`, `placeholder`, `input_unit`, `submit_label`, `success_message`.

**Drafts (the app's own storage)**
- [ ] Save unfinished answers on the device with the package `version` they
      were collected against. MCDC keeps no drafts.

**Checking answers**
- [ ] Enforce `required` (for visible questions), `validation`, and choice
      values before allowing Submit. MCDC re-checks everything.

**Offline queue and retries**
- [ ] On Submit, create a `client_submission_id` and store it with the answers.
- [ ] Send queued submissions when online; resend with the **same** id until a
      final answer arrives.
- [ ] Treat 201 and 200 (`replayed: true`) as success.
- [ ] On 422: show `detail.errors` against the questions; on `_form_version`,
      download the package again first.
- [ ] On 409 (conflicting id): do not resend with that id.
- [ ] On 404 / 409 (form no longer available): tell the user; keep the data
      for export if your product needs it.
- [ ] On 429: wait `Retry-After` seconds. On 5xx or no connection: retry later.

**Media**
- [ ] `start` once per submission; upload each file; `complete` each; then
      submit with that `survey_id`.
- [ ] Keep `survey_id` and completed `media_id`s with the queued submission, so
      a retry reuses them.
- [ ] Respect the 25 MB limit and the accepted content types.

**Location**
- [ ] When `config.location.enabled`, capture the position and send it as
      `location` (`latitude`, `longitude`, optionally `accuracy`, `captured_at`).
- [ ] Answer `location` questions as `{"lat", "lng"}` and `polygon` questions as
      `[longitude, latitude]` points.

**Confirmation**
- [ ] On 201 or 200, mark the submission sent, show `survey_id` as the receipt
      and `config.success_message`.

---

## 8. Endpoint reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | — | Sign in |
| GET | `/api/auth/me` | Bearer | Who the token belongs to |
| POST | `/api/auth/logout` | Bearer | End this session |
| GET | `/api/mcdc/forms` | Bearer | Forms this user may fill on mobile |
| GET | `/api/forms/{form_id}/package` | Bearer | The complete published form |
| POST | `/api/forms/{form_id}/submissions` | Bearer | Submit answers |
| POST | `/api/forms/{form_id}/submissions/start` | Bearer | Take a survey id (uploads only) |
| POST | `/api/forms/{form_id}/submissions/{survey_id}/media/upload-url` | Bearer | Where to upload one file |
| POST | `/api/forms/{form_id}/submissions/{survey_id}/media/{media_id}/complete` | Bearer | Confirm an upload |
| GET | `/api/forms/{form_id}/parent-options` | Bearer | Parent records for a child form |

Every response carries an `X-Request-ID` header; include it when reporting a
problem to the MCDC operator.

### Error body shapes

An error body is one of three shapes. Read `detail` first, then `error`:

```json
{ "detail": "No form 'FRM99999'" }

{ "detail": { "errors": { "farmer_name": "Farmer name is required" } } }

{ "error": { "code": "INVALID_REQUEST", "message": "form_version is a whole number." },
  "request_id": "d41bb7bc68c245e1a671be52e9808714" }
```

The third shape — a request refused before it reached the form — uses the codes
`INVALID_REQUEST` (400), `AUTHENTICATION_REQUIRED` (401, which also carries
`detail`), `ROUTE_NOT_ALLOWED` (404), `REQUEST_TOO_LARGE` (413) and
`RATE_LIMITED` (429).

---

## 9. Known limitations

- **No refresh token.** Sessions last a fixed time (12 hours by default); the
  app must sign in again after expiry. Plan the offline experience around
  re-authenticating before sending the queue.
- **No server-side drafts or partial saves.** The app keeps all unfinished work.
- **No push notifications of form changes.** Poll the list and use
  `If-None-Match`.
- **Parent records for child forms need a connection** (6.9); they are not in
  the package.
- **Package size grows with lists.** Each catalogue list is capped at 5,000
  values; a dependent crop-ontology list is resolved for at most 200 parent
  values.
- **Editing a published form in MCDC publishes it as a new version
  immediately.** There is no staged "next version": the list's `version` and the
  package change at once. Submissions collected against the old version are
  refused with `_form_version` and must be reviewed against the new package.
- **Taking a form back to draft makes it unavailable** (not listed, package
  409, submissions refused) until it is published again.
- **`signature` is a typed name**, not a drawn signature.
- **The submission response includes `table_name`**, an internal detail kept for
  compatibility with existing clients; ignore it.
