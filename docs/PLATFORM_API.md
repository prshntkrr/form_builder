# Platform API

System-level endpoints that are not part of any module.

Base URL: `{API}` = `https://<your-server>/api`

---

## Health check

```http
GET {API}/health
```

No authentication required.

```json
{
  "status": "healthy",
  "modules": ["forms", "projects", "dashboards", "client_catalog", "external_db"],
  "database": { "connected": true },
  "openai": { "configured": true }
}
```

---

## Platform statistics

```http
GET {API}/stats
GET {API}/stats?load_range=Week
```

Requires authentication (any signed-in user).

| Query | Default | Values |
|-------|---------|--------|
| `load_range` | `Day` | `Day`, `Week`, `Month`, `Year` |

```json
{
  "forms": 42,
  "submissions": 1580,
  "users": 12,
  "projects": 3,
  "session_chart": [ { "date": "2026-10-01", "count": 5 } ],
  "server_load": { "cpu": 12.4, "memory": 68.2 }
}
```

---

## Field types

```http
GET {API}/field-types
```

No authentication required. Returns the supported field type definitions used
by the form builder.

```json
[
  { "type": "text", "label": "Text", "category": "basic", "icon": "type",
    "validation": ["min_length", "max_length", "pattern"] },
  { "type": "number", "label": "Number", "category": "basic", "icon": "hash",
    "validation": ["min", "max"] },
  { "type": "select", "label": "Dropdown", "category": "choice", "icon": "list",
    "has_options": true },
  { "type": "image", "label": "Photo", "category": "media", "icon": "camera" }
]
```

---

## Endpoint reference

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | — | Health check |
| GET | `/api/stats` | Bearer | Platform statistics |
| GET | `/api/field-types` | — | Supported field types |
