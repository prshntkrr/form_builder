"""One WhatsApp conversation in progress, in the database.

    start ─> (LANGUAGE) ─> CONSENT ─yes─> QUESTIONS ─> (REVIEW) ─> COMPLETED
                              │                              submitted
                              └─no─> DECLINED

LANGUAGE is asked only by a form that offers more than one; a form with one
language starts at CONSENT exactly as it always has.

The database is the session. It is not a cache of one held in the process: an
in-memory dictionary does not survive `--reload`, is not shared between workers,
and two replies to the same question arriving on two workers would disagree
about which question is outstanding. `uq_whatsapp_session_live` makes "one live
conversation per number" something Postgres enforces rather than something every
code path has to remember.

What a session pins, and why:

    form_version    the definition the first question came from. Republishing
                    the form must not reinterpret a half-finished conversation,
                    so every later question, every validation and the final
                    submission read this version and not the live one.
    user_id         the account the phone number resolved to. Authorisation was
                    decided against the account, once, when the session started;
                    the number is never treated as an authenticated user.

`answers` holds validated values — what `form_data` would store — not the raw
replies, because each reply is checked as it arrives
(`submission_service.validate_field`). A partial kept at expiry is therefore
already coerced, and the one thing it has not been through is the whole-form
pass: required questions never reached. That is deliberate and it is what
`partial` means; see `expire`.
"""
import logging
import uuid
from typing import Any, Dict, List, Optional

from psycopg2.extras import Json

from app.core.database import transaction

logger = logging.getLogger(__name__)

# What the conversation is waiting for.
#: LANGUAGE comes before CONSENT and only for a form offering more than one
#: language — a form with one goes straight to the welcome, exactly as before.
LANGUAGE = "LANGUAGE"
CONSENT, QUESTIONS, REVIEW = "CONSENT", "QUESTIONS", "REVIEW"

# What became of it.
ACTIVE, COMPLETED, EXPIRED, DECLINED = "ACTIVE", "COMPLETED", "EXPIRED", "DECLINED"


def _shown(row: Dict[str, Any]) -> Dict[str, Any]:
    session = dict(row)
    session["answers"] = session.get("answers") or {}
    return session


def start(identity: str, receiver_number: str, route: Dict[str, Any],
          user_id: str, timeout_seconds: int) -> Dict[str, Any]:
    """Begin a conversation, replacing whatever this number was in the middle of.

    Sending a keyword while already answering something is a person starting
    again, not a second conversation: the previous session is expired first —
    which keeps whatever it had collected, exactly as a timeout would — and then
    this one becomes the live one. Both in one transaction, so the unique index
    on live sessions is never briefly violated.
    """
    session_id = uuid.uuid4().hex[:32]

    with transaction() as cur:
        cur.execute(
            "UPDATE whatsapp_session SET status = %s, completed_on = CURRENT_TIMESTAMP "
            "WHERE channel = 'whatsapp' AND identity = %s AND status = %s "
            "RETURNING session_id, form_id, form_version, answers, project_id",
            (EXPIRED, identity, ACTIVE),
        )
        replaced = [dict(r) for r in cur.fetchall()]

        cur.execute(
            """
            INSERT INTO whatsapp_session
                (session_id, identity, receiver_number, route_id, form_id,
                 form_version, project_id, user_id, state, answers, status,
                 expires_on)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    CURRENT_TIMESTAMP + make_interval(secs => %s))
            RETURNING *
            """,
            (session_id, identity, receiver_number or "", route.get("route_id"),
             route["form_id"], route["version"], route.get("project_id"),
             user_id, CONSENT, Json({}), ACTIVE, int(timeout_seconds)),
        )
        session = _shown(dict(cur.fetchone()))

    if replaced:
        logger.info("Replaced %d unfinished WhatsApp session(s) for a new one",
                    len(replaced))
    return session


def live(identity: str) -> Optional[Dict[str, Any]]:
    """The conversation this number is in, or None.

    Expiry is decided here, on the way in, because a webhook is the only clock
    this has: a message arriving after the deadline is answered as a new
    conversation, not as the next question of a dead one. The sweep
    (`expire_due`) exists so an abandoned session is still finished off when
    nobody sends anything.
    """
    with transaction() as cur:
        # Postgres decides whether the deadline has passed, not this process:
        # the timestamps were written by the database and comparing them to a
        # Python clock would make expiry depend on which machine answered.
        cur.execute(
            "SELECT *, (expires_on <= CURRENT_TIMESTAMP) AS due "
            "FROM whatsapp_session "
            "WHERE channel = 'whatsapp' AND identity = %s AND status = %s",
            (identity, ACTIVE),
        )
        row = cur.fetchone()

    if row is None:
        return None

    session = _shown(dict(row))
    if session.pop("due", False):
        expire(session["session_id"])
        return None
    return session


def touch(session_id: str, timeout_seconds: int, **changes: Any) -> Dict[str, Any]:
    """Record a reply and push the deadline out.

    Every write to a live session goes through this, so there is no path that
    advances the conversation without resetting the clock — a session that
    expires while somebody is answering it is the bug this shape prevents.
    """
    assignments = ["last_activity_on = CURRENT_TIMESTAMP",
                   "expires_on = CURRENT_TIMESTAMP + make_interval(secs => %s)"]
    values: List[Any] = [int(timeout_seconds)]

    for column in ("state", "consent", "current_field", "survey_id", "language"):
        if column in changes:
            assignments.append(f"{column} = %s")
            values.append(changes[column])

    if "answers" in changes:
        assignments.append("answers = %s")
        values.append(Json(changes["answers"] or {}))

    with transaction() as cur:
        cur.execute(
            f"UPDATE whatsapp_session SET {', '.join(assignments)} "
            "WHERE session_id = %s AND status = %s RETURNING *",
            [*values, session_id, ACTIVE],
        )
        row = cur.fetchone()

    return _shown(dict(row)) if row else {}


