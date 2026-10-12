# Submissions & Records API

API documentation for the web application's submission, records and review
endpoints. For the mobile app integration, see `MOBILE_API.md` instead.

Base URL: `{API}` = `https://<your-mcdc-server>/api`

All endpoints require `Authorization: Bearer <token>` (see `MOBILE_API.md` 2).

---

## 1. Form discovery (for filling)

### 1.1 Active forms available for filling

```http
GET {API}/forms/live/list
GET {API}/forms/live/list?project=PRJ00001
```

**Permission:** `records.view`

**200 OK**

```json
[
  {
    "form_id": "FRM00030",
    "form_title": "Farmer Registration",
    "form_description": "Register a farmer and their main plot",
    "form_status": "Active",
    "field_count": 7,
    "version": 3,
    "channel": "web_mobile",
    "project_id": "PRJ00001",
    "project_name": "Mexico Maize",
    "updated_on": "2026-09-18T10:12:40.118211"
  }
]
```

Only Active forms that the caller may fill are returned. The `project` query
parameter filters to one project (omit for all).

### 1.2 Form config for web rendering

```http
GET {API}/forms/{form_id}/render
GET {API}/forms/{form_id}/render?language=es
```

**Permission:** `records.create`

Returns the published form definition ready for the web form renderer. The
optional `language` parameter selects the display language (falls back to
`default_language`).

**200 OK**

```json
{
  "form_id": "FRM00030",
  "form_title": "Farmer Registration",
  "version": 3,
  "config": { "...same structure as package config..." },
  "option_sets": { "...resolved option sets..." }
}
```

| Status | Meaning |
|---|---|
| 404 | No such form, or the caller may not fill it |
| 409 | Form is not available (draft, paused, deleted) |

### 1.3 Complete mobile package

```http
GET {API}/forms/{form_id}/package
GET {API}/forms/{form_id}/package?language=es
If-None-Match: "<package_hash>"
```

**Permission:** `records.create`

See `MOBILE_API.md` 4 for the full package format, ETag/304 behaviour and
error codes.

---

## 2. Submissions

### 2.1 Submit answers

```http
POST {API}/forms/{form_id}/submissions
Content-Type: application/json
Idempotency-Key: 7f3c9e2a-5b1d-4e8a-9c0f-2d6b8a1e4f70    (optional)

{
  "data": {
    "consent": "yes",
    "farmer_name": "Ramesh Patil",
    "state": "MX-JAL",
    "area_ha": 2.5
  },
  "channel": "web",
  "form_version": 3,
  "language": "es",
  "client_submission_id": "7f3c9e2a-5b1d-4e8a-9c0f-2d6b8a1e4f70",
  "location": {
    "latitude": 20.62,
    "longitude": -103.38,
    "accuracy": 12.4,
    "captured_at": "2026-09-19T10:15:00Z"
  },
  "survey_id": "000043",
  "parent_survey_id": "000001"
}
```

**Permission:** `records.create`

| Field | Required | Notes |
|---|---|---|
| `data` | **yes** | `{question_name: answer}` — see `MOBILE_API.md` 5.3 for types |
| `channel` | no | `web` (default), `mobile`, `whatsapp`, `ivr` |
| `form_version` | recommended | Published version number (integer). Mismatch gives 422 `_form_version` |
| `language` | no | Language for error messages |
| `client_submission_id` | recommended | Idempotency key, 1-64 chars `[A-Za-z0-9._:-]` |
| `location` | when form requires | `{latitude, longitude, accuracy?, captured_at?}` |
| `survey_id` | only with media | From `POST .../submissions/start` |
| `parent_survey_id` | child forms | Survey ID of the parent record |

**201 Created**

```json
{
  "survey_id": "000042",
  "created_on": "2026-09-19T10:15:03.215044",
  "form_id": "FRM00030",
  "form_version": 3,
  "table_name": "farmer_registration",
  "parent_survey_id": "000001",
  "location": { "latitude": 20.62, "longitude": -103.38, "accuracy": 12.4,
                "captured_at": "2026-09-19T10:15:00Z" },
  "client_submission_id": "7f3c9e2a-5b1d-4e8a-9c0f-2d6b8a1e4f70",
  "replayed": false,
  "channel": "web"
}
```

