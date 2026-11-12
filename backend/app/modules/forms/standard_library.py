"""The Standard Form Library — forms worth starting from.

Most of what a programme collects is not novel. A farmer registration asks the
same fifteen things everywhere. Rebuilding that from a prompt each time produces
slightly different field keys each time, which makes the collected data hard to
compare across forms.

The library is the `standard_form_library` table. A row is added by offering a
saved form, and **carries its own copy of the definition** — so a standard
stands on its own: delete the form it came from and the standard keeps working.
`form_id` / `version_no` are provenance, and go NULL if that form is deleted.

Two ways to reuse one:

  * **start from it** — the whole definition becomes a new draft, with its
    origin recorded in `standard_id` / `standard_version`
  * **borrow part of it** — a section's fields are merged into a form already
    being edited, with colliding keys given a distinct suffix

Either way the result is an ordinary draft: every question, the title, the
description and the rules are all editable afterwards, by hand or by prompt.
Because the origin is recorded, `diff_against_standard` can later show how far a
form has drifted from the standard it came from.
"""
import copy
import logging
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from psycopg2.extras import Json

from app.modules.forms.config_validation import validate_config
from app.core.database import transaction
from app.modules.forms.diff_service import diff_definitions
from app.modules.forms.form_schema import MAX_IDENTIFIER, slugify_identifier

logger = logging.getLogger(__name__)


class LibraryError(RuntimeError):
    """The library cannot accept this — a clashing id, or a form it cannot use."""


@dataclass(frozen=True)
class StandardForm:
    standard_id: str
    standard_version: int
    title: str
    summary: str
    category: str
    tags: Tuple[str, ...]
    _definition: Dict[str, Any]
    form_id: Optional[str] = None       # provenance: where it came from
    version_no: Optional[int] = None
    added_by: Optional[str] = None

    project_id: Optional[str] = None

    @property
    def field_count(self) -> int:
        return len(self._definition.get("fields") or [])

    @property
    def sections(self) -> List[Dict[str, Any]]:
        return list(self._definition.get("sections") or [])

    def definition(self) -> Dict[str, Any]:
        """A copy, so a caller editing a draft cannot corrupt anything."""
        return copy.deepcopy(self._definition)

    def summary_entry(self) -> Dict[str, Any]:
        """The light shape used for listings — no field definitions."""
        return {
            "standard_id": self.standard_id,
            "standard_version": self.standard_version,
            "title": self.title,
            "summary": self.summary,
            "category": self.category,
            "tags": list(self.tags),
            "field_count": self.field_count,
            "sections": [{"key": s["key"], "title": s["title"]} for s in self.sections],
            "form_id": self.form_id,
            "version_no": self.version_no,
            "added_by": self.added_by,
            "project_id": self.project_id,
        }

    def full_entry(self) -> Dict[str, Any]:
        return {**self.summary_entry(), "form_json": self.definition()}


# --------------------------------------------------------------------------- #
# reading
# --------------------------------------------------------------------------- #
_SELECT = """
    SELECT standard_id, form_json, title, category, tags, summary,
           standard_version, form_id, version_no, added_by, project_id
    FROM   standard_form_library
    ORDER  BY category, title
"""


def _from_row(row: Dict[str, Any]) -> StandardForm:
    tags = row.get("tags")
    definition = row.get("form_json") or {}
    return StandardForm(
        standard_id=row["standard_id"],
        standard_version=int(row.get("standard_version") or 1),
        title=str(row.get("title") or definition.get("title") or row["standard_id"]),
        summary=str(row.get("summary") or ""),
        category=str(row.get("category") or "General"),
        tags=tuple(str(t) for t in (tags if isinstance(tags, list) else [])),
        _definition=definition,
        form_id=row.get("form_id"),
        version_no=row.get("version_no"),
        added_by=row.get("added_by"),
        project_id=row.get("project_id"),
    )


def catalogue(cur=None, project_id=None) -> Dict[str, StandardForm]:
    """Standards visible to a project: its own plus globals (project_id IS NULL).

    With no project_id, returns everything — the old behaviour.
    """
    def run(c) -> List[Dict[str, Any]]:
        c.execute(_SELECT)
        return [dict(r) for r in c.fetchall()]

    try:
        if cur is not None:
            rows = run(cur)
        else:
            with transaction() as own:
                rows = run(own)
    except Exception as exc:
        logger.warning("Could not read standard_form_library: %s", exc)
        return {}

    result = {row["standard_id"]: _from_row(row) for row in rows}

    if project_id is not None:
        result = {
            k: v for k, v in result.items()
            if v.project_id is None or v.project_id == project_id
        }

    return result


