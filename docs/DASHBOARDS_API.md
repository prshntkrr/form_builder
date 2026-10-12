# Dashboards API

API documentation for the Dashboards module: creating, editing, versioning,
sharing and querying dashboards built from form response data or imported
spreadsheets.

Base URL: `{API}` = `https://<your-server>/api`

---

## 1. Authentication

Every endpoint requires a session token (see the auth documentation). Send it
as a cookie or `Authorization: Bearer <token>` header.

The two exceptions are the **shared dashboard** endpoints (`/shared/{token}`),
which are public — anyone with the token can view the dashboard and query its
data.

---

## 2. Data sources

A dashboard reads from `_tabular` tables — either the tabular mirror of a
form's responses or an imported Excel workbook.

### 2.1 List data sources

```http
GET {API}/dashboards/data-sources
Authorization: Bearer <token>
```

**Permission**: `dashboards.view`

**200 OK**

```json
{
  "data_sources": [
    {
      "table_name": "household_survey_tabular",
      "source_type": "form",
      "label": "Household Survey"
    },
    {
      "table_name": "rainfall_2024_tabular",
      "source_type": "excel",
      "label": "rainfall_2024"
    }
  ]
}
```

### 2.2 Import Excel as data source

```http
POST {API}/dashboards/data-sources/excel
Authorization: Bearer <token>
Content-Type: multipart/form-data

file: <rainfall_2024.xlsx>
table_name: rainfall_2024
```

**Permission**: `dashboards.import`

The table is created as `<table_name>_tabular`. The name must not already exist.
Only `.xlsx` / `.xlsm` files are accepted.

**200 OK**

```json
{
  "table_name": "rainfall_2024_tabular",
  "rows_imported": 1420,
  "columns": ["district", "month", "rainfall_mm"]
}
```

| Status | Meaning |
|--------|---------|
| 400 | Not an `.xlsx` file, empty file, or name already taken |
| 413 | File too large |

### 2.3 Data source detail

```http
GET {API}/dashboards/data-sources/{table_name}
Authorization: Bearer <token>
```

**Permission**: `dashboards.view`

Returns field metadata (column names, data types) for the named `_tabular`
table.

**200 OK**

```json
{
  "table_name": "household_survey_tabular",
  "fields": [
    { "name": "district", "data_type": "text" },
    { "name": "household_size", "data_type": "integer" },
    { "name": "created_on", "data_type": "timestamp with time zone" }
  ]
}
```

### 2.4 Filter options

```http
GET {API}/dashboards/data-sources/{table_name}/filter-options?field=district
Authorization: Bearer <token>
```

**Permission**: `dashboards.view`

Returns the distinct values for a column, for populating a dashboard filter
dropdown.

**200 OK**

```json
{
  "field": "district",
  "values": ["Kampala", "Wakiso", "Mukono"]
}
```

---

## 3. Dashboard CRUD

### 3.1 List dashboards

```http
GET {API}/dashboards
Authorization: Bearer <token>
```

**Permission**: `dashboards.view`

Returns all active (non-deleted) dashboards.

### 3.2 Create dashboard

```http
POST {API}/dashboards
Authorization: Bearer <token>
Content-Type: application/json

{
  "dashboard": {
    "name": "Crop Yield Overview",
    "description": "District-level yield analysis"
  },
  "data_sources": [
    { "id": "ds_1", "name": "crop_yield_tabular", "type": "postgresql_tabular" }
  ],
  "widgets": [],
  "layout": { "columns": 12 }
}
```

**Permission**: `dashboards.create`

The body is the full dashboard specification. The `dashboard.name` field
becomes the title.

### 3.3 Get dashboard

```http
GET {API}/dashboards/{dashboard_id}
Authorization: Bearer <token>
```

**Permission**: `dashboards.view`

### 3.4 Update dashboard

```http
PUT {API}/dashboards/{dashboard_id}
Authorization: Bearer <token>
Content-Type: application/json

{
  "dashboard": {
    "name": "Crop Yield Overview (Updated)"
  },
  "data_sources": [...],
  "widgets": [...],
  "layout": { "columns": 12 }
}
```

**Permission**: `dashboards.edit`

### 3.5 Delete dashboard

```http
DELETE {API}/dashboards/{dashboard_id}
Authorization: Bearer <token>
```

**Permission**: `dashboards.delete`

Soft-deletes the dashboard.

**200 OK**

```json
{
  "message": "Dashboard deleted successfully.",
  "dashboard_id": "DSH00005"
}
```

---

## 4. Versions

Every save creates a new version. Publishing marks a version as live; restoring
creates a new draft from a previous version.

### 4.1 List versions

```http
GET {API}/dashboards/{dashboard_id}/versions
Authorization: Bearer <token>
```

**Permission**: `dashboards.view`

### 4.2 Get specific version

```http
GET {API}/dashboards/{dashboard_id}/versions/{version_no}
Authorization: Bearer <token>
```

**Permission**: `dashboards.view`

Returns the full dashboard configuration at that version.

### 4.3 Publish version

```http
POST {API}/dashboards/{dashboard_id}/versions/{version_no}/publish
Authorization: Bearer <token>
```

**Permission**: `dashboards.edit`

### 4.4 Restore version

```http
POST {API}/dashboards/{dashboard_id}/versions/{version_no}/restore
Authorization: Bearer <token>
```

