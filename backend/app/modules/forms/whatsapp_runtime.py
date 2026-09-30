"""The WhatsApp conversation: what to say next, given what somebody just said.

    keyword ─> routing.resolve ─> welcome ─> consent ─┬─ no ─> decline
                                                      │
                                                      └─ yes ─> Q1 ─> Q2 ─> …
                                                                            │
                                                          submission_service ┘

Transport is not here. This takes an identity, the number it reached and a line
of text, and returns the text to send back; `routers/whatsapp_webhook.py` is the
Picky Assist adapter that carries it. That split is why this can be tested
without a provider, and why swapping providers touches one file.

**Nothing in here decides anything it could ask something else.** The four
things it would be tempting to reimplement, and where they actually live:

    which form a keyword means      routing.resolve — scope, precedence,
                                    enabled, published, and may_fill_form
    what a reply means              ingestion (the WhatsApp adapter): "2" against
                                    a question with choices is the second choice
    whether a reply is acceptable   submission_service.validate_field — the same
                                    per-question check the whole-form pass runs
    whether it can be stored        submission_service.submit

What is genuinely this module's own is presentation: which question comes next,
how it is written out as a message, and what the numbers beside the choices are.
That is the one thing a channel cannot borrow from anywhere else.

The version is pinned when the session starts. Every question, every validation
and the final submission read the definition the conversation began with
(`publishing.config_of(form, session.form_version)`), so republishing a form
never reinterprets a conversation halfway through.
"""
import logging
import os
import urllib.parse
import uuid
from typing import Any, Dict, List, Optional, Tuple

import httpx

from app.modules.forms.channel_capabilities import (
    BUTTONS, LIST, NUMBERED, TEXT_REPLY,
)

from app.modules.forms import (
    channel_capabilities as caps,
    channel_config,
    channel_settings,
    conditions,
    ingestion,
    publishing,
    routing,
    submission_service,
    whatsapp_session as sessions,
)
from app.modules.forms.field_types import get_type, resolve_type
from app.modules.forms.form_schema import field_name

logger = logging.getLogger(__name__)

#: What somebody types to give up. Checked before anything else, in every state.
CANCEL_WORDS = {"cancel", "stop", "reset", "quit", "exit"}
#: …and to be shown what they can start.
MENU_WORDS = {"menu", "start", "hi", "hello", "help"}

YES_WORDS = {"yes", "y", "1", "ok", "okay", "agree", "accept", "continue", "haan", "ha"}
NO_WORDS = {"no", "n", "2", "stop", "decline", "nahi", "nahin"}

#: The consent question's two buttons. The values are what a tapped button
#: sends back, and both are already in the word lists above — so a tap and a
#: typed "yes" arrive as the same answer and only one of them has to be read.
CONSENT_CHOICES = [("Yes", "yes"), ("No", "no")]

#: Said to a number this installation does not recognise, and to a keyword that
#: reaches nothing. Deliberately the same sentence: an unlinked number must not
#: be able to tell a real keyword from an invented one by the reply it gets, or
#: the keyword space becomes a directory of what is being collected.
UNAVAILABLE = ("Sorry, there is nothing to fill in from this number right now. "
               "If you were expecting a survey, please check with your "
               "programme contact.")

DEFAULT_WELCOME = "Hello. You are about to fill in {title}."
DEFAULT_CONSENT = "Would you like to continue? Reply YES to start, or NO to stop."
DEFAULT_DECLINE = "No problem. Nothing has been recorded. Send the keyword again any time."
DEFAULT_COMPLETION = "Thank you. Your answers have been recorded."


def _tidy(text: Any) -> str:
    return " ".join(str(text or "").strip().split())


def _word(text: Any) -> str:
    """A reply reduced for comparison against a command: no spaces, no case.

    Somebody typing into a chat is not typing a database key. " Y E S ", "Yes."
    and "yes" are one answer.
    """
    return "".join(str(text or "").split()).casefold().rstrip(".!")


