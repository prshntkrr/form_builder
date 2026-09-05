# MCDC API Gateway

The boundary that channel traffic crosses to get into this application.

| | Status |
|---|---|
| Routing allowlist, request validation, size limit, throttling, request ids, error contract, logging | **Implemented** and tested |
| Rate limit / body size / timeouts | **Configuration required** for production — defaults are development values |
| Shared rate-limit store | **Required before running more than one instance.** Today's limiter is per process |
| MCDC's own endpoint, auth and payload | **Depends on the external MCDC team** — see [EXPORT_API.md](EXPORT_API.md) |

---

## 1. Purpose

Channel traffic — a phone, a WhatsApp conversation, an IVR call — arrives from
outside, in volume, from clients we do not control. The gateway is where a
request is refused for being malformed, oversized or too frequent, **before**
anything expensive happens to it, and where every request gets an id, one error
shape and one safe log line.

It is not where anybody's permissions are decided. That is the application's,
and it stays there.

## 2. Architecture — and why there is no proxy

```
Mobile ──┐
WhatsApp ─┼──> GATEWAY (middleware) ──> the routes that already exist
IVR ─────┘         │                          │
                   │                    common ingestion
   request id ─────┤                          │
   allowlist ──────┤                    submission service
   size + JSON ────┤                          │
   throttle ───────┤                     Postgres / S3
   log + errors ───┘
```

**Everything a channel talks to is served by this same application.** MCDC calls
*in*; it is not called *out to*. A gateway that forwarded these requests over
HTTP would be this process talking to itself — a second set of timeouts, a
second thing to break, and a second place for a request to be dropped. So the
boundary is middleware in front of the routes that already exist.

There is no Kong, NGINX, Traefik or cloud gateway in this repository, and none
was added. The deployment is a single `uvicorn app.main:app`.

The one genuinely remote call this application makes is **outbound**, to MCDC,
from `connectors.py` — with its own timeout, its own retries and its own
failure record.

## 3. Responsibilities

| The gateway does | The application does |
|---|---|
| is this route one channels may use? | which form is this? |
| is the body JSON, an object, small enough? | is this answer required? |
| does the envelope look like a submission? | does a condition hide that question? |
| has this caller asked too often? | is that value in the catalogue? |
| a request id, one error shape, a safe log line | may this account fill this form? |
| | is the position inside the fence? |

The gateway answering the right-hand column would mean two places to change a
rule and one of them getting it wrong.

## 4. Authentication

Reused unchanged: the existing bearer token from `POST /api/auth/login`. No
second JWT, no second session store, no second credential type.

Refused with **401** and `AUTHENTICATION_REQUIRED`: no token, malformed token,
unknown token, a session that has been logged out or expired.

Refused with **403** and `FORBIDDEN`: authenticated, but the role lacks the
permission the route needs — `mcdc.manage` for the routing table, `mcdc.integrate`
for acting as the collection platform. Neither is granted to ordinary accounts.

Both bodies keep the application's existing `detail` field **and** add the
gateway's `error` object. Additive on purpose: every existing client — the web
application included — reads `detail`, and a boundary that renamed the field
would break the screens it exists to protect.

## 5. Authorization — the two identities

```
MCDC service token          ← proves the request came from the integration
        +
WhatsApp number / caller id ← says who the person is
        ↓
    channel_identity
        ↓
    application user
        ↓
project membership → form assignment → may_fill_form()
```

The service token alone fills nothing. A phone number alone is nobody. A
`form_id`, a keyword or an IVR digit alone grants nothing. The gateway does not
weaken any of that — it never inspects a role and never decides a form.

**A hole this work found and closed:** `_assigned_form_ids` returned forms
assigned "to everyone in the project" without checking the caller was *in* the
project. Every existing caller asked only after a membership check, so nothing
was exposed — but `/forms/{id}/published`, broadened for mobile two changes ago,
called it standalone and let an outsider read a project form's configuration.
The membership check now lives in the query, where a future caller cannot forget
it. `backend/tests/core/test_gateway.py::test_permission_is_still_the_applications_answer`
holds it.

