"""The channels a form can be answered on, and which of them a form is open to.

    web       this application's own form page (and a public link to it)
    mobile    the field app
    whatsapp  a conversation
    ivr       a phone call

One list, here. Everything else that names a channel — the ingestion adapters,
keyword routing, the capability registry — reads it from this module rather
than keeping its own copy. (`app/core/gateway.py` keeps a literal of the same
four, because core must load with the forms module switched off; a test holds
the two lists together.)

Which channels a form is open to is part of the form's own definition, in
`form_json.channels`, so it is versioned, published and rolled back with the
questions it applies to:

    "channels": {"whatsapp": {"enabled": true}}

A channel the profile does not mention takes its default: web and mobile are
open, whatsapp and ivr are closed until somebody opens them. A form with no
profile at all — every form built before this existed — has all four defaults.

Two questions, deliberately kept apart:

    enabled(form_json, channel)   is this form offered on this channel?
    refusal(form_json, channel)   must a submission arriving on it be refused?

They differ only for a form with no profile. Such a form is *offered* on web
and mobile alone, but a submission arriving from WhatsApp or IVR is still
accepted, exactly as it was before profiles existed: the collection platform
already sends those, the tests hold it, and a form must not stop taking answers
because a setting it never had now exists. Once a form carries a profile, the
profile is the whole answer.
"""
from typing import Any, Dict, Optional

from app.modules.forms.field_types import FieldValueError, coerce_value

WEB, MOBILE, WHATSAPP, IVR = "web", "mobile", "whatsapp", "ivr"

#: Every channel, in the order they are shown.
CHANNELS = (WEB, MOBILE, WHATSAPP, IVR)

#: The channels a keyword or keypad menu option leads into. Web and mobile are
#: reached from a list of forms, not by typing a word.
ROUTED_CHANNELS = (WHATSAPP, IVR)

#: What a channel is when a form says nothing about it.
DEFAULTS: Dict[str, bool] = {WEB: True, MOBILE: True, WHATSAPP: False, IVR: False}

#: How a submission can be labelled without being a channel of its own. A
#: public link is this application's form page, opened without an account.
ALIASES: Dict[str, str] = {"public_web": WEB}

NAMES: Dict[str, str] = {WEB: "Web", MOBILE: "Mobile", WHATSAPP: "WhatsApp", IVR: "IVR"}

# --------------------------------------------------------------------------- #
# the channel a form is built for
# --------------------------------------------------------------------------- #
# A form is built for exactly one channel. Web and mobile are one choice — the
# same definition, drawn by the same builder, answered in a browser or the app.
#
#     "channel": "web_mobile" | "whatsapp" | "ivr"
#
# `channel` is the one value that says it. The per-channel `channels` profile
# above is *derived* from it by `normalize_form` (`profile_for`), so the
# submission path keeps a single rule for what a form accepts and there is no
# second copy of the choice to disagree with the first.
#
# A form with no `channel` is a legacy form: everything built before the choice
# existed, and anything created through the API without naming one. It keeps
# whatever `channels` profile it had — usually none, which is Web / Mobile — and
# `form_channel` reads it as the one channel it is closest to.
WEB_MOBILE = "web_mobile"
FORM_CHANNELS = (WEB_MOBILE, WHATSAPP, IVR)
FORM_CHANNEL_NAMES: Dict[str, str] = {
    WEB_MOBILE: "Web / Mobile", WHATSAPP: "WhatsApp", IVR: "IVR"}

#: Channels a form may be published on today. IVR has no builder yet, so an IVR
#: form can be drafted and kept, but not put live.
PUBLISHABLE = (WEB_MOBILE, WHATSAPP)

_PROFILES: Dict[str, Dict[str, bool]] = {
    WEB_MOBILE: {WEB: True, MOBILE: True, WHATSAPP: False, IVR: False},
    WHATSAPP: {WEB: False, MOBILE: False, WHATSAPP: True, IVR: False},
    IVR: {WEB: False, MOBILE: False, WHATSAPP: False, IVR: True},
}


def normalize_form_channel(raw: Any) -> Optional[str]:
    """The channel a form is built for, or None if it names none we know."""
    text = str(raw or "").strip().lower()
    return text if text in FORM_CHANNELS else None


