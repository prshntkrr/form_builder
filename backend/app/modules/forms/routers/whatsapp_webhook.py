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

from app.modules.forms import (
    channel_settings, routing, whatsapp_runtime, whatsapp_session,
)

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
# How an interactive message is asked for, in Picky Assist's own vocabulary.
#
# ⚠️ **Unverified against Picky Assist's documentation.** Nothing in this
# repository described their interactive payload, so these three keys are the
# one guess in the file. If buttons do not appear, this mapping is the only
# thing to correct — the conversation above it decides *what* to offer and is
# provider-agnostic.
#
# It is written to be safe when wrong: `message` always carries the choices
# numbered in the text (see `whatsapp_runtime.say`), so a provider that ignores
# these keys sends a question that can still be answered by replying with a
# number. That is exactly the behaviour this replaced, so the worst case is no
# worse than before.
PICKY_INTERACTIVE = {"buttons": "button", "list": "list"}
#: WhatsApp's own limits on what it will render. Beyond them it refuses the
#: message outright, so the numbered text is sent on its own instead.
MAX_BUTTON_TITLE = 20
MAX_ROW_TITLE = 24


def _interactive(message: Dict[str, Any]) -> Dict[str, Any]:
    """The provider-specific half of one outgoing message, or nothing.

    Nothing for a plain message, and nothing when a title is too long for
    WhatsApp to render — a refused interactive message would lose the question
    altogether, and the numbered text says the same thing.
    """
    kind = PICKY_INTERACTIVE.get(message.get("interaction") or "")
    choices = message.get("choices") or []
    if not kind or not choices:
        return {}

    limit = MAX_BUTTON_TITLE if kind == "button" else MAX_ROW_TITLE
    if any(len(str(label)) > limit for label, _ in choices):
        logger.info("Choices too long for a %s; sending the numbered text", kind)
        return {}

    return {
        "type": kind,
        # The id is the option's own value, so a tapped choice comes back as
        # the thing that gets stored rather than as something to map again.
        "options": [{"id": str(value), "title": str(label)}
                    for label, value in choices],
        "header": message.get("title") or "",
    }


async def send(number: str, message: Any, application: Any,
               project_id: Optional[str] = None) -> None:
    """One message out, on the account configured for this scope.

    `message` is what `whatsapp_runtime` produced: `{text, interaction,
    choices, title}`. A plain string is still accepted, so a caller that only
    has words to say does not have to build a dict.

    The token is fetched here rather than held anywhere: rotating it in the
    settings screen takes effect on the next message without a restart. It is
    never logged — not at debug, not in an error — and the message body is
    logged by length only, because it quotes back what somebody answered.
    """
    if isinstance(message, str):
        message = {"text": message}
    text = message.get("text") or ""

    token = channel_settings.token(project_id)
    if not token:
        logger.error(
            "No WhatsApp token configured for %s, so nothing can be sent. "
            "Set one in Channel routing > WhatsApp > Settings, in that "
            "context. A token saved against another project is not used here; "
            "one saved against the System context is inherited by all.",
            project_id or "the system (no project routes the number this "
                          "message arrived on)")
        return

    one = {"number": number, "message": text}
    one.update(_interactive(message))

    payload = {
        "token": token,
        "application": application,
        "data": [one],
    }

    try:
        async with httpx.AsyncClient(timeout=PUSH_TIMEOUT_SECONDS) as client:
            response = await client.post(PUSH_API_URL, json=payload)
        logger.info("WhatsApp push to %s: %s (%d chars)",
                    _masked(number), response.status_code, len(text))
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
#: Where the number the message *arrived on* might be, in order.
#:
#: **Picky Assist does not send one.** An observed inbound payload carries only:
#:
#:     application, direction, message-in, message_in_raw, name, number,
#:     project-id, type, unique-id
#:
#: `number` is the sender. Which of your numbers it reached is identified by
#: `application` — their account id — and not by a phone number at all. So a
#: route's `receiver_number` cannot pick the account to answer on with this
#: provider, and `_scope_of` falls through to the conversation or the system.
#:
#: Kept, and still tried first, because it costs nothing and another provider
#: (or a later version of this one) may send it. `_read` logs the keys it could
#: not place, which is how the list above was established.
#:
#: To support several Picky Assist accounts on one installation, map
#: `application` to a project in `channel_settings` and resolve on that. Not
#: built: one account, configured once in the System context, is inherited by
#: every project and needs no mapping.
RECEIVER_KEYS = ("receiver", "to", "receiver_number", "business_number",
                 "bot_number", "channel_number", "did", "account_number",
                 "from_number", "recipient")

SENDER_KEYS = ("number", "sender", "from", "mobile", "msisdn", "contact_number")

MESSAGE_KEYS = ("message-in", "text", "message", "body", "message_in")


def _first(body: Dict[str, Any], keys) -> str:
    for key in keys:
        value = body.get(key)
        if value not in (None, "", []):
            return str(value).strip()
    return ""


def _read(body: Dict[str, Any]) -> Dict[str, str]:
    """A Picky Assist delivery, in the three things the runtime needs.

    Several spellings because the provider's payload differs between its
    versions and its test console. Unknown keys are ignored rather than
    rejected: a webhook that 400s makes a provider retry forever.
    """
    sender = _first(body, SENDER_KEYS)
    receiver = _first(body, RECEIVER_KEYS)
    raw = _first(body, MESSAGE_KEYS)

    if not receiver:
        # Which number this arrived on decides whose provider account answers
        # it (`_scope_of`), so not finding it is worth saying out loud. The
        # keys are logged, never the values: the values are phone numbers and
        # whatever somebody typed.
        # Expected with Picky Assist, which identifies the account by
        # `application` rather than by a number. Debug, not a warning: it is
        # normal, and at warning level it buried the lines that matter.
        logger.debug(
            "No receiver number in the inbound payload; its keys were: %s",
            ", ".join(sorted(str(k) for k in body)) or "(none)")

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

    logger.info("WhatsApp in from %s on %s (app %s, %d chars)",
                _masked(message["identity"]), _masked(message["receiver"]),
                message["application"], len(message["text"]))

    try:
        answer = await asyncio.to_thread(
            whatsapp_runtime.reply,
            message["identity"], message["receiver"], message["text"])
    except Exception:
        logger.exception("The WhatsApp conversation failed for %s",
                         _masked(message["identity"]))
        answer = "Sorry, something went wrong. Please try again in a moment."

    if answer:
        background.add_task(send, message["identity"], answer,
                            message["application"],
                            _scope_of(message["identity"], message["receiver"]))

    return {"status": "ok"}


def _scope_of(identity: str, receiver: str = "") -> Optional[str]:
    """Which project's Picky Assist account to answer on.

    In order:

        the conversation's own      mid-survey, the project whose form is
                                    being answered
        the number it arrived on    before there is a conversation — the
                                    project that routes a form on that number
        the system                  neither, so the installation's own account

    The middle step is the one that matters and was missing. A welcome, a
    consent question and "there is nothing to fill in here" are all sent before
    any session exists, so they fell to the system scope — and an installation
    whose token is configured per project had none there and could send
    nothing. The symptom was `No WhatsApp token configured for the system`
    while a token was plainly saved against the project.
    """
    try:
        session = whatsapp_session.live(identity) \
            or whatsapp_session.recently_finished(identity)
        if session and session.get("project_id"):
            return session["project_id"]
    except Exception:
        logger.exception("Could not read the conversation for %s",
                         _masked(identity))

    try:
        return routing.project_for_receiver(receiver)
    except Exception:
        logger.exception("Could not tell whose number %s is", _masked(receiver))
        return None