def known_ids(cur=None) -> List[str]:
    return sorted(catalogue(cur))


def get(standard_id: str) -> Optional[StandardForm]:
    return catalogue().get(str(standard_id or "").strip())


def categories(project_id=None) -> List[str]:
    return sorted({entry.category for entry in catalogue(project_id=project_id).values()})


def search(
    query: Optional[str] = None,
    category: Optional[str] = None,
    project_id: Optional[str] = None,
) -> List[StandardForm]:
    """Match on title, summary, category or tags — one box, everything searched."""
    entries = sorted(
        catalogue(project_id=project_id).values(),
        key=lambda e: (e.category, e.title),
    )

    if category:
        wanted = category.strip().lower()
        entries = [e for e in entries if e.category.lower() == wanted]

    if query:
        needle = query.strip().lower()
        entries = [
            e for e in entries
            if needle in e.title.lower()
            or needle in e.summary.lower()
            or needle in e.category.lower()
            or any(needle in t.lower() for t in e.tags)
        ]
    return entries


# --------------------------------------------------------------------------- #
# adding and removing
# --------------------------------------------------------------------------- #
# Everything about a *saved* form that means nothing to a reusable template: its
# identity, where its answers live, who saved it, and which version it is on.
_INSTANCE_KEYS = (
    "form_id", "version", "table_name", "created_by", "updated_by",
    "renamed_from", "standard_id", "standard_version",
)


def to_library_entry(
    definition: Dict[str, Any],
    standard_id: Optional[str] = None,
    *,
    category: str = "General",
    tags: Optional[Sequence[str]] = None,
    summary: Optional[str] = None,
    standard_version: int = 1,
) -> Dict[str, Any]:
    """Turn a saved form's definition into a library entry.

    Strips everything that belongs to that one form rather than to the template —
    its `form_id`, its table, its author, its version — so what remains is the
    shape other forms can be built from.
    """
    template = {k: v for k, v in copy.deepcopy(definition).items() if k not in _INSTANCE_KEYS}
    title = str(template.get("title") or "Untitled Form")

    return {
        "standard_id": slugify_identifier(standard_id or title, "standard_form")[:MAX_IDENTIFIER],
        "standard_version": int(standard_version),
        "category": str(category or "General"),
        "tags": [str(t).strip() for t in (tags or []) if str(t).strip()],
        "summary": str(summary or template.get("description") or "").strip(),
        "form": template,
    }


