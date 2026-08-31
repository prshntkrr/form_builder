"""Form persistence: `forms`, `form_version`, and the per-form data table."""
import logging
from typing import Any, Dict, List, Optional

from psycopg2 import sql
from psycopg2.extras import Json

from app.modules.forms.constants import FORM_STATUSES, FORM_TYPES
from app.core.config import settings
from app.modules.forms.config_validation import BusinessContext, validate_config
from app.modules.forms.diff_service import diff_versions as _diff_versions, trace_names
from app.modules.forms.form_schema import derive_table_name, normalize_form
from app.core.database import transaction
from app.modules.forms.migration_service import apply_renames, revalidate, validate_renames
from app.modules.forms.table_service import resolve_table_name, sync_table, table_exists
from app.modules.forms import standard_library
from app.modules.forms import tabular_service

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
    """`version_no` is the version that is *live* — which after a rollback is not
    necessarily the highest one. Each definition carries its own number, so the
    `forms` row itself says which that is; `latest_version` is the highest."""
    form_json = row.get("form_json") or {}
    latest = row.get("max_version_no")
    live = version if version is not None else (form_json.get("version") or latest or 1)
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
        "version_no": int(live),
        "latest_version": int(latest) if latest else int(live),
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
    project: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Forms this installation holds.

    `project` narrows the list to one context. `"none"` is the system context:
    forms that belong to no project, which is every form built before projects
    existed. Without it the list is unnarrowed, which is what it always was.

    This is not project isolation — that is `projects/access.py`, which decides
    whether somebody may open a form at all. This only says which context a
    screen is showing, so a project's forms and the system's are never mixed on
    one page.
    """
    clauses = ["f.form_status <> 'Deleted'"]
    params: List[Any] = []

    if status:
        clauses = ["f.form_status = %s"]
        params.append(status)

    if project == "none":
        clauses.append("f.project_id IS NULL")
    elif project:
        clauses.append("f.project_id = %s")
        params.append(project)
    if search:
        clauses.append("(f.form_title ILIKE %s OR f.form_description ILIKE %s)")
        params += [f"%{search}%", f"%{search}%"]

    params += [limit, offset]
    sql_text = f"""
        SELECT f.*,
               (SELECT MAX(version_no) FROM form_version v WHERE v.form_id = f.form_id) AS max_version_no
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
                   (SELECT MAX(version_no) FROM form_version v WHERE v.form_id = f.form_id) AS max_version_no
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


def _validate_config(
    cur,
    form_json: Dict[str, Any],
    *,
    form_id: Optional[str] = None,
    form_type: str = "parent",
    parent_id: Optional[str] = None,
    status: str = "Active",
) -> None:
    """Run the two-stage pipeline before a config is allowed to be persisted.

    The database facts a business rule needs are gathered here so the pipeline
    itself stays pure and testable without a connection.
    """
    context = BusinessContext(
        form_id=form_id,
        form_type=form_type,
        parent_id=parent_id,
        form_status=status,
        known_form_ids=_known_form_ids(cur) if parent_id else (),
        known_standard_ids=standard_library.known_ids(cur),
    )
    validate_config(form_json, context)


def _known_form_ids(cur) -> List[str]:
    cur.execute("SELECT form_id FROM forms")
    return [r["form_id"] for r in cur.fetchall()]


def _raw_versions(cur, form_id: str) -> List[Dict[str, Any]]:
    cur.execute(
        """
        SELECT version_id, form_id, version_no, form_json
        FROM form_version WHERE form_id = %s ORDER BY version_no DESC
        """,
        (form_id,),
    )
    return [dict(r) for r in cur.fetchall()]


def _renames_between(
    by_no: Dict[int, Dict[str, Any]], live_no: int, target_no: int
) -> Dict[str, str]:
    """How field keys must move to go from the live version to the target one.

    `trace_names` only walks backwards through `renamed_from`, so going forward
    (after an earlier rollback) means tracing the other way and inverting.
    """
    live_fields = [f["name"] for f in (by_no[live_no].get("fields") or [])]
    target_fields = [f["name"] for f in (by_no[target_no].get("fields") or [])]

    if target_no < live_no:
        return trace_names(by_no, target_no, live_no, live_fields)

    forward = trace_names(by_no, live_no, target_no, target_fields)
    return {live_name: target_name for target_name, live_name in forward.items()}


