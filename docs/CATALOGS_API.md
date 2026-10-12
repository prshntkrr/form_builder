# Client Catalogs API

API documentation for the Client Catalogs module: user-defined option lists
(value sets) that form fields can reference. A catalog is a flat or hierarchical
list of coded values — districts, crop varieties, service providers — managed
independently of any form and reusable across many.

Base URL: `{API}` = `https://<your-server>/api`

---

## 1. Authentication

Every endpoint requires a session token. Send it as a cookie or
`Authorization: Bearer <token>` header.

| Permission | Grants |
|------------|--------|
| `client_catalog.view` | Read catalogs and their values |
| `client_catalog.manage` | Create, update, import catalogs and values |
| `records.create` | Also grants the `/options` endpoint (so form-fillers can load dropdown choices) |

---

## 2. Catalogs

### 2.1 List catalogs

```http
GET {API}/client-catalogs?search=district
Authorization: Bearer <token>
```

**Permission**: `client_catalog.view`

| Query | Description |
|-------|-------------|
| `search` | Optional. Filter by name |

**200 OK**

```json
{
  "catalogs": [
    {
      "catalog_id": "districts_ug",
      "name": "Uganda Districts",
      "description": "Administrative districts",
      "version": "2.0",
      "status": "Active",
      "parent_catalog_id": null,
      "value_count": 146
    }
  ],
  "catalog_statuses": ["Active", "Candidate", "Retired"],
  "value_statuses": ["Active", "Withdrawn"]
}
```

### 2.2 Get catalog

```http
GET {API}/client-catalogs/{catalog_id}
Authorization: Bearer <token>
```

**Permission**: `client_catalog.view`

### 2.3 Create catalog

```http
POST {API}/client-catalogs
Authorization: Bearer <token>
Content-Type: application/json

{
  "catalog_id": "districts_ug",
  "name": "Uganda Districts",
  "description": "Administrative districts",
  "version": "1.0",
  "status": "Candidate",
  "parent_catalog_id": null
}
```

**Permission**: `client_catalog.manage`

**201 Created**

| Field | Required | Default |
|-------|----------|---------|
| `catalog_id` | Yes | — |
| `name` | Yes | — |
| `description` | No | `""` |
| `version` | No | `"1.0"` |
| `status` | No | `"Candidate"` |
| `parent_catalog_id` | No | `null` |

### 2.4 Update catalog

```http
PATCH {API}/client-catalogs/{catalog_id}
Authorization: Bearer <token>
Content-Type: application/json

{
  "status": "Active",
  "version": "2.0"
}
```

**Permission**: `client_catalog.manage`

Only the fields present in the body are changed.

---

## 3. Values

### 3.1 List values

```http
GET {API}/client-catalogs/{catalog_id}/values?parent_code=central
Authorization: Bearer <token>
```

**Permission**: `client_catalog.view`

Returns all values (including Withdrawn). For hierarchical catalogs, pass
`parent_code` to list children of a specific node.

**200 OK**

```json
{
  "catalog": {
    "catalog_id": "districts_ug",
    "name": "Uganda Districts"
  },
  "values": [
    {
      "code": "kampala",
      "label": "Kampala",
      "definition": "",
      "parent_code": "central",
      "display_order": 1,
      "status": "Active"
    }
  ]
}
```

### 3.2 Add value

```http
POST {API}/client-catalogs/{catalog_id}/values
Authorization: Bearer <token>
Content-Type: application/json

{
  "code": "wakiso",
  "label": "Wakiso",
  "parent_code": "central",
  "display_order": 2
}
```

**Permission**: `client_catalog.manage`

**201 Created**

| Field | Required | Default |
|-------|----------|---------|
| `code` | Yes | — |
| `label` | No | `""` |
| `definition` | No | `""` |
| `parent_code` | No | `null` |
| `display_order` | No | `null` |
| `status` | No | `"Active"` |

### 3.3 Update value

```http
PATCH {API}/client-catalogs/{catalog_id}/values/{code}
Authorization: Bearer <token>
Content-Type: application/json

{
  "label": "Wakiso District",
  "status": "Active"
}
```

**Permission**: `client_catalog.manage`

Only the fields present in the body are changed.

---

## 4. Options (for form rendering)

```http
GET {API}/client-catalogs/{catalog_id}/options?parent_code=central&language=en&allowed[]=kampala&allowed[]=wakiso
Authorization: Bearer <token>
```

**Permission**: `client_catalog.view` or `records.create`

Returns active values shaped as form dropdown options. Used by the form renderer
and the mobile package.

| Query | Description |
|-------|-------------|
| `parent_code` | Filter to children of this code |
| `language` | Preferred language for labels |
| `allowed[]` | Restrict to these codes only |

**200 OK**

```json
[
  { "value": "kampala", "label": "Kampala" },
  { "value": "wakiso", "label": "Wakiso" }
]
```

---

## 5. Import from Excel

```http
POST {API}/client-catalogs/import
Authorization: Bearer <token>
Content-Type: multipart/form-data

file: <catalogs.xlsx>
```

**Permission**: `client_catalog.manage`

Imports a catalog and its values from an `.xlsx` / `.xlsm` workbook. The
workbook format is the same one the export produces.

**200 OK**

```json
{
  "source": "catalogs.xlsx",
  "catalog_id": "districts_ug",
  "values_imported": 146
}
```
