"""The boundary that channel traffic crosses to get in.

    Mobile ─┐
  WhatsApp ─┼─> GATEWAY ─> the routes that already exist
       IVR ─┘      │
                   ├─ a request id, on every answer
                   ├─ is this route one channels may use at all?
                   ├─ is the body a sane size, and JSON?
                   ├─ has this caller asked too often?
                   └─ one error shape, one log line, no secrets

**Not a proxy.** Everything a channel talks to is served by this same
application: MCDC calls in, it is not called out to. A gateway that forwarded
these requests over HTTP would be this process talking to itself, with a second
set of timeouts and a second thing to break. So this is middleware in front of
the routes that already exist — the same boundary, without the round trip. The
one genuinely remote thing, MCDC itself, is called by `connectors.py` and has
its own timeout.

What it deliberately does **not** do is decide anything about a form. Whether an
account may fill one is `may_fill_form`, in the handler, as it already was: this
answers "may this request enter the system at all", never "is this submission
valid" and never "is this person allowed". Two questions, two places, and the
gateway is not allowed to have an opinion about the second.

`ROUTES` is an allowlist of exact patterns. There is no `/gateway/{url}`, no
destination in a request, nothing to point somewhere it was not meant to go —
a path that does not match one of these, under a guarded prefix, is refused
rather than passed along.
"""
import hashlib
import json
import logging
import re
import time
import uuid
from collections import defaultdict, deque
from typing import Deque, Dict, Optional, Tuple

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.config import settings

logger = logging.getLogger("gateway")

# The traffic this boundary is for: collecting answers, and the channel plumbing
# around it. Building, publishing, reviewing, managing users and projects are
# ordinary administration and stay outside — they are not channel traffic, and
# putting them behind a channel's throttle would be throttling the office.
#
# `/api/mcdc/` is a namespace of its own, so everything under it is guarded and
# anything unrecognised in it is refused. The collection routes live among the
# builder's own under `/api/forms/`, so those are guarded one at a time, by the
# same patterns that allow them — guarding the whole prefix would have put the
# builder behind a channel's throttle and refused every route not listed here.
GUARDED_PREFIXES = ("/api/mcdc/",)

# What a channel may reach, exactly. Anything else under a guarded prefix is
# ROUTE_NOT_ALLOWED — including anything a path tried to sneak in with `..`,
# which cannot match these patterns whatever it is encoded as.
FORM_ID = r"[A-Za-z0-9_-]{1,20}"
SURVEY_ID = r"[A-Za-z0-9_-]{1,50}"
MEDIA_ID = r"[A-Za-z0-9]{1,40}"

ROUTES: Tuple[Tuple[str, str], ...] = (
    # Which form does this channel mean, and what may this account fill in.
    ("GET", r"/api/mcdc/forms"),
    ("GET", r"/api/mcdc/whatsapp/routes"),
    ("GET", r"/api/mcdc/ivr/routes"),
    # Managing the routing table is administration; it is here because it lives
    # under the same prefix, and it is guarded the same way.
    ("GET", r"/api/mcdc/routes"),
    ("POST", r"/api/mcdc/routes"),
    ("PUT", rf"/api/mcdc/routes/\d+"),
    ("DELETE", rf"/api/mcdc/routes/\d+"),
    ("POST", r"/api/mcdc/identities"),

    # Collecting: the published configuration, then the submission.
    ("GET", r"/api/forms/live/list"),
    ("GET", rf"/api/forms/{FORM_ID}/published"),
    ("GET", rf"/api/forms/{FORM_ID}/render"),
    ("GET", rf"/api/forms/{FORM_ID}/relationship"),
    ("GET", rf"/api/forms/{FORM_ID}/parent-options"),
    ("POST", rf"/api/forms/{FORM_ID}/submissions"),
    ("POST", rf"/api/forms/{FORM_ID}/submissions/start"),
    ("POST", rf"/api/forms/{FORM_ID}/submissions/ingest"),

    # Media: the control requests only. The bytes go straight to S3 on a
    # presigned URL and never pass through here — a gateway that proxied
    # uploads would be a gateway that has to hold a 25 MB photo in memory.
    ("POST", rf"/api/forms/{FORM_ID}/submissions/{SURVEY_ID}/media/upload-url"),
    ("POST", rf"/api/forms/{FORM_ID}/submissions/{SURVEY_ID}/media/{MEDIA_ID}/complete"),
    ("GET", rf"/api/forms/{FORM_ID}/submissions/{SURVEY_ID}/media"),
    ("GET", rf"/api/forms/{FORM_ID}/submissions/{SURVEY_ID}/media/{MEDIA_ID}/url"),
)

