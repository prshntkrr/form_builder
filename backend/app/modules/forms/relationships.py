"""One form's submissions hanging off another's.

    Farmer Registration   survey_id = FRM00001-000001
            │
            └── Plot Registration   survey_id        = FRM00002-000001
                                    parent_survey_id = FRM00001-000001

A child submission keeps its own `survey_id` and stores *which* parent
submission it belongs to. Nothing is copied: the farmer's name lives in the
farmer's row and nowhere else, so correcting it corrects every plot at once.

Three separate questions, and they are answered in three different places
because they need different things:

    is this a legal relationship?     `check_configuration` — the form being
                                      saved, its parent, and the forms between
                                      them. Needs the database.
    may this account use it?          `parents_for` / `validate_parent` — needs
                                      the account, and asks the existing
                                      helpers rather than inventing rules.
    what hangs off this submission?   `children_of` / `parent_of` — plain reads,
                                      still authorized by the caller.

The permission model is not extended here. A child form is a form: it is filled
by whoever may fill it, its submissions are read by whoever may read them, and a
relationship is never a way to reach either. Every function below asks
`projects/access.py` the same questions every other route asks it.
"""
import logging
from typing import Any, Dict, List, Optional

from psycopg2 import sql

from app.core.config import settings
from app.core.database import transaction
from app.modules.forms.form_schema import parent_form_id
from app.modules.forms.table_service import table_exists

logger = logging.getLogger(__name__)

# How deep a chain may go. Farmer -> Plot -> Crop season is three; the limit is
# generous and exists only so a cycle that somehow survived the check below
# cannot loop forever.
MAX_DEPTH = 10


class RelationshipError(ValueError):
    """The relationship cannot be configured, or the parent cannot be used."""


# --------------------------------------------------------------------------- #
# reading a form's place in the tree
# --------------------------------------------------------------------------- #
def _form_row(cur, form_id: str) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT form_id, form_title, form_status, form_json, project_id "
        "FROM forms WHERE form_id = %s",
        (form_id,),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def parent_of_form(form_id: str) -> Optional[str]:
    """The form whose submissions this form's submissions hang off."""
    with transaction() as cur:
        row = _form_row(cur, form_id)
    return parent_form_id((row or {}).get("form_json") or {})


def child_forms(form_id: str) -> List[Dict[str, Any]]:
    """The forms configured as children of this one.

    Read from each definition rather than from a lookup table: the definition is
    where the relationship is declared, and a second copy of it would be a
    second thing to keep in step.
    """
    with transaction() as cur:
        cur.execute(
            """
            SELECT form_id, form_title, form_description, form_status, project_id,
                   form_json
            FROM   forms
            WHERE  form_status <> 'Deleted'
              AND  form_json -> 'relationship' ->> 'parent_form_id' = %s
              AND  form_json -> 'relationship' ->> 'type' = 'child'
            ORDER  BY form_title
            """,
            (form_id,),
        )
        rows = [dict(r) for r in cur.fetchall()]

    return [{k: v for k, v in row.items() if k != "form_json"} for row in rows]


def ancestry(form_id: str) -> List[str]:
    """This form and every form above it, nearest first.

    Stops at `MAX_DEPTH` and on a repeat, so a loop that somehow reached the
    database cannot hang a request.
    """
    chain: List[str] = []
    seen = set()
    current: Optional[str] = form_id

    while current and current not in seen and len(chain) < MAX_DEPTH:
        seen.add(current)
        chain.append(current)
        current = parent_of_form(current)

    return chain