def profile_for(form_channel: str) -> Dict[str, Dict[str, bool]]:
    """The per-channel profile a form built for one channel carries."""
    return {c: {"enabled": on} for c, on in _PROFILES[form_channel].items()}


def declared_channel(form_json: Optional[Dict[str, Any]]) -> Optional[str]:
    """The channel this form was created for, or None for a legacy form."""
    return normalize_form_channel((form_json or {}).get("channel"))


def form_channel(form_json: Optional[Dict[str, Any]]) -> str:
    """The one channel a form belongs to, for showing and for choosing a builder.

    A form that declares one is that. A legacy form is read from its profile: a
    form open on web or mobile is Web / Mobile — every form built before
    profiles existed — and one open on WhatsApp alone, or IVR alone, is that.
    """
    declared = declared_channel(form_json)
    if declared:
        return declared
    on = enabled_channels(form_json)
    if on[WEB] or on[MOBILE]:
        return WEB_MOBILE
    if on[WHATSAPP]:
        return WHATSAPP
    if on[IVR]:
        return IVR
    return WEB_MOBILE


def canonical(channel: Any) -> Optional[str]:
    """The channel a label means, or None if it is not one."""
    text = str(channel or "").strip().lower()
    text = ALIASES.get(text, text)
    return text if text in CHANNELS else None


def _flag(raw: Any, default: bool) -> bool:
    """A yes/no, read the way a boolean answer is read; anything else is the default."""
    try:
        value = coerce_value("boolean", raw)
    except FieldValueError:
        return default
    return default if value is None else value


def normalize_profile(raw: Any) -> Optional[Dict[str, Dict[str, bool]]]:
    """The channel profile, reduced to what this application understands.

    Only the four channels, each carrying only `enabled`, as a real boolean.
    Anything else — an unknown channel, an extra key, a token somebody pasted in —
    is dropped here, so nothing arbitrary can ride along inside a form
    definition that is published, exported and handed to phones.

    `{"whatsapp": true}` is read as `{"whatsapp": {"enabled": true}}`. A channel
    entry that says nothing usable about `enabled` takes that channel's default.
    Channels that were not mentioned stay unmentioned — defaults are applied when
    the profile is read, not written into it — so this is idempotent and a
    profile keeps the shape its author gave it.

    None when there is nothing left, so a form without a profile carries no key.
    """
    if not isinstance(raw, dict):
        return None

    profile: Dict[str, Dict[str, bool]] = {}
    for key, entry in raw.items():
        channel = str(key or "").strip().lower()
        if channel not in CHANNELS or channel in profile:
            continue
        said = entry.get("enabled") if isinstance(entry, dict) else entry
        profile[channel] = {"enabled": _flag(said, DEFAULTS[channel])}

    # Written in the canonical order, whatever order it arrived in.
    return {c: profile[c] for c in CHANNELS if c in profile} or None


def _profile(form_json: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    profile = (form_json or {}).get("channels")
    return profile if isinstance(profile, dict) else None


def enabled(form_json: Optional[Dict[str, Any]], channel: str) -> bool:
    """Whether this form is offered on this channel.

    Read defensively, as the stored definition says it: an unknown channel is
    never enabled, and an entry the profile does not have takes the default.
    """
    name = canonical(channel)
    if name is None:
        return False

    entry = (_profile(form_json) or {}).get(name)
    if isinstance(entry, dict) and "enabled" in entry:
        return _flag(entry.get("enabled"), DEFAULTS[name])
    return DEFAULTS[name]


def enabled_channels(form_json: Optional[Dict[str, Any]]) -> Dict[str, bool]:
    """Every channel and whether this form is offered on it."""
    return {c: enabled(form_json, c) for c in CHANNELS}


def refusal(form_json: Optional[Dict[str, Any]], channel: str) -> Optional[str]:
    """Why a submission arriving on this channel must be refused, or None.

    The message is safe to show to whoever sent it.
    """
    name = canonical(channel)
    if name is None:
        return f"'{channel}' is not a channel. Use one of: {', '.join(CHANNELS)}."

    if _profile(form_json) is None:
        # A form with no profile takes what it always took. See the module note.
        return None

    if not enabled(form_json, name):
        return f"This form is not open to answers on {NAMES[name]}."
    return None