_COMPILED = tuple((method, re.compile(f"^{pattern}$")) for method, pattern in ROUTES)

# Which paths are collection traffic *at all*, before asking whether they are
# allowed. Deliberately loose about the ids: `/api/forms/whatever/submissions`
# is a submission attempt however badly the id is spelled, and it should be
# refused here rather than reaching a handler to be looked up. The strict
# patterns above then decide. Everything else under `/api/forms/` — the
# builder's own routes — is ordinary application traffic and never comes near
# this boundary.
COLLECTION_SHAPES = tuple((method, re.compile(pattern)) for method, pattern in (
    ("GET", r"^/api/forms/live/list$"),
    ("GET", r"^/api/forms/[^/]+/(published|render|relationship|parent-options)$"),
    # Writing a submission, starting one, sending one in from a channel, and
    # the media control calls that hang off one.
    ("POST", r"^/api/forms/[^/]+/submissions(/|$)"),
    ("GET", r"^/api/forms/[^/]+/submissions/[^/]+/media(/|$)"),
))

# A request id from a client is used, but only if it looks like one: anything
# else would be somebody else's text in our log lines.
REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")

# Channel names the boundary recognises. What each one *means* is the ingestion
# module's business; this only refuses a word that is not one of them.
CHANNELS = ("web", "mobile", "whatsapp", "ivr")


class GatewayError(Exception):
    """A request that will not be let in. `code` is the client's to act on."""

    def __init__(self, status: int, code: str, message: str,
                 headers: Optional[Dict[str, str]] = None):
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers or {}
        super().__init__(message)


# --------------------------------------------------------------------------- #
# how often one caller may ask
# --------------------------------------------------------------------------- #
class RateLimiter:
    """How often one principal may ask. Per principal, never globally.

    One busy surveyor must not throttle every other surveyor, and one chatty
    WhatsApp caller must not throttle the platform they arrived through — which
    is why the key below is the credential *and* the person behind it.
    """

    def check(self, key: str) -> Optional[int]:
        """None if the request may proceed, or the seconds until it may."""
        raise NotImplementedError


class InMemoryRateLimiter(RateLimiter):
    """A sliding window per principal, in this process.

    Correct for a single process, which is what this application is deployed as
    today (one uvicorn, no `--workers`). It is **not** correct across several:
    two instances would each count to the limit and let twice as much through.

    That is a deployment decision rather than a code one, so the abstraction is
    here and the note is in MCDC_GATEWAY.md: before running more than one
    instance, put a shared counter behind `RateLimiter` — Redis, or the
    database. Nothing else has to change.
    """

    def __init__(self):
        self._seen: Dict[str, Deque[float]] = defaultdict(deque)

    def check(self, key: str) -> Optional[int]:
        limit = settings.mcdc_gateway_rate_limit
        window = settings.mcdc_gateway_rate_window_seconds
        if limit <= 0:
            return None

        now = time.monotonic()
        asked = self._seen[key]
        while asked and now - asked[0] >= window:
            asked.popleft()

        if len(asked) >= limit:
            return max(1, int(window - (now - asked[0])) + 1)

        asked.append(now)
        # A key nobody has used for a while is not worth remembering.
        if len(self._seen) > 10_000:
            for stale in [k for k, v in self._seen.items() if not v][:5_000]:
                self._seen.pop(stale, None)
        return None

    def forget(self) -> None:
        self._seen.clear()


limiter: RateLimiter = InMemoryRateLimiter()


