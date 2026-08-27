"""Storing an answer in the unit its standard uses.

A form is filled in the unit the person in the field measures in. Crop Ontology
says maize plant height is recorded in centimetres, so 150 means 150 cm. ICASA
records the same variable in metres. Both definitions stay exactly as they are —
what was missing is the arithmetic between them, so a figure collected here can
be compared with one collected anywhere else.

That arithmetic happens once, on submission, and what is stored is the
standardized figure:

    submitted   {"crop_type": "CO_322", "plant_height": 150}
    stored      {"crop_type": "CO_322", "plant_height": 1.5}

Nothing about the unit goes into `form_data`. It does not need to: the field
definition says outright what unit that number is in — `data_standard.unit` is
`m` for PHTD — and the definition is versioned alongside the answers, so a row
can always be read back against the definition that produced it.

Because the value itself is standardized, the flat `<form>_tabular` mirror, the
CSV export and everything else downstream carry the standardized figure too,
without any of them knowing this step exists.

Where the units come from, in order and never from a model:

    input     an explicit `input_unit` on the field, or the Crop Ontology scale
              the field is measured on — `cm` for CO_322:0000996.
    standard  the unit on the field's ICASA variable — `m` for PHTD.

A field that does not name both is not a candidate and its answer is stored
exactly as it was given, which is every field on every form with no standard
attached.
"""
import logging
from typing import Any, Dict, Tuple

from app.modules.forms.form_schema import field_name

logger = logging.getLogger(__name__)

# ICASA fills its unit column even for variables that are not measured in
# anything — a code, a date, a bare count. None of these convert.
NOT_A_UNIT = {
    "", "code", "codes", "date", "datetime", "text", "string",
    "number", "count", "integer", "ratio", "fraction", "index",
    "percent", "%", "none", "n/a", "na", "-",
}


def input_unit_for(field: Dict[str, Any]) -> str:
    """The unit the answer is given in, or "" when it cannot be said reliably.

    An `input_unit` written on the field wins — a form author who says so is the
    best evidence there is. Otherwise the Crop Ontology scale, which is the unit
    that crop's variable is defined as being measured on.
    """
    explicit = str(field.get("input_unit") or "").strip()
    if explicit:
        return explicit

    crop = field.get("crop_ontology") or {}
    return str(crop.get("scale_name") or crop.get("scale") or "").strip()


def standard_unit_for(field: Dict[str, Any]) -> str:
    """The unit the field's data standard records this variable in."""
    return str((field.get("data_standard") or {}).get("unit") or "").strip()


def _is_number(value: Any) -> bool:
    # bool is an int in Python, and "true" is not a measurement.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def standardize(
    form_json: Dict[str, Any],
    clean: Dict[str, Any],
) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """The answer set with every convertible figure in its standard's unit.

    Returns `(clean, errors)`. `errors` is keyed by field name and merges into
    the ordinary validation errors, so a form whose units cannot be reconciled
    is refused rather than stored half-converted.

    What is converted, what is refused, and what is quietly left alone is the
    whole of the design here:

    * No input unit, no standard unit, or a standard "unit" that is really a code
      or a date — not a candidate. The answer is stored as given. This is every
      ordinary form.
    * An input unit this installation does not recognise — stored as given too.
      A Crop Ontology scale can be `1-9` or `Text`; that is a scale, not a unit,
      and there is nothing to convert.
    * An input unit we do recognise against a standard unit we do not, or against
      one measuring something else entirely — the field's metadata is wrong and
      the submission is refused. Storing a number under a unit nobody can
      interpret is worse than refusing it.
    """
    try:
        from app.modules.units import service as units
    except Exception:
        # The units module is switched off. A form that was collecting answers
        # before must go on collecting them.
        return clean, {}

    converted = dict(clean)
    errors: Dict[str, str] = {}

    for field in form_json.get("fields") or []:
        name = field_name(field)
        if not name:
            continue

        value = clean.get(name)
        if not _is_number(value):
            continue

        from_unit = input_unit_for(field)
        to_unit = standard_unit_for(field)

        if not from_unit or to_unit.lower() in NOT_A_UNIT:
            continue

        try:
            if units.find_unit(from_unit) is None:
                # A scale, not a unit. Nothing to say about it.
                continue

            result = units.convert(value, from_unit, to_unit)

        except units.UnknownUnit:
            errors[name] = (
                f"{field.get('label') or name}: this field is recorded in '{from_unit}' and its "
                f"standard in '{to_unit}', which is not a unit this installation knows."
            )
            continue

        except units.IncompatibleUnits as exc:
            errors[name] = f"{field.get('label') or name}: {exc}"
            continue

        except Exception:
            # Never let a conversion take a submission down with it.
            logger.exception("Could not standardize %s", name)
            continue

        converted[name] = result["output_value"]

    return converted, errors
