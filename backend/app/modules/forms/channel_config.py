"""How a form built for one channel is presented on it.

The questions are the form's own — `fields`, with their names, types, choices,
catalogue references and rules. This is only what a channel adds on top, keyed
by those same field names:

    "channel_config": {
      "whatsapp": {
        "welcome_message":    "Welcome to the farmer survey",
        "order":              ["farmer_name", "crop", "area"],
        "fields": {
          "crop": {"prompt": "What crop do you grow?", "interaction": "list"}
        },
        "review":             true,
        "completion_message": "Thank you!"
      }
    }

Nothing here copies a question: no label, no type, no options, no catalogue
values. A choice asked as a list still answers with the option's own value, and
a catalogue question still reads its catalogue. And nothing here may hold
anything else — no numbers, no tokens, no provider settings: those belong to the
gateway, never to a definition that is published and handed out.

`normalize` cleans the shape but keeps every field reference as it was given, so
`problems` can refuse one that names a question the form does not have, rather
than quietly forgetting it.
"""
from typing import Any, Dict, List, Optional

from app.modules.forms.channels import _flag

#: WhatsApp's own limit on a message body carrying buttons or a list.
MAX_MESSAGE = 1024


def _text(raw: Any) -> str:
    return str(raw).strip()[:MAX_MESSAGE] if isinstance(raw, (str, int, float)) else ""


def _normalize_whatsapp(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None

    config: Dict[str, Any] = {}
    for key in ("welcome_message", "completion_message"):
        text = _text(raw.get(key))
        if text:
            config[key] = text

    if "review" in raw:
        config["review"] = _flag(raw.get("review"), False)

    order: List[str] = []
    for name in raw.get("order") if isinstance(raw.get("order"), list) else []:
        name = str(name).strip() if isinstance(name, str) else ""
        if name and name not in order:
            order.append(name)
    if order:
        config["order"] = order

    fields: Dict[str, Dict[str, str]] = {}
    for name, entry in (raw.get("fields") if isinstance(raw.get("fields"), dict) else {}).items():
        if not isinstance(entry, dict):
            continue
        cleaned = {}
        prompt = _text(entry.get("prompt"))
        if prompt:
            cleaned["prompt"] = prompt
        interaction = str(entry.get("interaction") or "").strip().lower()
        if interaction:
            cleaned["interaction"] = interaction
        if cleaned:
            fields[str(name).strip()] = cleaned
    if fields:
        config["fields"] = fields

    return config or None


def normalize(raw: Any) -> Optional[Dict[str, Any]]:
    """The channel configuration, in the only shape it may take. None if empty."""
    if not isinstance(raw, dict):
        return None
    whatsapp = _normalize_whatsapp(raw.get("whatsapp"))
    return {"whatsapp": whatsapp} if whatsapp else None


def whatsapp_problems(form_json: Dict[str, Any]) -> List[Dict[str, str]]:
    """What is wrong with this form's WhatsApp configuration. Empty when nothing.

    Each problem is `{path, message}`. A reference to a question the form does
    not have, an interaction WhatsApp does not have, or one this question cannot
    be asked as — five choices as three buttons, a boundary at all.
    """
    from app.modules.forms import channel_capabilities as caps
    from app.modules.forms.form_schema import field_name

    config = ((form_json.get("channel_config") or {}).get("whatsapp")) or {}
    if not isinstance(config, dict):
        return []

    by_name = {field_name(f): f for f in form_json.get("fields") or []
               if isinstance(f, dict) and field_name(f)}
    found: List[Dict[str, str]] = []

    for i, name in enumerate(config.get("order") or []):
        if name not in by_name:
            found.append({"path": f"channel_config.whatsapp.order.{i}",
                          "message": f"'{name}' is not a question on this form"})

    for name, entry in (config.get("fields") or {}).items():
        path = f"channel_config.whatsapp.fields.{name}"
        field = by_name.get(name)
        if field is None:
            found.append({"path": path,
                          "message": f"'{name}' is not a question on this form"})
            continue

        label = field.get("label") or name
        interaction = (entry or {}).get("interaction")
        if not interaction:
            continue
        if interaction not in caps.WHATSAPP_INTERACTIONS:
            found.append({"path": f"{path}.interaction", "message": (
                f"'{interaction}' is not a WhatsApp interaction "
                f"({', '.join(caps.WHATSAPP_INTERACTIONS)})")})
            continue

        allowed = caps.whatsapp_interactions(field)
        if not allowed:
            reason = caps.capability("whatsapp", field.get("type") or "text").reason
            found.append({"path": f"{path}.interaction",
                          "message": f"'{label}' cannot be asked on WhatsApp — {reason}"})
        elif interaction not in allowed:
            found.append({"path": f"{path}.interaction", "message": (
                f"'{label}' cannot be asked as {interaction} on WhatsApp. "
                f"Use {' or '.join(allowed)}.")})
    return found
