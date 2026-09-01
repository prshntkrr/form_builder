"""Moving a submission through review.

Four routes, one for each move the workflow allows. None of them takes a status
from the caller: the move is the URL, and `submission_workflow.advance` decides
whether this account may make it from where the submission currently is. There
is deliberately no `PATCH /submissions/{id}/status`.
"""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core import auth_service
from app.core.database import transaction
from app.core.deps import current_user
from app.modules.projects import access, project_service, submission_workflow

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/submissions", tags=["submission review"])


class RejectRequest(BaseModel):
    reason: str


def _submission(form_id: str, survey_id: str) -> Dict[str, Any]:
    """The response itself, so its author is known before anything is decided."""
    from app.modules.forms import form_service
    from app.modules.forms.table_service import table_exists
    from psycopg2 import sql

    try:
        form = form_service.get_form(form_id)
    except form_service.FormNotFound:
        raise HTTPException(status_code=404, detail=f"No form '{form_id}'")

    table = (form["form_json"] or {}).get("table_name")

    with transaction() as cur:
        if not table or not table_exists(cur, table):
            raise HTTPException(status_code=404, detail=f"No submission '{survey_id}'")

        cur.execute(
            sql.SQL("SELECT survey_id, created_by FROM {} WHERE survey_id = %s")
            .format(sql.Identifier(table)),
            (survey_id,),
        )
        row = cur.fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail=f"No submission '{survey_id}'")

    return {"form": form, "created_by": row["created_by"]}


def _reachable(form_id: str, survey_id: str, user: Dict[str, Any]) -> Dict[str, Any]:
    """Everything a move needs to be judged, and a refusal if it cannot be.

    A submission belonging to a project this account is not in is answered 404,
    the same as one that does not exist — consistent with `access.require`, and
    the reason a manager of one project cannot even confirm another's ids.
    """
    found = _submission(form_id, survey_id)
    project_id = project_service.project_of_form(form_id)

    author = auth_service.display_name(user)
    is_author = bool(found["created_by"]) and found["created_by"] == author

    if not project_id:
        # A form built before projects. It keeps the system-wide rules it always
        # had; review is a project idea and does not apply to it.
        raise HTTPException(
            status_code=404,
            detail=f"Form '{form_id}' does not belong to a project",
        )

    # Whose answers this account may read here — `all`, `own`, or nothing at
    # all for somebody who is not in the project.
    scope = access.submission_scope(user, project_id)
    if scope is None:
        raise HTTPException(status_code=404, detail=f"No submission '{survey_id}'")

    if scope != access.SCOPE_ALL and not is_author:
        # In the project, but this is somebody else's answer and they may not
        # read those.
        raise HTTPException(status_code=404, detail=f"No submission '{survey_id}'")

    return {
        "project_id": project_id,
        "is_author": is_author,
        # Reading a submission and judging one are separate permissions, asked
        # separately. A surveyor reaches their own answer and can still move it
        # nowhere a reviewer would.
        "may_review": access.may_review_submissions(user, project_id),
        "actor": author,
    }


def _move(form_id: str, survey_id: str, action: str,
          user: Dict[str, Any], reason: str = "") -> Dict[str, Any]:
    context = _reachable(form_id, survey_id, user)

    try:
        return submission_workflow.advance(
            form_id, survey_id, action,
            actor=context["actor"],
            is_author=context["is_author"],
            may_review=context["may_review"],
            reason=reason,
        )
    except submission_workflow.WorkflowError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/{form_id}/{survey_id}")
def status(form_id: str, survey_id: str, user: Dict[str, Any] = Depends(current_user)):
    """Where one submission has got to."""
    _reachable(form_id, survey_id, user)
    return submission_workflow.status_of(form_id, survey_id)


@router.get("/{form_id}/{survey_id}/detail")
def detail(form_id: str, survey_id: str, user: Dict[str, Any] = Depends(current_user)):
    """One submission in full: its questions, its answers and where it has got to.

    What a reviewer reads before deciding. Authorized exactly as every other
    route in this file — `_reachable` first, so a submission from a project this
    account is not in, or somebody else's answer when they may only read their
    own, is a 404 here as it is everywhere else. Changing the id in the URL
    reaches nothing new.

    Read-only, and deliberately narrow: labels, types and stored values. The
    form's definition, its table and its validation rules are not part of the
    answer, and a screen that only displays a submission does not need them.
    """
    from app.modules.forms import submission_service

    context = _reachable(form_id, survey_id, user)

    found = _submission(form_id, survey_id)
    form = found["form"]
    row = submission_service.one_submission(form, survey_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"No submission '{survey_id}'")

    state = submission_workflow.status_of(form_id, survey_id)
    form_json = form["form_json"] or {}

    return {
        "submission_id": survey_id,
        "form_id": form_id,
        "form_name": form["form_title"],
        "project_id": context["project_id"],
        "submitted_by": row["created_by"] or state["submitted_by"],
        "submitted_at": row["created_on"],
        "form_version": row["form_version"],
        "status": state["status"],
        "rejection_reason": state["rejection_reason"],
        "answers": submission_service.answers_for(form_json, row["form_data"]),
        # There is no event log — `submission_review` keeps the current state
        # only — so this is what is actually known about how it got here, not an
        # invented history.
        "review_history": _history(state),
        # What this account may do with it, so the screen shows the moves it has
        # rather than offering ones the backend would refuse.
        "may_review": context["may_review"],
        "is_author": context["is_author"],
    }


