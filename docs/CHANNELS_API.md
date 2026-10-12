# Channels API — MCDC Routing, WhatsApp, IVR

API documentation for channel routing and integration: connecting forms to
WhatsApp keywords, IVR menus, and managing the settings that make each channel
work. The mobile channel's own contract is in `MOBILE_API.md`.

Base URL: `{API}` = `https://<your-server>/api`

---

## 1. Authentication

All `/api/mcdc/` endpoints require a session token except the webhook
endpoints under `/api/integrations/`, which are called by external services
and carry no session.

**Gateway note**: every path under `/api/mcdc/` must be listed in
`core/gateway.py`'s `ROUTES` allowlist. A correctly declared route that is not
in the allowlist returns **404** before it reaches the router.

---

## 2. Mobile form list

```http
GET {API}/mcdc/forms?project=PRJ00001&identity=+256700000000
Authorization: Bearer <token>
```

**Permission**: `records.view`

Returns the forms the authenticated account may fill on mobile.

| Query | Description |
|-------|-------------|
| `project` | Filter to one project |
| `identity` | Phone number (resolves account via `channel_identity`) |

---

## 3. Route management

Routes connect a channel-specific key (a WhatsApp keyword, an IVR menu option)
to a form.

### 3.1 List all routes

```http
GET {API}/mcdc/routes?project=PRJ00001&channel=whatsapp
Authorization: Bearer <token>
```

**Permission**: `mcdc.manage`

**200 OK**

```json
{
  "routes": [
    {
      "route_id": 1,
      "channel": "whatsapp",
      "route_key": "SURVEY",
      "form_id": "FRM00012",
      "project_id": "PRJ00001",
      "enabled": true,
      "receiver_number": "+256700000000",
      "metadata": {}
    }
  ],
  "channels": ["whatsapp", "ivr"]
}
```

### 3.2 Create route

```http
POST {API}/mcdc/routes
Authorization: Bearer <token>
Content-Type: application/json

{
  "channel": "whatsapp",
  "route_key": "SURVEY",
  "form_id": "FRM00012",
  "project_id": "PRJ00001",
  "enabled": true,
  "receiver_number": "+256700000000"
}
```

**Permission**: `mcdc.manage`

**201 Created**

| Field | Required | Default |
|-------|----------|---------|
| `channel` | Yes | — |
| `route_key` | Yes | — |
| `form_id` | Yes | — |
| `project_id` | No | `null` |
| `enabled` | No | `true` |
| `metadata` | No | `{}` |
| `receiver_number` | No | `""` |

A route may be created against a draft form — it is stored switched off until
the form goes Active.

### 3.3 Update route

```http
PUT {API}/mcdc/routes/{route_id}
Authorization: Bearer <token>
Content-Type: application/json

{
  "channel": "whatsapp",
  "route_key": "SURVEY2",
  "form_id": "FRM00012",
  "enabled": true
}
```

**Permission**: `mcdc.manage`

### 3.4 Delete route

```http
DELETE {API}/mcdc/routes/{route_id}
Authorization: Bearer <token>
```

**Permission**: `mcdc.manage`

**200 OK**

```json
{ "route_id": 1, "deleted": true }
```

---

## 4. WhatsApp

### 4.1 Resolve keyword

```http
GET {API}/mcdc/whatsapp/routes?keyword=SURVEY&identity=+256700000000&receiver=+256800000000
Authorization: Bearer <token>
```

**Permission**: `mcdc.integrate`

Resolves a keyword to a form, running the same scope and eligibility checks the
runtime uses. An unlinked number and an unknown keyword get the same response —
telling them apart would turn the keyword space into a directory.

### 4.2 Form's WhatsApp route

```http
GET {API}/mcdc/forms/{form_id}/whatsapp-route
Authorization: Bearer <token>
```

**Permission**: `mcdc.manage`

**200 OK**

```json
{
  "route": {
    "route_id": 1,
    "keyword": "SURVEY",
    "receiver_number": "+256700000000",
    "enabled": true
  }
}
```

### 4.3 Save form's WhatsApp route

```http
PUT {API}/mcdc/forms/{form_id}/whatsapp-route
Authorization: Bearer <token>
Content-Type: application/json

{
  "keyword": "SURVEY",
  "receiver_number": "+256700000000",
  "enabled": true
}
```

**Permission**: `mcdc.manage`

Creates or updates the WhatsApp route for the form. This is the same
`channel_form_route` row that the route list edits — by form rather than by
route id.

