"""Answers arriving from somewhere that is not this application's own form page.

    mobile ─┐
  whatsapp ─┼─> channel adapter ─> canonical answers ─> submission_service.submit
       ivr ─┘

An adapter does one job: turn what a channel happens to send into the answers
the form asks for. A phone sends a dict already; WhatsApp sends a conversation;
an IVR call sends keypresses. All three become the same `{field: answer}`.

What an adapter must never do is decide anything. Whether a field is required,
whether a condition makes it apply at all, whether a value is in the catalogue,
which version it is being validated against, whether the position is inside the
fence, what the survey id is — every one of those is the submission service's,
and stays there whatever the answers came in on. Three channels with three
notions of "required" is three products.

Channel is metadata: it says how an answer arrived, never what is allowed.
"""
import logging
from typing import Any, Dict, List, Optional

from app.core.database import transaction
from app.modules.forms.form_schema import field_name

logger = logging.getLogger(__name__)

CHANNELS = ("mobile", "whatsapp", "ivr", "web")


class ChannelError(ValueError):
    """The channel payload cannot be turned into answers."""


def _options_of(field: Dict[str, Any]) -> List[Any]:
    """The choices a field offers, as the definition holds them.

    A catalogue-backed field carries a reference rather than a copy, so its list
    here may be empty. That is not this module's problem to solve: the raw reply
    is passed through and the submission service validates it against the
    catalogue exactly as it would from any other channel. Copying catalogue
    values into three adapters is how three copies drift.
    """
    options = field.get("options") or []
    return [o.get("value") if isinstance(o, dict) else o for o in options]


def _one_answer(field: Dict[str, Any], raw: Any) -> Any:
    """One reply, as the answer to one question.

    A keypad and a chat reply both say "2" when they mean the second choice, so
    a number against a field that offers choices is read as a choice. Anything
    else is passed through untouched — including a value that happens to be
    numeric on a numeric question, which has no options to index into.
    """
    options = _options_of(field)
    if not options:
        return raw

    text = str(raw).strip()
    if text.isdigit():
        index = int(text)
        if 1 <= index <= len(options):
            return options[index - 1]

    # Said in full, or said in a way this cannot read — either way the
    # submission service decides whether it is a valid choice.
    return raw


