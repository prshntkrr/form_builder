# External Database API

API documentation for the External Database module: connecting to remote
databases (PostgreSQL, Databricks), browsing their schemas, previewing data,
and importing tables into the local database for use as dashboard data sources.

Base URL: `{API}` = `https://<your-server>/api`

---

## 1. Authentication

Every endpoint requires a session token and the `external_db.import` permission.
Send the token as a cookie or `Authorization: Bearer <token>` header.

---

## 2. Connections

A saved connection stores host, database, and credentials. The credential is
sealed with `core/secrets.py` before storage and never returned in full.

### 2.1 List connections

```http
GET {API}/external-db/connections
Authorization: Bearer <token>
```

Returns all saved connections without credentials.

**200 OK**

```json
[
  {
    "connection_id": 1,
    "name": "Production DW",
    "db_type": "postgres",
    "host": "db.example.org",
    "port": 5432,
    "database": "warehouse",
    "username": "reader",
    "db_schema": "public",
    "project_id": "PRJ00001",
    "enabled": true
  }
]
```

### 2.2 Create connection

```http
POST {API}/external-db/connections
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Production DW",
  "db_type": "postgres",
  "host": "db.example.org",
  "port": 5432,
  "database": "warehouse",
  "username": "reader",
  "password": "secret",
  "db_schema": "public",
  "project_id": "PRJ00001"
}
```

**201 Created**

The connection is tested before saving. If it cannot connect, the request fails.

| Field | Required | Default | Notes |
|-------|----------|---------|-------|
| `name` | Yes | — | Max 100 characters |
| `db_type` | Yes | — | `"postgres"` or `"databricks"` |
| `host` | Yes | — | |
| `port` | No | DB default | |
| `database` | Yes | — | |
| `username` | Yes | — | |
| `password` | Yes | — | Sealed before storage |
| `db_schema` | No | `""` | |
| `project_id` | No | `null` | |
| `enabled` | No | `true` | |

For **Databricks** connections, use `warehouse_id`, `catalog`, and `token`
instead of `port`, `username`, and `password`.

### 2.3 Get connection

```http
GET {API}/external-db/connections/{connection_id}
Authorization: Bearer <token>
```

### 2.4 Update connection

```http
PATCH {API}/external-db/connections/{connection_id}
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Production DW (updated)",
  "enabled": false
}
```

Omitting `password` keeps the existing credential.

### 2.5 Delete connection

```http
DELETE {API}/external-db/connections/{connection_id}
Authorization: Bearer <token>
```

Deletes the connection and its sealed credential. Tables already imported are
not affected.

### 2.6 Test saved connection

```http
POST {API}/external-db/connections/{connection_id}/test
Authorization: Bearer <token>
```

Tests connectivity using the saved credentials.

---

## 3. Ad-hoc connection test

```http
POST {API}/external-db/test-connection
Authorization: Bearer <token>
Content-Type: application/json

{
  "db_type": "postgres",
  "host": "db.example.org",
  "port": 5432,
  "database": "warehouse",
  "username": "reader",
  "password": "secret"
}
```

Tests connectivity using the provided credentials without saving anything.

---

## 4. Schema exploration

These endpoints use POST because the request body contains a credential.

### 4.1 List schemas

```http
POST {API}/external-db/schemas
Authorization: Bearer <token>
Content-Type: application/json

{
  "connection": {
    "db_type": "postgres",
    "host": "db.example.org",
    "port": 5432,
    "database": "warehouse",
    "username": "reader",
    "password": "secret"
  }
}
```

**200 OK**

```json
{
  "schemas": ["public", "analytics", "staging"]
}
```

### 4.2 List tables

```http
POST {API}/external-db/tables
Authorization: Bearer <token>
Content-Type: application/json

{
  "connection": { "..." },
  "source_schema": "public"
}
```

**200 OK**

```json
{
  "schema": "public",
  "tables": ["farmers", "plots", "observations"]
}
```

### 4.3 Preview data

```http
POST {API}/external-db/preview
Authorization: Bearer <token>
Content-Type: application/json

{
  "connection": { "..." },
  "source_schema": "public",
  "table": "farmers",
  "limit": 20
}
```

**200 OK**

Returns column metadata and sample rows.

```json
{
  "columns": [
    { "name": "farmer_id", "data_type": "integer" },
    { "name": "name", "data_type": "text" }
  ],
  "rows": [
    { "farmer_id": 1, "name": "Jane Nakato" }
  ],
  "total_rows": 1420
}
```

---

## 5. Import

### 5.1 Import history

```http
GET {API}/external-db/imports
Authorization: Bearer <token>
```

**200 OK**

```json
{
  "imports": [
    {
      "import_id": 1,
      "source_table": "public.farmers",
      "destination_table": "farmers_imported",
      "rows_imported": 1420,
      "imported_by": "admin",
      "imported_on": "2026-09-15T10:30:00"
    }
  ]
}
```

### 5.2 Import table

```http
POST {API}/external-db/load
Authorization: Bearer <token>
Content-Type: application/json

{
  "connection": { "..." },
  "source_schema": "public",
  "source_table": "farmers",
  "destination_table": "farmers_imported"
}
```

Copies the remote table into the local database in one transaction. The
destination table must not already exist.

**200 OK**

```json
{
  "destination_table": "farmers_imported",
  "rows_imported": 1420,
  "columns": 12
}
```