# --------------------------------------------------------------------------- #
# is this a legal relationship?
# --------------------------------------------------------------------------- #
def check_configuration(form_id: Optional[str], form_json: Dict[str, Any],
                        project_id: Optional[str] = None) -> None:
    """Refuse a relationship that cannot mean anything. Raises, or returns None.

    Called wherever a definition is saved, so a form cannot reach the database
    carrying a parent that is missing, elsewhere, itself, or upstream of itself.
    """
    parent = parent_form_id(form_json)
    if not parent:
        return

    if form_id and parent == form_id:
        raise RelationshipError(
            "A form cannot be its own parent. Choose another form, or make this "
            "one independent."
        )

    with transaction() as cur:
        row = _form_row(cur, parent)

    if row is None or row["form_status"] == "Deleted":
        raise RelationshipError(
            f"There is no form '{parent}' to be the parent of this one."
        )

    # A relationship must not reach across the line the rest of the application
    # keeps. A project's form belongs to that project; a system form belongs to
    # no project, and the two are not each other's business.
    if project_id != row["project_id"]:
        here = f"project {project_id}" if project_id else "no project"
        there = f"project {row['project_id']}" if row["project_id"] else "no project"
        raise RelationshipError(
            f"A form in {here} cannot hang off a form in {there}. A parent and "
            f"its children have to belong to the same place."
        )

    # Walking up from the proposed parent must not arrive back here.
    if form_id and form_id in ancestry(parent):
        raise RelationshipError(
            "That would make a loop: this form is already somewhere above the "
            "one you picked."
        )

    if len(ancestry(parent)) >= MAX_DEPTH:
        raise RelationshipError(
            f"That chain would be more than {MAX_DEPTH} forms deep."
        )


def check_change_is_safe(form_id: str, form_json: Dict[str, Any]) -> None:
    """Refuse a change of parent that would orphan submissions already stored.

    A child submission's `parent_survey_id` points into one particular form's
    rows. Re-pointing the child form at a different parent leaves every existing
    value meaning nothing — and silently rewriting them would be worse. So the
    change is refused while those submissions exist, and the person is told what
    is in the way.

    Going from independent to child is always safe: there is nothing to orphan.
    """
    was = parent_of_form(form_id)
    now = parent_form_id(form_json)

    if was == now or not was:
        return

    held = count_children_stored(form_id)
    if not held:
        return

    if now:
        raise RelationshipError(
            f"This form already has {held} submission(s) linked to "
            f"'{was}'. Changing the parent to '{now}' would leave every one of "
            f"them pointing at a submission in the wrong form. Those responses "
            f"have to be dealt with first."
        )

    raise RelationshipError(
        f"This form already has {held} submission(s) linked to '{was}'. Making "
        f"it independent would strand them."
    )


def count_children_stored(form_id: str) -> int:
    """How many submissions of this form name a parent."""
    from app.modules.forms import form_service

    try:
        form = form_service.get_form(form_id)
    except Exception:
        return 0

    table = (form.get("form_json") or {}).get("table_name")
    if not table:
        return 0

    with transaction() as cur:
        if not table_exists(cur, table):
            return 0
        if "parent_survey_id" not in _columns(cur, table):
            return 0
        cur.execute(
            sql.SQL("SELECT COUNT(*) AS n FROM {}.{} WHERE parent_survey_id IS NOT NULL")
            .format(sql.Identifier(settings.db_schema), sql.Identifier(table))
        )
        return int(cur.fetchone()["n"])


def _columns(cur, table: str) -> set:
    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s",
        (settings.db_schema, table),
    )
    return {row["column_name"] for row in cur.fetchall()}


# --------------------------------------------------------------------------- #
# may this account use this parent?
# --------------------------------------------------------------------------- #
def _may_read_submission(user: Dict[str, Any], form: Dict[str, Any],
                         created_by: str) -> bool:
    """Whether this account may read one submission of one form.

    The existing rules, asked rather than restated:

        a project's form   `submission_scope` — every submission in the project,
                           or only this account's own
        a system form      the account permission that reaches system forms

    A relationship never widens either. Being offered a parent to attach to is
    the same permission as being able to open that parent.
    """
    from app.core import auth_service

    project_id = form.get("project_id")

    if not project_id:
        return auth_service.may(user, "forms.system.view")

    try:
        from app.modules.projects import access
    except Exception:
        return False

    scope = access.submission_scope(user, project_id)
    if scope is None:
        return False
    if scope == access.SCOPE_ALL:
        return True
    return bool(created_by) and created_by == auth_service.display_name(user)