**Idempotent replay** (200): same `client_submission_id` + same `data` + same
`channel` returns the original receipt with `"replayed": true`. Different data
under the same id gives 409.

### 2.2 Channel ingest (WhatsApp / IVR)

```http
POST {API}/forms/{form_id}/submissions/ingest
Content-Type: application/json

{
  "channel": "whatsapp",
  "payload": {
    "consent": "yes",
    "farmer_name": "Ramesh Patil"
  },
  "channel_identity": "+919876543210"
}
```

**Permission:** `records.create`

Used by the WhatsApp and IVR pipelines. The `channel_identity` maps to an
account for authorisation (an unlinked identity is refused). The `payload` goes
through the same validation as a regular submission.

**201 Created** — same shape as 2.1.

### 2.3 Test submission

```http
POST {API}/forms/{form_id}/test-submission
Content-Type: application/json

{
  "data": {
    "consent": "yes",
    "farmer_name": "Ramesh Patil"
  }
}
```

**Permission:** `forms.edit`

Validates `data` against the form definition without storing anything. Returns
200 on success; 422 with `{detail: {errors: {...}}}` on failure.

**200 OK**

```json
{ "valid": true }
```

### 2.4 Start submission (for media uploads)

```http
POST {API}/forms/{form_id}/submissions/start
```

**Permission:** `records.create`

Reserves a `survey_id` before uploading media files. The id is then passed to
the media upload endpoints and the final submission.

**201 Created**

```json
{ "survey_id": "000043" }
```

---

## 3. Records & responses

### 3.1 List records

```http
GET {API}/forms/{form_id}/records
GET {API}/forms/{form_id}/records?limit=25&offset=0
```

**Permission:** `records.view`

Returns records from the form's tabular table.

| Query | Default | Notes |
|---|---|---|
| `limit` | 25 | Max rows |
| `offset` | 0 | Pagination offset |

**200 OK**

```json
{
  "records": [
    {
      "survey_id": "000042",
      "form_id": "FRM00030",
      "farmer_name": "Ramesh Patil",
      "state": "MX-JAL",
      "area_ha": 2.5,
      "created_on": "2026-09-19T10:15:03.215044",
      "created_by": "Shrishti Rao"
    }
  ],
  "total": 156,
  "limit": 25,
  "offset": 0
}
```

### 3.2 List submissions

```http
GET {API}/forms/{form_id}/submissions
GET {API}/forms/{form_id}/submissions?limit=50&offset=0&from=2026-09-01&to=2026-09-30
```

**Permission:** `responses.view` or `project.submissions.view_all`

| Query | Default | Notes |
|---|---|---|
| `limit` | 50 | Max rows |
| `offset` | 0 | Pagination offset |
| `from` | — | Start date filter (`YYYY-MM-DD`) |
| `to` | — | End date filter (`YYYY-MM-DD`) |

**200 OK**

```json
{
  "submissions": [
    {
      "survey_id": "000042",
      "form_id": "FRM00030",
      "form_data": {
        "consent": "yes",
        "farmer_name": "Ramesh Patil",
        "state": "MX-JAL",
        "area_ha": 2.5
      },
      "form_version": 3,
      "created_on": "2026-09-19T10:15:03.215044",
      "created_by": "Shrishti Rao"
    }
  ],
  "total": 156,
  "limit": 50,
  "offset": 0
}
```

### 3.3 Export submissions

```http
GET {API}/forms/{form_id}/submissions/export
GET {API}/forms/{form_id}/submissions/export?format=xlsx&from=2026-09-01&to=2026-09-30
```

**Permission:** `responses.export` or `project.submissions.view_all`

| Query | Default | Notes |
|---|---|---|
| `format` | `csv` | `csv` or `xlsx` |
| `columns` | all | Comma-separated list of column names |
| `from` | — | Start date filter (`YYYY-MM-DD`) |
| `to` | — | End date filter (`YYYY-MM-DD`) |

Returns a file download with `Content-Disposition: attachment`.

---

## 4. View configuration

Control which columns are visible in the submissions table on the web.

### 4.1 Get view config