def _history(state: Dict[str, Any]) -> list:
    """What the review record can honestly say about how it got here."""
    events = []
    if state.get("submitted_on"):
        events.append({"event": "submitted",
                       "by": state.get("submitted_by") or "",
                       "on": state["submitted_on"]})
    if state.get("reviewed_on"):
        events.append({"event": state["status"],
                       "by": state.get("reviewed_by") or "",
                       "on": state["reviewed_on"],
                       "reason": state.get("rejection_reason") or ""})
    return events

@router.post("/{form_id}/{survey_id}/submit")
def submit(form_id: str, survey_id: str, user: Dict[str, Any] = Depends(current_user)):
    """Hand a draft, or a rejected answer, back for review."""
    return _move(form_id, survey_id, "submit", user)


@router.post("/{form_id}/{survey_id}/start-review")
def start_review(form_id: str, survey_id: str, user: Dict[str, Any] = Depends(current_user)):
    return _move(form_id, survey_id, "start_review", user)


@router.post("/{form_id}/{survey_id}/approve")
def approve(form_id: str, survey_id: str, user: Dict[str, Any] = Depends(current_user)):
    return _move(form_id, survey_id, "approve", user)


@router.post("/{form_id}/{survey_id}/reject")
def reject(form_id: str, survey_id: str, req: RejectRequest,
           user: Dict[str, Any] = Depends(current_user)):
    """Send it back, saying why. A rejection with no reason is refused."""
    return _move(form_id, survey_id, "reject", user, reason=req.reason)


# --------------------------------------------------------------------------- #
# the project's review queue
# --------------------------------------------------------------------------- #
queue_router = APIRouter(prefix="/api/projects", tags=["submission review"])


@queue_router.get("/{project_id}/submissions")
def project_submissions(
    project_id: str,
    status: Optional[str] = Query(None, description="Only submissions in this state"),
    form_id: Optional[str] = Query(None, description="Only submissions of this form"),
    limit: int = Query(50, ge=1, le=500),
    user: Dict[str, Any] = Depends(current_user),
):
    """Every submission in the project this account may read.

    Somebody holding `submissions.view_all` sees the project's submissions;
    anybody else sees the ones they made themselves. `everything` says which of
    the two answers this is, so a screen can word itself honestly.

    `form_id` and `status` narrow that answer and can never widen it. Both are
    applied in SQL, before the row limit — a status filter applied afterwards
    would take fifty rows and then throw most of them away, so a queue with
    sixty submitted responses would show ten. And `form_id` is matched inside
    this project's own forms, so an id from another project simply selects
    nothing.
    """
    from app.modules.forms import form_service
    from app.modules.forms.table_service import table_exists
    from psycopg2 import sql

    scope = access.submission_scope(user, project_id)
    if scope is None:
        raise HTTPException(status_code=404, detail=f"No project '{project_id}'")

    # A reviewer or a manager reads the project's submissions; anybody else
    # reads their own. Never narrowed to the caller for somebody holding
    # `submissions.view_all` — that would empty the review queue.
    everything = scope == access.SCOPE_ALL
    author = auth_service.display_name(user)

    with transaction() as cur:
        # The form filter is a WHERE on *this project's* forms. That is the whole
        # of its cross-project isolation: another project's id matches no row
        # here, so the answer is empty rather than somebody else's data.
        cur.execute(
            "SELECT form_id, form_title, form_json FROM forms "
            "WHERE project_id = %s AND form_status <> 'Deleted'"
            + (" AND form_id = %s" if form_id else ""),
            (project_id, form_id) if form_id else (project_id,),
        )
        forms = [dict(row) for row in cur.fetchall()]

    rows = []
    for form in forms:
        table = (form["form_json"] or {}).get("table_name")
        if not table:
            continue

        with transaction() as cur:
            if not table_exists(cur, table):
                continue

            # `submission_review` holds a row only once something has happened
            # to a submission; one collected before that existed, or never acted
            # on, reads as `submitted`. COALESCE says so in the query, so
            # filtering on "Submitted" finds those too.
            clauses = ["t.form_id = %s"]
            values: list = [form["form_id"]]

            if not everything:
                clauses.append("t.created_by = %s")
                values.append(author)

            if status:
                clauses.append("COALESCE(r.status, %s) = %s")
                values.extend([submission_workflow.DEFAULT_STATUS, status])

            values.append(limit)

            query = sql.SQL(
                "SELECT t.survey_id, t.created_on, t.created_by "
                "FROM {} t "
                "LEFT JOIN submission_review r "
                "       ON r.form_id = t.form_id AND r.survey_id = t.survey_id "
                "WHERE {} "
                "ORDER BY t.created_on DESC LIMIT %s"
            ).format(
                sql.Identifier(table),
                sql.SQL(" AND ").join(sql.SQL(c) for c in clauses),
            )
            cur.execute(query, values)
            found = [dict(r) for r in cur.fetchall()]

        states = submission_workflow.statuses_for(
            form["form_id"], [r["survey_id"] for r in found])

        for row in found:
            # The state is read for its reviewer and its rejection reason; the
            # filtering already happened in SQL above.
            state = states.get(row["survey_id"]) or {}
            rows.append({
                "form_id": form["form_id"],
                "form_title": form["form_title"],
                "survey_id": row["survey_id"],
                "created_on": row["created_on"],
                "created_by": row["created_by"],
                "status": state.get("status", submission_workflow.DEFAULT_STATUS),
                "reviewed_by": state.get("reviewed_by", ""),
                "rejection_reason": state.get("rejection_reason", ""),
            })

    rows.sort(key=lambda r: r["created_on"] or "", reverse=True)
    return {
        "submissions": rows[:limit],
        "everything": everything,
        # What was actually applied, so a screen can tell "nothing here" from
        # "nothing matches what you chose".
        "filters": {"form_id": form_id or None, "status": status or None},
    }