### 4.4 WhatsApp settings

```http
GET {API}/mcdc/whatsapp/settings?project=PRJ00001
Authorization: Bearer <token>
```

**Permission**: `mcdc.manage`

Returns session timeout and a masked token hint (never the full credential).

```http
PUT {API}/mcdc/whatsapp/settings?project=PRJ00001
Authorization: Bearer <token>
Content-Type: application/json

{
  "session_timeout_seconds": 3600,
  "api_token": "picky_assist_token_here"
}
```

**Permission**: `mcdc.manage`

The token is sealed with `core/secrets.py` before storage. Omitting `api_token`
keeps the existing credential.

---

## 5. Webhooks

Webhook entries let a single server receive inbound messages from multiple
Picky Assist accounts, each with its own token.

### 5.1 List webhooks

```http
GET {API}/mcdc/whatsapp/webhooks?project=PRJ00001
Authorization: Bearer <token>
```

**Permission**: `mcdc.manage`

**200 OK**

```json
{
  "webhooks": [
    {
      "webhook_id": 1,
      "label": "Production",
      "project_id": "PRJ00001",
      "enabled": true,
      "webhook_url": "https://<server>/api/integrations/whatsapp/webhook/1"
    }
  ]
}
```

### 5.2 Create webhook

```http
POST {API}/mcdc/whatsapp/webhooks
Authorization: Bearer <token>
Content-Type: application/json

{
  "label": "Production",
  "project_id": "PRJ00001",
  "api_token": "picky_assist_token",
  "enabled": true
}
```

**Permission**: `mcdc.manage`

**201 Created**

### 5.3 Update webhook

```http
PUT {API}/mcdc/whatsapp/webhooks/{webhook_id}
Authorization: Bearer <token>
Content-Type: application/json

{
  "label": "Production (updated)",
  "enabled": false
}
```

**Permission**: `mcdc.manage`

### 5.4 Delete webhook

```http
DELETE {API}/mcdc/whatsapp/webhooks/{webhook_id}
Authorization: Bearer <token>
```

**Permission**: `mcdc.manage`

**200 OK**

```json
{ "webhook_id": 1, "deleted": true }
```

---

## 6. IVR

### 6.1 Resolve IVR menu

```http
GET {API}/mcdc/ivr/routes?menu=1&identity=+256700000000
Authorization: Bearer <token>
```

**Permission**: `mcdc.integrate`

### 6.2 IVR settings

```http
GET {API}/mcdc/ivr/settings?project=PRJ00001
PUT {API}/mcdc/ivr/settings?project=PRJ00001
Authorization: Bearer <token>
```

**Permission**: `mcdc.manage`

Same shape as WhatsApp settings (`session_timeout_seconds`, `api_token`).

---

## 7. Sarvam AI (speech-to-text)

```http
GET {API}/mcdc/sarvam/settings?project=PRJ00001
PUT {API}/mcdc/sarvam/settings?project=PRJ00001
Authorization: Bearer <token>
```

**Permission**: `mcdc.manage`

Same shape as WhatsApp settings. The token is the Sarvam AI API key used for
IVR transcription.

---

## 8. Channel identity

```http
POST {API}/mcdc/identities
Authorization: Bearer <token>
Content-Type: application/json

{
  "channel": "whatsapp",
  "identity": "+256700000000",
  "user_id": "USR00012"
}
```

**Permission**: `mcdc.manage`

Links a phone number to a user account. A phone number is not an account — the
runtime resolves it through `channel_identity` before anything is offered.

**201 Created**

```json
{
  "channel": "whatsapp",
  "identity": "+256700000000",
  "user_id": "USR00012"
}
```

---

## 9. Inbound webhooks (no auth)

These endpoints are called by external services. They carry no session token.

### 9.1 WhatsApp (Picky Assist)

```http
POST {API}/integrations/whatsapp/webhook
POST {API}/integrations/whatsapp/webhook/{webhook_id}
```

Receives a Picky Assist payload. The router is transport only — it extracts
`identity`, `receiver`, and `text`, hands them to `whatsapp_runtime.reply()`,
and returns the response text to be pushed back via the Picky Assist API.

The per-webhook variant (`/{webhook_id}`) uses that webhook's own API token.

### 9.2 IVR

```http
POST {API}/integrations/ivr/webhook
```

Receives a telephony provider's call/DTMF payload. The adapter normalises it
and hands it to `ivr_runtime.reply()`, returning a TTS response. Voice
transcription uses the Sarvam AI API when configured.