def add_form(
    cur,
    definition: Dict[str, Any],
    *,
    form_id: Optional[str] = None,
    version_no: Optional[int] = None,
    standard_id: Optional[str] = None,
    title: Optional[str] = None,
    category: str = "General",
    tags: Optional[Sequence[str]] = None,
    summary: Optional[str] = None,
    added_by: Optional[str] = None,
    project_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Put a definition into the library as a standard others can start from.

    The definition is copied in. Nothing about the resulting standard depends on
    the form it came from still existing.
    """
    entry = to_library_entry(
        definition, standard_id, category=category, tags=tags, summary=summary,
    )
    resolved = entry["standard_id"]

    if form_id:
        cur.execute(
            "SELECT standard_id FROM standard_form_library "
            "WHERE form_id = %s AND standard_id <> %s",
            (form_id, resolved),
        )
        clash = cur.fetchone()
        if clash:
            raise LibraryError(
                f"{form_id} is already in the library as '{clash['standard_id']}'. "
                f"Remove that entry first, or update it instead."
            )

    validate_config(entry["form"])   # raises ConfigValidationError

    cur.execute(
        """
        INSERT INTO standard_form_library
              (standard_id, form_json, title, category, tags, summary,
               standard_version, form_id, version_no, added_by, project_id)
        VALUES (%s, %s, %s, %s, %s, %s, 1, %s, %s, %s, %s)
        ON CONFLICT (standard_id) DO UPDATE SET
              form_json        = EXCLUDED.form_json,
              title            = EXCLUDED.title,
              category         = EXCLUDED.category,
              tags             = EXCLUDED.tags,
              summary          = EXCLUDED.summary,
              standard_version = standard_form_library.standard_version + 1,
              form_id          = EXCLUDED.form_id,
              version_no       = EXCLUDED.version_no,
              added_by         = EXCLUDED.added_by,
              added_on         = CURRENT_TIMESTAMP,
              project_id       = EXCLUDED.project_id
        RETURNING standard_id, title, category, standard_version, form_id, version_no, project_id
        """,
        (
            resolved, Json(entry["form"]),
            (title or entry["form"].get("title") or resolved)[:200],
            entry["category"][:50], Json(entry["tags"]), entry["summary"],
            form_id, version_no, added_by, project_id,
        ),
    )
    row = dict(cur.fetchone())
    logger.info("Library: '%s' (%d questions)", resolved,
                len(entry["form"].get("fields") or []))

    try:
        from app.modules.beneficiaries.service import sync_master_fields_from_standard
        all_fields = [
            f["name"] for f in (entry["form"].get("fields") or [])
            if f.get("name") and f.get("type") not in ("label", "banner")
        ]
        sync_master_fields_from_standard(resolved, all_fields)
    except ImportError:
        pass
    except Exception:
        logger.exception("Could not sync beneficiary master_fields for '%s'", resolved)

    return {**row, "field_count": len(entry["form"].get("fields") or [])}


def remove_form(cur, standard_id: str) -> bool:
    """Withdraw a standard. Forms already started from it keep working; they
    simply report the standard as missing."""
    cur.execute(
        "DELETE FROM standard_form_library WHERE standard_id = %s RETURNING standard_id",
        (standard_id,),
    )
    removed = cur.fetchone() is not None
    if removed:
        logger.info("Library: withdrew '%s'", standard_id)
    return removed


# --------------------------------------------------------------------------- #
# reuse
# --------------------------------------------------------------------------- #
def start_from(standard_id: str, title: Optional[str] = None) -> Dict[str, Any]:
    """The whole standard as a new draft, with its origin recorded.

    What comes back is an ordinary draft — rename it, reword it, add or remove
    questions, or hand it to the model to revise. Nothing is locked.
    """
    entry = get(standard_id)
    if entry is None:
        raise LookupError(f"No standard form '{standard_id}'")

    definition = entry.definition()
    if title:
        definition["title"] = title[:200]
    definition["table_name"] = slugify_identifier(definition.get("title") or "", "form")
    definition["standard_id"] = entry.standard_id
    definition["standard_version"] = entry.standard_version
    return definition


def _free_key(name: str, taken: Sequence[str]) -> str:
    if name not in taken:
        return name
    stem = re.sub(r"_\d+$", "", name)
    n = 2
    while f"{stem}_{n}" in taken:
        n += 1
    return f"{stem}_{n}"


def borrow(
    definition: Dict[str, Any],
    standard_id: str,
    section: Optional[str] = None,
    fields: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """Merge a standard's fields — or one of its sections — into a draft.

    The draft keeps its own title and origin. A borrowed field whose key is
    already used gets a suffixed one, so nothing silently overwrites an existing
    question. Returns a new definition; the input is not modified.
    """
    entry = get(standard_id)
    if entry is None:
        raise LookupError(f"No standard form '{standard_id}'")

    source = entry.definition()
    incoming = source.get("fields") or []
    if section:
        incoming = [f for f in incoming if f.get("section") == section]
        if not incoming:
            raise LookupError(f"'{standard_id}' has no section '{section}'")
    if fields:
        wanted = set(fields)
        incoming = [f for f in incoming if f.get("name") in wanted]

    merged = copy.deepcopy(definition)
    fields = list(merged.get("fields") or [])
    sections = list(merged.get("sections") or [])

    taken_fields = [f["name"] for f in fields]
    taken_sections = {s["key"] for s in sections}

    # Bring across only the sections the borrowed fields actually reference.
    for candidate in source.get("sections") or []:
        if candidate["key"] in taken_sections:
            continue
        if any(f.get("section") == candidate["key"] for f in incoming):
            sections.append(copy.deepcopy(candidate))
            taken_sections.add(candidate["key"])

    for field in incoming:
        field = copy.deepcopy(field)
        field["name"] = _free_key(field["name"], taken_fields)
        taken_fields.append(field["name"])
        if field.get("section") not in taken_sections:
            field["section"] = None
        fields.append(field)

    merged["fields"] = [{**f, "order": i + 1} for i, f in enumerate(fields)]
    merged["sections"] = sections
    return merged


def diff_against_standard(definition: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """How far a form has drifted from the standard it started from.

    None if it did not come from one. Reuses the version-diff machinery, so the
    output reads exactly like a diff between two versions.
    """
    standard_id = (definition or {}).get("standard_id")
    if not standard_id:
        return None

    entry = get(standard_id)
    if entry is None:
        return {
            "standard_id": standard_id,
            "available": False,
            "message": f"This form cites standard '{standard_id}', which is no longer in the library",
        }

    result = diff_definitions(entry.definition(), definition)
    result.update({
        "standard_id": entry.standard_id,
        "available": True,
        "title": entry.title,
        "standard_version": entry.standard_version,
        "started_from_version": definition.get("standard_version"),
        "behind": bool(
            definition.get("standard_version")
            and definition["standard_version"] < entry.standard_version
        ),
    })
    return result


def pull_standard_fields(
    form_json: Dict[str, Any],
    field_names: Sequence[str],
    standard_def: Dict[str, Any],
) -> Tuple[Dict[str, Any], List[str]]:
    """Add the named fields from the standard into a form that came from it.

    Additive and one-directional on purpose. A name is pulled only when the
    standard defines it *and* the form does not already have it, so this can
    never remove, rename or overwrite a question — the cases that would strand
    answers already collected, or undo a project's own local change. Everything
    else about the form, including fields the project added itself, is left
    exactly as it was.

    Pure: the standard's definition is passed in rather than read here, so this
    is tested without a database. The caller saves the result through
    `form_service.update_form`, which is where validation, the master-field
    expansion and the new version happen.

    Returns the new definition (a copy — the input is not touched) and the names
    actually added, which may be fewer than asked for.
    """
    std_fields = {
        f["name"]: f
        for f in (standard_def.get("fields") or [])
        if isinstance(f, dict) and f.get("name")
    }
    have = {
        f.get("name")
        for f in (form_json.get("fields") or [])
        if isinstance(f, dict)
    }

    added = [n for n in field_names if n in std_fields and n not in have]

    new_def = dict(form_json)
    new_def["fields"] = list(form_json.get("fields") or []) + [
        copy.deepcopy(std_fields[n]) for n in added
    ]

    # Place each pulled field in the section it occupies on the standard, so it
    # appears there rather than in the designer's "Unplaced questions" pool. A
    # field the standard did not place, or whose section has no match on this
    # form, is left unplaced — which is honest, and the form still shows it.
    layout = form_json.get("layout")
    for name in added:
        layout = _place_in_layout(layout, standard_def.get("layout"), name)
    if layout is not None:
        new_def["layout"] = layout

    return new_def, added


def _layout_section_of(layout: Optional[Dict[str, Any]], name: str) -> Optional[Dict[str, Any]]:
    """The section a field sits in, in this layout, or None."""
    for section in (layout or {}).get("sections") or []:
        for container in section.get("containers") or []:
            if any((c or {}).get("fieldId") == name for c in container.get("fields") or []):
                return section
    return None


def _place_in_layout(form_layout: Optional[Dict[str, Any]],
                     standard_layout: Optional[Dict[str, Any]],
                     name: str) -> Optional[Dict[str, Any]]:
    """Add `name` to `form_layout` in the section it holds on the standard.

    Returns the layout unchanged when there is nowhere sensible to put it: the
    form has no layout, the standard never placed the field, or the form has no
    section matching the standard's (by id, then by title). In those cases the
    field stays out of the layout and the renderer shows it after the placed
    ones — never dropped. `update_form` re-normalizes the result, so the row id
    coined here is provisional.
    """
    if not isinstance(form_layout, dict) or not form_layout.get("sections"):
        return form_layout

    std_section = _layout_section_of(standard_layout, name)
    if not std_section:
        return form_layout

    std_id = std_section.get("id")
    std_title = (std_section.get("title") or "").strip().lower()

    def _matches(section: Dict[str, Any]) -> bool:
        if std_id and section.get("id") == std_id:
            return True
        return bool(std_title) and (section.get("title") or "").strip().lower() == std_title

    if not any(_matches(s) for s in form_layout["sections"]):
        return form_layout

    new_layout = copy.deepcopy(form_layout)
    for section in new_layout["sections"]:
        if _matches(section):
            section.setdefault("containers", []).append(
                {"id": f"{section.get('id') or 'section'}-row-{name}",
                 "fields": [{"fieldId": name, "width": 12}]}
            )
            break
    return new_layout
