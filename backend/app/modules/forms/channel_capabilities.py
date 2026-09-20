"""Which kinds of question each channel can actually ask.

    field type ─> channel ─> supported | limited | unsupported

    supported     asked and answered the way the type means
    limited       answerable, in a narrower way — typed rather than picked, a
                  numbered list rather than a dropdown, a keypad date. The reason
                  says how
    unsupported   the channel has no way to collect it at all

The field types themselves are `field_types.FIELD_TYPES`; nothing here defines
one. This table only says, for each type that already exists, what each channel
can do with it. A type added to the registry without a row here is caught by a
test rather than quietly treated as askable, and a type this table has never
heard of is `unsupported` — a channel promising to collect something nobody has
thought about is how a form ends up unanswerable on it.

Mirrored in `frontend/src/modules/forms/channelCapabilities.js` so the builder
can say the same thing before anyone saves; a test compares the two.

`required_unreachable` is what publishing asks: can this channel complete this
form? It uses the condition engine as it is — `conditions.hidden` — to decide
which questions somebody on that channel could actually reach.
"""
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from app.modules.forms.channels import CHANNELS, IVR, MOBILE, NAMES, WEB, WHATSAPP
from app.modules.forms.field_types import FIELD_TYPES, resolve_type

SUPPORTED, LIMITED, UNSUPPORTED = "supported", "limited", "unsupported"
LEVELS = (SUPPORTED, LIMITED, UNSUPPORTED)


@dataclass(frozen=True)
class Capability:
    level: str
    reason: str = ""

    @property
    def usable(self) -> bool:
        """Whether an answer can be collected at all, however narrowly."""
        return self.level != UNSUPPORTED

    def as_dict(self) -> Dict[str, str]:
        return {"level": self.level, "reason": self.reason}


def _ok() -> Capability:
    return Capability(SUPPORTED)


def _limited(reason: str) -> Capability:
    return Capability(LIMITED, reason)


def _no(reason: str) -> Capability:
    return Capability(UNSUPPORTED, reason)


# Web and mobile draw the same definition with a full form, so they can ask
# everything the builder can make. Written out rather than defaulted, so a new
# type has to be thought about for every channel.
_FULL = {WEB: _ok(), MOBILE: _ok()}

_KEYPAD_TEXT = "a keypad cannot type words; this needs speech input"

CAPABILITIES: Dict[str, Dict[str, Capability]] = {
    "text": {**_FULL, WHATSAPP: _ok(), IVR: _no(_KEYPAD_TEXT)},
    "textarea": {**_FULL,
                 WHATSAPP: _limited("answered as a single message"),
                 IVR: _no(_KEYPAD_TEXT)},
    "email": {**_FULL, WHATSAPP: _ok(), IVR: _no(_KEYPAD_TEXT)},
    "phone": {**_FULL, WHATSAPP: _ok(), IVR: _ok()},
    "url": {**_FULL, WHATSAPP: _ok(), IVR: _no(_KEYPAD_TEXT)},
    "number": {**_FULL, WHATSAPP: _ok(), IVR: _ok()},
    "decimal": {**_FULL, WHATSAPP: _ok(),
                IVR: _limited("keyed in with * standing for the decimal point")},
    "rating": {**_FULL, WHATSAPP: _ok(), IVR: _ok()},
    "date": {**_FULL,
             WHATSAPP: _limited("typed as a date, e.g. 2026-09-18"),
             IVR: _limited("keyed in as DDMMYYYY")},
    "datetime": {**_FULL,
                 WHATSAPP: _limited("typed as a date and time"),
                 IVR: _limited("keyed in as DDMMYYYYHHMM")},
    "time": {**_FULL,
             WHATSAPP: _limited("typed as a time, e.g. 14:30"),
             IVR: _limited("keyed in as HHMM")},
    "boolean": {**_FULL, WHATSAPP: _ok(), IVR: _ok()},
    "select": {**_FULL,
               WHATSAPP: _ok(),
               IVR: _limited("read out as a menu; a keypad reaches nine choices")},
    "radio": {**_FULL,
              WHATSAPP: _ok(),
              IVR: _limited("read out as a menu; a keypad reaches nine choices")},
    "multiselect": {**_FULL,
                    WHATSAPP: _limited("chosen by replying with numbers, e.g. 1,3"),
                    IVR: _no("a call menu takes one choice at a time")},
    "file": {**_FULL,
             WHATSAPP: _limited("sent as an attachment in the chat"),
             IVR: _no("a call cannot carry a file")},
    "image": {**_FULL,
              WHATSAPP: _limited("sent as a photo in the chat"),
              IVR: _no("a call cannot carry a photo")},
    "audio": {**_FULL,
              WHATSAPP: _limited("sent as a voice note"),
              IVR: _limited("recorded during the call")},
    "signature": {**_FULL,
                  WHATSAPP: _no("a chat has nothing to sign on"),
                  IVR: _no("a call has nothing to sign on")},
    "location": {**_FULL,
                 WHATSAPP: _limited("shared as a WhatsApp location"),
                 IVR: _no("a call cannot report where the phone is")},
    "polygon": {**_FULL,
                WHATSAPP: _no("drawing a boundary needs a map"),
                IVR: _no("drawing a boundary needs a map")},
}