```http
GET {API}/forms/{form_id}/view-config
```

**Permission:** `responses.view` or `project.forms.manage`

**200 OK**

```json
{
  "form_id": "FRM00030",
  "show_all": false,
  "visible_fields": ["farmer_name", "state", "area_ha", "created_on"]
}
```

### 4.2 Update view config

```http
PUT {API}/forms/{form_id}/view-config
Content-Type: application/json

{
  "show_all": false,
  "visible_fields": ["farmer_name", "state", "area_ha", "created_on"]
}
```

**Permission:** `view.configure` or `project.forms.manage`

**200 OK** — returns the updated config (same shape as 4.1).

---

## 5. Relationships (parent/child forms)

### 5.1 Get relationship

```http
GET {API}/forms/{form_id}/relationship
```

**Permission:** `records.view`

**200 OK**

```json
{
  "type": "child",
  "parent_form_id": "FRM00029",
  "parent_form_title": "Farmer Registration"
}
```

Returns `null` or an empty object when the form has no relationship.

### 5.2 Parent record options

```http
GET {API}/forms/{form_id}/parent-options?q=ramesh&limit=50
```

**Permission:** `records.create`

| Query | Default | Notes |
|---|---|---|
| `q` | — | Search text to filter parent records |
| `limit` | 50 | Max results (1-200) |

**200 OK**

```json
{
  "parent_form_id": "FRM00029",
  "parent_form_title": "Farmer Registration",
  "submissions": [
    {
      "survey_id": "000001",
      "summary": "Ramesh Patil · Jalisco",
      "created_by": "Shrishti Rao",
      "created_on": "2026-09-10T08:00:00"
    }
  ]
}
```

### 5.3 Children of a record

```http
GET {API}/forms/{form_id}/records/{survey_id}/children
```

**Permission:** `records.view`

**200 OK**

```json
{
  "children": [
    {
      "form_id": "FRM00031",
      "form_title": "Plot Survey",
      "submissions": [
        {
          "survey_id": "000050",
          "form_data": { "plot_size": 2.5, "crop": "maize" },
          "created_on": "2026-09-20T14:30:00"
        }
      ]
    }
  ]
}
```

### 5.4 Parent of a record

```http
GET {API}/forms/{form_id}/records/{survey_id}/parent
```

**Permission:** `records.view`

**200 OK**

```json
{
  "parent_form_id": "FRM00029",
  "parent_form_title": "Farmer Registration",
  "survey_id": "000001",
  "form_data": { "farmer_name": "Ramesh Patil", "state": "MX-JAL" },
  "created_on": "2026-09-10T08:00:00"
}
```

---

## 6. Media

Files are uploaded via presigned S3 URLs. See `MOBILE_API.md` 6.8 for the full
upload flow (start -> upload-url -> PUT to S3 -> complete -> submit).

### 6.1 Get upload URL

```http
POST {API}/forms/{form_id}/submissions/{survey_id}/media/upload-url
Content-Type: application/json

{
  "field_name": "plot_photo",
  "filename": "plot.jpg",
  "content_type": "image/jpeg",
  "file_size": 482912
}
```

**Permission:** `records.create`

**200 OK**

```json
{
  "media_id": "MEDa1b2c3d4",
  "s3_key": "forms/FRM00030/000043/plot_photo/MEDa1b2c3d4.jpg",
  "media_type": "image",
  "upload_url": "https://s3.amazonaws.com/bucket/...?X-Amz-Signature=..."
}
```

Upload the bytes with `PUT <upload_url>` using the exact `Content-Type` from the
request. No `Authorization` header on the S3 request. The URL expires in about
15 minutes.

**Limits:** 25 MB per file. Accepted types per question type:

| Question type | Accepted `content_type` |
|---|---|
| `image` | `image/jpeg`, `image/png`, `image/webp`, `image/heic` |
| `audio` | `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/webm`, `audio/mp4` |
| `file` | `application/pdf`, `application/msword`, `.docx`, `.xlsx`, `text/csv`, `text/plain` |

| Status | Meaning |
|---|---|
| 422 | Wrong content type, oversized, or question does not accept uploads |
| 502 | Storage could not be reached |
| 503 | File storage not configured |