# --------------------------------------------------------------------------- #
# who is asking
# --------------------------------------------------------------------------- #
def principal(request: Request, body: Optional[dict]) -> str:
    """What the throttle counts against.

    The token, and the person on the other end of it. A collection platform
    holds one credential for thousands of callers, so counting the credential
    alone would let one talkative caller use up everybody's allowance. The token
    is hashed: a rate-limit key is not a place to keep a credential, and this
    one reaches a log line.

    An unauthenticated request is counted by address, which is all there is to
    count — it is refused by the handler anyway, and this keeps the refusing
    cheap.
    """
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        who = "t:" + hashlib.sha256(header[7:].strip().encode()).hexdigest()[:16]
    else:
        who = "ip:" + (request.client.host if request.client else "unknown")

    caller = (request.query_params.get("identity")
              or (body or {}).get("channel_identity"))
    if caller:
        who += ":" + hashlib.sha256(str(caller).encode()).hexdigest()[:12]
    return who


# --------------------------------------------------------------------------- #
# what the boundary checks
# --------------------------------------------------------------------------- #
def _route_allowed(method: str, path: str) -> bool:
    return any(m == method and pattern.match(path) for m, pattern in _COMPILED)


def _check_request_id(raw: Optional[str]) -> str:
    if raw and REQUEST_ID.match(raw):
        return raw
    return uuid.uuid4().hex


def _check_body(raw: bytes, content_type: str) -> Optional[dict]:
    """Sane size, and JSON that parses. Nothing about what the JSON means."""
    limit = settings.mcdc_gateway_max_body_mb * 1024 * 1024
    if len(raw) > limit:
        raise GatewayError(
            413, "REQUEST_TOO_LARGE",
            f"The request body is larger than {settings.mcdc_gateway_max_body_mb} MB. "
            "Files are uploaded straight to storage on a presigned URL, not through "
            "this endpoint.")

    if not raw:
        return None

    if "application/json" not in (content_type or "").lower():
        raise GatewayError(415, "INVALID_REQUEST",
                           "This endpoint takes application/json.")

    try:
        body = json.loads(raw)
    except ValueError:
        raise GatewayError(400, "INVALID_REQUEST", "The request body is not valid JSON.")

    if not isinstance(body, dict):
        raise GatewayError(400, "INVALID_REQUEST", "The request body must be an object.")
    return body


def _check_envelope(body: Optional[dict]) -> None:
    """The shape of a submission, not its contents.

    Whether an answer is required, in a catalogue, inside the fence — all of
    that belongs to the submission service and stays there. This is only what
    would have to be true of *any* submission for the request to be worth
    passing on.
    """
    if not body:
        return

    channel = body.get("channel")
    if channel is not None and channel not in CHANNELS:
        raise GatewayError(400, "INVALID_REQUEST",
                           f"'{channel}' is not a channel. Use one of: "
                           f"{', '.join(CHANNELS)}.")

    version = body.get("form_version")
    if version is not None and (isinstance(version, bool) or not isinstance(version, int)):
        raise GatewayError(400, "INVALID_REQUEST", "form_version is a whole number.")

    survey_id = body.get("survey_id")
    if survey_id is not None and not re.match(f"^{SURVEY_ID}$", str(survey_id)):
        raise GatewayError(400, "INVALID_REQUEST", "That is not a survey id.")

    if "data" in body and not isinstance(body["data"], dict):
        raise GatewayError(400, "INVALID_REQUEST", "'data' is an object of answers.")


def _check_idempotency(request: Request) -> None:
    """A caller's own idempotency key, if it sent one.

    Checked for shape only, and never rewritten: a key is the caller's name for
    its own operation, and quietly replacing it would break the retry it exists
    for. It is also namespaced by the principal downstream, so one caller cannot
    reach into another's.
    """
    key = request.headers.get("idempotency-key")
    if key is not None and not REQUEST_ID.match(key):
        raise GatewayError(400, "INVALID_REQUEST",
                           "Idempotency-Key must be up to 64 characters of "
                           "letters, digits, dot, dash, colon or underscore.")


# --------------------------------------------------------------------------- #
# the middleware
# --------------------------------------------------------------------------- #
def _error(status: int, code: str, message: str, request_id: str,
           headers: Optional[Dict[str, str]] = None) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message}, "request_id": request_id},
        headers={"X-Request-ID": request_id, "Cache-Control": "no-store",
                 **(headers or {})},
    )


