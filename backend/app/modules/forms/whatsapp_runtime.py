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
from typing import Any, Dict, List, Optional, Tuple

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
def _choices(field: Dict[str, Any]) -> List[Tuple[str, str]]:
    """The choices to number, as `(label, value)`.

    Yes/No for a boolean is this module's own: the definition has no options for
    one, because "true" and "false" are how it is *stored*, not how a person is
    asked. Everything else is the field's own list, exactly as stored — a
    catalogue-backed question has none written down and is answered by typing.
    """
    if resolve_type(field.get("type") or "text") == "boolean":
        return [("Yes", "yes"), ("No", "no")]

    found = []
    for option in field.get("options") or []:
        if isinstance(option, dict):
            found.append((str(option.get("label") or option.get("value") or ""),
                          str(option.get("value") or "")))
        else:
            found.append((str(option), str(option)))
    return [c for c in found if c[1]]


def render(field: Dict[str, Any], config: Dict[str, Any]) -> str:
    """One question as a WhatsApp message.

    The prompt the author wrote, or the question's label. Then, for a question
    with choices, the choices numbered — which is the presentation every
    interaction degrades to in plain text, and the one the adapter reads back.

    The hint at the end is what the *type* needs, taken from the capability
    registry's reason where there is one, so a date says how to write a date
    without this file keeping its own table of formats.
    """
    name = field_name(field)
    entry = (config.get("fields") or {}).get(name) or {}
    prompt = _tidy(entry.get("prompt")) or field.get("label") or name

    lines = [f"*{prompt}*"]

    choices = _choices(field)
    if choices:
        lines.append("")
        lines.extend(f"{i}. {label}" for i, (label, _) in enumerate(choices, 1))
        spec = get_type(field.get("type") or "text")
        lines.append("")
        lines.append("_Reply with the number"
                     + (" — several separated by commas, e.g. 1,3_" if spec.multi
                        else ", or type the option_"))
    else:
        hint = caps.capability("whatsapp", field.get("type") or "text").reason
        if hint:
            lines.append(f"\n_{hint}_")

    if not field.get("required"):
        lines.append("\n_Reply SKIP to leave this blank._")

    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# reading a reply back
# --------------------------------------------------------------------------- #
def _one_value(field: Dict[str, Any], text: str) -> Any:
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
    """The account this number belongs to, or None.

    A phone number is not an account. `channel_identity` is where a number
    becomes an identity, and every authorisation below is decided against the
    account it names — never against the number.
    """
    return routing.user_for_identity("whatsapp", identity)


def _timeout(project_id: Optional[str]) -> int:
    return channel_settings.timeout_seconds(project_id)


# --------------------------------------------------------------------------- #
# the conversation
# --------------------------------------------------------------------------- #
def reply(identity: str, receiver: str, text: str) -> Optional[str]:
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
            return ("Stopped. Nothing further has been recorded. Send the "
                    "keyword again when you are ready.")
        return "There is nothing in progress."

    caller = _caller(identity)
    if caller is None:
        # An unrecognised number is told what an unknown keyword is told.
        if session:
            # The link was removed mid-conversation. Stop rather than carry on
            # collecting for an account that no longer claims this number.
            sessions.finish(session["session_id"], sessions.EXPIRED)
        return UNAVAILABLE

    if session:
        return _continue(session, caller, text)

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
        return ("That word means more than one thing here. Please check with "
                "your programme contact.")
    except routing.RoutingError:
        return UNAVAILABLE

    if not resolved.get("matched"):
        return _menu(caller, receiver)

    session = sessions.start(
        identity, receiver, resolved, caller.get("user_id") or "",
        _timeout(resolved.get("project_id")))

    form_json = _definition(session)
    if form_json is None:
        sessions.finish(session["session_id"], sessions.EXPIRED)
        return UNAVAILABLE

    return _welcome_and_consent(session, form_json, resolved["form_title"])


def _menu(caller: Dict[str, Any], receiver: str) -> str:
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
        return UNAVAILABLE

    lines = ["*Available surveys*", ""]
    lines += [f"{i}. {o['form_title']} — send *{o['route_key']}*"
              for i, o in enumerate(offers, 1)]
    lines += ["", "_Send the keyword for the one you want._"]
    return "\n".join(lines)