### 6.2 Confirm upload complete

```http
POST {API}/forms/{form_id}/submissions/{survey_id}/media/{media_id}/complete
Content-Type: application/json

{ "file_size": 482912 }
```

**Permission:** `records.create`

**200 OK**

```json
{
  "media_id": "MEDa1b2c3d4",
  "field_name": "plot_photo",
  "media_type": "image",
  "filename": "plot.jpg",
  "content_type": "image/jpeg",
  "file_size": 482912
}
```

### 6.3 List media for a submission

```http
GET {API}/forms/{form_id}/submissions/{survey_id}/media
```

**Permission:** `records.view`

**200 OK**

```json
{
  "media": [
    {
      "media_id": "MEDa1b2c3d4",
      "field_name": "plot_photo",
      "media_type": "image",
      "filename": "plot.jpg",
      "content_type": "image/jpeg",
      "file_size": 482912
    }
  ]
}
```

### 6.4 Get download URL

```http
GET {API}/forms/{form_id}/submissions/{survey_id}/media/{media_id}/url
```

**Permission:** `records.view`

**200 OK**

```json
{
  "media_id": "MEDa1b2c3d4",
  "download_url": "https://s3.amazonaws.com/bucket/...?X-Amz-Signature=..."
}
```

The URL is a temporary presigned download link.

---

## 7. Submission review

A review workflow for submitted records. Permissions are scoped per project
and role.

### 7.1 Review status

```http
GET {API}/submissions/{form_id}/{survey_id}
```

**200 OK**

```json
{
  "form_id": "FRM00030",
  "survey_id": "000042",
  "status": "draft",
  "submitted_at": null,
  "reviewed_at": null,
  "reviewer": null
}
```

Status values: `draft`, `submitted`, `in_review`, `approved`, `rejected`.

### 7.2 Full detail

```http
GET {API}/submissions/{form_id}/{survey_id}/detail
```

**200 OK**

```json
{
  "form_id": "FRM00030",
  "survey_id": "000042",
  "status": "submitted",
  "form_data": {
    "consent": "yes",
    "farmer_name": "Ramesh Patil",
    "state": "MX-JAL",
    "area_ha": 2.5
  },
  "form_version": 3,
  "created_on": "2026-09-19T10:15:03.215044",
  "created_by": "Shrishti Rao",
  "submitted_at": "2026-09-19T10:16:00",
  "reviewed_at": null,
  "reviewer": null,
  "rejection_reason": null
}
```

### 7.3 Submit for review

```http
POST {API}/submissions/{form_id}/{survey_id}/submit
```

**200 OK**

```json
{ "status": "submitted", "submitted_at": "2026-09-19T10:16:00" }
```

### 7.4 Start review

```http
POST {API}/submissions/{form_id}/{survey_id}/start-review
```

**200 OK**

```json
{ "status": "in_review", "reviewer": "Admin User" }
```

### 7.5 Approve

```http
POST {API}/submissions/{form_id}/{survey_id}/approve
```

**200 OK**

```json
{ "status": "approved", "reviewed_at": "2026-09-19T11:00:00", "reviewer": "Admin User" }
```

### 7.6 Reject

```http
POST {API}/submissions/{form_id}/{survey_id}/reject
Content-Type: application/json

{ "reason": "Plot area exceeds the maximum for this region." }
```

**200 OK**

```json
{
  "status": "rejected",
  "reviewed_at": "2026-09-19T11:00:00",
  "reviewer": "Admin User",
  "rejection_reason": "Plot area exceeds the maximum for this region."
}
```

---

## 8. Error handling

### 8.1 Validation errors (422)

All validation problems are returned at once:

```json
{
  "detail": {
    "errors": {
      "farmer_name": "Farmer name is required",
      "area_ha": "Must be between 0 and 500"
    }
  }
}
```

### 8.2 Special error keys

These appear alongside (or instead of) field names in `detail.errors`:

| Key | Meaning |
|---|---|
| `_form_version` | A newer version is published — download the form again |
| `_channel` | This form does not accept answers from this channel |
| `_location` | Location missing, invalid, or outside the geofence |
| `_form` | Form is not accepting answers (paused, deleted, or survey_id issue) |
| `client_submission_id` | Malformed id, or conflicts with `Idempotency-Key` header |