## 6. Routing

An explicit allowlist of `(method, exact path pattern)` in `gateway.ROUTES`:

```
GET    /api/mcdc/forms                      GET  /api/forms/{id}/published
GET    /api/mcdc/whatsapp/routes            GET  /api/forms/{id}/relationship
GET    /api/mcdc/ivr/routes                 GET  /api/forms/{id}/parent-options
GET    /api/mcdc/routes                     POST /api/forms/{id}/submissions
POST   /api/mcdc/routes                     POST /api/forms/{id}/submissions/start
PUT    /api/mcdc/routes/{n}                 POST /api/forms/{id}/submissions/ingest
DELETE /api/mcdc/routes/{n}                 POST …/{survey}/media/upload-url
POST   /api/mcdc/identities                 POST …/{survey}/media/{id}/complete
                                            GET  …/{survey}/media
                                            GET  …/{survey}/media/{id}/url
```

Anything else under `/api/mcdc/` or `/api/forms/` → **404 `ROUTE_NOT_ALLOWED`**.

There is **no** `/gateway/{url}`, no destination in any request body, no upstream
host taken from a header. There is nothing to point anywhere: SSRF and open-proxy
abuse are impossible by construction, not by filtering. `form_id`, `survey_id`
and `media_id` are constrained character classes, so a traversal cannot match a
pattern whatever it is encoded as.

Form building, publishing, review, users, projects, catalogues and exports are
**outside** the boundary — administration is not channel traffic and is not
throttled as if it were.

## 7. Request validation

Method and path (allowlist) · `Content-Type: application/json` when there is a
body · body parses as JSON · body is an object · body under the size limit ·
`X-Request-ID` well-formed if given · `Idempotency-Key` well-formed if given.

Envelope only, for submissions: `channel` is one of web/mobile/whatsapp/ivr,
`form_version` is an integer, `survey_id` looks like one, `data` is an object.
**Not** required fields, conditions, catalogues, geofences or media — those
belong to the submission service and a copy here would be a second answer to
drift from the first.

## 8. Rate limiting

Sliding window, **per principal**, `429 RATE_LIMITED` with `Retry-After`.

The key is the **hashed bearer token plus the hashed channel identity**. A
collection platform holds one credential for thousands of callers, so counting
the credential alone would let one talkative caller spend everybody's allowance.
The token is hashed because a rate-limit key reaches a log line and a credential
must not. An unauthenticated request is counted by address.

> ### ⚠ Single process only
>
> `InMemoryRateLimiter` counts inside one Python process. The deployment today
> is one `uvicorn` with no `--workers`, so it is correct **now**.
>
> **It is not correct across instances.** Two would each count to the limit and
> let twice as much through. Before running `--workers > 1`, a second server or
> an autoscaling group, put a shared counter behind the `RateLimiter`
> abstraction — Redis, or a small Postgres table. Nothing else changes: one
> class, one line in `gateway.py`.
>
> Redis was **not** added. This project has none, and adding infrastructure for
> one feature that does not yet need it would be a cost with no buyer.

## 9. Request size

`MCDC_GATEWAY_MAX_BODY_MB` (default 5) → **413 `REQUEST_TOO_LARGE`**.

Control requests only. **Media never passes through the gateway**: the browser or
phone PUTs the file straight to S3 on a presigned URL, and only the small
`upload-url` / `complete` calls cross this boundary. The 25 MB media limit is
`MEDIA_MAX_MB`, enforced by the media service, and is unrelated to this one.

## 10. Timeouts

The gateway makes no outbound calls, so it has none to configure. The outbound
call this application does make — to MCDC — uses `MCDC_TIMEOUT` (total) and maps
a timeout to **502** with a retryable `FAILED` record.
`MCDC_GATEWAY_CONNECT_TIMEOUT` / `MCDC_GATEWAY_READ_TIMEOUT` are provided for a
client that wants the halves separately, and are unused until a connector needs
them.

## 11. Error contract

```json
{ "error": { "code": "RATE_LIMITED", "message": "Too many requests. Try again shortly." },
  "request_id": "9f2c4a…" }
```

