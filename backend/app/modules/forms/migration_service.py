"""Keeping stored answers in step with a form that has been edited by hand.

Two operations, both working on the `form_data` JSONB column:

  * `apply_renames` -a field was renamed, so move every stored answer from the
    old key to the new one.
  * `revalidate`    -a field's type, options or requiredness changed, so check
    what is already stored against the current definition and,
    optionally, re-coerce it.

Neither ever deletes an answer. The worst case is a reported issue you decide
what to do about.
"""
import logging
from typing import Any, Dict, List, Optional, Tuple

from psycopg2 import sql
from psycopg2.extras import Json

from app.core.config import settings
from app.modules.forms.field_types import FieldValueError, coerce_value, get_type, json_safe

logger = logging.getLogger(__name__)


class MigrationError(ValueError):
    pass


def _qualified(table_name: str) -> sql.Composed:
    return sql.SQL("{}.{}").format(
        sql.Identifier(settings.db_schema), sql.Identifier(table_name)
    )


# --------------------------------------------------------------------------- #
# renaming a field
# --------------------------------------------------------------------------- #
def validate_renames(
    renames: Dict[str, str],
    previous_fields: List[Dict[str, Any]],
    new_fields: List[Dict[str, Any]],
) -> Dict[str, str]:
    """Reject a rename map that would lose or clobber data."""
    old_names = {f["name"] for f in previous_fields}
    new_names = {f["name"] for f in new_fields}
    clean: Dict[str, str] = {}

    for old, new in (renames or {}).items():
        old, new = str(old).strip(), str(new).strip()
        if not old or not new or old == new:
            continue
        if old not in old_names:
            raise MigrationError(f"Cannot rename '{old}' - no such field in the saved form")
        if new not in new_names:
            raise MigrationError(f"Cannot rename '{old}' to '{new}' - '{new}' is not in the new form")
        if new in old_names and new not in renames:
            raise MigrationError(
                f"Cannot rename '{old}' to '{new}' - a field already uses that key, "
                f"which would overwrite its answers"
            )
        clean[old] = new

    # Two fields renamed onto the same key would collide.
    targets = list(clean.values())
    if len(targets) != len(set(targets)):
        raise MigrationError("Two fields cannot be renamed to the same key")
    return clean


def apply_renames(cur, table_name: str, renames: Dict[str, str]) -> Dict[str, int]:
    """Move each stored answer from its old key to the new one."""
    moved: Dict[str, int] = {}
    for old, new in (renames or {}).items():
        cur.execute(
            sql.SQL(
                """
                UPDATE {}
                   SET form_data = (form_data - %s)
                                   || jsonb_build_object(%s, form_data -> %s)
                 WHERE form_data ? %s
                """
            ).format(_qualified(table_name)),
            (old, new, old, old),
        )
        moved[f"{old} -> {new}"] = cur.rowcount
        logger.info("Renamed %s.%s -> %s in %d rows", table_name, old, new, cur.rowcount)
    return moved


# --------------------------------------------------------------------------- #
# revalidating stored answers
# --------------------------------------------------------------------------- #
def inspect_row(
    form_json: Dict[str, Any], form_data: Dict[str, Any]
) -> Tuple[List[Dict[str, str]], Dict[str, Any], bool]:
    """Check one stored response against the current definition.

    Returns (problems, repaired_form_data, changed). Unlike submission
    validation this never raises -a stored row is history, not an input.
    """
    problems: List[Dict[str, str]] = []
    repaired = dict(form_data or {})
    changed = False

    known = set()
    for field in form_json.get("fields") or []:
        name, label = field["name"], field.get("label") or field["name"]
        known.add(name)
        spec = get_type(field["type"])
        value = repaired.get(name)

        if value in (None, "", [], {}):
            if field.get("required"):
                problems.append({"field": name, "issue": f"{label} is now required but is empty"})
            continue

        if spec.has_options:
            allowed = {o["value"] for o in field.get("options") or []}
            selected = value if isinstance(value, list) else [value]
            gone = [str(v) for v in selected if str(v) not in allowed]
            if gone:
                problems.append(
                    {"field": name, "issue": f"{label} holds '{gone[0]}', no longer an option"}
                )
                continue

        try:
            coerced = json_safe(coerce_value(field["type"], value))
        except FieldValueError as exc:
            problems.append({"field": name, "issue": f"{label}: {exc}"})
            continue

        if coerced != value:
            repaired[name] = coerced
            changed = True

    for key in form_data or {}:
        if key not in known:
            problems.append(
                {"field": key, "issue": f"'{key}' is not in the form any more (answer kept)"}
            )

    return problems, repaired, changed


def revalidate(
    cur, table_name: str, form_id: str, form_json: Dict[str, Any], fix: bool = False
) -> Dict[str, Any]:
    """Walk every stored response for this form and report what no longer fits.

    With `fix=True`, values that can be re-coerced to the current type are
    rewritten in place (a `"12.5"` string becomes `12.5` after the field is
    changed to decimal). Values that cannot be are only ever reported.
    """
    cur.execute(
        sql.SQL("SELECT survey_id, form_data FROM {} WHERE form_id = %s ORDER BY created_on").format(
            _qualified(table_name)
        ),
        (form_id,),
    )
    rows = [dict(r) for r in cur.fetchall()]

    report: Dict[str, Any] = {
        "checked": len(rows),
        "clean": 0,
        "repaired": 0,
        "rows_with_issues": [],
        "fixed": fix,
    }

    for row in rows:
        problems, repaired, changed = inspect_row(form_json, row["form_data"] or {})

        if fix and changed:
            cur.execute(
                sql.SQL("UPDATE {} SET form_data = %s WHERE survey_id = %s").format(
                    _qualified(table_name)
                ),
                (Json(repaired), row["survey_id"]),
            )
            report["repaired"] += 1

        if problems:
            report["rows_with_issues"].append(
                {"survey_id": row["survey_id"], "problems": problems}
            )
        else:
            report["clean"] += 1

    return report