def rollback(form_id: str, version_no: int, updated_by: Optional[str] = None) -> Dict[str, Any]:
    """Make an existing version the live one.

    No new version is written. `forms.form_json` is pointed at that version's
    stored definition verbatim, and because every definition carries its own
    `version` number, the row itself says which version is live. The version
    history is untouched, so this is reversible by rolling to any other version.

    Fields renamed between the two versions are traced through the chain, so the
    answers already collected move to the keys the newly live definition expects
    rather than being orphaned.
    """
    with transaction() as cur:
        cur.execute("SELECT * FROM forms WHERE form_id = %s FOR UPDATE", (form_id,))
        existing = cur.fetchone()
        if not existing:
            raise FormNotFound(f"Form {form_id} not found")

        rows = _raw_versions(cur, form_id)
        by_no = {int(r["version_no"]): (r.get("form_json") or {}) for r in rows}
        if version_no not in by_no:
            raise FormServiceError(f"Version {version_no} does not exist")

        existing_json = existing["form_json"] or {}
        live_no = int(existing_json.get("version") or max(by_no, default=1))
        if version_no == live_no:
            raise FormServiceError(f"Version {version_no} is already live")
        if live_no not in by_no:
            raise FormServiceError(f"The live definition (version {live_no}) is not in the history")

        # Copied verbatim, so `forms.form_json` and the version row stay identical
        # and "live version N" is literally true. Only the table name is pinned,
        # since it is fixed at creation and never travels with a definition.
        target = dict(by_no[version_no])
        target["table_name"] = existing_json.get("table_name") or target.get("table_name")
        target["form_id"] = form_id

        rename_map = validate_renames(
            _renames_between(by_no, live_no, version_no),
            existing_json.get("fields") or [],
            target.get("fields") or [],
        )

        cur.execute(
            """
            UPDATE forms
               SET form_title = %s, form_description = %s, form_json = %s,
                   updated_on = CURRENT_TIMESTAMP
             WHERE form_id = %s
            RETURNING *
            """,
            (target.get("title"), target.get("description"), Json(target), form_id),
        )
        row = dict(cur.fetchone())

        moved = apply_renames(cur, target["table_name"], rename_map) if rename_map else {}
        table_report = sync_table(cur, target)
        tabular_report = tabular_service.sync(cur, target, rename_map)
        if tabular_report["created"] or tabular_report["added"] or tabular_report["retyped"]:
            tabular_report.update(tabular_service.rebuild(cur, target, form_id))

    logger.info("Form %s rolled from version %s to version %s (%s by)",
                form_id, live_no, version_no, updated_by or settings.default_user)
    result = _row_to_form(row, version=version_no)
    result["rolled_from"] = live_no
    result["table"] = table_report
    result["tabular"] = tabular_report
    result["renamed"] = moved
    return result


def add_to_library(
    form_id: str,
    version_no: Optional[int] = None,
    *,
    standard_id: Optional[str] = None,
    category: str = "General",
    tags: Optional[List[str]] = None,
    summary: Optional[str] = None,
    added_by: Optional[str] = None,
) -> Dict[str, Any]:
    """Offer one of this form's versions as a standard others can start from.

    Defaults to the version that is live. The definition is copied into the
    library, so the form itself is untouched and the standard outlives it.
    """
    form = get_form(form_id)
    pinned = int(version_no or form["version_no"] or 1)

    with transaction() as cur:
        cur.execute(
            "SELECT form_json FROM form_version WHERE form_id = %s AND version_no = %s",
            (form_id, pinned),
        )
        row = cur.fetchone()
        if not row:
            raise FormServiceError(f"{form_id} has no version {pinned}")

        # The definition is copied into the library, so what happens to this
        # form afterwards — edits, deletion — cannot affect the standard.
        return standard_library.add_form(
            cur, row["form_json"] or {},
            form_id=form_id, version_no=pinned, standard_id=standard_id,
            title=form["form_title"], category=category, tags=tags,
            summary=summary, added_by=added_by,
        )


def remove_from_library(standard_id: str) -> bool:
    with transaction() as cur:
        return standard_library.remove_form(cur, standard_id)


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
        # Nothing invalid reaches the INSERT below.
        _validate_config(
            cur, form_json, form_type=form_type, parent_id=parent_id, status=status
        )
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

        _validate_config(
            cur,
            form_json,
            form_id=form_id,
            form_type=existing.get("form_type") or "parent",
            parent_id=existing.get("parent_id"),
            status=status or existing.get("form_status") or "Active",
        )

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
