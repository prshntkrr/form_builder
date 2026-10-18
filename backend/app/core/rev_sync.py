"""Sync project membership changes back to the REV platform database.

When a member is added or removed from a project inside form_builder,
the change must be reflected in REV's project_members table so the
REV dashboard shows the correct project list for each user.
"""
import logging

from app.core.database import rev_transaction, transaction

logger = logging.getLogger(__name__)


def _rev_user_id_for(email: str):
    """Look up a user's REV id by email."""
    with rev_transaction() as cur:
        cur.execute("SELECT id FROM users WHERE email = %s", (email,))
        row = cur.fetchone()
        return row["id"] if row else None


def sync_member_added(project_id: str, user_id: str):
    """Add user to the project in REV's database."""
    try:
        with transaction() as cur:
            cur.execute("SELECT email FROM app_user WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            if not row:
                return

        email = row["email"]
        rev_user_id = _rev_user_id_for(email)
        if not rev_user_id:
            logger.warning("REV sync: no REV user for %s", email)
            return

        with rev_transaction() as cur:
            cur.execute(
                """
                INSERT INTO project_members (project_id, user_id)
                VALUES (%s, %s)
                ON CONFLICT (project_id, user_id) DO NOTHING
                """,
                (project_id, rev_user_id),
            )
        logger.info("REV sync: added %s to project %s", email, project_id)
    except Exception as exc:
        logger.warning("REV sync failed (add member): %s", exc)


def sync_member_removed(project_id: str, user_id: str):
    """Remove user from the project in REV's database."""
    try:
        with transaction() as cur:
            cur.execute("SELECT email FROM app_user WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            if not row:
                return

        email = row["email"]
        rev_user_id = _rev_user_id_for(email)
        if not rev_user_id:
            return

        with rev_transaction() as cur:
            cur.execute(
                "DELETE FROM project_members WHERE project_id = %s AND user_id = %s",
                (project_id, rev_user_id),
            )
        logger.info("REV sync: removed %s from project %s", email, project_id)
    except Exception as exc:
        logger.warning("REV sync failed (remove member): %s", exc)
