"""Conditional logic: which questions apply, given the answers so far.

A form often asks something only when an earlier answer calls for it. Rather
than a special case per form, the definition carries rules:

    {"rules": [
      {"conditions": [{"field": "consent", "operator": "equals", "value": "yes"}],
       "logic": "AND",
       "action": "show",
       "target": {"type": "form"}}
    ]}

Three things this deliberately is not.

**It is not an expression language.** No string is parsed and nothing is ever
executed — a condition is three values and an operator looked up in a table, so
a definition can be edited by anyone without becoming a way to run code.

**It never mentions a label.** A rule names a field by the key answers are
stored under and compares against the stored value — `consent == "yes"`, not
`"Consent" == "Yes"`. That is what lets the same form work in every language
and with every catalogue: translating a form or a catalogue changes what is
read, never what is compared. See `translations.py` and
`client_catalog/catalog_options.py`, which both hold the value fixed and vary
only the label.

**It is not the frontend's alone.** These same semantics are mirrored in
`frontend/src/modules/forms/conditions.js` so a form reacts as it is filled in,
but the submission service evaluates them again on arrival. A hidden question is
not an optional one: an answer to something the form did not ask is refused.

Targets are the structures the form already has:

    {"type": "field", "name": "..."}     one question
    {"type": "section", "key": "..."}    every question in that section
    {"type": "form"}                     the whole questionnaire

`group` is accepted as another word for `section` — the section *is* the group
of questions here, and adding a parallel structure to mean the same thing would
be two things to keep in step.
"""
import logging
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# operators
# --------------------------------------------------------------------------- #
def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _same(answer: Any, wanted: Any) -> bool:
    """Whether an answer is the value a rule names.

    Compared as text, because a form sends `"18"` where the definition says
    `18`, and a rule written either way must mean the same thing. A multi-select
    answer matches when the value is among the ones chosen.
    """
    if isinstance(answer, list):
        return any(_text(item) == _text(wanted) for item in answer)
    if isinstance(answer, bool) or isinstance(wanted, bool):
        return _truth(answer) == _truth(wanted)
    return _text(answer) == _text(wanted)


