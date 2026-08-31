"""Where a submission has got to, and who may move it.

    draft ──▶ submitted ──▶ under_review ──▶ approved
                  │              │
                  └──────────────┴────────▶ rejected ──▶ submitted

The transitions are a table, not a chain of `if`s, and every move goes through
`advance()`. That is what stops the obvious attack — a surveyor posting
`{"status": "approved"}` at their own submission — without every route having to
remember to check.

Two rules a state machine alone would not give:

* Who may make a move is part of the move. Submitting is the author's to do;
  approving and rejecting need `submissions.review`, which a surveyor's role
  does not carry.
* A rejection has to say why. A submission that comes back with no reason is
  not something anybody can act on.

The answers themselves are untouched by any of this. Review lives in
`submission_review`, beside the response rather than inside it, so a form's own
table and its flat mirror stay exactly as they were.
"""
import logging
from typing import Any, Dict, List, Optional

from app.core.database import transaction

logger = logging.getLogger(__name__)

DRAFT = "draft"
SUBMITTED = "submitted"
UNDER_REVIEW = "under_review"
APPROVED = "approved"
REJECTED = "rejected"

STATUSES = (DRAFT, SUBMITTED, UNDER_REVIEW, APPROVED, REJECTED)

# What a submission may be recorded as when nothing has said otherwise. A
# response that arrived before this existed was simply submitted.
DEFAULT_STATUS = SUBMITTED


class WorkflowError(ValueError):
    """The move is not one this submission can make."""


class NotFound(LookupError):
    pass


# action -> (states it may be made from, the state it leads to, who may make it)
#
# `author` means the person who submitted it; `reviewer` means somebody holding
# `project.submissions.review` here.
TRANSITIONS: Dict[str, Dict[str, Any]] = {
    "submit": {"from": (DRAFT, REJECTED), "to": SUBMITTED, "by": "author"},
    "start_review": {"from": (SUBMITTED,), "to": UNDER_REVIEW, "by": "reviewer"},
    "approve": {"from": (SUBMITTED, UNDER_REVIEW), "to": APPROVED, "by": "reviewer"},
    "reject": {"from": (SUBMITTED, UNDER_REVIEW), "to": REJECTED, "by": "reviewer"},
}


def status_of(form_id: str, survey_id: str) -> Dict[str, Any]:
    """One submission's review record, invented at its default if there is none.

    Responses collected before this module existed have no row. They read as
    `submitted`, which is what they are, and the row appears the first time
    somebody acts on one.
    """
    with transaction() as cur:
        cur.execute(
            "SELECT * FROM submission_review WHERE form_id = %s AND survey_id = %s",
            (form_id, survey_id),
        )
        row = cur.fetchone()

    if row:
        return dict(row)

    return {
        "form_id": form_id,
        "survey_id": survey_id,
        "status": DEFAULT_STATUS,
        "submitted_by": "",
        "submitted_on": None,
        "reviewed_by": "",
        "reviewed_on": None,
        "rejection_reason": "",
    }