# --------------------------------------------------------------------------- #
# the definition a session is running on
# --------------------------------------------------------------------------- #
def _definition(session: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The exact form definition this conversation started against.

    The pinned version out of `form_version`, never `forms.form_json`, which the
    next edit rewrites. A session whose version has somehow gone returns None
    and the conversation is ended rather than continued against something else.
    """
    from app.modules.forms import form_service

    try:
        form = form_service.get_form(session["form_id"])
        return publishing.config_of(form, session.get("form_version"))
    except Exception:
        logger.exception("Session %s has no definition to run on",
                         session.get("session_id"))
        return None


def _whatsapp_config(form_json: Dict[str, Any]) -> Dict[str, Any]:
    return ((form_json.get("channel_config") or {}).get("whatsapp")) or {}


def _conversation_order(form_json: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The questions, in the order the conversation asks them.

    The configured order first, keeping only questions the form still has, then
    everything it does not mention in form order — so a question added after the
    order was set is asked at the end rather than never. The same rule as the
    builder's `conversationOrder`, which is what the author was looking at.
    """
    by_name = {field_name(f): f for f in form_json.get("fields") or []
               if isinstance(f, dict) and field_name(f)}

    ordered: List[Dict[str, Any]] = []
    for name in _whatsapp_config(form_json).get("order") or []:
        field = by_name.pop(name, None)
        if field is not None:
            ordered.append(field)
    ordered.extend(by_name.values())
    return ordered


def _next_question(form_json: Dict[str, Any],
                   answers: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The next question to ask, or None when there is nothing left.

    Three reasons a question is passed over, and none of them is invented here:

        a condition says it does not apply    `conditions.hidden`, the same
                                              engine the form page uses
        WhatsApp cannot ask it                `channel_capabilities`; it is
                                              optional, or the form could not
                                              have been published
        it has been answered                  it is already in `answers`
    """
    skip = set(conditions.hidden(form_json, answers)["fields"])

    for field in _conversation_order(form_json):
        name = field_name(field)
        if not name or name in answers or name in skip:
            continue
        if not caps.whatsapp_interactions(field):
            # Unaskable here. Required-and-unaskable cannot be published
            # (`channels_can_complete_the_form`), so this is an optional one and
            # the answer is simply absent.
            continue
        return field
    return None


# --------------------------------------------------------------------------- #
# writing a question out
# --------------------------------------------------------------------------- #
def _choices(field: Dict[str, Any],
             answers: Optional[Dict[str, Any]] = None) -> List[Tuple[str, str]]:
    """The choices to offer, as `(label, value)`.

    Three sources, and only the first is this module's own:

        Yes/No      for a boolean. The definition has no options for one,
                    because `true`/`false` is how it is *stored*, not how a
                    person is asked.
        a catalogue when the question carries `options_from` rather than a
                    list. Resolved now, through `mobile_package.options_for` —
                    the same dispatch the mobile package uses, narrowed by the
                    answer to whatever it depends on.
        its own     otherwise, exactly as stored.

    A catalogue question used to fall through with nothing, so it was sent as a
    bare prompt and every reply was refused as "not an available option" — the
    choices existed, and the conversation had simply never asked for them.
    """
    ftype = resolve_type(field.get("type") or "text")
    if ftype == "boolean":
        return [("Yes", "yes"), ("No", "no")]

    # Only choice-based fields offer selectable choices
    if ftype not in ("select", "radio", "multiselect"):
        return []

    source = field.get("options_from") or {}
    if source:
        from app.modules.forms import mobile_package

        parent = source.get("depends_on")
        try:
            resolved = mobile_package.options_for(
                field, parent_value=(answers or {}).get(parent) if parent else None)
        except Exception:
            logger.exception("Could not resolve the choices for %s",
                             field_name(field))
            resolved = []
        return [(str(o.get("label") or o.get("value") or ""),
                 str(o.get("value") or ""))
                for o in resolved if o.get("value") not in (None, "")]

    found = []
    for option in field.get("options") or []:
        if isinstance(option, dict):
            found.append((str(option.get("label") or option.get("value") or ""),
                          str(option.get("value") or "")))
        else:
            found.append((str(option), str(option)))
    return [c for c in found if c[1]]


def say(text: str, interaction: str = TEXT_REPLY,
        choices: Optional[List[Tuple[str, str]]] = None,
        title: str = "") -> Dict[str, Any]:
    """One outgoing message, in the shape the transport needs.

    `text` is always complete on its own — it carries the choices written out
    and numbered even when `choices` asks for buttons or a list. That is
    deliberate: if the provider cannot render an interactive message (the
    window has closed, the account is not approved for it, the payload is
    refused), the person still gets a question they can answer by replying with
    a number. A channel that degrades to nothing is a conversation that stops.
    """
    return {"text": text, "interaction": interaction,
            "choices": list(choices or []), "title": title}


def _how_to_ask(field: Dict[str, Any], config: Dict[str, Any],
                choices: Optional[List[Tuple[str, str]]] = None) -> str:
    """The interaction this question is asked with.

    What the author chose in the builder, when the question can still be asked
    that way — a list that has grown past ten rows since cannot, and falls back
    rather than being sent and refused. Otherwise the registry's own preference
    (`default_whatsapp_interaction`), which is buttons for two or three choices,
    a list up to ten, and a numbered menu beyond that.
    """
    allowed = caps.whatsapp_interactions(field)
    if not allowed:
        return TEXT_REPLY

    # The registry can only offer `numbered` for a catalogue question, because
    # when the form was built nobody knew how long the list would be. Now it is
    # resolved, so a short one can be tapped after all.
    if choices and field.get("options_from"):
        if len(choices) <= caps.MAX_BUTTONS:
            allowed = [BUTTONS, LIST, NUMBERED]
        elif len(choices) <= caps.MAX_LIST_ROWS:
            allowed = [LIST, NUMBERED]

    name = field_name(field)
    chosen = ((config.get("fields") or {}).get(name) or {}).get("interaction")
    if chosen in allowed:
        return chosen
    return allowed[0] if allowed else (
        caps.default_whatsapp_interaction(field) or TEXT_REPLY)


def render(field: Dict[str, Any], config: Dict[str, Any],
           answers: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """One question as a WhatsApp message.

    The prompt the author wrote, or the question's label. Then, for a question
    with choices, the choices — as buttons, as a list, or numbered in the text,
    according to what the builder chose and what WhatsApp allows for that many
    choices.

    The numbered text is written out **whatever the interaction is**, so the
    message stands on its own if the interactive part does not arrive. See
    `say`.

    The hint at the end is what the *type* needs, taken from the capability
    registry's reason where there is one, so a date says how to write a date
    without this file keeping its own table of formats.
    """
    name = field_name(field)
    entry = (config.get("fields") or {}).get(name) or {}
    prompt = _tidy(entry.get("prompt")) or field.get("label") or name

    lines = [f"*{prompt}*"]
    choices = _choices(field, answers)
    interaction = _how_to_ask(field, config, choices)
    spec = get_type(field.get("type") or "text")

    if choices:
        lines.append("")
        lines.extend(f"{i}. {label}" for i, (label, _) in enumerate(choices, 1))
        lines.append("")
        if spec.multi:
            # Several answers cannot be tapped: a button or a list row sends one
            # reply and closes. A multi-select is a numbered menu, always.
            interaction = NUMBERED
            lines.append("_Reply with the numbers, separated by commas — e.g. 1,3_")
        elif interaction in (BUTTONS, LIST):
            lines.append("_Tap a choice above, or reply with the number._")
        else:
            lines.append("_Reply with the number, or type the option._")
    else:
        hint = caps.capability("whatsapp", field.get("type") or "text").reason
        if hint:
            lines.append(f"\n_{hint}_")

    if not field.get("required"):
        lines.append("\n_Reply SKIP to leave this blank._")

    return say("\n".join(lines), interaction, choices if choices else None,
               title="Select")


# --------------------------------------------------------------------------- #
# reading a reply back
# --------------------------------------------------------------------------- #
def _one_value(field: Dict[str, Any], text: str,
               answers: Optional[Dict[str, Any]] = None) -> Any:
    """One reply, as a value the form's own validation can judge.

    The mapping from "2" to the second choice is `ingestion`'s — the WhatsApp
    adapter, the same one the MCDC ingest path uses — so there is one place that
    knows a numbered reply is an index. This only supplies the choices a boolean
    was offered, because those are not in the definition, and splits a
    multi-select reply into the several answers it is.
    """
    if resolve_type(field.get("type") or "text") == "boolean":
        choices = _choices(field)
        word = _word(text)
        if word.isdigit() and 1 <= int(word) <= len(choices):
            return choices[int(word) - 1][1]
        return text

    # A catalogue question's choices are not on the field, so the adapter has
    # nothing to map against. Read against the list that was actually offered,
    # by the same three rules: the number, the label, or the value.
    if field.get("options_from"):
        choices = _choices(field, answers)
        if choices:
            word = _tidy(text)
            if word.isdigit() and 1 <= int(word) <= len(choices):
                return choices[int(word) - 1][1]
            folded = word.casefold()
            for label, value in choices:
                if folded in (label.strip().casefold(), str(value).strip().casefold()):
                    return value
        return text

    spec = get_type(field.get("type") or "text")
    parts = [p for p in (text.split(",") if spec.multi else [text]) if _tidy(p)]

    mapped = [
        ingestion.normalize("whatsapp", {"fields": [field]},
                            {"answers": {field_name(field): _tidy(part)}})
        .get(field_name(field))
        for part in parts
    ]
    return mapped if spec.multi else (mapped[0] if mapped else text)


# --------------------------------------------------------------------------- #
# who is on the other end
# --------------------------------------------------------------------------- #
def _caller(identity: str) -> Optional[Dict[str, Any]]:
    """The account this number belongs to, or a public respondent fallback.

    If linked in `channel_identity`, the linked account is returned with its permissions.
    Otherwise, falls back to a public respondent (using default system/admin user) so that
    anyone on WhatsApp can fill out active published forms without requiring pre-registration.
    """
    account = routing.user_for_identity("whatsapp", identity)
    if account:
        return account

    # Public respondent fallback:
    from app.core import auth_service
    from app.core.config import settings

    for candidate in (settings.default_user, "USR00001", "system", "admin@e-agrology.local"):
        if candidate:
            try:
                user = auth_service.get_user(candidate)
                if user:
                    return user
            except Exception:
                pass

    try:
        from app.core.database import transaction
        with transaction() as cur:
            cur.execute("SELECT user_id FROM users WHERE is_active ORDER BY created_on ASC LIMIT 1")
            row = cur.fetchone()
            if row:
                return auth_service.get_user(row["user_id"])
    except Exception:
        pass

    return None


def _timeout(project_id: Optional[str]) -> int:
    return channel_settings.timeout_seconds(project_id)


# --------------------------------------------------------------------------- #
# the conversation
# --------------------------------------------------------------------------- #
def reply(identity: str, receiver: str, text: str,
          media_url: str = "", media_type: str = "") -> Optional[str]:
    """What to send back, or None to say nothing.

    The one entry point. Everything above is called from here and nothing else
    calls into the middle of it.
    """
    identity = _tidy(identity)
    if not identity:
        return None

    word = _word(text)
    session = sessions.live(identity)

    if word in CANCEL_WORDS:
        if session:
            sessions.finish(session["session_id"], sessions.EXPIRED)
            return say("Stopped. Nothing further has been recorded. Send "
                       "the keyword again when you are ready.")
        return say("There is nothing in progress.")

    caller = _caller(identity)
    if caller is None:
        # An unrecognised number is told what an unknown keyword is told.
        if session:
            # The link was removed mid-conversation. Stop rather than carry on
            # collecting for an account that no longer claims this number.
            sessions.finish(session["session_id"], sessions.EXPIRED)
        return say(UNAVAILABLE)

    if session:
        return _continue(session, caller, text, media_url=media_url, media_type=media_type)

    # A reply that arrives just after the last one completed a survey: a
    # provider retrying the delivery it never heard back from, not a new answer.
    if word and word not in MENU_WORDS:
        finished = sessions.recently_finished(identity)
        if finished and finished["status"] == sessions.COMPLETED:
            return None

    return _begin(identity, receiver, caller, text)


def _begin(identity: str, receiver: str, caller: Dict[str, Any],
           text: str) -> Optional[str]:
    """A keyword, with nothing in progress.

    Resolution then authorization, in that order and through `routing` — the
    same two steps, the same functions and the same refusal as the MCDC
    endpoint. A keyword this account may not use is answered exactly like one
    nobody configured.
    """
    keyword = _tidy(text)

    try:
        resolved = routing.resolve("whatsapp", keyword, caller, receiver=receiver)
    except routing.Ambiguous as exc:
        logger.warning("Ambiguous WhatsApp keyword from a caller: %s", exc)
        return say("That word means more than one thing here. Please check "
                   "with your programme contact.")
    except routing.RoutingError:
        return say(UNAVAILABLE)

    if not resolved.get("matched"):
        return _menu(caller, receiver)

    session = sessions.start(
        identity, receiver, resolved, caller.get("user_id") or "",
        _timeout(resolved.get("project_id")))

    form_json = _definition(session)
    if form_json is None:
        sessions.finish(session["session_id"], sessions.EXPIRED)
        return say(UNAVAILABLE)

    return _welcome_and_consent(session, form_json, resolved["form_title"])


def _menu(caller: Dict[str, Any], receiver: str) -> Dict[str, Any]:
    """What this account can start, when the keyword meant nothing.

    Built from `routing.offered`, which runs the same resolution and the same
    `may_fill_form` as a keyword — so the menu can never list something a
    keyword would refuse, and an account with nothing assigned sees the same
    sentence an unlinked number sees.
    """
    try:
        offers = routing.offered("whatsapp", caller, receiver=receiver)
    except routing.RoutingError:
        offers = []

    if not offers:
        return say(UNAVAILABLE)

    # lines = ["*Available surveys*", ""]
    # lines += [f"{i}. {o['form_title']} — send *{o['route_key']}*"
    #           for i, o in enumerate(offers, 1)]
    # lines += ["", "_Tap an option below or send the keyword._"]

    # if len(offers) <= caps.MAX_BUTTONS:
    #     choices = [(str(o["form_title"])[:20], o["route_key"]) for o in offers]
    #     return say("\n".join(lines), interaction=caps.BUTTONS, choices=choices, title="Available surveys")
    # elif len(offers) <= caps.MAX_LIST_ROWS:
    #     choices = [(str(o["form_title"])[:24], o["route_key"]) for o in offers]
    #     return say("\n".join(lines), interaction=caps.LIST, choices=choices, title="Available surveys")

    # return say("\n".join(lines))
    return say(
    "*Welcome to E-Agrology!*\n\n"
    "To get started, simply type the *keyword* of the form you want to fill out.\n\n"
    "We’ll guide you through the form step by step.")


def _welcome_and_consent(session: Dict[str, Any], form_json: Dict[str, Any],
                         title: str) -> Dict[str, Any]:
    """The first message: the welcome prompt with Yes/No consent buttons.

    Matches the Form Builder preview which presents the welcome prompt followed by
    native Yes / No buttons. When the user taps Yes, the survey advances to Question 1.
    """
    config = _whatsapp_config(form_json)
    welcome = _tidy(config.get("welcome_message")) or DEFAULT_WELCOME.format(title=title)
    consent = _tidy(config.get("consent_message"))

    body = f"{welcome}\n\n{consent}" if consent else welcome
    return say(f"{body}\n\n_Tap a button, or reply YES or NO._",
               BUTTONS, CONSENT_CHOICES, title="Consent")


def _start_questions(session: Dict[str, Any], form_json: Dict[str, Any],
                     preamble: str = "") -> str:
    """Consent given (or never asked): move to the questions and ask the first."""
    answers = session.get("answers") or {}
    field = _next_question(form_json, answers)

    if field is None:
        # A form with nothing WhatsApp can ask. Not publishable if anything
        # required is unaskable, so this is an empty or wholly optional form.
        return _submit(session, form_json)

    # Ensure survey_id is allocated for media tracking
    survey_id = session.get("survey_id")
    if not survey_id:
        from app.modules.forms import form_service
        try:
            form = form_service.get_form(session["form_id"])
            survey_id = submission_service.start(
                form, created_by=f"whatsapp:{session['identity']}")
        except Exception as exc:
            logger.warning("Could not pre-allocate survey_id: %s", exc)

    updated = sessions.touch(
        session["session_id"], _timeout(session.get("project_id")),
        state=sessions.QUESTIONS, consent=True, current_field=field_name(field),
        survey_id=survey_id)
    if not updated:
        return say(UNAVAILABLE)

    question = render(field, _whatsapp_config(form_json), answers)
    if preamble:
        # One message, not two: two deliveries can arrive in either order, and
        # a question landing before its welcome reads as a non-sequitur.
        question = {**question, "text": f"{preamble}\n\n{question['text']}"}
    return question


def _continue(session: Dict[str, Any], caller: Dict[str, Any], text: str,
              media_url: str = "", media_type: str = "") -> str:
    """The next reply of a conversation already under way."""
    form_json = _definition(session)
    if form_json is None:
        sessions.finish(session["session_id"], sessions.EXPIRED)
        return say(UNAVAILABLE)

    if session["state"] == sessions.CONSENT:
        return _consent_reply(session, form_json, text)
    return _answer(session, form_json, text, media_url=media_url, media_type=media_type)


def _consent_reply(session: Dict[str, Any], form_json: Dict[str, Any],
                   text: str) -> str:
    config = _whatsapp_config(form_json)
    word = _word(text)

    if word in NO_WORDS:
        sessions.finish(session["session_id"], sessions.DECLINED)
        return say(_tidy(config.get("decline_message")) or DEFAULT_DECLINE)

    if word not in YES_WORDS:
        consent = _tidy(config.get("consent_message")) or DEFAULT_CONSENT
        return say(f"Sorry, I did not understand that.\n\n{consent}\n\n"
                   "_Tap a button, or reply YES or NO._",
                   BUTTONS, CONSENT_CHOICES)

    return _start_questions(session, form_json)


def _process_media_upload(session: Dict[str, Any], form_json: Dict[str, Any],
                          field: Dict[str, Any], media_url: str,
                          media_type: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """Download media from Picky Assist URL and upload to S3 via media_service.

    Returns (media_id, survey_id, error_message).
    """
    from app.modules.forms import form_service, media_service

    survey_id = session.get("survey_id")
    if not survey_id:
        try:
            form = form_service.get_form(session["form_id"])
            survey_id = submission_service.start(
                form, created_by=f"whatsapp:{session['identity']}")
        except Exception as exc:
            logger.exception("Failed to allocate survey_id for WhatsApp media: %s", exc)
            return None, None, "Could not initialize storage for upload."

    # Download from Picky Assist
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.get(media_url)
            resp.raise_for_status()
            data = resp.content
            raw_content_type = resp.headers.get("content-type") or ""
    except Exception as exc:
        logger.exception("Failed to download WhatsApp media from %s: %s", media_url, exc)
        return None, survey_id, "We could not download the file you sent. Please try sending it again."

    content_type = raw_content_type.split(";")[0].strip().lower()
    ftype = resolve_type(field.get("type") or "text")

    # Guess extension and default content_type if missing or generic
    parsed = urllib.parse.urlparse(media_url)
    base_name = os.path.basename(parsed.path)
    ext = os.path.splitext(base_name)[1].lower()
    if not ext or len(ext) > 5:
        if ftype == "image":
            ext = ".jpg"
        elif ftype == "audio":
            ext = ".ogg"
        else:
            ext = ".pdf"

    if not content_type or content_type == "application/octet-stream":
        if ext in (".jpg", ".jpeg"):
            content_type = "image/jpeg"
        elif ext == ".png":
            content_type = "image/png"
        elif ext == ".ogg":
            content_type = "audio/ogg"
        elif ext == ".mp3":
            content_type = "audio/mpeg"
        elif ext == ".pdf":
            content_type = "application/pdf"
        elif ftype == "image":
            content_type = "image/jpeg"
        elif ftype == "audio":
            content_type = "audio/ogg"
        elif ftype == "file":
            content_type = "application/pdf"

    filename = f"{field_name(field)}_{uuid.uuid4().hex[:8]}{ext}"

    try:
        media_row = media_service.store_media_bytes(
            project_id=session.get("project_id"),
            form_id=session["form_id"],
            survey_id=survey_id,
            field_name=field_name(field),
            media_type=ftype,
            filename=filename,
            content_type=content_type,
            data=data,
            created_by=f"whatsapp:{session['identity']}"
        )
        return media_row["media_id"], survey_id, None
    except Exception as exc:
        logger.exception("Failed to store WhatsApp media in S3: %s", exc)
        return None, survey_id, "Failed to save the file. Please try sending it again."


def _answer(session: Dict[str, Any], form_json: Dict[str, Any], text: str,
            media_url: str = "", media_type: str = "") -> str:
    """One answer to the outstanding question.

    Validated by `submission_service.validate_field` — the same per-question
    check the whole-form pass runs, given the answers so far so a condition or a
    dependent list is judged against them. A reply it refuses is reported and
    the same question asked again; nothing is stored until it passes.
    """
    name = session.get("current_field") or ""
    field = next((f for f in form_json.get("fields") or []
                  if field_name(f) == name), None)
    if field is None:
        # The question went away with a version this session is not on, or the
        # session lost its place. Re-asking is the only honest thing to do.
        return _start_questions(session, form_json)

    answers = dict(session.get("answers") or {})
    config = _whatsapp_config(form_json)
    ftype = resolve_type(field.get("type") or "text")
    is_media = ftype in ("image", "audio", "file")
    word = _word(text)
    survey_id = session.get("survey_id")

    if is_media:
        # 1. Check for skip
        if word == "skip":
            if not field.get("required"):
                answers[name] = None
            else:
                again = render(field, config, answers)
                return {**again, "text": f"⚠️ This question is required and cannot be skipped.\n\n{again['text']}"}
        # 2. Plain text sent when media is expected -> reject text!
        elif not media_url:
            again = render(field, config, answers)
            skip_hint = "\n\n_Reply SKIP to leave this blank._" if not field.get("required") else "\n\n_This question is required._"
            if ftype == "image":
                hint = "⚠️ Please send a photo using your WhatsApp camera or gallery attachment." + skip_hint
            elif ftype == "audio":
                hint = "⚠️ Please record and send a voice note using the microphone button." + skip_hint
            else:
                hint = "⚠️ Please attach a document or file using the attachment button." + skip_hint
            return {**again, "text": f"{hint}\n\n{again['text']}"}
        # 3. Media attachment received
        else:
            if ftype == "image" and media_type == "audio":
                again = render(field, config, answers)
                return {**again, "text": f"⚠️ A photo is expected for this question, but a voice note was received. Please send a photo.\n\n{again['text']}"}
            if ftype == "audio" and media_type == "image":
                again = render(field, config, answers)
                return {**again, "text": f"⚠️ A voice note is expected for this question, but a photo was received. Please record and send a voice note.\n\n{again['text']}"}

            media_id, survey_id, err = _process_media_upload(
                session, form_json, field, media_url, media_type)
            if err:
                again = render(field, config, answers)
                return {**again, "text": f"⚠️ {err}\n\n{again['text']}"}
            answers[name] = media_id
    else:
        # Field is NOT a media field (e.g. text, select, boolean, number)
        if media_url:
            again = render(field, config, answers)
            return {**again, "text": f"⚠️ This question expects a text reply or option choice, not a file/photo.\n\n{again['text']}"}

        if word == "skip" and not field.get("required"):
            answers[name] = None
        else:
            try:
                value = submission_service.validate_field(
                    form_json, name, _one_value(field, _tidy(text), answers), answers)
            except submission_service.ValidationFailed as failed:
                problem = failed.errors.get(name) or "That answer cannot be used."
                again = render(field, config, answers)
                return {**again, "text": f"⚠️ {problem}\n\n{again['text']}"}
            except KeyError:
                return _start_questions(session, form_json)
            answers[name] = value

    following = _next_question(form_json, answers)
    if following is None:
        session = {**session, "answers": answers, "survey_id": survey_id}
        return _submit(session, form_json)

    updated = sessions.touch(
        session["session_id"], _timeout(session.get("project_id")),
        answers=answers, current_field=field_name(following),
        survey_id=survey_id)
    if not updated:
        return say(UNAVAILABLE)

    next_q = render(following, config, answers)
    if is_media and answers.get(name):
        type_label = "Photo" if ftype == "image" else ("Voice note" if ftype == "audio" else "Document")
        next_q = {**next_q, "text": f"✅ {type_label} received!\n\n{next_q['text']}"}
    return next_q


def _submit(session: Dict[str, Any], form_json: Dict[str, Any]) -> str:
    """The last answer is in: store the response through the canonical service.

    `submission_service.submit` and nothing else — the channel profile, the
    whole-form validation, the answers row, the flat mirror, the channel note
    and the review state, all in the one transaction it already runs. The
    session id is the `client_submission_id`, so a provider redelivering the
    final reply gets the original submission back instead of a second one.
    """
    from app.modules.forms import form_service

    answers = session.get("answers") or {}

    try:
        form = form_service.get_form(session["form_id"])
        stored = submission_service.submit(
            form, answers,
            created_by=f"whatsapp:{session['identity']}",
            channel="whatsapp",
            client_submission_id=session["session_id"],
            source_ref=f"whatsapp {session['receiver_number']}",
            survey_id=session.get("survey_id"),
        )
    except submission_service.ValidationFailed as failed:
        # Every answer passed on its way in, so this is the whole-form pass
        # objecting — a required question the conversation never reached, or a
        # cross-field rule. The session stays alive so the person can correct it
        # rather than losing what they typed.
        logger.warning("WhatsApp submission refused for %s: %s",
                       session["session_id"], failed.errors)
        first = next(iter(failed.errors.values()), "That could not be saved.")
        return say(f"⚠️ {first}\n\nReply CANCEL to stop, or send the "
                   "keyword to start again.")
    except Exception:
        logger.exception("WhatsApp submission failed for %s", session["session_id"])
        return say("Sorry, something went wrong saving your answers. Please "
                   "try again shortly.")

    sessions.finish(session["session_id"], sessions.COMPLETED,
                    survey_id=stored.get("survey_id"))

    config = _whatsapp_config(form_json)
    return say(_tidy(config.get("completion_message")) or DEFAULT_COMPLETION)