def _truth(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return _text(value).lower() in ("true", "yes", "y", "1")


def _number(value: Any) -> Optional[float]:
    try:
        return float(_text(value))
    except (TypeError, ValueError):
        return None


def _compare(answer: Any, wanted: Any, decide) -> bool:
    """A numeric comparison, or False when either side is not a number.

    Not an error: a rule comparing a text answer to a number simply does not
    hold, and a half-filled form must not be unanswerable because of it.
    """
    left, right = _number(answer), _number(wanted)
    if left is None or right is None:
        return False
    return decide(left, right)


def _contains(answer: Any, wanted: Any) -> bool:
    """Whether the answer includes the value.

    A multi-select holds a list, so membership; anything else is text, so a
    substring — which is what "contains" means for a written answer.
    """
    if isinstance(answer, list):
        return any(_text(item) == _text(wanted) for item in answer)
    return _text(wanted).lower() in _text(answer).lower()


# The operators a rule may use, by name. A table rather than a chain of ifs, so
# adding one is a line here and a line in the frontend's mirror — and so nothing
# outside this module ever has to know how a comparison is made.
OPERATORS = {
    "equals": _same,
    "not_equals": lambda a, w: not _same(a, w),
    "is_empty": lambda a, w: _empty(a),
    "is_not_empty": lambda a, w: not _empty(a),
    "greater_than": lambda a, w: _compare(a, w, lambda x, y: x > y),
    "greater_than_or_equal": lambda a, w: _compare(a, w, lambda x, y: x >= y),
    "less_than": lambda a, w: _compare(a, w, lambda x, y: x < y),
    "less_than_or_equal": lambda a, w: _compare(a, w, lambda x, y: x <= y),
    "contains": _contains,
    "not_contains": lambda a, w: not _contains(a, w),
}

# The operators that compare against nothing — their `value` is meaningless and
# the builder hides the box for it.
UNARY = ("is_empty", "is_not_empty")

ACTIONS = ("show", "hide")
LOGIC = ("AND", "OR")
TARGET_TYPES = ("field", "section", "form")


# --------------------------------------------------------------------------- #
# evaluating
# --------------------------------------------------------------------------- #
def evaluate(condition: Dict[str, Any], answers: Dict[str, Any]) -> bool:
    """One condition against the answers so far.

    An unknown operator is False rather than an error: a definition written by a
    newer version of this application must not make an old one unusable.
    """
    if not isinstance(condition, dict):
        return False

    decide = OPERATORS.get(_text(condition.get("operator")))
    if decide is None:
        logger.warning("Unknown condition operator %r", condition.get("operator"))
        return False

    return bool(decide(answers.get(_text(condition.get("field"))), condition.get("value")))


def evaluate_rule(rule: Dict[str, Any], answers: Dict[str, Any]) -> bool:
    """Whether a rule's conditions hold. A rule with no conditions never fires."""
    if not isinstance(rule, dict):
        return False

    conditions = [c for c in (rule.get("conditions") or []) if isinstance(c, dict)]
    if not conditions:
        return False

    results = (evaluate(condition, answers) for condition in conditions)
    return any(results) if _text(rule.get("logic")).upper() == "OR" else all(results)


def evaluate_rules(rules: List[Dict[str, Any]], answers: Dict[str, Any]) -> List[bool]:
    """Each rule's verdict, in order. For a caller that wants to explain itself."""
    return [evaluate_rule(rule, answers) for rule in rules or []]


# --------------------------------------------------------------------------- #
# what that means for a form
# --------------------------------------------------------------------------- #
def _targets(rule: Dict[str, Any]) -> Dict[str, str]:
    target = rule.get("target")
    return target if isinstance(target, dict) else {}


def hidden(form_json: Dict[str, Any], answers: Dict[str, Any]) -> Dict[str, Any]:
    """Which parts of the form do not apply, given these answers.

    Returns the hidden field names, the hidden section keys, and whether the
    questionnaire as a whole is hidden.

    Everything is visible until a rule says otherwise, so a form with no rules —
    every form built before this existed — is unaffected. A `show` rule whose
    conditions do not hold hides its target; a `hide` rule whose conditions do
    hold hides it. Several rules on one target are read together: if any of them
    hides it, it is hidden.

    A field a rule reads is never hidden by that rule. The question controlling
    the questionnaire has to stay answerable, or nothing could ever be shown.
    """
    from app.modules.forms.form_schema import field_name

    rules = [r for r in (form_json.get("rules") or []) if isinstance(r, dict)]

    hidden_fields: Set[str] = set()
    hidden_sections: Set[str] = set()
    form_hidden = False

    for rule in rules:
        holds = evaluate_rule(rule, answers)
        action = _text(rule.get("action")).lower() or "show"

        # show + conditions unmet, or hide + conditions met.
        if (action == "show") == holds:
            continue

        target = _targets(rule)
        kind = _text(target.get("type")).lower()

        if kind == "field":
            name = _text(target.get("name"))
            if name:
                hidden_fields.add(name)
        elif kind in ("section", "group"):
            key = _text(target.get("key") or target.get("name"))
            if key:
                hidden_sections.add(key)
        elif kind == "form":
            form_hidden = True

    # Everything in a hidden section is hidden with it, and everything at all is
    # hidden when the questionnaire is.
    for field in form_json.get("fields") or []:
        if not isinstance(field, dict):
            continue
        name = field_name(field)
        if not name:
            continue
        if form_hidden or (field.get("section") and field["section"] in hidden_sections):
            hidden_fields.add(name)

    # …except the questions the rules read. A form-level rule that hid its own
    # controlling question could never be satisfied again.
    for name in controlling_fields(rules):
        hidden_fields.discard(name)

    return {
        "fields": sorted(hidden_fields),
        "sections": sorted(hidden_sections),
        "form": form_hidden,
    }


def controlling_fields(rules: List[Dict[str, Any]]) -> Set[str]:
    """Every field a rule reads. These stay answerable whatever the rules say."""
    names: Set[str] = set()
    for rule in rules or []:
        if not isinstance(rule, dict):
            continue
        for condition in rule.get("conditions") or []:
            if isinstance(condition, dict):
                name = _text(condition.get("field"))
                if name:
                    names.add(name)
    return names


def applies(form_json: Dict[str, Any], answers: Dict[str, Any], name: str) -> bool:
    """Whether one question applies. Convenience over `hidden`."""
    return name not in set(hidden(form_json, answers)["fields"])


# --------------------------------------------------------------------------- #
# cleaning what arrives
# --------------------------------------------------------------------------- #
def normalize_rules(raw: Any) -> List[Dict[str, Any]]:
    """Keep only rules this engine can actually evaluate.

    Called from `normalize_form`, so a hand-edited definition cannot store a
    shape the renderer would choke on. Anything unrecognised is dropped rather
    than rejected: a bad rule must never stop a form being saved, and a dropped
    rule leaves its target visible, which is the safe direction to fail.
    """
    if not isinstance(raw, list):
        return []

    cleaned: List[Dict[str, Any]] = []

    for item in raw:
        if not isinstance(item, dict):
            continue

        conditions = []
        for condition in item.get("conditions") or []:
            if not isinstance(condition, dict):
                continue
            field = _text(condition.get("field"))
            operator = _text(condition.get("operator"))
            if not field or operator not in OPERATORS:
                continue

            kept = {"field": field, "operator": operator}
            if operator not in UNARY:
                kept["value"] = condition.get("value")
            conditions.append(kept)

        if not conditions:
            continue

        target = item.get("target")
        if not isinstance(target, dict):
            continue

        kind = _text(target.get("type")).lower()
        # One word for one thing: a group of questions is a section here.
        if kind == "group":
            kind = "section"
        if kind not in TARGET_TYPES:
            continue

        cleaned_target: Dict[str, Any] = {"type": kind}
        if kind == "field":
            name = _text(target.get("name"))
            if not name:
                continue
            cleaned_target["name"] = name
        elif kind == "section":
            key = _text(target.get("key") or target.get("name"))
            if not key:
                continue
            cleaned_target["key"] = key

        action = _text(item.get("action")).lower()
        logic = _text(item.get("logic")).upper()

        cleaned.append({
            "conditions": conditions,
            "logic": logic if logic in LOGIC else "AND",
            "action": action if action in ACTIONS else "show",
            "target": cleaned_target,
        })

    return cleaned


def problems(form_json: Dict[str, Any]) -> List[Dict[str, str]]:
    """Configurations that cannot work, for the validation pipeline.

    Three of them. A question cannot depend on itself — its own answer decides
    whether it may be answered. A rule cannot read a field the form does not
    have. And a chain of rules cannot come back round to where it started, since
    nothing would settle.
    """
    from app.modules.forms.form_schema import field_name

    rules = form_json.get("rules") or []
    names = {field_name(f) for f in form_json.get("fields") or []
             if isinstance(f, dict) and field_name(f)}
    sections = {s.get("key") for s in form_json.get("sections") or []
                if isinstance(s, dict)}

    found: List[Dict[str, str]] = []

    # Which fields each field's visibility depends on, for the cycle check.
    depends: Dict[str, Set[str]] = {}

    for index, rule in enumerate(rules):
        target = _targets(rule)
        kind = _text(target.get("type"))
        reads = {_text(c.get("field")) for c in rule.get("conditions") or []
                 if isinstance(c, dict)}

        for name in reads:
            if name and name not in names:
                found.append({
                    "path": f"rules.{index}.conditions",
                    "message": f"This rule asks about '{name}', which is not a question "
                               f"on this form.",
                })

        if kind == "field":
            name = _text(target.get("name"))
            if name and name not in names:
                found.append({
                    "path": f"rules.{index}.target",
                    "message": f"This rule controls '{name}', which is not a question "
                               f"on this form.",
                })
            if name in reads:
                found.append({
                    "path": f"rules.{index}",
                    "message": f"'{name}' cannot decide whether it is asked — a question "
                               f"cannot depend on its own answer.",
                })
            if name:
                depends.setdefault(name, set()).update(reads - {name})

        elif kind == "section":
            key = _text(target.get("key"))
            if key and key not in sections:
                found.append({
                    "path": f"rules.{index}.target",
                    "message": f"This rule controls the section '{key}', which this form "
                               f"does not have.",
                })
            # Everything in the section inherits the dependency.
            for field in form_json.get("fields") or []:
                if isinstance(field, dict) and field.get("section") == key:
                    name = field_name(field)
                    if name in reads:
                        found.append({
                            "path": f"rules.{index}",
                            "message": f"'{name}' is in the section this rule controls and "
                                       f"is also what it asks about, so it would decide "
                                       f"whether it is asked.",
                        })
                    if name:
                        depends.setdefault(name, set()).update(reads - {name})

    for name in sorted(_cycles(depends)):
        found.append({
            "path": "rules",
            "message": f"The rules around '{name}' depend on each other in a circle, so "
                       f"nothing would decide whether it is asked.",
        })

    return found


def _cycles(depends: Dict[str, Set[str]]) -> Set[str]:
    """The names caught in a dependency circle."""
    caught: Set[str] = set()

    for start in depends:
        seen: Set[str] = set()
        stack = [start]
        while stack:
            name = stack.pop()
            for other in depends.get(name, ()):
                if other == start:
                    caught.add(start)
                    stack = []
                    break
                if other not in seen:
                    seen.add(other)
                    stack.append(other)

    return caught