def parents_for(user: Dict[str, Any], child_form_id: str,
                search: str = "", limit: int = 50) -> Dict[str, Any]:
    """The parent submissions this account may attach a new child to.

    Narrowed here, never in the browser. A surveyor is offered the submissions
    their own scope already lets them read; somebody who may read the whole
    project's is offered the whole project's. Nobody is offered a submission
    they could not open.
    """
    from app.modules.forms import form_service, submission_service

    child = form_service.get_form(child_form_id)
    parent_id = parent_form_id(child.get("form_json") or {})
    if not parent_id:
        raise RelationshipError(f"'{child_form_id}' is not configured as a child form.")

    parent = form_service.get_form(parent_id)
    with transaction() as cur:
        row = _form_row(cur, parent_id)
    project_id = (row or {}).get("project_id")

    listed = submission_service.list_submissions(parent, limit=500)

    rows = []
    for record in listed["rows"]:
        if not _may_read_submission(user, {"project_id": project_id},
                                    record.get("created_by") or ""):
            continue

        summary = _summarise(parent.get("form_json") or {}, record.get("form_data") or {})
        if search and search.lower() not in f"{summary} {record['survey_id']}".lower():
            continue

        rows.append({
            "survey_id": record["survey_id"],
            "summary": summary,
            "created_by": record.get("created_by") or "",
            "created_on": record.get("created_on"),
        })
        if len(rows) >= limit:
            break

    return {
        "parent_form_id": parent_id,
        "parent_form_title": parent["form_title"],
        "submissions": rows,
    }


def _summarise(form_json: Dict[str, Any], form_data: Dict[str, Any]) -> str:
    """Enough of a submission to recognise it in a list.

    The first couple of answered text-ish questions, in the order the form asks
    them — which for a registration form is the name of the thing registered.
    """
    parts = []
    for field in (form_json.get("fields") or [])[:6]:
        if not isinstance(field, dict):
            continue
        if field.get("type") not in ("text", "select", "radio", "email", "phone"):
            continue
        value = form_data.get(field.get("name"))
        if value in (None, "", []):
            continue
        parts.append(str(value))
        if len(parts) == 2:
            break

    return " · ".join(parts)


def validate_parent(user: Dict[str, Any], child_form: Dict[str, Any],
                    parent_survey_id: Any) -> Optional[str]:
    """The check a child submission has to pass. Returns the id to store.

    Everything the caller sent is treated as a claim. In order:

        the child form really is a child form
        its configured parent form exists
        the submission named exists *in that parent form's own table*
        the two are in the same project, or both outside every project
        this account may read that parent submission

    The third is the one that stops a plausible-looking attack: a survey id from
    another form is a real id, and only looking for it in the right table
    rejects it.
    """
    from app.modules.forms import form_service

    child_json = child_form.get("form_json") or {}
    parent_id = parent_form_id(child_json)
    supplied = str(parent_survey_id or "").strip()

    if not parent_id:
        if supplied:
            raise RelationshipError(
                "This form is not a child form, so it cannot be attached to "
                "another submission."
            )
        return None

    if not supplied:
        raise RelationshipError(
            "This form's submissions belong to a submission of "
            f"'{parent_id}'. Choose which one before saving."
        )

    try:
        parent = form_service.get_form(parent_id)
    except Exception:
        raise RelationshipError(f"The parent form '{parent_id}' no longer exists.")

    with transaction() as cur:
        child_row = _form_row(cur, child_form["form_id"])
        parent_row = _form_row(cur, parent_id)

    if parent_row is None:
        raise RelationshipError(f"The parent form '{parent_id}' no longer exists.")

    # The same line the configuration check draws, enforced again at submission:
    # a form can be edited, and a stored relationship is not a licence.
    if (child_row or {}).get("project_id") != parent_row.get("project_id"):
        raise RelationshipError(
            "The parent submission belongs to a different project."
        )

    table = (parent.get("form_json") or {}).get("table_name")
    if not table:
        raise RelationshipError(f"The parent form '{parent_id}' has no submissions.")

    with transaction() as cur:
        if not table_exists(cur, table):
            raise RelationshipError(f"The parent form '{parent_id}' has no submissions.")
        cur.execute(
            sql.SQL("SELECT survey_id, created_by FROM {}.{} "
                    "WHERE form_id = %s AND survey_id = %s")
            .format(sql.Identifier(settings.db_schema), sql.Identifier(table)),
            (parent_id, supplied),
        )
        found = cur.fetchone()

    if found is None:
        # Deliberately the same message whether the id is invented or belongs to
        # a different form: either way it is not a submission of this parent.
        raise RelationshipError(
            f"'{supplied}' is not a submission of '{parent['form_title']}'."
        )

    if not _may_read_submission(user, parent_row, found["created_by"] or ""):
        raise RelationshipError(
            "That submission is not one you can attach to."
        )

    return supplied