### 8.3 Other status codes

| Status | Body shape | Meaning |
|---|---|---|
| 400 | `{"error": {"code": "INVALID_REQUEST", "message": "..."}, "request_id": "..."}` | Malformed request |
| 401 | `{"detail": "Sign in to continue", "error": {"code": "AUTHENTICATION_REQUIRED"}}` | Not authenticated |
| 403 | `{"detail": "Your role (...) cannot do this..."}` | Missing permission |
| 404 | `{"detail": "No form '...'"}` | Form not found or not accessible |
| 409 | `{"detail": "... already used for a different submission ..."}` | Conflicting idempotency key |
| 413 | `{"error": {"code": "REQUEST_TOO_LARGE"}}` | Body over 5 MB |
| 429 | `{"error": {"code": "RATE_LIMITED"}}` + `Retry-After` header | Rate limited |

---

## 9. Key notes

- **Idempotent submissions.** Send `client_submission_id` (or `Idempotency-Key`
  header) on every submission. Same id + same data = 200 replay; different data
  = 409. See `MOBILE_API.md` 6.5.
- **Channels:** `web`, `mobile`, `whatsapp`, `ivr`. A form's `channel` field
  (`web_mobile`, `whatsapp`, `ivr`) describes what it was built for; a
  submission's `channel` describes where answers came from.
- **One validation pipeline.** Every submission — web, mobile, WhatsApp, IVR —
  goes through the same checks in `submission_service`.
- **Media uploads** use presigned S3 URLs with a 25 MB limit. The bytes never
  pass through MCDC.
- **All timestamps are UTC**, without a timezone suffix.
- **`X-Request-ID`** is on every response; include it when reporting problems.

---

## 10. Endpoint reference

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/forms/live/list` | `records.view` | Active forms for filling |
| GET | `/api/forms/{form_id}/render` | `records.create` | Form config for web rendering |
| GET | `/api/forms/{form_id}/package` | `records.create` | Complete mobile package |
| POST | `/api/forms/{form_id}/submissions` | `records.create` | Submit answers |
| POST | `/api/forms/{form_id}/submissions/ingest` | `records.create` | Channel ingest |
| POST | `/api/forms/{form_id}/test-submission` | `forms.edit` | Validate without storing |
| POST | `/api/forms/{form_id}/submissions/start` | `records.create` | Reserve survey_id |
| GET | `/api/forms/{form_id}/records` | `records.view` | List records |
| GET | `/api/forms/{form_id}/submissions` | `responses.view` | List submissions |
| GET | `/api/forms/{form_id}/submissions/export` | `responses.export` | Export CSV/XLSX |
| GET | `/api/forms/{form_id}/view-config` | `responses.view` | Get view config |
| PUT | `/api/forms/{form_id}/view-config` | `view.configure` | Update view config |
| GET | `/api/forms/{form_id}/relationship` | `records.view` | Get relationship |
| GET | `/api/forms/{form_id}/parent-options` | `records.create` | Parent record picker |
| GET | `/api/forms/{form_id}/records/{survey_id}/children` | `records.view` | Child submissions |
| GET | `/api/forms/{form_id}/records/{survey_id}/parent` | `records.view` | Parent record |
| POST | `.../media/upload-url` | `records.create` | Get presigned upload URL |
| POST | `.../media/{media_id}/complete` | `records.create` | Confirm upload |
| GET | `.../media` | `records.view` | List media |
| GET | `.../media/{media_id}/url` | `records.view` | Get download URL |
| GET | `/api/submissions/{form_id}/{survey_id}` | scoped | Review status |
| GET | `/api/submissions/{form_id}/{survey_id}/detail` | scoped | Full submission detail |
| POST | `/api/submissions/{form_id}/{survey_id}/submit` | scoped | Submit for review |
| POST | `/api/submissions/{form_id}/{survey_id}/start-review` | scoped | Begin review |
| POST | `/api/submissions/{form_id}/{survey_id}/approve` | scoped | Approve submission |
| POST | `/api/submissions/{form_id}/{survey_id}/reject` | scoped | Reject submission |
