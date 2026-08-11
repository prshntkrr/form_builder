"""Field type registry.

Answers three questions for every supported field type:
  * how a submitted value is validated and coerced to a Python value,
  * how that value is normalized for storage in the `form_data` JSONB column,
  * whether the type carries a list of options.

Answers are never spread across typed columns — every form table has the same
six envelope columns and the whole response lives in `form_data`. The coercion
here is what keeps that JSONB clean and queryable: numbers stored as numbers,
booleans as booleans, dates as ISO strings.
"""
import re
from dataclasses import dataclass, field as dc_field
from datetime import date, datetime, time
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Dict, List, Optional


class FieldValueError(ValueError):
    """Raised when a submitted value cannot be coerced to the field's type."""


# --------------------------------------------------------------------------- #
# coercers
# --------------------------------------------------------------------------- #
def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


def _to_str(value: Any) -> Optional[str]:
    if _blank(value):
        return None
    return str(value).strip()


def _to_int(value: Any) -> Optional[int]:
    if _blank(value):
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        raise FieldValueError(f"'{value}' is not a whole number")


def _to_decimal(value: Any) -> Optional[Decimal]:
    if _blank(value):
        return None
    try:
        return Decimal(str(value).strip())
    except (TypeError, InvalidOperation):
        raise FieldValueError(f"'{value}' is not a number")


def _to_bool(value: Any) -> Optional[bool]:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ("true", "1", "yes", "y", "on"):
        return True
    if text in ("false", "0", "no", "n", "off"):
        return False
    raise FieldValueError(f"'{value}' is not a yes/no value")


def _to_date(value: Any) -> Optional[date]:
    if _blank(value):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value).strip()[:10])
    except ValueError:
        raise FieldValueError(f"'{value}' is not a date (expected YYYY-MM-DD)")


def _to_datetime(value: Any) -> Optional[datetime]:
    if _blank(value):
        return None
    if isinstance(value, datetime):
        return value
    text = str(value).strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        raise FieldValueError(f"'{value}' is not a date/time")


def _to_time(value: Any) -> Optional[time]:
    if _blank(value):
        return None
    if isinstance(value, time):
        return value
    try:
        return time.fromisoformat(str(value).strip())
    except ValueError:
        raise FieldValueError(f"'{value}' is not a time (expected HH:MM)")


def _to_list(value: Any) -> Optional[List[Any]]:
    """Multi-value answers are always stored as a JSON array."""
    if value is None or value == "" or value == []:
        return None
    if isinstance(value, list):
        return [v for v in value if v not in (None, "")]
    return [value]


def _to_object(value: Any) -> Optional[Dict[str, Any]]:
    """Structured answers (a GPS point, say) are stored as a JSON object."""
    if value is None or value == "" or value == {}:
        return None
    if isinstance(value, dict):
        cleaned = {k: v for k, v in value.items() if v not in (None, "")}
        return cleaned or None
    raise FieldValueError(f"'{value}' is not a valid location")


def _to_email(value: Any) -> Optional[str]:
    text = _to_str(value)
    if text and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", text):
        raise FieldValueError(f"'{text}' is not a valid email address")
    return text


# --------------------------------------------------------------------------- #
# registry
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class FieldType:
    name: str
    coerce: Callable[[Any], Any]
    json_type: str           # how it appears inside form_data
    has_options: bool = False
    multi: bool = False
    # Whether min_length / max_length count digits rather than characters. True
    # for anything people describe by its digit count — a 12-digit ID, a 10-digit
    # mobile number — so separators and spacing don't eat into the limit.
    counts_digits: bool = False
    aliases: List[str] = dc_field(default_factory=list)


_TYPES: List[FieldType] = [
    FieldType("text", _to_str, "string", aliases=["string", "shorttext", "short_text"]),
    FieldType("textarea", _to_str, "string", aliases=["longtext", "long_text", "paragraph"]),
    FieldType("email", _to_email, "string"),
    FieldType("phone", _to_str, "string", counts_digits=True, aliases=["tel", "mobile"]),
    FieldType("url", _to_str, "string", aliases=["link"]),
    FieldType("number", _to_int, "number", counts_digits=True, aliases=["integer", "int"]),
    FieldType("decimal", _to_decimal, "number", counts_digits=True,
              aliases=["float", "double", "currency", "money"]),
    FieldType("rating", _to_int, "number", counts_digits=True, aliases=["scale", "stars"]),
    FieldType("date", _to_date, "string (YYYY-MM-DD)"),
    FieldType("datetime", _to_datetime, "string (ISO 8601)",
              aliases=["timestamp", "datetime-local"]),
    FieldType("time", _to_time, "string (HH:MM:SS)"),
    FieldType("boolean", _to_bool, "boolean",
              aliases=["checkbox", "toggle", "switch", "yesno"]),
    FieldType("select", _to_str, "string", has_options=True, aliases=["dropdown", "combobox"]),
    FieldType("radio", _to_str, "string", has_options=True,
              aliases=["radiogroup", "radio_group", "option"]),
    FieldType("multiselect", _to_list, "array", has_options=True, multi=True,
              aliases=["checkboxgroup", "checkbox_group", "checkboxes",
                       "multi_select", "multiple"]),
    FieldType("file", _to_str, "string", aliases=["upload", "image", "photo", "attachment"]),
    FieldType("signature", _to_str, "string"),
    FieldType("location", _to_object, "object {lat, lng}",
              aliases=["gps", "geo", "coordinates", "geopoint"]),
]

FIELD_TYPES: Dict[str, FieldType] = {t.name: t for t in _TYPES}


def _key(raw: Any) -> str:
    """Fold a type name so 'Multi-Select', 'multi_select' and 'multiselect' agree."""
    return re.sub(r"[^a-z0-9]", "", str(raw or "").lower())


_ALIAS_MAP: Dict[str, str] = {}
for _t in _TYPES:
    _ALIAS_MAP[_key(_t.name)] = _t.name
    for _a in _t.aliases:
        _ALIAS_MAP[_key(_a)] = _t.name

SUPPORTED_TYPES = sorted(FIELD_TYPES)
DEFAULT_TYPE = "text"


def normalize_type(raw: Any) -> str:
    """Map whatever the LLM produced onto a supported type name."""
    return _ALIAS_MAP.get(_key(raw), DEFAULT_TYPE)


def get_type(name: str) -> FieldType:
    return FIELD_TYPES.get(normalize_type(name), FIELD_TYPES[DEFAULT_TYPE])


def coerce_value(field_type: str, value: Any) -> Any:
    """Validate and coerce a submitted value. Raises FieldValueError."""
    return get_type(field_type).coerce(value)


def json_safe(value: Any) -> Any:
    """Render a coerced value as something `json.dumps` accepts, so it can go
    straight into the `form_data` JSONB column."""
    if isinstance(value, Decimal):
        # int when it is whole, so form_data holds 12 rather than 12.0
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, list):
        return [json_safe(v) for v in value]
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    return value
