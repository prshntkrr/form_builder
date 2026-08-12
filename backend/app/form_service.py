"""Form persistence: `forms`, `form_version`, and the per-form data table."""
import logging
from typing import Any, Dict, List, Optional

from psycopg2 import sql
from psycopg2.extras import Json

from .bootstrap import FORM_STATUSES, FORM_TYPES
from .config import settings
from .diff_service import diff_versions as _diff_versions
from .form_schema import derive_table_name, normalize_form
from .database import transaction
from .migration_service import apply_renames, revalidate, validate_renames
from .table_service import resolve_table_name, sync_table, table_exists
from . import tabular_service

logger = logging.getLogger(__name__)

FORM_ID_PREFIX = "FRM"


class FormNotFound(LookupError):
    pass


class FormServiceError(RuntimeError):
    pass


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _next_form_id(cur) -> str:
    """FRM00001, FRM00002, ... — derived from the highest existing id.

    The surrounding transaction takes the row lock, so two concurrent creates
    serialize rather than colliding on the primary key.
    """
    cur.execute(
        f"""
        SELECT COALESCE(MAX(CAST(SUBSTRING(form_id, {len(FORM_ID_PREFIX) + 1}) AS INTEGER)), 0) + 1
               AS next_no
        FROM forms
        WHERE form_id ~ %s
        """,
        (f"^{FORM_ID_PREFIX}[0-9]+$",),
    )
    return f"{FORM_ID_PREFIX}{int(cur.fetchone()['next_no']):05d}"


def _current_version(cur, form_id: str) -> int:
    cur.execute(
        "SELECT COALESCE(MAX(version_no), 0) AS v FROM form_version WHERE form_id = %s",
        (form_id,),
    )
    return int(cur.fetchone()["v"])


def _row_to_form(row: Dict[str, Any], version: Optional[int] = None) -> Dict[str, Any]:
    form_json = row.get("form_json") or {}
    return {
        "form_id": row["form_id"],
        "form_title": row["form_title"],
        "form_description": row.get("form_description"),
        "form_json": form_json,
        "form_type": row.get("form_type"),
        "form_status": row.get("form_status"),
        "parent_id": row.get("parent_id"),
        "created_on": row.get("created_on"),
        "updated_on": row.get("updated_on"),
        "created_by": row.get("created_by"),
        "table_name": form_json.get("table_name"),
        "field_count": len(form_json.get("fields") or []),
        "version_no": version if version is not None else row.get("version_no"),
        "submission_count": row.get("submission_count"),
    }


