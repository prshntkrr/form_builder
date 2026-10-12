# Standards API — ICASA, ISO 3166, Ontologies, Units

API documentation for the standards modules: searching agricultural data
standards (ICASA, CIMMYT), ontologies (SEOnt, Crop Ontology), country codes
(ISO 3166), and unit conversion. These endpoints let the form builder attach
standard variable identifiers to form fields and use curated option lists.

Base URL: `{API}` = `https://<your-server>/api`

---

## 1. Authentication

Every endpoint requires a session token except where noted. Send it as a
cookie or `Authorization: Bearer <token>` header.

---

## 2. ICASA Standards (`/api/standards`)

### 2.1 Loaded standards

```http
GET {API}/standards
Authorization: Bearer <token>
```

**Permission**: `standards.view`

Returns which standards have been imported.

### 2.2 Search variables

```http
GET {API}/standards/variables/search?q=yield&standard=icasa&limit=25
Authorization: Bearer <token>
```

**Permission**: `standards.view`

| Query | Description |
|-------|-------------|
| `q` | Search term (name, definition) |
| `standard` | Filter to one standard |
| `limit` | Max results (default 25) |

### 2.3 Variable detail

```http
GET {API}/standards/variables/{variable_id}
Authorization: Bearer <token>
```

**Permission**: `standards.view`

### 2.4 Variable options

```http
GET {API}/standards/variables/{variable_id}/options
Authorization: Bearer <token>
```

**Permission**: `standards.view`

Returns the variable's coded values shaped as form options.

**200 OK**

```json
[
  { "value": "maize", "label": "Maize (Zea mays)" },
  { "value": "rice", "label": "Rice (Oryza sativa)" }
]
```

### 2.5 AI-enrich form

```http
POST {API}/standards/enrich
Authorization: Bearer <token>
Content-Type: application/json

{
  "form_json": { "...form definition..." },
  "prompt": "Map fields to ICASA variables where possible"
}
```

**Permission**: `standards.view`

Auto-attaches standard variable identifiers to a draft form's fields using AI
matching.

**200 OK**

```json
{
  "form_json": { "...updated definition with standard_id on matched fields..." },
  "attached": [
    { "field": "crop_name", "variable_id": "crid", "standard": "icasa", "confidence": 0.92 }
  ]
}
```

### 2.6 Match single field

```http
POST {API}/standards/match-field
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "grain_yield",
  "type": "number",
  "label": "Grain yield (kg/ha)"
}
```

**Permission**: `standards.view`

Returns match candidates with confidence scores and near misses.

### 2.7 Remove standard

```http
DELETE {API}/standards/{name}
Authorization: Bearer <token>
```

**Permission**: `standards.manage`

Removes an imported standard and all its variables.

### 2.8 Standard mapping for form

```http
GET {API}/standards/mapping/{form_id}
Authorization: Bearer <token>
```

**Permission**: `standards.view`

Returns the standard identifiers behind a form's tabular columns.

**200 OK**

```json
{
  "form_id": "FRM00012",
  "form_title": "Crop Survey",
  "version_no": 3,
  "table_name": "crop_survey_tabular",
  "columns": [
    { "column": "crop_name", "variable_id": "crid", "standard": "icasa" },
    { "column": "yield_kg", "variable_id": "hwam", "standard": "icasa" }
  ]
}
```

---

## 3. Standards browser (`/api/standards/browse`)

A unified tree view across all imported standards and ontologies.

### 3.1 Browse vocabularies

```http
GET {API}/standards/browse?p=icasa&p=management
Authorization: Bearer <token>
```

**Permission**: any authenticated user

Walk the standards tree. Each `p` query parameter is a path segment, drilling
deeper into the hierarchy.

**200 OK**

```json
{
  "path": ["icasa", "management"],
  "level": "group",
  "items": [
    { "id": "planting", "label": "Planting", "kind": "group", "children": 12 },
    { "id": "harvest", "label": "Harvest", "kind": "group", "children": 8 }
  ]
}
```

### 3.2 Locate item

```http
GET {API}/standards/browse/locate?kind=icasa&id=crid
Authorization: Bearer <token>
```

**Permission**: any authenticated user

Finds an item's path in the tree so the browser can expand to it.

| Query | Description |
|-------|-------------|
| `kind` | `icasa`, `seont`, or `crop` |
| `id` | Variable or concept id |
| `standard` | Standard name (for ICASA) |
| `uri` | URI (for SEOnt) |
| `ontology` | Ontology name (for Crop Ontology) |

**200 OK**

```json
{
  "path": ["icasa", "management", "planting", "crid"]
}
```

---

## 4. CIMMYT (`/api/standards/cimmyt`)

CIMMYT's Controlled Vocabulary for agricultural research variables.

### 4.1 List variables

```http
GET {API}/standards/cimmyt/variables?q=yield&limit=200
Authorization: Bearer <token>
```

**Permission**: `standards.view`

### 4.2 Create / edit variable

```http
POST {API}/standards/cimmyt/variables
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "GrainYield",
  "definition": "Total grain yield per plot",
  "data_type": "numeric",
  "unit": "kg/ha",
  "external_id": "CIMMYT_GY_001"
}
```

**Permission**: `standards.manage`

| Field | Required |
|-------|----------|
| `name` | Yes |
| `definition` | No |
| `data_type` | No |
| `unit` | No |
| `catalog_id` | No |
| `observation_entity` | No |
| `measurement_role` | No |
| `concept_id` | No |
| `method` | No |
| `status` | No |
| `version` | No |
| `external_id` | No |

### 4.3 Delete variable

```http
DELETE {API}/standards/cimmyt/variables/{external_id}
Authorization: Bearer <token>
```