def capability(channel: str, field_type: Any) -> Capability:
    """What one channel can do with one kind of question.

    Aliases resolve the way the rest of the application resolves them ("dropdown"
    is a select). An unknown channel or an unknown type is unsupported — never a
    guess that it probably works.
    """
    if channel not in CHANNELS:
        return _no(f"'{channel}' is not a channel")

    name = resolve_type(field_type)
    row = CAPABILITIES.get(name or "")
    if row is None or channel not in row:
        return _no(f"'{field_type}' is not a question type this channel knows")
    return row[channel]


def supports(channel: str, field_type: Any) -> bool:
    """Whether this channel can collect an answer of this type at all."""
    return capability(channel, field_type).usable


def missing_entries() -> List[str]:
    """Every registered type/channel pair with no capability. Empty when complete."""
    return [f"{t}/{c}" for t in FIELD_TYPES for c in CHANNELS
            if c not in CAPABILITIES.get(t, {})]


# --------------------------------------------------------------------------- #
# can this channel complete this form?
# --------------------------------------------------------------------------- #
def _number(value: Any) -> Optional[float]:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


_OTHER = "__not_a_value_any_rule_compares_against__"


def _making_true(condition: Dict[str, Any]) -> Any:
    """An answer that makes this condition hold, or `_OTHER` if none is obvious."""
    operator = str(condition.get("operator") or "").strip()
    wanted = condition.get("value")
    number = _number(wanted)

    if operator in ("equals", "contains"):
        return wanted
    if operator == "is_empty":
        return None
    if operator == "is_not_empty":
        return _OTHER
    if operator in ("not_equals", "not_contains"):
        return _OTHER
    if operator in ("greater_than", "greater_than_or_equal") and number is not None:
        return number + 1
    if operator in ("less_than", "less_than_or_equal") and number is not None:
        return number - 1
    return _OTHER


def _making_false(condition: Dict[str, Any]) -> Any:
    """An answer that makes this condition fail."""
    operator = str(condition.get("operator") or "").strip()
    if operator in ("is_empty", "not_equals", "not_contains"):
        return condition.get("value") if operator != "is_empty" else _OTHER
    return None


def reachable_fields(form_json: Dict[str, Any], answerable: set) -> set:
    """The questions somebody could be shown, answering only `answerable` ones.

    Tried rather than solved. `conditions.hidden` — the engine the form page and
    the submission service use — is asked about a handful of answer sets: none at
    all; each rule made to hold; each rule made to fail; and every rule made to
    hold at once. A question visible in any of them is reachable.

    A question the channel cannot answer is never given an answer in any of
    these, so a question shown only once an unaskable one is answered is — right
    — unreachable on that channel.

    ponytail: probing, not a solver. It errs towards "reachable", which errs
    towards refusing a channel rather than publishing a form that channel
    cannot finish. Upgrade to real constraint solving if a legitimate form is
    ever refused because of it.
    """
    from app.modules.forms import conditions
    from app.modules.forms.form_schema import field_name

    names = {field_name(f) for f in form_json.get("fields") or [] if field_name(f)}
    rules = [r for r in (form_json.get("rules") or []) if isinstance(r, dict)]

    def answers_for(rule: Dict[str, Any], hold: bool) -> List[Dict[str, Any]]:
        conds = [c for c in (rule.get("conditions") or []) if isinstance(c, dict)]
        pick = _making_true if hold else _making_false
        pairs = [(str(c.get("field") or ""), pick(c)) for c in conds]
        pairs = [(n, v) for n, v in pairs if n in answerable]
        any_one = str(rule.get("logic") or "").upper() == "OR"
        # Holding an OR needs one condition, failing an AND needs one; the others
        # need all of them at once.
        if any_one == hold:
            return [{n: v} for n, v in pairs]
        return [dict(pairs)]

    probes: List[Dict[str, Any]] = [{}]
    together: Dict[str, Any] = {}
    for rule in rules:
        holding = answers_for(rule, True)
        probes.extend(holding)
        probes.extend(answers_for(rule, False))
        for answers in holding[:1]:
            together.update(answers)
    probes.append(together)

    seen: set = set()
    for answers in probes:
        seen |= names - set(conditions.hidden(form_json, answers)["fields"])
        if seen >= names:
            break
    return seen