def record_submission(form_id: str, survey_id: str, submitted_by: str,
                      status: str = SUBMITTED) -> Dict[str, Any]:
    """Start a submission's review record, as the response is stored.

    Called from the submission service so every new response has a state from
    the moment it exists.
    """
    if status not in (DRAFT, SUBMITTED):
        raise WorkflowError(f"A new submission is {DRAFT} or {SUBMITTED}, not {status}.")

    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO submission_review
                (form_id, survey_id, status, submitted_by, submitted_on, updated_on)
            VALUES (%s, %s, %s, %s,
                    CASE WHEN %s = 'submitted' THEN CURRENT_TIMESTAMP END,
                    CURRENT_TIMESTAMP)
            ON CONFLICT (form_id, survey_id) DO NOTHING
            """,
            (form_id, survey_id, status, submitted_by, status),
        )

    return status_of(form_id, survey_id)


def advance(form_id: str, survey_id: str, action: str, *, actor: str,
            is_author: bool, may_review: bool, reason: str = "") -> Dict[str, Any]:
    """Make one move, or explain why it cannot be made.

    Every status change in the application comes through here — there is no
    endpoint that writes `status` directly, which is what makes the table above
    the whole of the rule rather than a description of it.
    """
    move = TRANSITIONS.get(action)
    if move is None:
        raise WorkflowError(
            f"'{action}' is not something a submission can do. "
            f"Try one of: {', '.join(TRANSITIONS)}"
        )

    current = status_of(form_id, survey_id)

    if current["status"] not in move["from"]:
        raise WorkflowError(
            f"A submission that is {current['status']} cannot be {action}ed — "
            f"that is for one that is {' or '.join(move['from'])}."
        )

    if move["by"] == "author" and not is_author:
        raise WorkflowError("Only the person who filled this in can submit it.")

    if move["by"] == "reviewer" and not may_review:
        raise WorkflowError(
            "Reviewing a submission needs the review permission in this project."
        )

    if action == "reject" and not str(reason or "").strip():
        raise WorkflowError(
            "A rejection has to say why, or there is nothing for anybody to act on."
        )

    to = move["to"]
    reviewed = move["by"] == "reviewer"

    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO submission_review
                (form_id, survey_id, status, submitted_by, submitted_on,
                 reviewed_by, reviewed_on, rejection_reason, updated_on)
            VALUES (%(form)s, %(survey)s, %(to)s,
                    %(submitted_by)s, %(submitted_on)s,
                    %(reviewer)s, %(reviewed_on)s, %(reason)s, CURRENT_TIMESTAMP)
            ON CONFLICT (form_id, survey_id) DO UPDATE SET
                status           = EXCLUDED.status,
                submitted_by     = COALESCE(NULLIF(EXCLUDED.submitted_by, ''),
                                            submission_review.submitted_by),
                submitted_on     = COALESCE(EXCLUDED.submitted_on,
                                            submission_review.submitted_on),
                reviewed_by      = EXCLUDED.reviewed_by,
                reviewed_on      = EXCLUDED.reviewed_on,
                rejection_reason = EXCLUDED.rejection_reason,
                updated_on       = CURRENT_TIMESTAMP
            """,
            {
                "form": form_id,
                "survey": survey_id,
                "to": to,
                "submitted_by": actor if action == "submit" else current["submitted_by"],
                "submitted_on": None if action != "submit" else "now",
                "reviewer": actor if reviewed else current["reviewed_by"],
                "reviewed_on": "now" if reviewed else current["reviewed_on"],
                # A reason belongs to the rejection that carried it. Coming back
                # round to submitted clears it, so a stale one cannot be read as
                # the state of things now.
                "reason": reason.strip() if action == "reject" else "",
            },
        )

        if action == "submit":
            cur.execute(
                "UPDATE submission_review SET submitted_on = CURRENT_TIMESTAMP "
                "WHERE form_id = %s AND survey_id = %s",
                (form_id, survey_id),
            )
        if reviewed:
            cur.execute(
                "UPDATE submission_review SET reviewed_on = CURRENT_TIMESTAMP "
                "WHERE form_id = %s AND survey_id = %s",
                (form_id, survey_id),
            )

    logger.info("Submission %s/%s: %s -> %s by %s",
                form_id, survey_id, current["status"], to, actor)
    return status_of(form_id, survey_id)


def statuses_for(form_id: str, survey_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """Review records for a page of submissions, in one query."""
    if not survey_ids:
        return {}

    with transaction() as cur:
        cur.execute(
            "SELECT * FROM submission_review WHERE form_id = %s AND survey_id = ANY(%s)",
            (form_id, list(survey_ids)),
        )
        found = {row["survey_id"]: dict(row) for row in cur.fetchall()}

    return {sid: found.get(sid) or status_of(form_id, sid) for sid in survey_ids}


def counts_for(form_id: str) -> Dict[str, int]:
    """How many submissions are in each state, for a review queue."""
    with transaction() as cur:
        cur.execute(
            "SELECT status, COUNT(*) AS n FROM submission_review "
            "WHERE form_id = %s GROUP BY status",
            (form_id,),
        )
        return {row["status"]: int(row["n"]) for row in cur.fetchall()}