**Permission**: `dashboards.edit`

Creates a new draft version from the specified version.

---

## 5. AI generation

### 5.1 Generate dashboard from prompt

```http
POST {API}/dashboards/generate
Authorization: Bearer <token>
Content-Type: application/json

{
  "table_name": "crop_yield_tabular",
  "prompt": "Show yield by district with a bar chart and a KPI for average yield"
}
```

**Permission**: `dashboards.create`

The AI receives table metadata only — it never sees database rows and never
executes SQL. Returns a validated `DashboardSpecification`.

| Status | Meaning |
|--------|---------|
| 404 | Data source not found |
| 422 | AI generation or validation failed |

### 5.2 Widget operation

```http
POST {API}/dashboards/widget-operation
Authorization: Bearer <token>
Content-Type: application/json

{
  "table_name": "crop_yield_tabular",
  "prompt": "Add a pie chart showing distribution by crop type",
  "mode": "add",
  "dashboard": { ...current dashboard specification... }
}
```

**Permission**: `dashboards.edit`

| Field | Required | Description |
|-------|----------|-------------|
| `table_name` | Yes | The `_tabular` data source |
| `prompt` | Yes | What to add or change |
| `mode` | Yes | `"add"` or `"update"` |
| `widget_id` | When `mode` is `"update"` | Which widget to change |
| `dashboard` | Yes | The current dashboard specification |

**200 OK**

```json
{
  "operation": "add_widget",
  "widget_id": "w_abc123",
  "widget": { "id": "w_abc123", "type": "pie", "title": "Crop Distribution", "..." : "..." },
  "dashboard": { "...updated full specification..." }
}
```

---

## 6. Data queries

### 6.1 Query data (authenticated)

```http
POST {API}/dashboards/data
Authorization: Bearer <token>
Content-Type: application/json

{
  "table_name": "crop_yield_tabular",
  "binding": {
    "dimensions": [{ "field": "district" }],
    "measures": [{ "field": "yield_kg", "aggregation": "AVG" }],
    "filters": [],
    "sort": [{ "field": "yield_kg", "direction": "DESC" }]
  },
  "page": 1,
  "page_size": 50
}
```

**Permission**: `dashboards.view`

The frontend sends structured data-binding information, never raw SQL.

**200 OK** (with paging)

```json
{
  "table_name": "crop_yield_tabular",
  "rows": [
    { "district": "Wakiso", "yield_kg": 3200.5 },
    { "district": "Kampala", "yield_kg": 2800.0 }
  ],
  "page": 1,
  "page_size": 50,
  "total_rows": 124,
  "total_pages": 3
}
```

When `page` and `page_size` are omitted, the response contains only
`table_name` and `rows`.

#### Binding reference

| Object | Fields |
|--------|--------|
| `dimensions[]` | `field` |
| `measures[]` | `field`, `aggregation` (`COUNT`, `COUNT_DISTINCT`, `SUM`, `AVG`, `MIN`, `MAX`, `NONE`) |
| `filters[]` | `field`, `operator` (`EQUALS`, `NOT_EQUALS`, `GREATER_THAN`, `LESS_THAN`, `IN`, `IS_NULL`, `IS_NOT_NULL`, ...), `value` |
| `sort[]` | `field`, `direction` (`ASC`, `DESC`) |

---

## 7. Sharing

A published dashboard can be shared via a public link. The link contains an
unguessable token; anyone with it can view the dashboard and its data.

### 7.1 Share dashboard

```http
POST {API}/dashboards/{dashboard_id}/share
Authorization: Bearer <token>
```

**Permission**: `dashboards.share`

The dashboard must be published (409 otherwise).

**200 OK**

```json
{
  "dashboard_id": "DSH00005",
  "share_token": "a1b2c3d4e5f6...",
  "share_url": "https://<server>/shared/dashboards/a1b2c3d4e5f6..."
}
```

### 7.2 Stop sharing

```http
DELETE {API}/dashboards/{dashboard_id}/share
Authorization: Bearer <token>
```

**Permission**: `dashboards.share`

**204 No Content** — the token is invalidated; every copy of the link stops
working.

### 7.3 View shared dashboard (public)

```http
GET {API}/dashboards/shared/{token}
```

No authentication. Returns the published dashboard specification.

**404** if the token is invalid, expired, or was never issued — the response
does not distinguish the cases.

### 7.4 Query shared dashboard data (public)

```http
POST {API}/dashboards/shared/{token}/data
Content-Type: application/json

{
  "widget_id": "w_abc123"
}
```

No authentication. Returns data for one widget only. The query is read from the
published specification — the caller cannot name a table, column, or filter.

**200 OK**

```json
{
  "rows": [
    { "district": "Wakiso", "yield_kg": 3200.5 }
  ]
}
```

For table widgets, paging fields (`page`, `page_size`, `total_rows`,
`total_pages`) are included automatically, using the widget's own
`table_page_size` setting.

---

## 8. Widget types

| Type | Description |
|------|-------------|
| `bar` | Bar chart |
| `line` | Line chart |
| `pie` | Pie chart |
| `doughnut` | Doughnut chart |
| `kpi` | Single-value card |
| `table` | Data table with paging |
| `map` | Geographic map |
| `bubble` | Bubble chart |
| `histogram` | Histogram |
| `scatter` | Scatter plot |