def _welcome_and_consent(session: Dict[str, Any], form_json: Dict[str, Any],
                         title: str) -> str:
    """The first message: the welcome, then the consent question.

    Sent together as one message rather than two, because two messages is two
    deliveries and the second can arrive first. The keyword never goes straight
    to a question — that is the point of the consent step.

    A form that configures no consent question is not asking for consent: the
    welcome is sent and the first question comes with it.
    """
    config = _whatsapp_config(form_json)
    welcome = _tidy(config.get("welcome_message")) or DEFAULT_WELCOME.format(title=title)
    consent = _tidy(config.get("consent_message"))

    if not consent:
        return _start_questions(session, form_json, preamble=welcome)

    return f"{welcome}\n\n{consent}\n\n_Reply YES to continue, or NO to stop._"


def _start_questions(session: Dict[str, Any], form_json: Dict[str, Any],
                     preamble: str = "") -> str:
    """Consent given (or never asked): move to the questions and ask the first."""
    answers = session.get("answers") or {}
    field = _next_question(form_json, answers)

    if field is None:
        # A form with nothing WhatsApp can ask. Not publishable if anything
        # required is unaskable, so this is an empty or wholly optional form.
        return _submit(session, form_json)

    updated = sessions.touch(
        session["session_id"], _timeout(session.get("project_id")),
        state=sessions.QUESTIONS, consent=True, current_field=field_name(field))
    if not updated:
        return UNAVAILABLE

    question = render(field, _whatsapp_config(form_json))
    return f"{preamble}\n\n{question}" if preamble else question


def _continue(session: Dict[str, Any], caller: Dict[str, Any], text: str) -> str:
    """The next reply of a conversation already under way."""
    form_json = _definition(session)
    if form_json is None:
        sessions.finish(session["session_id"], sessions.EXPIRED)
        return UNAVAILABLE

    if session["state"] == sessions.CONSENT:
        return _consent_reply(session, form_json, text)
    return _answer(session, form_json, text)


def _consent_reply(session: Dict[str, Any], form_json: Dict[str, Any],
                   text: str) -> str:
    config = _whatsapp_config(form_json)
    word = _word(text)

    if word in NO_WORDS:
        sessions.finish(session["session_id"], sessions.DECLINED)
        return _tidy(config.get("decline_message")) or DEFAULT_DECLINE

    if word not in YES_WORDS:
        consent = _tidy(config.get("consent_message")) or DEFAULT_CONSENT
        return f"Sorry, I did not understand that.\n\n{consent}\n\n_Reply YES or NO._"

    return _start_questions(session, form_json)


def _answer(session: Dict[str, Any], form_json: Dict[str, Any], text: str) -> str:
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

    if _word(text) == "skip" and not field.get("required"):
        answers[name] = None
    else:
        try:
            value = submission_service.validate_field(
                form_json, name, _one_value(field, _tidy(text)), answers)
        except submission_service.ValidationFailed as failed:
            problem = failed.errors.get(name) or "That answer cannot be used."
            return f"⚠️ {problem}\n\n{render(field, config)}"
        except KeyError:
            return _start_questions(session, form_json)
        answers[name] = value

    following = _next_question(form_json, answers)
    if following is None:
        session = {**session, "answers": answers}
        return _submit(session, form_json)

    updated = sessions.touch(
        session["session_id"], _timeout(session.get("project_id")),
        answers=answers, current_field=field_name(following))
    if not updated:
        return UNAVAILABLE

    return render(following, config)


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
        )
    except submission_service.ValidationFailed as failed:
        # Every answer passed on its way in, so this is the whole-form pass
        # objecting — a required question the conversation never reached, or a
        # cross-field rule. The session stays alive so the person can correct it
        # rather than losing what they typed.
        logger.warning("WhatsApp submission refused for %s: %s",
                       session["session_id"], failed.errors)
        first = next(iter(failed.errors.values()), "That could not be saved.")
        return f"⚠️ {first}\n\nReply CANCEL to stop, or send the keyword to start again."
    except Exception:
        logger.exception("WhatsApp submission failed for %s", session["session_id"])
        return ("Sorry, something went wrong saving your answers. Please try "
                "again shortly.")

    sessions.finish(session["session_id"], sessions.COMPLETED,
                    survey_id=stored.get("survey_id"))

    config = _whatsapp_config(form_json)
    return _tidy(config.get("completion_message")) or DEFAULT_COMPLETION