# --------------------------------------------------------------------------- #
# reads
# --------------------------------------------------------------------------- #
def list_forms(
    status: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> List[Dict[str, Any]]:
    clauses = ["f.form_status <> 'Deleted'"]
    params: List[Any] = []

    if status:
        clauses = ["f.form_status = %s"]
        params.append(status)
    if search:
        clauses.append("(f.form_title ILIKE %s OR f.form_description ILIKE %s)")
        params += [f"%{search}%", f"%{search}%"]

    params += [limit, offset]
    sql_text = f"""
        SELECT f.*,
               (SELECT MAX(version_no) FROM form_version v WHERE v.form_id = f.form_id) AS version_no
        FROM forms f
        WHERE {' AND '.join(clauses)}
        ORDER BY f.updated_on DESC NULLS LAST, f.created_on DESC
        LIMIT %s OFFSET %s
    """
    with transaction() as cur:
        cur.execute(sql_text, params)
        forms = [_row_to_form(dict(r)) for r in cur.fetchall()]
        for form in forms:
            form["submission_count"] = _count_submissions(cur, form)
        return forms


def _count_submissions(cur, form: Dict[str, Any]) -> Optional[int]:
    """How many responses this form has. None if it has no table yet."""
    table = form.get("table_name")
    if not table or not table_exists(cur, table):
        return None
    cur.execute(
        sql.SQL("SELECT COUNT(*) AS n FROM {}.{} WHERE form_id = %s").format(
            sql.Identifier(settings.db_schema), sql.Identifier(table)
        ),
        (form["form_id"],),
    )
    return int(cur.fetchone()["n"])


def get_form(form_id: str) -> Dict[str, Any]:
    with transaction() as cur:
        cur.execute(
            """
            SELECT f.*,
                   (SELECT MAX(version_no) FROM form_version v WHERE v.form_id = f.form_id) AS version_no
            FROM forms f WHERE f.form_id = %s
            """,
            (form_id,),
        )
        row = cur.fetchone()
        if not row:
            raise FormNotFound(f"Form {form_id} not found")
        form = _row_to_form(dict(row))
        form["submission_count"] = _count_submissions(cur, form)
        return form


def check_submissions(form_id: str, fix: bool = False) -> Dict[str, Any]:
    """Re-check stored responses against the form's current definition.

    Use after editing a field by hand: it reports answers that no longer fit the
    type, options or requiredness, and with `fix=True` re-coerces the ones it can.
    """
    form = get_form(form_id)
    table = (form["form_json"] or {}).get("table_name")
    with transaction() as cur:
        if not table or not table_exists(cur, table):
            return {"checked": 0, "clean": 0, "repaired": 0, "rows_with_issues": [], "fixed": fix}
        return revalidate(cur, table, form_id, form["form_json"], fix=fix)


def _raw_versions(cur, form_id: str) -> List[Dict[str, Any]]:
    cur.execute(
        """
        SELECT version_id, form_id, version_no, form_json
        FROM form_version WHERE form_id = %s ORDER BY version_no DESC
        """,
        (form_id,),
    )
    return [dict(r) for r in cur.fetchall()]


def rebuild_tabular(form_id: str) -> Dict[str, Any]:
    """Repopulate a form's flat mirror from its JSONB table.

    Runs automatically when columns change; this is the manual door, for a form
    whose responses predate the mirror.
    """
    form = get_form(form_id)
    definition = form["form_json"] or {}
    if not definition.get("table_name"):
        raise FormNotFound(f"Form {form_id} has no data table")

    with transaction() as cur:
        report = tabular_service.sync(cur, definition)
        report.update(tabular_service.rebuild(cur, definition, form_id))
    return report


def get_versions(form_id: str, include_json: bool = False) -> List[Dict[str, Any]]:
    """The revision history, newest first. The full definitions are heavy, so
    they are only included when asked for."""
    with transaction() as cur:
        rows = _raw_versions(cur, form_id)

    out = []
    for r in rows:
        fj = r.get("form_json") or {}
        entry = {
            "version_id": r["version_id"],
            "form_id": r["form_id"],
            "version_no": r["version_no"],
            "title": fj.get("title"),
            "field_count": len(fj.get("fields") or []),
            "saved_by": fj.get("updated_by") or fj.get("created_by"),
            "renamed_from": fj.get("renamed_from") or None,
        }
        if include_json:
            entry["form_json"] = fj
        out.append(entry)
    return out


def diff_versions(form_id: str, from_no: Optional[int], to_no: Optional[int]) -> Dict[str, Any]:
    """What changed between two saved versions of this form.

    Defaults to the newest version against the one before it.
    """
    with transaction() as cur:
        cur.execute("SELECT 1 FROM forms WHERE form_id = %s", (form_id,))
        if not cur.fetchone():
            raise FormNotFound(f"Form {form_id} not found")
        rows = _raw_versions(cur, form_id)

    if not rows:
        raise FormNotFound(f"Form {form_id} has no saved versions")

    numbers = sorted(int(r["version_no"]) for r in rows)
    to_no = int(to_no) if to_no else numbers[-1]
    from_no = int(from_no) if from_no else max(numbers[0], to_no - 1)

    result = _diff_versions(rows, from_no, to_no)
    result["form_id"] = form_id
    result["available_versions"] = numbers
    return result


# --------------------------------------------------------------------------- #
# writes
# --------------------------------------------------------------------------- #
def create_form(
    form_json: Dict[str, Any],
    created_by: Optional[str] = None,
    form_type: str = "parent",
    parent_id: Optional[str] = None,
    status: str = "Active",
) -> Dict[str, Any]:
    """Persist a new form, open version 1, and provision its data table."""
    if status not in FORM_STATUSES:
        raise FormServiceError(f"Unknown status '{status}'")
    if form_type not in FORM_TYPES:
        raise FormServiceError(f"Unknown form type '{form_type}'")

    definition = normalize_form(form_json)

    # Precedence: what the request says, then an author the prompt named and the
    # model picked up, then the configured fallback.
    author = (created_by or definition.get("created_by") or settings.default_user)[:50]

    with transaction() as cur:
        form_id = _next_form_id(cur)
        definition["table_name"] = resolve_table_name(cur, definition["table_name"])
        definition["form_id"] = form_id
        definition["version"] = 1
        definition["created_by"] = author

        cur.execute(
            """
            INSERT INTO forms (form_id, form_title, form_description, form_json,
                               form_type, form_status, parent_id, created_by,
                               created_on, updated_on)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            RETURNING *
            """,
            (
                form_id,
                definition["title"],
                definition["description"],
                Json(definition),
                form_type,
                status,
                parent_id,
                author,
            ),
        )
        row = dict(cur.fetchone())

        cur.execute(
            "INSERT INTO form_version (form_id, version_no, form_json) VALUES (%s, %s, %s)",
            (form_id, 1, Json(definition)),
        )

        table_report = sync_table(cur, definition)
        tabular_report = tabular_service.sync(cur, definition)

    logger.info(
        "Created form %s -> %s + %s",
        form_id,
        table_report["table_name"],
        tabular_report["name"],
    )
    result = _row_to_form(row, version=1)
    result["table"] = table_report
    result["tabular"] = tabular_report
    return result


def update_form(
    form_id: str,
    form_json: Dict[str, Any],
    updated_by: Optional[str] = None,
    status: Optional[str] = None,
    renames: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Save a new revision.

    Bumps the version and appends to `form_version`. If fields were renamed,
    `renames` maps old key -> new key and the stored answers are moved with them
    so existing responses keep matching the definition.
    """
    definition = normalize_form(form_json)

    with transaction() as cur:
        cur.execute("SELECT * FROM forms WHERE form_id = %s FOR UPDATE", (form_id,))
        existing = cur.fetchone()
        if not existing:
            raise FormNotFound(f"Form {form_id} not found")

        existing_json = existing["form_json"] or {}
        # The table is never renamed — its name is fixed at creation so live data
        # keeps its home even if the title changes.
        definition["table_name"] = existing_json.get("table_name") or resolve_table_name(
            cur, derive_table_name(definition["title"]), form_id
        )
        definition["form_id"] = form_id

        version_no = _current_version(cur, form_id) + 1
        definition["version"] = version_no
        # The original author is never rewritten by an edit.
        definition["created_by"] = existing_json.get("created_by") or existing.get("created_by")
        # `forms` has no updated_by column, so the author of this revision is
        # recorded inside the versioned JSON instead.
        definition["updated_by"] = updated_by or settings.default_user

        # Checked before anything is written: an invalid rename should reject the
        # whole edit, not leave a version behind.
        rename_map = validate_renames(
            renames or {}, existing_json.get("fields") or [], definition["fields"]
        )
        # Stored new key -> old key, so a later diff can follow a field across
        # however many versions separate the two being compared.
        definition["renamed_from"] = {new: old for old, new in rename_map.items()} or None

        cur.execute(
            """
            UPDATE forms
               SET form_title = %s, form_description = %s, form_json = %s,
                   form_status = COALESCE(%s, form_status),
                   updated_on = CURRENT_TIMESTAMP
             WHERE form_id = %s
            RETURNING *
            """,
            (
                definition["title"],
                definition["description"],
                Json(definition),
                status,
                form_id,
            ),
        )
        row = dict(cur.fetchone())

        cur.execute(
            "INSERT INTO form_version (form_id, version_no, form_json) VALUES (%s, %s, %s)",
            (form_id, version_no, Json(definition)),
        )

        table_report = sync_table(cur, definition)

        # Move stored answers to their new keys, in the same transaction as the
        # definition change, so the two can never disagree.
        moved = apply_renames(cur, definition["table_name"], rename_map) if rename_map else {}

        # The flat mirror follows the definition: columns added, dropped,
        # renamed or replaced to match the new set of questions.
        tabular_report = tabular_service.sync(cur, definition, rename_map)
        if tabular_report["created"] or tabular_report["added"] or tabular_report["retyped"]:
            tabular_report.update(tabular_service.rebuild(cur, definition, form_id))

    logger.info("Updated form %s to version %s", form_id, version_no)
    result = _row_to_form(row, version=version_no)
    result["table"] = table_report
    result["tabular"] = tabular_report
    result["renamed"] = moved
    return result


def set_status(form_id: str, status: str) -> Dict[str, Any]:
    if status not in FORM_STATUSES:
        raise FormServiceError(
            f"Unknown status '{status}' - expected one of {', '.join(FORM_STATUSES)}"
        )
    with transaction() as cur:
        cur.execute(
            """
            UPDATE forms SET form_status = %s, updated_on = CURRENT_TIMESTAMP
            WHERE form_id = %s RETURNING *
            """,
            (status, form_id),
        )
        row = cur.fetchone()
        if not row:
            raise FormNotFound(f"Form {form_id} not found")
        return _row_to_form(dict(row))