| code | status |
|---|---|
| `AUTHENTICATION_REQUIRED` | 401 |
| `FORBIDDEN` | 403 |
| `ROUTE_NOT_ALLOWED` | 404 |
| `INVALID_REQUEST` | 400 / 415 |
| `REQUEST_TOO_LARGE` | 413 |
| `RATE_LIMITED` | 429 (with `Retry-After`) |

Application errors keep their existing shapes — 422 validation still answers
`{"detail": {"errors": {...}}}`, which is what every client already reads. No
stack trace, no SQL, no credential and no upstream body is ever echoed.

## 12. Request IDs

`X-Request-ID` on every response, guarded routes or not. A client's own is used
if it matches `[A-Za-z0-9._:-]{1,64}` — otherwise one is generated, so nobody can
write newlines into a log line and forge entries.

## 13. Logging

One structured line per guarded request: `request_id`, `method`, `path`,
`channel`, `form_id`, hashed `principal`, `status_code`, `latency_ms`,
`rate_limited`.

Never: `form_data`, any answer, the `Authorization` header, tokens, API keys,
media, or personal data. `form_data` is somebody's farm, their name and where
they live — it does not belong in a log file.
`test_nothing_anybody_answered_reaches_the_log` holds this.

## 14–17. The flows

**Mobile** — unchanged, and not forced through keyword routing:
`login → GET /api/mcdc/forms → GET /api/forms/{id}/published → fill →
[start → upload-url → PUT to S3 → complete] → POST /api/forms/{id}/submissions`

**WhatsApp** — `GET /api/mcdc/whatsapp/routes?keyword=…&identity=…` → a form id
(or `{"matched": false}`) → `POST …/submissions/ingest` with
`{"channel": "whatsapp", "channel_identity": "…", "payload": {"messages": […]}}`

**IVR** — the same with `?menu=1` and `{"digits": […]}`.

**All three** land in the same `_store()` → `submission_service.submit()` →
the form's own table, one survey-id sequence, one set of rules. There is no
mobile table, no WhatsApp table and no IVR pipeline;
`test_a_phone_and_the_web_app_write_the_same_rows` asserts no table matching
`%mobile%` exists.

## 18. Production configuration

```bash
MCDC_GATEWAY_ENABLED=true
MCDC_GATEWAY_MAX_BODY_MB=5
MCDC_GATEWAY_RATE_LIMIT=120          # per principal per window; 0 disables
MCDC_GATEWAY_RATE_WINDOW_SECONDS=60
MCDC_GATEWAY_CONNECT_TIMEOUT=5
MCDC_GATEWAY_READ_TIMEOUT=30
```

Defaults are development values. Before going live, size the rate limit against
what a real surveyor does — one submission with a photo is about five requests —
and set it high enough that ordinary work never sees a 429. CORS is unchanged
and is not an authentication mechanism; a native app is not subject to it at all.

## 19. Examples

```http
GET /api/mcdc/forms HTTP/1.1
Authorization: Bearer <token>
X-Request-ID: mobile-42:abc

200 OK
X-Request-ID: mobile-42:abc
Cache-Control: no-store
[ { "form_id": "FRM00030", "form_title": "Farmer Registration", "version": 3,
    "project_id": "PRJ00001", "project_name": "Mexico Maize" } ]
```

```http
POST /api/forms/FRM00030/submissions HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json

{ "channel": "mobile", "form_version": 3,
  "data": { "farmer_name": "Ramesh" },
  "location": { "latitude": 19.4326, "longitude": -99.1332 } }

201 Created  { "survey_id": "000001", … }
429 Too Many Requests
Retry-After: 43
{ "error": { "code": "RATE_LIMITED", "message": "Too many requests. Try again shortly." },
  "request_id": "9f2c4a…" }
```

## 20. External dependencies

Nothing in this gateway depends on MCDC existing. What still does — MCDC's
endpoint path, payload envelope, authentication scheme, response shape and error
meanings — is listed in [EXPORT_API.md](EXPORT_API.md#-what-needs-the-mcdc-team).
