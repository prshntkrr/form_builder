"""The IVR conversation: what to say next, given what the caller just pressed.

    keyword ─> routing.resolve ─> welcome ─> Q1 ─> Q2 ─> … ─> submission
                                              │
                                    TTS speaks each question
                                    DTMF collects keypad input
                                    Voice collected for audio fields

Transport is not here. This takes an identity, a DTMF input or voice
transcript, and returns a structured response the provider webhook turns
into TTS + DTMF collection. Swapping telephony providers touches only
`routers/ivr_webhook.py`.

Reuses `whatsapp_session` with `channel='ivr'` — same table, same lifecycle.
"""
import logging
from typing import Any, Dict, List, Optional, Tuple

from app.modules.forms import (
    channel_capabilities as caps,
    channel_settings,
    conditions,
    publishing,
    routing,
    submission_service,
    translations,
    whatsapp_session as sessions,
)
from app.modules.forms.field_types import resolve_type
from app.modules.forms.form_schema import field_name

logger = logging.getLogger(__name__)

CANCEL_WORDS = {"cancel", "stop", "0", "exit"}

UNAVAILABLE = ("Sorry, there is nothing available from this number right now. "
               "Please contact your programme coordinator.")

DEFAULT_WELCOME = "Welcome to {title}. Please answer the following questions using your keypad."
DEFAULT_COMPLETION = "Thank you. Your answers have been recorded. Goodbye."
DEFAULT_ERROR = "Sorry, that input was not understood. Please try again."
DEFAULT_TIMEOUT = "We did not receive any input. Please try again."


def _tidy(text: Any) -> str:
    return " ".join(str(text or "").strip().split())


def _ivr_config(form_json: Dict[str, Any]) -> Dict[str, Any]:
    return ((form_json.get("channel_config") or {}).get("ivr")) or {}