# --------------------------------------------------------------------------- #
# what hangs off this submission?
# --------------------------------------------------------------------------- #
def children_of(user: Dict[str, Any], form_id: str,
                survey_id: str) -> List[Dict[str, Any]]:
    """Every child submission of one parent submission, per child form.

    The caller has already been allowed to read the parent. Each child form is
    then filtered on its own terms — a surveyor sees the plots they entered, not
    a colleague's — so a parent is never a way around a scope.
    """
    from app.modules.forms import form_service, submission_service

    out = []
    for child in child_forms(form_id):
        try:
            definition = form_service.get_form(child["form_id"])
        except Exception:
            continue

        table = (definition.get("form_json") or {}).get("table_name")
        if not table:
            continue

        with transaction() as cur:
            if not table_exists(cur, table) or "parent_survey_id" not in _columns(cur, table):
                continue
            cur.execute(
                sql.SQL("SELECT survey_id, form_data, created_by, created_on FROM {}.{} "
                        "WHERE form_id = %s AND parent_survey_id = %s "
                        "ORDER BY created_on DESC")
                .format(sql.Identifier(settings.db_schema), sql.Identifier(table)),
                (child["form_id"], survey_id),
            )
            rows = [dict(r) for r in cur.fetchall()]

        readable = [
            row for row in rows
            if _may_read_submission(user, child, row.get("created_by") or "")
        ]

        out.append({
            "form_id": child["form_id"],
            "form_title": child["form_title"],
            "form_status": child["form_status"],
            "submissions": [
                {
                    "survey_id": row["survey_id"],
                    "created_by": row.get("created_by") or "",
                    "created_on": row.get("created_on"),
                    "form_data": row.get("form_data") or {},
                }
                for row in readable
            ],
        })

    return out


def parent_of(form_id: str, survey_id: str) -> Optional[Dict[str, Any]]:
    """Which submission this one hangs off, if any.

    Reading it is not permission to open it: the caller decides that, through
    the same route anybody else would use.
    """
    from app.modules.forms import form_service

    try:
        child = form_service.get_form(form_id)
    except Exception:
        return None

    parent_id = parent_form_id(child.get("form_json") or {})
    table = (child.get("form_json") or {}).get("table_name")
    if not parent_id or not table:
        return None

    with transaction() as cur:
        if not table_exists(cur, table) or "parent_survey_id" not in _columns(cur, table):
            return None
        cur.execute(
            sql.SQL("SELECT parent_survey_id FROM {}.{} WHERE survey_id = %s")
            .format(sql.Identifier(settings.db_schema), sql.Identifier(table)),
            (survey_id,),
        )
        row = cur.fetchone()

    linked = (row or {}).get("parent_survey_id")
    if not linked:
        return None

    parent = form_service.get_form(parent_id)
    parent_table = (parent.get("form_json") or {}).get("table_name")

    summary = ""
    with transaction() as cur:
        if parent_table and table_exists(cur, parent_table):
            cur.execute(
                sql.SQL("SELECT form_data FROM {}.{} WHERE survey_id = %s")
                .format(sql.Identifier(settings.db_schema), sql.Identifier(parent_table)),
                (linked,),
            )
            found = cur.fetchone()
            if found:
                summary = _summarise(parent.get("form_json") or {},
                                     found["form_data"] or {})

    return {
        "form_id": parent_id,
        "form_title": parent["form_title"],
        "survey_id": linked,
        "summary": summary,
    }
