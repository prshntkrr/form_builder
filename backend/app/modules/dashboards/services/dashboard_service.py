"""Persistence service for dashboards."""

from typing import Any, Dict, Optional
from uuid import uuid4

from psycopg2.extras import Json

from app.core.database import transaction


def _generate_dashboard_id() -> str:
    """Generate a short unique dashboard identifier."""
    return uuid4().hex[:20]


def create_dashboard(
    title: str,
    dashboard_json: Dict[str, Any],
    created_by: Optional[str] = None,
) -> Dict[str, Any]:
    """Create and persist a dashboard."""

    dashboard_id = _generate_dashboard_id()

    with transaction() as conn:
        conn.execute(
            """
            INSERT INTO dashboard (
                dashboard_id,
                title,
                dashboard_json,
                created_by
            )
            VALUES (
                %s,
                %s,
                %s,
                %s
            )
            RETURNING
                dashboard_id,
                title,
                dashboard_json,
                status,
                created_on,
                updated_on,
                created_by
            """,
            (
                dashboard_id,
                title,
                Json(dashboard_json),
                created_by,
            ),
        )

        row = conn.fetchone()

    return dict(row)


def list_dashboards() -> list[Dict[str, Any]]:
    """Return all active dashboards."""

    with transaction() as conn:
        conn.execute(
            """
            SELECT
                dashboard_id,
                title,
                status,
                created_on,
                updated_on,
                created_by
            FROM dashboard
            WHERE status = 'Active'
            ORDER BY updated_on DESC, created_on DESC
            """
        )

        rows = conn.fetchall()

    return [dict(row) for row in rows]


def get_dashboard(
    dashboard_id: str,
) -> Optional[Dict[str, Any]]:
    """Return an active dashboard by ID."""

    with transaction() as conn:
        conn.execute(
            """
            SELECT
                dashboard_id,
                title,
                dashboard_json,
                status,
                created_on,
                updated_on,
                created_by
            FROM dashboard
            WHERE dashboard_id = %s
              AND status = 'Active'
            """,
            (dashboard_id,),
        )

        row = conn.fetchone()

    if row is None:
        return None

    return dict(row)

def update_dashboard(
    dashboard_id: str,
    title: str,
    dashboard_json: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Update an existing active dashboard."""

    with transaction() as conn:
        conn.execute(
            """
            UPDATE dashboard
            SET
                title = %s,
                dashboard_json = %s,
                updated_on = CURRENT_TIMESTAMP
            WHERE dashboard_id = %s
              AND status = 'Active'
            """,
            (
                title,
                Json(dashboard_json),
                dashboard_id,
            ),
        )

        if conn.rowcount == 0:
            return None

        conn.execute(
            """
            SELECT
                dashboard_id,
                title,
                dashboard_json,
                status,
                created_on,
                updated_on,
                created_by
            FROM dashboard
            WHERE dashboard_id = %s
            """,
            (dashboard_id,),
        )

        row = conn.fetchone()

    return dict(row)

def delete_dashboard(
    dashboard_id: str,
) -> bool:
    """Soft-delete an active dashboard."""

    with transaction() as conn:
        conn.execute(
            """
            UPDATE dashboard
            SET
                status = 'Deleted',
                updated_on = CURRENT_TIMESTAMP
            WHERE dashboard_id = %s
              AND status = 'Active'
            """,
            (dashboard_id,),
        )

        return conn.rowcount > 0