**Permission**: `standards.manage`

Only manually-added variables can be deleted. Variables imported from a workbook
return **409 Conflict**.

### 4.4 Import workbook

```http
POST {API}/standards/cimmyt/import?version=2.0
Authorization: Bearer <token>
Content-Type: multipart/form-data

file: <cimmyt_cv.xlsx>
```

**Permission**: `standards.manage`

| Query | Description |
|-------|-------------|
| `version` | Version label for this import |

---

## 5. ISO 3166 (`/api/standards/iso3166`)

Country codes, used by form fields that need a country selector.

### 5.1 Summary

```http
GET {API}/standards/iso3166
Authorization: Bearer <token>
```

**Permission**: `standards.view` or `records.create`

### 5.2 List countries

```http
GET {API}/standards/iso3166/countries?q=uga&limit=10
Authorization: Bearer <token>
```

**Permission**: `standards.view` or `records.create`

### 5.3 Country detail

```http
GET {API}/standards/iso3166/countries/{code}
Authorization: Bearer <token>
```

**Permission**: `standards.view` or `records.create`

The `code` may be alpha-2 (`UG`), alpha-3 (`UGA`), or numeric (`800`).

### 5.4 Options for form fields

```http
GET {API}/standards/iso3166/options?code_type=alpha_2&q=uga
Authorization: Bearer <token>
```

**Permission**: `standards.view` or `records.create`

| Query | Description |
|-------|-------------|
| `code_type` | `alpha_2` (default), `alpha_3`, or `numeric` |
| `q` | Search filter |

**200 OK**

```json
[
  { "value": "UG", "label": "Uganda" },
  { "value": "KE", "label": "Kenya" }
]
```

---

## 6. Units (`/api/units`)

### 6.1 List units

```http
GET {API}/units
Authorization: Bearer <token>
```

**Permission**: `units.view`

**200 OK**

```json
{
  "units": [
    { "name": "kilogram", "symbol": "kg", "dimension": "mass" },
    { "name": "hectare", "symbol": "ha", "dimension": "area" }
  ]
}
```

### 6.2 Convert value

```http
POST {API}/units/convert
Authorization: Bearer <token>
Content-Type: application/json

{
  "value": 100,
  "from_unit": "kg",
  "to_unit": "lb"
}
```

**Permission**: `units.view`

**200 OK**

```json
{
  "value": 100,
  "from_unit": "kg",
  "to_unit": "lb",
  "result": 220.462
}
```

---

## 7. SEOnt Ontology (`/api/ontology`)

Socio-Economic Ontology — concepts for socio-economic survey variables.

### 7.1 Loaded ontologies

```http
GET {API}/ontology
Authorization: Bearer <token>
```

**Permission**: `ontology.view`

### 7.2 Search concepts

```http
GET {API}/ontology/search?q=income&ontology=seont&limit=25
Authorization: Bearer <token>
```

**Permission**: `ontology.view`

| Query | Description |
|-------|-------------|
| `q` | Search term |
| `ontology` | Filter to one ontology |
| `limit` | Max results (default 25) |

### 7.3 Concept detail

```http
GET {API}/ontology/{concept_id}
Authorization: Bearer <token>
```

**Permission**: `ontology.view`

### 7.4 Children

```http
GET {API}/ontology/{concept_id}/children
Authorization: Bearer <token>
```

**Permission**: `ontology.view`

Returns subclasses of the concept.

### 7.5 Concept options

```http
GET {API}/ontology/{concept_id}/options
Authorization: Bearer <token>
```

**Permission**: `ontology.view`

Children shaped as form options.

### 7.6 Remove ontology

```http
DELETE {API}/ontology/{ontology_name}
Authorization: Bearer <token>
```

**Permission**: `ontology.manage`

---

## 8. Crop Ontology (`/api/crop-ontology`)

Traits, methods, scales and variables from the Crop Ontology.

### 8.1 Loaded ontologies

```http
GET {API}/crop-ontology
Authorization: Bearer <token>
```

**Permission**: `crop_ontology.view`

### 8.2 Options for form fields

```http
GET {API}/crop-ontology/options?kind=crop&depends_on=CO_334
Authorization: Bearer <token>
```

**Permission**: `crop_ontology.view` or `records.create`

Dynamic options for cascading dropdowns (crop -> trait -> variable).

| Query | Description |
|-------|-------------|
| `kind` | `crop`, `trait`, or `variable` |
| `depends_on` | Parent selection (e.g. crop id for traits) |

### 8.3 Search variables

```http
GET {API}/crop-ontology/search?q=yield&crop=CO_334&limit=25
Authorization: Bearer <token>
```

**Permission**: `crop_ontology.view`

### 8.4 Search traits

```http
GET {API}/crop-ontology/traits?q=yield&crop=CO_334&limit=25
Authorization: Bearer <token>
```

**Permission**: `crop_ontology.view`

### 8.5 Trait detail

```http
GET {API}/crop-ontology/traits/{trait_id}
Authorization: Bearer <token>
```

**Permission**: `crop_ontology.view`

The `trait_id` is a path parameter (may contain slashes).

### 8.6 Variable options

```http
GET {API}/crop-ontology/variables/{variable_id}/options
Authorization: Bearer <token>
```

**Permission**: `crop_ontology.view`

Returns scale categories as form options.

### 8.7 Variable detail

```http
GET {API}/crop-ontology/variables/{variable_id}
Authorization: Bearer <token>
```

**Permission**: `crop_ontology.view`

Returns the variable with its trait, method, and scale.

### 8.8 Remove ontology

```http
DELETE {API}/crop-ontology/{ontology_id}
Authorization: Bearer <token>
```

**Permission**: `crop_ontology.manage`