def _definition(session: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    from app.modules.forms import form_service

    try:
        form = form_service.get_form(session["form_id"])
        form_json = publishing.config_of(form, session.get("form_version"))
    except Exception:
        logger.exception("IVR session %s has no definition", session.get("session_id"))
        return None

    language = (session.get("language") or "").strip()
    if form_json and language:
        return translations.translate_form(form_json, language)
    return form_json


def _conversation_order(form_json: Dict[str, Any]) -> List[Dict[str, Any]]:
    by_name = {field_name(f): f for f in form_json.get("fields") or []
               if isinstance(f, dict) and field_name(f)}

    ordered: List[Dict[str, Any]] = []
    for name in _ivr_config(form_json).get("order") or []:
        field = by_name.pop(name, None)
        if field is not None:
            ordered.append(field)
    ordered.extend(by_name.values())
    return ordered


def _next_question(form_json: Dict[str, Any],
                   answers: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    skip = set(conditions.hidden(form_json, answers)["fields"])

    for field in _conversation_order(form_json):
        name = field_name(field)
        if not name or name in answers or name in skip:
            continue
        if not caps.ivr_interactions(field):
            continue
        return field
    return None


def _choices(field: Dict[str, Any],
             answers: Optional[Dict[str, Any]] = None) -> List[Tuple[str, str]]:
    ftype = resolve_type(field.get("type") or "text")
    if ftype == "boolean":
        return [("Yes", "yes"), ("No", "no")]

    if ftype not in ("select", "radio"):
        return []

    source = field.get("options_from") or {}
    if source:
        from app.modules.forms import mobile_package

        parent = source.get("depends_on")
        try:
            resolved = mobile_package.options_for(
                field, parent_value=(answers or {}).get(parent) if parent else None)
        except Exception:
            logger.exception("Could not resolve choices for %s", field_name(field))
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


# --------------------------------------------------------------------------- #
# TTS response builders
# --------------------------------------------------------------------------- #
def tts(text: str, collect: str = "dtmf", max_digits: int = 1,
        timeout: int = 10, choices: Optional[List[Tuple[str, str]]] = None) -> Dict[str, Any]:
    """Structured response the webhook adapter turns into provider-specific TTS.

    `collect`: 'dtmf' (wait for keypad), 'voice' (record), 'none' (just speak).
    """
    return {
        "text": text,
        "collect": collect,
        "max_digits": max_digits,
        "timeout": timeout,
        "choices": list(choices or []),
    }


def render(field: Dict[str, Any], config: Dict[str, Any],
           answers: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """One question as a TTS instruction."""
    name = field_name(field)
    entry = (config.get("fields") or {}).get(name) or {}
    prompt = _tidy(entry.get("prompt")) or field.get("label") or name
    ftype = resolve_type(field.get("type") or "text")

    choices = _choices(field, answers)
    timeout = config.get("input_timeout") or 10

    if ftype == "boolean":
        text = f"{prompt}. Press 1 for Yes, Press 2 for No."
        return tts(text, "dtmf", max_digits=1, timeout=timeout, choices=choices)

    if choices:
        lines = [prompt]
        for i, (label, _) in enumerate(choices, 1):
            lines.append(f"Press {i} for {label}.")
        text = " ".join(lines)
        return tts(text, "dtmf", max_digits=len(str(len(choices))),
                   timeout=timeout, choices=choices)

    if ftype == "audio":
        text = f"{prompt}. Please speak your answer after the tone."
        return tts(text, "voice", timeout=timeout)

    if ftype in ("phone", "number", "decimal", "rating"):
        hint = caps.capability("ivr", ftype).reason
        text = f"{prompt}." + (f" {hint}." if hint else " Enter the digits on your keypad, then press hash.")
        return tts(text, "dtmf", max_digits=20, timeout=timeout)

    if ftype in ("date", "datetime", "time"):
        hint = caps.capability("ivr", ftype).reason
        text = f"{prompt}. {hint}. Press hash when done."
        return tts(text, "dtmf", max_digits=12, timeout=timeout)

    # Fallback
    text = f"{prompt}. Enter your response using the keypad."
    return tts(text, "dtmf", max_digits=20, timeout=timeout)


def _one_value(field: Dict[str, Any], text: str,
               answers: Optional[Dict[str, Any]] = None) -> Any:
    """Map DTMF input to a value the form's validation can judge."""
    ftype = resolve_type(field.get("type") or "text")

    if ftype == "boolean":
        choices = _choices(field)
        if text.isdigit() and 1 <= int(text) <= len(choices):
            return choices[int(text) - 1][1]
        return text

    if ftype in ("select", "radio"):
        choices = _choices(field, answers)
        if choices and text.isdigit() and 1 <= int(text) <= len(choices):
            return choices[int(text) - 1][1]
        return text

    if ftype == "decimal":
        # * stands for decimal point on a keypad
        return text.replace("*", ".")

    return text


def _timeout_seconds(project_id: Optional[str]) -> int:
    return channel_settings.timeout_seconds(project_id)


def _caller(identity: str) -> Optional[Dict[str, Any]]:
    account = routing.user_for_identity("ivr", identity)
    if account:
        return account

    from app.core import auth_service
    from app.core.config import settings

    for candidate in (settings.default_user, "USR00001", "system"):
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


# --------------------------------------------------------------------------- #
# the conversation
# --------------------------------------------------------------------------- #
def reply(identity: str, dtmf: str = "", voice_text: str = "",
          menu_key: str = "") -> Optional[Dict[str, Any]]:
    """What to say next.

    Returns a TTS instruction dict, or None for silence.
    `dtmf` is the keypad input, `voice_text` is a Sarvam transcript,
    `menu_key` is the initial IVR menu option (like a keyword).
    """
    identity = _tidy(identity)
    if not identity:
        return None

    text = _tidy(dtmf or voice_text or menu_key)
    if not text:
        return None

    session = sessions.live(identity, channel="ivr")

    if text in CANCEL_WORDS:
        if session:
            sessions.finish(session["session_id"], sessions.EXPIRED)
            return tts("Your call has been ended. Nothing further has been recorded. Goodbye.",
                       collect="none")
        return tts("There is nothing in progress. Goodbye.", collect="none")

    caller = _caller(identity)
    if caller is None:
        if session:
            sessions.finish(session["session_id"], sessions.EXPIRED)
        return tts(UNAVAILABLE, collect="none")

    if session:
        return _continue(session, caller, text)

    return _begin(identity, "", caller, text)


def _begin(identity: str, receiver: str, caller: Dict[str, Any],
           text: str) -> Optional[Dict[str, Any]]:
    keyword = _tidy(text)

    try:
        resolved = routing.resolve("ivr", keyword, caller, receiver=receiver)
    except routing.Ambiguous:
        return tts("That option is ambiguous. Please contact your programme coordinator.",
                   collect="none")
    except routing.RoutingError:
        return tts(UNAVAILABLE, collect="none")

    if not resolved.get("matched"):
        return tts(UNAVAILABLE, collect="none")

    session = sessions.start(
        identity, receiver, resolved, caller.get("user_id") or "",
        _timeout_seconds(resolved.get("project_id")),
        channel="ivr")

    form_json = _definition(session)
    if form_json is None:
        sessions.finish(session["session_id"], sessions.EXPIRED)
        return tts(UNAVAILABLE, collect="none")

    config = _ivr_config(form_json)
    title = resolved.get("form_title") or form_json.get("title") or ""
    welcome = _tidy(config.get("welcome_message")) or DEFAULT_WELCOME.format(title=title)

    return _start_questions(session, form_json, preamble=welcome)


def _start_questions(session: Dict[str, Any], form_json: Dict[str, Any],
                     preamble: str = "") -> Dict[str, Any]:
    answers = session.get("answers") or {}
    field = _next_question(form_json, answers)

    if field is None:
        return _submit(session, form_json)

    updated = sessions.touch(
        session["session_id"], _timeout_seconds(session.get("project_id")),
        state=sessions.QUESTIONS, consent=True, current_field=field_name(field))
    if not updated:
        return tts(UNAVAILABLE, collect="none")

    question = render(field, _ivr_config(form_json), answers)
    if preamble:
        question = {**question, "text": f"{preamble} {question['text']}"}
    return question


def _continue(session: Dict[str, Any], caller: Dict[str, Any],
              text: str) -> Dict[str, Any]:
    form_json = _definition(session)
    if form_json is None:
        sessions.finish(session["session_id"], sessions.EXPIRED)
        return tts(UNAVAILABLE, collect="none")

    return _answer(session, form_json, text)


def _answer(session: Dict[str, Any], form_json: Dict[str, Any],
            text: str) -> Dict[str, Any]:
    name = session.get("current_field") or ""
    field = next((f for f in form_json.get("fields") or []
                  if field_name(f) == name), None)
    if field is None:
        return _start_questions(session, form_json)

    answers = dict(session.get("answers") or {})
    config = _ivr_config(form_json)
    max_retries = config.get("max_retries") or 3

    retry_key = f"__retries_{name}"
    try:
        value = submission_service.validate_field(
            form_json, name, _one_value(field, _tidy(text), answers), answers)
    except submission_service.ValidationFailed as failed:
        problem = failed.errors.get(name) or "That input was not valid."
        retries = answers.get(retry_key, 0) + 1
        if retries >= max_retries:
            if not field.get("required"):
                answers.pop(retry_key, None)
                answers[name] = None
            else:
                sessions.finish(session["session_id"], sessions.EXPIRED)
                return tts("Too many invalid attempts. Your call is being ended. Goodbye.",
                           collect="none")
        else:
            answers[retry_key] = retries
            sessions.touch(
                session["session_id"], _timeout_seconds(session.get("project_id")),
                answers=answers)
            error_msg = _tidy(config.get("error_message")) or DEFAULT_ERROR
            question = render(field, config, answers)
            return {**question, "text": f"{error_msg} {problem} {question['text']}"}
    except KeyError:
        return _start_questions(session, form_json)
    else:
        answers[name] = value

    following = _next_question(form_json, answers)
    if following is None:
        session = {**session, "answers": answers}
        return _submit(session, form_json)

    updated = sessions.touch(
        session["session_id"], _timeout_seconds(session.get("project_id")),
        answers=answers, current_field=field_name(following))
    if not updated:
        return tts(UNAVAILABLE, collect="none")

    return render(following, config, answers)


def _submit(session: Dict[str, Any], form_json: Dict[str, Any]) -> Dict[str, Any]:
    from app.modules.forms import form_service

    answers = {k: v for k, v in (session.get("answers") or {}).items()
               if not k.startswith("__retries_")}

    try:
        form = form_service.get_form(session["form_id"])
        submission_service.submit(
            form, answers,
            created_by=f"ivr:{session['identity']}",
            channel="ivr",
            client_submission_id=session["session_id"],
            source_ref=f"ivr call",
            survey_id=session.get("survey_id"),
        )
    except submission_service.ValidationFailed as failed:
        first = next(iter(failed.errors.values()), "Could not save your answers.")
        return tts(f"{first} Your call is being ended. Goodbye.", collect="none")
    except Exception:
        logger.exception("IVR submission failed for %s", session["session_id"])
        return tts("Sorry, something went wrong saving your answers. Goodbye.",
                   collect="none")

    sessions.finish(session["session_id"], sessions.COMPLETED)

    config = _ivr_config(form_json)
    return tts(_tidy(config.get("completion_message")) or DEFAULT_COMPLETION,
               collect="none")
