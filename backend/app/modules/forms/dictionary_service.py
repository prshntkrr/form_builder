"""The data dictionary: what a field name means everywhere in this installation.

One entry says that `age` is a whole number above 0, that `plant_height` is a
decimal no greater than 25, that `first_name` is text of at most 60 characters.
Entries are written by hand and applied when a form is drafted, so the same
question does not end up as text on one form and a number on another.

The dictionary decides **type, validation and options** — that is the whole
point of agreeing them once. It only fills in **label, help text and
placeholder** when the form left them empty, because the wording belongs to
whoever is writing the form.

Nothing here happens silently: `apply_to_form` reports every change it made.
"""
import logging
from typing import Any, Dict, List, Optional

from psycopg2.extras import Json

from app.core.database import transaction
from app.modules.forms.field_types import SUPPORTED_TYPES, resolve_type
from app.modules.forms.form_schema import slugify_identifier

logger = logging.getLogger(__name__)

# The validation keys an entry may carry — the same ones a field spec uses.
RULE_KEYS = ("min", "max", "min_length", "max_length", "pattern", "step")


class DictionaryError(ValueError):
    """The entry cannot be stored as given."""


class EntryNotFound(LookupError):
    pass


# --------------------------------------------------------------------------- #
# reading
# --------------------------------------------------------------------------- #
def list_entries(search: Optional[str] = None) -> List[Dict[str, Any]]:
    """Every entry, newest changes last. `search` matches the name or label."""
    with transaction() as cur:
        if search:
            cur.execute(
                """
                SELECT * FROM data_dictionary
                WHERE name ILIKE %s OR label ILIKE %s
                ORDER BY name
                """,
                (f"%{search}%", f"%{search}%"),
            )
        else:
            cur.execute("SELECT * FROM data_dictionary ORDER BY name")
        return [dict(row) for row in cur.fetchall()]


def get_entry(entry_id: str) -> Dict[str, Any]:
    with transaction() as cur:
        cur.execute("SELECT * FROM data_dictionary WHERE entry_id = %s", (entry_id,))
        row = cur.fetchone()
    if not row:
        raise EntryNotFound(f"No dictionary entry {entry_id}")
    return dict(row)


# --------------------------------------------------------------------------- #
# writing
# --------------------------------------------------------------------------- #
def _clean_aliases(raw: Any, name: str) -> List[str]:
    """Other spellings of the same field, slugified so matching is exact."""
    if not isinstance(raw, list):
        return []

    aliases = []
    for item in raw:
        alias = slugify_identifier(str(item), "")
        if alias and alias != name and alias not in aliases:
            aliases.append(alias)
    return aliases


def _clean_validation(raw: Any) -> Dict[str, Any]:
    """Keep only the rules a field spec understands, and drop the empty ones."""
    if not isinstance(raw, dict):
        return {}

    rules = {}
    for key in RULE_KEYS:
        value = raw.get(key)
        if value is None or value == "":
            continue
        if key == "pattern":
            rules[key] = str(value)
        else:
            try:
                rules[key] = float(value) if "." in str(value) else int(value)
            except (TypeError, ValueError):
                continue
    return rules


def _clean_options(raw: Any) -> List[Dict[str, str]]:
    if not isinstance(raw, list):
        return []

    options = []
    for item in raw:
        if isinstance(item, dict):
            label = str(item.get("label") or item.get("value") or "").strip()
            value = str(item.get("value") or "").strip() or slugify_identifier(label, "option")
        else:
            label = str(item).strip()
            value = slugify_identifier(label, "option")
        if label:
            options.append({"label": label, "value": value})
    return options


def _check(name: str, field_type: str) -> None:
    if not name:
        raise DictionaryError("Give the field a name")
    if resolve_type(field_type) is None:
        raise DictionaryError(
            f"'{field_type}' is not a field type. Use one of: {', '.join(SUPPORTED_TYPES)}"
        )