class GatewayMiddleware(BaseHTTPMiddleware):
    """Everything above, in front of the routes that already exist."""

    async def dispatch(self, request: Request, call_next):
        request_id = _check_request_id(request.headers.get("x-request-id"))
        path = request.url.path

        guarded = settings.mcdc_gateway_enabled and (
            any(path.startswith(p) for p in GUARDED_PREFIXES)
            or any(m == request.method and shape.match(path)
                   for m, shape in COLLECTION_SHAPES))
        if not guarded:
            answer = await call_next(request)
            answer.headers.setdefault("X-Request-ID", request_id)
            return answer

        started = time.monotonic()
        body: Optional[dict] = None

        try:
            if not _route_allowed(request.method, path):
                raise GatewayError(404, "ROUTE_NOT_ALLOWED",
                                   "That is not something this endpoint serves.")

            raw = await request.body()
            body = _check_body(raw, request.headers.get("content-type", ""))
            _check_envelope(body)
            _check_idempotency(request)

            wait = limiter.check(principal(request, body))
            if wait is not None:
                raise GatewayError(
                    429, "RATE_LIMITED",
                    "Too many requests. Try again shortly.",
                    headers={"Retry-After": str(wait)})

        except GatewayError as refused:
            _log(request, request_id, refused.status, started, body,
                 rate_limited=refused.code == "RATE_LIMITED")
            return _error(refused.status, refused.code, refused.message,
                          request_id, refused.headers)

        answer = await call_next(request)
        if answer.status_code in (401, 403):
            answer = await _with_error_code(answer, request_id)
        answer.headers["X-Request-ID"] = request_id
        answer.headers.setdefault("Cache-Control", "no-store")
        _log(request, request_id, answer.status_code, started, body)
        return answer


async def _with_error_code(answer, request_id: str):
    """Give a refusal from the application the gateway's error shape too.

    Added beside `detail`, never instead of it: every existing client — the web
    application included — reads `detail`, and a boundary that renamed the field
    would break the screens it is supposed to be protecting. So a refusal now
    carries both, and a client can read whichever it knows about.

    Only 401 and 403, only on guarded routes, and only bodies small enough to
    be an error in the first place.
    """
    body = b""
    async for chunk in answer.body_iterator:
        body += chunk
        if len(body) > 8192:                 # not an error message any more
            return _raw(answer, body, request_id)

    try:
        parsed = json.loads(body)
    except ValueError:
        return _raw(answer, body, request_id)

    if not isinstance(parsed, dict) or "detail" not in parsed:
        return _raw(answer, body, request_id)

    detail = parsed["detail"]
    code = ("AUTHENTICATION_REQUIRED" if answer.status_code == 401 else "FORBIDDEN")
    return JSONResponse(
        status_code=answer.status_code,
        content={**parsed,
                 "error": {"code": code,
                           "message": detail if isinstance(detail, str)
                           else "This request was refused."},
                 "request_id": request_id},
        headers={k: v for k, v in answer.headers.items()
                 if k.lower() not in ("content-length", "content-type")},
    )


def _raw(answer, body: bytes, request_id: str):
    from starlette.responses import Response

    return Response(content=body, status_code=answer.status_code,
                    headers={k: v for k, v in answer.headers.items()
                             if k.lower() != "content-length"},
                    media_type=answer.media_type)


def _log(request: Request, request_id: str, status: int, started: float,
         body: Optional[dict], rate_limited: bool = False) -> None:
    """One line per request, and nothing anybody answered.

    Deliberately narrow. `form_data` is somebody's farm, their name and where
    they live; it does not belong in a log file, and neither does the token that
    carried it. What is here is what an operator needs to find one request
    again: what was asked, how it went, how long it took, and a hashed principal
    to tell one caller from another without naming either.
    """
    logger.info(
        "gateway %s",
        {
            "request_id": request_id,
            "method": request.method,
            "path": request.url.path,
            "channel": (body or {}).get("channel"),
            "form_id": _form_id_of(request.url.path),
            "principal": principal(request, body),
            "status_code": status,
            "latency_ms": int((time.monotonic() - started) * 1000),
            "rate_limited": rate_limited,
        },
    )


def _form_id_of(path: str) -> Optional[str]:
    found = re.match(rf"^/api/forms/({FORM_ID})/", path)
    return found.group(1) if found else None