def finish(session_id: str, status: str, survey_id: Optional[str] = None) -> None:
    """The conversation is over: submitted, declined, or given up on.

    The row is kept rather than deleted. A provider that retries a webhook it
    never heard back from would otherwise be starting a fresh survey with the
    reply that finished the last one.
    """
    with transaction() as cur:
        cur.execute(
            "UPDATE whatsapp_session SET status = %s, survey_id = COALESCE(%s, survey_id), "
            "completed_on = CURRENT_TIMESTAMP WHERE session_id = %s",
            (status, survey_id, session_id),
        )


def recently_finished(identity: str, seconds: int = 300) -> Optional[Dict[str, Any]]:
    """The conversation this number just finished, if it did.

    So a duplicate delivery of the reply that completed a survey is answered
    with the confirmation again rather than starting a new one.
    """
    with transaction() as cur:
        cur.execute(
            "SELECT * FROM whatsapp_session "
            "WHERE channel = 'whatsapp' AND identity = %s AND status <> %s "
            "  AND completed_on > CURRENT_TIMESTAMP - make_interval(secs => %s) "
            "ORDER BY completed_on DESC LIMIT 1",
            (identity, ACTIVE, int(seconds)),
        )
        row = cur.fetchone()
    return _shown(dict(row)) if row else None


# --------------------------------------------------------------------------- #
# expiry
# --------------------------------------------------------------------------- #
def expire(session_id: str) -> Optional[Dict[str, Any]]:
    """End one silent conversation, keeping what it had collected.

    A partial is stored as a submission and an expired session is **not** a
    completed one: `status` says EXPIRED, `completed_on` is when it was given up
    on, and the row is never marked COMPLETED. What tells the two apart in the
    collected data is `form_survey_progress` — a partial is written through the
    same submission service as everything else, so there is no second write
    path — and the session row itself.

    Returns the session as it was, so a caller can say what was kept.
    """
    with transaction() as cur:
        cur.execute(
            "UPDATE whatsapp_session SET status = %s, completed_on = CURRENT_TIMESTAMP "
            "WHERE session_id = %s AND status = %s RETURNING *",
            (EXPIRED, session_id, ACTIVE),
        )
        row = cur.fetchone()

    if row is None:
        return None                     # somebody else expired it first

    session = _shown(dict(row))
    _keep_partial(session)
    return session


def expire_due(limit: int = 200) -> int:
    """End every conversation that has gone quiet. Returns how many.

    Called from the background sweep. `live()` also expires on the way in, so
    this is only for the sessions nobody comes back to.
    """
    with transaction() as cur:
        cur.execute(
            "SELECT session_id FROM whatsapp_session "
            "WHERE status = %s AND expires_on <= CURRENT_TIMESTAMP LIMIT %s",
            (ACTIVE, limit),
        )
        due = [r["session_id"] for r in cur.fetchall()]

    return len([s for s in due if expire(s) is not None])


def _keep_partial(session: Dict[str, Any]) -> None:
    """Store what an abandoned conversation had answered, if anything.

    **This deliberately skips the whole-form validation.** A partial is by
    definition missing the questions that were never asked, so running
    `validate_payload` over it would refuse every required answer that had not
    been reached yet and the work would be thrown away instead of kept. Each
    value here has already been through `validate_field` as it arrived, so what
    is stored is coerced and individually valid — what it is not is complete.

    It is written through `submission_service._write` for that reason and no
    other: it is the one entry point that stores the answers, the flat mirror
    and the channel note in a single transaction. Everything above it —
    required-field checks, conditions, the channel profile — is the part being
    deliberately skipped.

    Failure here is logged and swallowed. A partial that cannot be stored must
    not stop the session being marked expired, or the conversation would be
    retried forever.
    """
    answers = session.get("answers") or {}
    if not answers or not session.get("form_id"):
        return

    from app.modules.forms import form_service, submission_service, table_service

    try:
        form = form_service.get_form(session["form_id"])
        form_json = form.get("form_json") or {}
        table_name = form_json.get("table_name")
        if not table_name:
            return

        with transaction() as cur:
            if not table_service.table_exists(cur, table_name):
                return
            survey_id = table_service.next_survey_id(cur, form["form_id"], table_name)
            submission_service._write(
                cur=cur, form=form, form_json=form_json, table_name=table_name,
                clean=answers,
                version=session.get("form_version") or 1,
                created_by=f"whatsapp:{session['identity']}",
                parent_survey_id=None, location=None, survey_id=survey_id,
                channel="whatsapp", client_submission_id=None,
                source_ref=f"partial {session['session_id']}", payload=answers,
            )

        with transaction() as cur:
            cur.execute("UPDATE whatsapp_session SET survey_id = %s WHERE session_id = %s",
                        (survey_id, session["session_id"]))

        logger.info("Kept %d partial answer(s) from expired session %s as %s",
                    len(answers), session["session_id"], survey_id)
    except Exception:
        logger.exception("Could not keep the partial answers of session %s",
                         session.get("session_id"))
