# Standard Forms Library API

API documentation for the Standard Forms Library: a curated collection of
reusable form definitions. Forms are added to the library from saved forms,
imported from Excel workbooks, and used to start new forms or borrow sections
into existing ones.

Base URL: `{API}` = `https://<your-server>/api`

---

## 1. Authentication

Every endpoint requires a session token. Send it as a cookie or
`Authorization: Bearer <token>` header.

| Permission | Grants |
|------------|--------|
| `library.view` | Browse the library, start forms, borrow sections |
| `library.manage` | Add forms to the library, withdraw them, import from Excel |

---

## 2. Browsing

### 2.1 List standards

```http
GET {API}/standard-forms?search=household&category=Agriculture
Authorization: Bearer <token>
```

**Permission**: `library.view`

| Query | Description |
|-------|-------------|
| `search` | Filter by title or summary |
| `category` | Filter by category |

**200 OK**

```json
{
  "categories": ["Agriculture", "Health", "Socioeconomic"],
  "forms": [
    {
      "standard_id": "STD00001",
      "form_id": "FRM00012",
      "version_no": 3,
      "title": "Household Agriculture Survey",
      "category": "Agriculture",
      "tags": ["household", "crops", "livestock"],
      "summary": "Comprehensive household-level agricultural data collection",
      "added_by": "admin",
      "added_on": "2026-08-15T09:00:00"
    }
  ]
}
```

### 2.2 Get standard

```http
GET {API}/standard-forms/{standard_id}
Authorization: Bearer <token>
```

**Permission**: `library.view`

Returns the full standard including its form definition.

---

## 3. Managing the library

### 3.1 Add form to library

```http
POST {API}/standard-forms
Authorization: Bearer <token>
Content-Type: application/json

{
  "form_id": "FRM00012",
  "version_no": 3,
  "standard_id": "STD00001",
  "category": "Agriculture",
  "tags": ["household", "crops"],
  "summary": "Household-level agricultural data collection",
  "added_by": "admin"
}
```

**Permission**: `library.manage`

**201 Created**

| Field | Required | Default |
|-------|----------|---------|
| `form_id` | Yes | — |
| `version_no` | Yes | — |
| `standard_id` | No | Auto-generated |
| `category` | No | `null` |
| `tags` | No | `[]` |
| `summary` | No | `null` |
| `added_by` | No | `null` |

### 3.2 Withdraw from library

```http
DELETE {API}/standard-forms/{standard_id}
Authorization: Bearer <token>
```

**Permission**: `library.manage`

**200 OK**

```json
{ "standard_id": "STD00001", "removed": true }
```

---

## 4. Using standards

### 4.1 Start new form from standard

```http
POST {API}/standard-forms/{standard_id}/start
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "My Household Survey"
}
```

**Permission**: `library.view`

Creates a new draft form definition from the standard. The title is optional;
if omitted, the standard's title is used.

**200 OK**

```json
{
  "form_json": {
    "title": "My Household Survey",
    "sections": [...],
    "fields": [...]
  }
}
```

### 4.2 Borrow section into existing form

```http
POST {API}/standard-forms/{standard_id}/borrow
Authorization: Bearer <token>
Content-Type: application/json

{
  "form_json": { "...current form definition..." },
  "section": "livestock"
}
```

**Permission**: `library.view`

Merges fields from the standard into the caller's form definition. When
`section` is provided, only that section's fields are borrowed; otherwise the
entire standard is merged.

**200 OK**

```json
{
  "form_json": { "...updated form definition with borrowed fields..." }
}
```

---

## 5. Import from Excel

A two-step process: parse the workbook into draft definitions, then save each
one to the library.

### 5.1 Parse workbook

```http
POST {API}/standard-forms/import
Authorization: Bearer <token>
Content-Type: multipart/form-data

file: <forms.xlsx>
```

**Permission**: `library.manage`

Accepts `.xlsx` / `.xlsm` files up to 8 MB.

**200 OK**

```json
{
  "source": "forms.xlsx",
  "forms": [
    {
      "form_json": { "title": "Crop Assessment", "fields": [...] },
      "standards": ["ICASA"],
      "profile": { "sections": 3, "fields": 24 }
    }
  ]
}
```

### 5.2 Save imported form

```http
POST {API}/standard-forms/import/save
Authorization: Bearer <token>
Content-Type: application/json

{
  "form_json": { "title": "Crop Assessment", "fields": [...] },
  "title": "Crop Assessment",
  "category": "Agriculture",
  "tags": ["crops", "assessment"],
  "summary": "Standard crop assessment form",
  "source": "forms.xlsx"
}
```

**Permission**: `library.manage`

**201 Created**

| Field | Required | Default |
|-------|----------|---------|
| `form_json` | Yes | — |
| `title` | No | From `form_json.title` |
| `category` | No | `null` |
| `tags` | No | `[]` |
| `summary` | No | `null` |
| `source` | No | `null` |