def _asked_fields(form_json: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The questions, in the order the form asks them.

    The fields array is the order — the same order the form page renders and the
    conversation follows. Nothing here re-sorts it.
    """
    return [f for f in (form_json.get("fields") or []) if field_name(f)]


class ChannelAdapter:
    """Channel-specific input, canonical answers out. Nothing else."""

    channel = ""

    def answers(self, form_json: Dict[str, Any], payload: Any) -> Dict[str, Any]:
        raise NotImplementedError


class MobileAdapter(ChannelAdapter):
    """A mobile client already speaks the canonical shape.

        {"farmer_name": "Ramesh", "main_crop": "MAIZE"}
    """

    channel = "mobile"

    def answers(self, form_json: Dict[str, Any], payload: Any) -> Dict[str, Any]:
        if not isinstance(payload, dict):
            raise ChannelError("A mobile submission is an object of answers.")
        return dict(payload)


class WhatsAppAdapter(ChannelAdapter):
    """A conversation: one reply per question, in the order they were asked.

        {"messages": ["Ramesh", "1"]}

    or, where the channel tracked which question each reply answered:

        {"answers": {"farmer_name": "Ramesh", "main_crop": "1"}}

    Named replies are used when they are there, because a conversation that
    doubled back is not in question order any more.
    """

    channel = "whatsapp"

    def answers(self, form_json: Dict[str, Any], payload: Any) -> Dict[str, Any]:
        if not isinstance(payload, dict):
            raise ChannelError("A WhatsApp submission is an object.")

        fields = _asked_fields(form_json)
        by_name = {field_name(f): f for f in fields}

        named = payload.get("answers")
        if isinstance(named, dict):
            return {name: _one_answer(by_name[name], value)
                    for name, value in named.items() if name in by_name}

        messages = payload.get("messages")
        if not isinstance(messages, list):
            raise ChannelError(
                "A WhatsApp submission carries either 'answers' or 'messages'.")
        if len(messages) > len(fields):
            raise ChannelError(
                f"This form asks {len(fields)} questions; {len(messages)} replies "
                "arrived.")

        return {field_name(field): _one_answer(field, reply)
                for field, reply in zip(fields, messages)}


class IVRAdapter(ChannelAdapter):
    """A phone call: keypresses, in the order the questions were read out.

        {"digits": ["1", "2"]}
        {"digits": {"main_crop": "1"}}

    A keypress is a choice. A question with no choices cannot be answered from a
    keypad in any useful way, and whatever arrives is passed on for the
    submission service to accept or refuse — an IVR call must not be the one
    place in the system that quietly drops an answer.
    """

    channel = "ivr"

    def answers(self, form_json: Dict[str, Any], payload: Any) -> Dict[str, Any]:
        if not isinstance(payload, dict):
            raise ChannelError("An IVR submission is an object.")

        digits = payload.get("digits")
        if digits is None:
            raise ChannelError("An IVR submission carries 'digits'.")

        fields = _asked_fields(form_json)
        by_name = {field_name(f): f for f in fields}

        if isinstance(digits, dict):
            return {name: _one_answer(by_name[name], value)
                    for name, value in digits.items() if name in by_name}

        if not isinstance(digits, list):
            raise ChannelError("'digits' is a list of keypresses, or an object.")
        if len(digits) > len(fields):
            raise ChannelError(
                f"This form asks {len(fields)} questions; {len(digits)} keypresses "
                "arrived.")

        return {field_name(field): _one_answer(field, pressed)
                for field, pressed in zip(fields, digits)}


class WebAdapter(MobileAdapter):
    """This application's own form page. The same canonical shape."""

    channel = "web"


ADAPTERS: Dict[str, ChannelAdapter] = {
    a.channel: a for a in (MobileAdapter(), WhatsAppAdapter(), IVRAdapter(), WebAdapter())
}


def adapter(channel: str) -> ChannelAdapter:
    found = ADAPTERS.get((channel or "").strip().lower())
    if found is None:
        raise ChannelError(
            f"There is no '{channel}' channel. Known: {', '.join(sorted(ADAPTERS))}.")
    return found


def normalize(channel: str, form_json: Dict[str, Any], payload: Any) -> Dict[str, Any]:
    """Whatever one channel sent, as the answers this form asks for."""
    return adapter(channel).answers(form_json or {}, payload)


def check_version(form: Dict[str, Any], claimed: Optional[int]) -> None:
    """Refuse answers collected against a version that is no longer live.

    A channel is given a published configuration and collects against it. If the
    form has moved on since, those answers describe questions that may not exist
    any more — validating them against the current definition would quietly
    reinterpret them. Better to say so and let the channel fetch the current
    configuration.
    """
    if claimed is None:
        return

    from app.modules.forms.publishing import published_version

    live = published_version(form)
    if int(claimed) != live:
        from app.modules.forms.submission_service import ValidationFailed

        raise ValidationFailed({
            "_form_version": (
                f"These answers were collected against version {claimed} of this "
                f"form, and version {live} is live now. Fetch the published "
                "configuration again and resend them."
            )})


def record_channel(form_id: str, survey_id: str, channel: str) -> None:
    """How one submission arrived, kept beside it.

    Its own row rather than a column in `form_data`, which is answers, and
    rather than a column on every form's table, which would be a migration for
    every form to store one word. Defensive on purpose: a submission that is
    already stored must not fail because a note about it could not be.
    """
    if not channel or channel == "web":
        return
    try:
        with transaction() as cur:
            cur.execute(
                "INSERT INTO submission_channel (form_id, survey_id, channel) "
                "VALUES (%s, %s, %s) ON CONFLICT (form_id, survey_id) DO NOTHING",
                (form_id, survey_id, channel),
            )
    except Exception:
        logger.exception("Could not record the channel for %s", survey_id)


def channel_of(form_id: str, survey_id: str) -> str:
    with transaction() as cur:
        cur.execute(
            "SELECT channel FROM submission_channel WHERE form_id = %s AND survey_id = %s",
            (form_id, survey_id),
        )
        row = cur.fetchone()
    return row["channel"] if row else "web"
