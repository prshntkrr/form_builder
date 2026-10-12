# API Documentation Index

Complete API reference for the form builder platform, organised by module.
Each document is self-contained with endpoints, permissions, request/response
examples and error codes.

---

## Core

| Document | Module | Endpoints |
|----------|--------|-----------|
| [PLATFORM_API.md](PLATFORM_API.md) | Health, stats, field types | 3 |
| [AUTH_API.md](AUTH_API.md) | Authentication, users, roles | 19 |

## Forms

| Document | Module | Endpoints |
|----------|--------|-----------|
| [FORMS_API.md](FORMS_API.md) | Form builder — AI generation, CRUD, versioning, status, public sharing, export | ~28 |
| [SUBMISSIONS_API.md](SUBMISSIONS_API.md) | Submissions, records, media uploads, review workflow | ~25 |
| [STANDARD_FORMS_API.md](STANDARD_FORMS_API.md) | Standard forms library — browse, import, borrow | 8 |

## Channels

| Document | Module | Endpoints |
|----------|--------|-----------|
| [CHANNELS_API.md](CHANNELS_API.md) | MCDC routing, WhatsApp/IVR settings, webhooks, identities | ~25 |
| [MOBILE_API.md](../MOBILE_API.md) | Mobile app integration (developer handoff) | 10 |
| [EXPORT_API.md](../EXPORT_API.md) | Form export to MCDC | 3 |
| [MCDC_GATEWAY.md](../MCDC_GATEWAY.md) | Gateway middleware — rate limiting, request validation, error contract | — |

## Projects

| Document | Module | Endpoints |
|----------|--------|-----------|
| [PROJECTS_API.md](PROJECTS_API.md) | Projects, members, groups, form assignments | ~20 |

## Data

| Document | Module | Endpoints |
|----------|--------|-----------|
| [DASHBOARDS_API.md](DASHBOARDS_API.md) | Dashboard builder — AI generation, data queries, sharing | ~20 |
| [CATALOGS_API.md](CATALOGS_API.md) | Client catalogues — value lists for dropdowns | 9 |
| [EXTERNAL_DB_API.md](EXTERNAL_DB_API.md) | External database connections — Postgres, Databricks | 12 |

## Standards

| Document | Module | Endpoints |
|----------|--------|-----------|
| [STANDARDS_API.md](STANDARDS_API.md) | ICASA, Crop Ontology, CIMMYT, ISO 3166, Units, SEOnt | ~30 |

---

## Conventions across all endpoints

- **Authentication**: `Authorization: Bearer <token>` from `POST /api/auth/login`
- **Permissions**: every endpoint declares `Depends(needs(SOME_PERMISSION))`; authorisation is by permission, never by role name
- **IDs**: `FRM00030` (forms), `USR00012` (users), `ROL00003` (roles), `PRJ00001` (projects)
- **Errors**: 422 validation returns `{"detail": {"errors": {"field": "message"}}}`;
  gateway errors return `{"error": {"code": "...", "message": "..."}, "request_id": "..."}`
- **Request ID**: `X-Request-ID` header on every response; send your own or one is generated
- **Rate limiting**: per-principal sliding window; 429 with `Retry-After` header

Total: **~160 endpoints** across 12 documentation files.
