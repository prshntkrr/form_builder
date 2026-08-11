"""Comparing two saved versions of a form.

`form_version` keeps a complete definition per revision, so the difference
between any two versions is just a comparison of two JSON documents — no
separate change log to keep in step.

The one thing plain JSON comparison gets wrong is a renamed field: it looks like
one field removed and another added. Each version records the renames that
produced it (`renamed_from`), so a field can be traced back through however many
versions lie between the two being compared.
"""
from typing import Any, Dict, List, Optional, Tuple

# Form-level properties worth reporting, in the order they should be shown.
FORM_PROPS: List[Tuple[str, str]] = [
    ("title", "Title"),
    ("description", "Description"),
    ("submit_label", "Submit button"),
    ("success_message", "Confirmation message"),
]

FIELD_PROPS: List[Tuple[str, str]] = [
    ("label", "Label"),
    ("type", "Type"),
    ("required", "Required"),
    ("placeholder", "Placeholder"),
    ("help_text", "Hint"),
    ("section", "Section"),
]

RULE_NAMES: Dict[str, str] = {
    "min": "Smallest allowed",
    "max": "Largest allowed",
    "min_length": "Shortest answer",
    "max_length": "Longest answer",
    "pattern": "Must match",
    "step": "Step",
}


def _fields_by_name(definition: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {f["name"]: f for f in definition.get("fields") or []}


def trace_names(
    versions: Dict[int, Dict[str, Any]], from_no: int, to_no: int, names: List[str]
) -> Dict[str, str]:
    """Map each field name at `to_no` back to the name it had at `from_no`.

    Only names that actually changed appear in the result.
    """
    traced: Dict[str, str] = {}
    for name in names:
        current = name
        for version_no in range(to_no, from_no, -1):
            renames = (versions.get(version_no) or {}).get("renamed_from") or {}
            if current in renames:
                current = renames[current]
        if current != name:
            traced[name] = current
    return traced


def _changed(before: Any, after: Any) -> bool:
    if isinstance(before, str) and isinstance(after, str):
        return before.strip() != after.strip()
    return (before or None) != (after or None)


def _option_diff(before: Dict[str, Any], after: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    old = {o["value"]: o["label"] for o in before.get("options") or []}
    new = {o["value"]: o["label"] for o in after.get("options") or []}
    if old == new:
        return None

    added = [new[v] for v in new if v not in old]
    removed = [old[v] for v in old if v not in new]
    renamed = [
        {"before": old[v], "after": new[v]} for v in new if v in old and old[v] != new[v]
    ]
    if not (added or removed or renamed):
        return None
    return {
        "property": "options",
        "label": "Choices",
        "added": added,
        "removed": removed,
        "renamed": renamed,
    }


def _rule_diffs(before: Dict[str, Any], after: Dict[str, Any]) -> List[Dict[str, Any]]:
    old = before.get("validation") or {}
    new = after.get("validation") or {}
    out: List[Dict[str, Any]] = []
    for key in sorted(set(old) | set(new)):
        if old.get(key) != new.get(key):
            out.append(
                {
                    "property": f"validation.{key}",
                    "label": RULE_NAMES.get(key, key),
                    "before": old.get(key),
                    "after": new.get(key),
                }
            )
    return out


def _field_changes(before: Dict[str, Any], after: Dict[str, Any]) -> List[Dict[str, Any]]:
    changes: List[Dict[str, Any]] = []
    for prop, label in FIELD_PROPS:
        if _changed(before.get(prop), after.get(prop)):
            changes.append(
                {"property": prop, "label": label, "before": before.get(prop), "after": after.get(prop)}
            )

    options = _option_diff(before, after)
    if options:
        changes.append(options)

    changes.extend(_rule_diffs(before, after))
    return changes


def diff_definitions(
    old: Dict[str, Any],
    new: Dict[str, Any],
    renamed: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Compare two form definitions.

    `renamed` maps a field's name in `new` to the name it had in `old`.
    """
    renamed = renamed or {}
    old_fields = _fields_by_name(old)
    new_fields = _fields_by_name(new)

    # A field in `new` matches the one in `old` under its traced-back name.
    matched_old: Dict[str, str] = {}
    for name in new_fields:
        was = renamed.get(name, name)
        if was in old_fields:
            matched_old[name] = was

    added = [
        {"name": n, "label": f["label"], "type": f["type"], "required": bool(f.get("required"))}
        for n, f in new_fields.items()
        if n not in matched_old
    ]
    still_there = set(matched_old.values())
    removed = [
        {"name": n, "label": f["label"], "type": f["type"]}
        for n, f in old_fields.items()
        if n not in still_there
    ]

    changed: List[Dict[str, Any]] = []
    for name, was in matched_old.items():
        entry_changes = _field_changes(old_fields[was], new_fields[name])
        if name != was or entry_changes:
            changed.append(
                {
                    "name": name,
                    "label": new_fields[name]["label"],
                    "renamed_from": was if was != name else None,
                    "changes": entry_changes,
                }
            )

    # Position, judged only over the fields present in both versions.
    old_order = [n for n in old_fields if n in still_there]
    new_order = [n for n in new_fields if n in matched_old]
    reordered = [
        new_fields[n]["label"]
        for i, n in enumerate(new_order)
        if i < len(old_order) and old_order[i] != matched_old[n]
    ]

    form_changes = [
        {"property": prop, "label": label, "before": old.get(prop), "after": new.get(prop)}
        for prop, label in FORM_PROPS
        if _changed(old.get(prop), new.get(prop))
    ]

    old_sections = [s["title"] for s in old.get("sections") or []]
    new_sections = [s["title"] for s in new.get("sections") or []]
    if old_sections != new_sections:
        form_changes.append(
            {
                "property": "sections",
                "label": "Sections",
                "before": ", ".join(old_sections) or None,
                "after": ", ".join(new_sections) or None,
            }
        )

    return {
        "form_changes": form_changes,
        "added": added,
        "removed": removed,
        "changed": changed,
        "reordered": reordered,
        "summary": {
            "form_changes": len(form_changes),
            "added": len(added),
            "removed": len(removed),
            "changed": len(changed),
            "reordered": len(reordered),
            "identical": not (form_changes or added or removed or changed or reordered),
        },
    }


def diff_versions(
    versions: List[Dict[str, Any]], from_no: int, to_no: int
) -> Dict[str, Any]:
    """Diff two rows out of `form_version`, tracing renames across the gap."""
    by_no = {int(v["version_no"]): (v.get("form_json") or {}) for v in versions}

    if from_no not in by_no:
        raise LookupError(f"Version {from_no} does not exist")
    if to_no not in by_no:
        raise LookupError(f"Version {to_no} does not exist")

    # Always read forwards, whichever way round they were given.
    low, high = sorted((from_no, to_no))
    old, new = by_no[low], by_no[high]

    renamed = trace_names(by_no, low, high, [f["name"] for f in new.get("fields") or []])

    result = diff_definitions(old, new, renamed)
    result["from"] = {
        "version_no": low,
        "title": old.get("title"),
        "field_count": len(old.get("fields") or []),
    }
    result["to"] = {
        "version_no": high,
        "title": new.get("title"),
        "field_count": len(new.get("fields") or []),
        "saved_by": new.get("updated_by") or new.get("created_by"),
    }
    return result
