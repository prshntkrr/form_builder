"""The Picky Assist WhatsApp gateway: carrying messages, and nothing else.

    Picky Assist ──POST──> /api/integrations/whatsapp/webhook
                                    │
                                    │  identity, receiver, text
                                    v
                           whatsapp_runtime.reply
                                    │
                                    │  the text to send back
                                    v
                           Picky Assist push API

Deliberately thin. What a keyword means, who may use it, what a reply means,
whether it is acceptable and how it is stored are all decided elsewhere — by
`routing`, `ingestion` and `submission_service`, which are the same
implementations the mobile and web paths use. This file knows two things
nothing else should: the shape of a Picky Assist payload, and the URL its push
API lives at. Swapping providers is this file.

The credential is not here either. It is in `channel_settings`, sealed with
`app/core/secrets.py`, read at the moment of the call and never logged. A
hard-coded token in this file was how it was done first; it is in version
control forever, and rotating it meant a deployment.

**The endpoint is unauthenticated**, because a provider posts to it. That is
safe only because it grants nothing: a phone number is not an account, and the
runtime resolves it through `channel_identity` before anything at all is
offered. An unrecognised number is told exactly what an unknown keyword is told.
"""
import asyncio
import logging
import urllib.parse
from typing import Any, Dict, Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Request

from app.modules.forms import channel_settings, whatsapp_runtime, whatsapp_session

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/integrations/whatsapp", tags=["whatsapp-webhook"])

PUSH_API_URL = "https://app.pickyassist.com/api/v2/push"
PUSH_TIMEOUT_SECONDS = 30

#: How often the sweep looks for conversations nobody came back to. The
#: timeout itself is per project (`channel_settings`); this is only how often
#: the clock is read.
SWEEP_SECONDS = 60

_sweeper: Optional[asyncio.Task] = None


# --------------------------------------------------------------------------- #
# sending
# --------------------------------------------------------------------------- #
async def send(number: str, message: str, application: Any,
               project_id: Optional[str] = None) -> None:
    """One message out, on the account configured for this scope.

    The token is fetched here rather than held anywhere: rotating it in the
    settings screen takes effect on the next message without a restart. It is
    never logged — not at debug, not in an error — and the message body is
    logged by length only, because it quotes back what somebody answered.
    """
    token = channel_settings.token(project_id)
    if not token:
        logger.error(
            "No WhatsApp token configured for %s, so nothing can be sent. "
            "Set one in Channel routing → WhatsApp → Settings.",
            project_id or "the system")
        return

    payload = {
        "token": token,
        "application": application,
        "data": [{"number": number, "message": message}],
    }

    try:
        async with httpx.AsyncClient(timeout=PUSH_TIMEOUT_SECONDS) as client:
            response = await client.post(PUSH_API_URL, json=payload)
        logger.info("WhatsApp push to %s: %s (%d chars)",
                    _masked(number), response.status_code, len(message))
    except Exception:
        # Never `logger.exception(payload)` — the token is in it.
        logger.exception("WhatsApp push to %s failed", _masked(number))


def _masked(number: str) -> str:
    """A number in a log line: enough to correlate, not enough to dial."""
    digits = "".join(c for c in str(number or "") if c.isdigit())
    return f"…{digits[-4:]}" if len(digits) >= 4 else "…"


# --------------------------------------------------------------------------- #
# the sweep
# --------------------------------------------------------------------------- #
async def _sweep_loop() -> None:
    """End the conversations nobody came back to.

    `whatsapp_session.live` already expires one on the way in, so this is only
    for the sessions that get no further message — without it, an abandoned
    conversation would keep its partial answers unstored indefinitely.
    """
    logger.info("WhatsApp session sweep started")
    while True:
        try:
            await asyncio.sleep(SWEEP_SECONDS)
            expired = await asyncio.to_thread(whatsapp_session.expire_due)
            if expired:
                logger.info("Expired %d idle WhatsApp session(s)", expired)
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("The WhatsApp session sweep failed")


def _ensure_sweeping() -> None:
    global _sweeper
    if _sweeper is None or _sweeper.done():
        try:
            _sweeper = asyncio.get_running_loop().create_task(_sweep_loop())
        except RuntimeError:
            pass                     # no loop (a test, a script): nothing to sweep


# --------------------------------------------------------------------------- #
# the webhook
# --------------------------------------------------------------------------- #
def _read(body: Dict[str, Any]) -> Dict[str, str]:
    """A Picky Assist delivery, in the three things the runtime needs.

    Several spellings because the provider's payload differs between its
    versions and its test console. Unknown keys are ignored rather than
    rejected: a webhook that 400s makes a provider retry forever.
    """
    sender = str(body.get("number") or body.get("sender") or "").strip()
    receiver = str(body.get("receiver") or body.get("to") or "").strip()
    raw = str(body.get("message-in") or body.get("text")
              or body.get("message") or "").strip()

    return {
        "identity": sender,
        "receiver": receiver,
        # Picky Assist form-encodes the body, so "+" arrives for a space.
        "text": urllib.parse.unquote_plus(raw),
        "application": body.get("application") or 121,
    }


@router.post("/webhook")
async def webhook(request: Request, background: BackgroundTasks):
    """One inbound WhatsApp message.

    Answers 200 immediately whatever happens, and sends the reply in the
    background: a provider that does not hear back quickly redelivers, and a
    redelivery of a message already handled would be a second answer to the same
    question. The idempotency that protects the *submission* is the session id;
    this is what protects the conversation.
    """
    _ensure_sweeping()

    try:
        body = await request.json()
    except Exception:
        body = {}

    message = _read(body)
    if not message["identity"] or not message["text"]:
        return {"status": "ok"}

    logger.info("WhatsApp in from %s on %s (%d chars)",
                _masked(message["identity"]), _masked(message["receiver"]),
                len(message["text"]))

    try:
        answer = await asyncio.to_thread(
            whatsapp_runtime.reply,
            message["identity"], message["receiver"], message["text"])
    except Exception:
        logger.exception("The WhatsApp conversation failed for %s",
                         _masked(message["identity"]))
        answer = ("Sorry, something went wrong. Please try again in a "
                  "moment.")

    if answer:
        background.add_task(send, message["identity"], answer,
                            message["application"], _scope_of(message["identity"]))

    return {"status": "ok"}


def _scope_of(identity: str) -> Optional[str]:
    """Which project's Picky Assist account to answer on.

    The conversation's own, when there is one — a reply about a project's form
    goes out on that project's account. Otherwise the system account, which is
    what an unrecognised number and a menu are answered on.
    """
    try:
        session = whatsapp_session.live(identity) \
            or whatsapp_session.recently_finished(identity)
        return session.get("project_id") if session else None
    except Exception:
        logger.exception("Could not tell which account to answer %s on",
                         _masked(identity))
        return None