def create_entry(
    name: str,
    label: str,
    field_type: str,
    aliases: Any = None,
    validation: Any = None,
    options: Any = None,
    help_text: str = "",
    placeholder: str = "",
    notes: str = "",
    updated_by: Optional[str] = None,
) -> Dict[str, Any]:
    name = slugify_identifier(name, "")
    _check(name, field_type)

    entry = {
        "entry_id": name,
        "name": name,
        "label": (label or name.replace("_", " ").title())[:200],
        "field_type": field_type,
        "aliases": _clean_aliases(aliases, name),
        "validation": _clean_validation(validation),
        "options": _clean_options(options),
        "help_text": str(help_text or "")[:300],
        "placeholder": str(placeholder or "")[:200],
        "notes": str(notes or "")[:500],
    }

    with transaction() as cur:
        cur.execute("SELECT 1 FROM data_dictionary WHERE name = %s", (name,))
        if cur.fetchone():
            raise DictionaryError(f"'{name}' is already in the dictionary")

        cur.execute(
            """
            INSERT INTO data_dictionary
                (entry_id, name, label, field_type, aliases, validation, options,
                 help_text, placeholder, notes, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                entry["entry_id"], entry["name"], entry["label"], entry["field_type"],
                Json(entry["aliases"]), Json(entry["validation"]), Json(entry["options"]),
                entry["help_text"], entry["placeholder"], entry["notes"], updated_by,
            ),
        )

    logger.info("Dictionary entry added: %s", name)
    return get_entry(name)


def update_entry(entry_id: str, updated_by: Optional[str] = None, **changes: Any) -> Dict[str, Any]:
    """Change an entry. The name is its identity and cannot move."""
    existing = get_entry(entry_id)

    label = changes.get("label", existing["label"])
    field_type = changes.get("field_type", existing["field_type"])
    _check(existing["name"], field_type)

    aliases = (_clean_aliases(changes["aliases"], existing["name"])
               if "aliases" in changes else existing["aliases"])
    validation = (_clean_validation(changes["validation"])
                  if "validation" in changes else existing["validation"])
    options = (_clean_options(changes["options"])
               if "options" in changes else existing["options"])

    with transaction() as cur:
        cur.execute(
            """
            UPDATE data_dictionary
               SET label = %s, field_type = %s, aliases = %s, validation = %s,
                   options = %s, help_text = %s, placeholder = %s, notes = %s,
                   updated_by = %s, updated_on = CURRENT_TIMESTAMP
             WHERE entry_id = %s
            """,
            (
                str(label)[:200], field_type, Json(aliases), Json(validation), Json(options),
                str(changes.get("help_text", existing["help_text"]) or "")[:300],
                str(changes.get("placeholder", existing["placeholder"]) or "")[:200],
                str(changes.get("notes", existing["notes"]) or "")[:500],
                updated_by, entry_id,
            ),
        )

    logger.info("Dictionary entry updated: %s", entry_id)
    return get_entry(entry_id)


def delete_entry(entry_id: str) -> Dict[str, Any]:
    """Remove an entry. Forms already built from it are untouched — the
    dictionary shapes a form when it is drafted, and holds nothing afterwards."""
    get_entry(entry_id)
    with transaction() as cur:
        cur.execute("DELETE FROM data_dictionary WHERE entry_id = %s", (entry_id,))
    logger.info("Dictionary entry removed: %s", entry_id)
    return {"entry_id": entry_id, "deleted": True}


# --------------------------------------------------------------------------- #
# applying it to a form
# --------------------------------------------------------------------------- #
def _index(entries: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Every name that should reach an entry — its own, plus its aliases."""
    index = {}
    for entry in entries:
        index[entry["name"]] = entry
        for alias in entry["aliases"] or []:
            # An entry's own name always wins over somebody else's alias.
            if alias not in index:
                index[alias] = entry
    return index


def _match(field: Dict[str, Any], index: Dict[str, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The entry this field is an instance of, by name and then by label."""
    name = slugify_identifier(str(field.get("name") or ""), "")
    if name in index:
        return index[name]

    label = slugify_identifier(str(field.get("label") or ""), "")
    return index.get(label)


def apply_to_form(form_json: Dict[str, Any]) -> Dict[str, Any]:
    """Bring a draft into line with the dictionary.

    Returns the form and a list of what changed, one line per field, so the
    person who asked can see what the dictionary decided rather than wondering
    why their field became a number.
    """
    entries = list_entries()
    if not entries:
        return {"form_json": form_json, "applied": []}

    index = _index(entries)
    fields = []
    applied = []

    for field in form_json.get("fields") or []:
        if not isinstance(field, dict):
            fields.append(field)
            continue

        entry = _match(field, index)
        if not entry:
            fields.append(field)
            continue

        updated = dict(field)
        changes = []

        # The dictionary decides these — agreeing them once is the point.
        if updated.get("type") != entry["field_type"]:
            changes.append(f"type {updated.get('type')} → {entry['field_type']}")
            updated["type"] = entry["field_type"]

        if entry["validation"] and updated.get("validation") != entry["validation"]:
            changes.append(f"rules {_describe(entry['validation'])}")
            updated["validation"] = dict(entry["validation"])

        if entry["options"] and not (updated.get("options") or []):
            changes.append(f"{len(entry['options'])} choices")
            updated["options"] = [dict(o) for o in entry["options"]]

        # The wording stays the form author's, so these only fill a gap.
        for key in ("label", "help_text", "placeholder"):
            if not str(updated.get(key) or "").strip() and entry[key if key != "label" else "label"]:
                updated[key] = entry["label"] if key == "label" else entry[key]
                changes.append(f"{key.replace('_', ' ')} filled in")

        fields.append(updated)
        if changes:
            applied.append({
                "field": updated.get("name"),
                "entry": entry["name"],
                "changes": changes,
            })

    return {"form_json": {**form_json, "fields": fields}, "applied": applied}


def _describe(rules: Dict[str, Any]) -> str:
    """The rules in words, for the report."""
    said = []
    if "min" in rules:
        said.append(f"at least {rules['min']}")
    if "max" in rules:
        said.append(f"at most {rules['max']}")
    if "min_length" in rules:
        said.append(f"{rules['min_length']}+ long")
    if "max_length" in rules:
        said.append(f"up to {rules['max_length']} long")
    if "pattern" in rules:
        said.append("must match a pattern")
    return ", ".join(said) or "cleared"