def required_unreachable(form_json: Dict[str, Any], channel: str) -> List[Dict[str, Any]]:
    """The required questions a channel would reach and could not ask.

    Each is `{index, name, label, type, reason}`. Empty means this channel can
    complete the form. An optional question it cannot ask is not listed: it is
    skipped on that channel, and the answer is simply absent.
    """
    from app.modules.forms.form_schema import field_name

    fields = [f for f in form_json.get("fields") or [] if isinstance(f, dict)]
    answerable = {field_name(f) for f in fields
                  if field_name(f) and supports(channel, f.get("type") or "text")}
    reachable = reachable_fields(form_json, answerable)

    found = []
    for index, field in enumerate(fields):
        name = field_name(field)
        if not name or not field.get("required") or name not in reachable:
            continue
        can = capability(channel, field.get("type") or "text")
        if can.usable:
            continue
        found.append({
            "index": index,
            "name": name,
            "label": field.get("label") or name,
            "type": field.get("type") or "text",
            "reason": can.reason,
            "channel": NAMES.get(channel, channel),
        })
    return found


# --------------------------------------------------------------------------- #
# how WhatsApp asks each kind of question
# --------------------------------------------------------------------------- #
# The level above says *whether* WhatsApp can ask a question; this says *how*.
# A WhatsApp form's builder picks one of these per question, and the form is
# refused if it picks one the question cannot be asked as.
#
#     text      a typed reply                    names, dates, email…
#     number    a typed number                   quantities, ratings
#     buttons   reply buttons                    up to 3 fixed choices
#     list      an interactive list              up to 10 fixed choices
#     numbered  a numbered menu, reply with 1-n  any number of choices
#     media     a photo, voice note or document
#     location  a shared WhatsApp location
#
# The limits are WhatsApp's own (Picky Assist, interactive messages: at most 3
# reply buttons, at most 10 list rows). A catalogue-backed question has no fixed
# length when the form is built, so it is only offered as a numbered menu — the
# one presentation that fits a list of any size.
TEXT_REPLY, NUMBER_REPLY, BUTTONS, LIST, NUMBERED, MEDIA, LOCATION_SHARE = (
    "text", "number", "buttons", "list", "numbered", "media", "location")
WHATSAPP_INTERACTIONS = (TEXT_REPLY, NUMBER_REPLY, BUTTONS, LIST, NUMBERED,
                         MEDIA, LOCATION_SHARE)
MAX_BUTTONS = 3
MAX_LIST_ROWS = 10

# In order of preference: the first allowed one is the default.
_WHATSAPP_BY_TYPE: Dict[str, tuple] = {
    "text": (TEXT_REPLY,), "textarea": (TEXT_REPLY,), "email": (TEXT_REPLY,),
    "phone": (TEXT_REPLY,), "url": (TEXT_REPLY,),
    "date": (TEXT_REPLY,), "datetime": (TEXT_REPLY,), "time": (TEXT_REPLY,),
    "number": (NUMBER_REPLY,), "decimal": (NUMBER_REPLY,), "rating": (NUMBER_REPLY,),
    "boolean": (BUTTONS, NUMBERED),
    "select": (BUTTONS, LIST, NUMBERED), "radio": (BUTTONS, LIST, NUMBERED),
    "multiselect": (NUMBERED,),
    "file": (MEDIA,), "image": (MEDIA,), "audio": (MEDIA,),
    "location": (LOCATION_SHARE,),
    "signature": (), "polygon": (),
}


def _choice_count(field: Dict[str, Any]) -> Optional[int]:
    """How many choices a question offers, or None if that is not known yet."""
    if resolve_type(field.get("type") or "text") == "boolean":
        return 2
    if field.get("options_from"):
        return None
    return len(field.get("options") or [])


def whatsapp_interactions(field: Dict[str, Any]) -> List[str]:
    """The ways WhatsApp can ask this question, best first. Empty: it cannot."""
    name = resolve_type(field.get("type") or "text")
    allowed = list(_WHATSAPP_BY_TYPE.get(name or "", ()))
    count = _choice_count(field)

    if BUTTONS in allowed and (count is None or count > MAX_BUTTONS):
        allowed.remove(BUTTONS)
    if LIST in allowed and (count is None or count > MAX_LIST_ROWS):
        allowed.remove(LIST)
    return allowed


def default_whatsapp_interaction(field: Dict[str, Any]) -> Optional[str]:
    allowed = whatsapp_interactions(field)
    return allowed[0] if allowed else None
