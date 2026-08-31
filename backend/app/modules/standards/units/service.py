"""Converting a measurement from one unit to another.

Deterministic arithmetic against the `unit` table. No model is asked to do this:
a conversion is a fact, and a plausible-looking wrong number is worse here than
an error.

Two units convert only within one dimension — 100 cm is 1 m, and 100 cm is not
any number of kilograms. Everything goes through the dimension's base unit:

    base  = value * factor + offset
    value = (base - offset) / factor

Decimal throughout, because 100 cm has to come back as exactly 1 m rather than
0.9999999999999999.

This module knows nothing about the standards. ICASA recording plant height in
metres and Crop Ontology recording it in centimetres are both correct; neither
is rewritten, and neither calls in here.
"""
import logging
from decimal import Decimal, DivisionByZero, InvalidOperation
from typing import Any, Dict, List, Optional

from app.core.database import transaction

logger = logging.getLogger(__name__)


class UnknownUnit(ValueError):
    """The unit is not one this installation holds."""


class IncompatibleUnits(ValueError):
    """Both units are known, but they do not measure the same thing."""


# The units a fresh database starts with. Seeded once and never overwritten, so
# an installation can correct or extend the table and keep its changes.
#
#   (code, name, dimension, factor, offset, aliases, is_base)
SEED_UNITS = [
    ("m", "metre", "length", "1", "0", ["meter", "metres", "meters"], True),
    ("cm", "centimetre", "length", "0.01", "0", ["centimeter", "centimetres", "centimeters", "cms"], False),
    ("mm", "millimetre", "length", "0.001", "0", ["millimeter", "millimetres", "millimeters"], False),
    ("km", "kilometre", "length", "1000", "0", ["kilometer", "kilometres", "kilometers"], False),
    ("in", "inch", "length", "0.0254", "0", ["inches"], False),
    ("ft", "foot", "length", "0.3048", "0", ["feet"], False),

    ("kg", "kilogram", "mass", "1", "0", ["kilograms", "kilogramme"], True),
    ("g", "gram", "mass", "0.001", "0", ["grams", "gramme"], False),
    ("mg", "milligram", "mass", "0.000001", "0", ["milligrams"], False),
    ("t", "tonne", "mass", "1000", "0", ["ton", "tonnes", "mt"], False),
    ("lb", "pound", "mass", "0.45359237", "0", ["lbs", "pounds"], False),

    ("m2", "square metre", "area", "1", "0", ["sqm", "m^2", "square meter"], True),
    ("ha", "hectare", "area", "10000", "0", ["hectares"], False),
    ("km2", "square kilometre", "area", "1000000", "0", ["sqkm", "km^2"], False),
    ("acre", "acre", "area", "4046.8564224", "0", ["acres", "ac"], False),

    ("l", "litre", "volume", "1", "0", ["liter", "litres", "liters"], True),
    ("ml", "millilitre", "volume", "0.001", "0", ["milliliter", "millilitres"], False),
    ("m3", "cubic metre", "volume", "1000", "0", ["cubic meter", "m^3"], False),

    # Yield, the way a field records it. Its own dimension: kg/ha converts to
    # t/ha and to nothing else.
    ("kg/ha", "kilograms per hectare", "mass_per_area", "1", "0", ["kgha", "kg per ha"], True),
    ("t/ha", "tonnes per hectare", "mass_per_area", "1000", "0", ["tha", "tonnes per ha"], False),

    # Temperature needs the offset: the scales do not share a zero.
    ("C", "degrees Celsius", "temperature", "1", "0", ["celsius", "degc", "°c"], True),
    ("K", "kelvin", "temperature", "1", "-273.15", ["kelvins"], False),
    ("F", "degrees Fahrenheit", "temperature", "0.5555555555555556", "-17.7777777777777778",
     ["fahrenheit", "degf", "°f"], False),
]


def seed_units() -> bool:
    """Put the standard units in place. Idempotent, and never overwrites a row.

    Run at every startup from the module manifest. An installation that has
    corrected a factor or added a local unit keeps both.
    """
    from psycopg2.extras import Json

    with transaction() as cur:
        for code, name, dimension, factor, offset, aliases, is_base in SEED_UNITS:
            cur.execute(
                """
                INSERT INTO unit (code, name, dimension, factor, "offset", aliases, is_base)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (code) DO NOTHING
                """,
                (code, name, dimension, Decimal(factor), Decimal(offset), Json(aliases), is_base),
            )
    return True


def _lookup(unit: str) -> Optional[Dict[str, Any]]:
    """One unit by its code or by any spelling recorded for it. Case-insensitive."""
    wanted = (unit or "").strip()
    if not wanted:
        return None

    with transaction() as cur:
        cur.execute(
            """
            SELECT code, name, dimension, factor, "offset"
            FROM   unit
            WHERE  lower(code) = lower(%s)
               OR  aliases @> %s::jsonb
            LIMIT  1
            """,
            (wanted, f'["{wanted.lower()}"]'),
        )
        row = cur.fetchone()

    return dict(row) if row else None


def find_unit(unit: str) -> Optional[Dict[str, Any]]:
    """One unit as this installation holds it, or None if it holds no such unit.

    For a caller that has to know whether something is a unit at all before it
    can decide what to do — a Crop Ontology scale may be `cm`, or it may be
    `1-9`, and only one of those converts.
    """
    return _lookup(unit)


def list_units() -> List[Dict[str, Any]]:
    """Every unit this installation can convert, grouped by what it measures."""
    with transaction() as cur:
        cur.execute(
            """
            SELECT code, name, dimension, is_base
            FROM   unit
            ORDER BY dimension, is_base DESC, code
            """
        )
        return [dict(row) for row in cur.fetchall()]


def _number(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError(f"'{value}' is not a number")


def convert(value: Any, from_unit: str, to_unit: str) -> Dict[str, Any]:
    """`value` in `from_unit`, expressed in `to_unit`.

    Raises UnknownUnit for a unit this installation does not hold, and
    IncompatibleUnits when both are known but measure different things.
    """
    amount = _number(value)

    source = _lookup(from_unit)
    if source is None:
        raise UnknownUnit(f"'{from_unit}' is not a unit this installation knows")

    target = _lookup(to_unit)
    if target is None:
        raise UnknownUnit(f"'{to_unit}' is not a unit this installation knows")

    if source["dimension"] != target["dimension"]:
        raise IncompatibleUnits(
            f"{source['code']} measures {source['dimension']} and "
            f"{target['code']} measures {target['dimension']}: they do not convert"
        )

    if source["code"] == target["code"]:
        # Same unit, same number. Said explicitly so no rounding creeps in.
        result = amount
    else:
        try:
            base = amount * source["factor"] + source["offset"]
            result = (base - target["offset"]) / target["factor"]
        except (DivisionByZero, InvalidOperation) as exc:
            raise IncompatibleUnits(f"{target['code']} has no usable factor") from exc

    return {
        "input_value": _plain(amount),
        "input_unit": source["code"],
        "output_value": _plain(result),
        "output_unit": target["code"],
        "dimension": source["dimension"],
    }


def _plain(number: Decimal) -> float:
    """A Decimal as a JSON number, without the trailing zeros of the arithmetic."""
    try:
        trimmed = number.normalize()
    except InvalidOperation:
        trimmed = number
    return float(trimmed)
