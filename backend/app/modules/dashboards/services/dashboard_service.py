"""Persistence service for dashboards.

Every mutation that creates a new version atomically increments
``dashboard.latest_version`` rather than using ``MAX(version_no) + 1``,
so concurrent saves against the same dashboard always receive distinct
version numbers.

Version rows in ``dashboard_version`` are immutable once inserted — only
their ``status`` column (draft / published) may change.
"""

import secrets
from typing import Any, Dict, List, Optional
from uuid import uuid4

from psycopg2.extras import Json

from app.core.database import transaction


def _generate_dashboard_id() -> str:
    """Generate a short unique dashboard identifier."""
    return uuid4().hex[:20]


class NotPublished(Exception):
    """A dashboard was asked to be shared before anything of it was published."""


# ── Public links ────────────────────────────────────────────────
#
# A public link serves one thing: the published version, to anyone holding the
# link, read-only. Nothing else about the dashboard is reachable through it —
# not its drafts, not its history, not who built it, and not the list it
# belongs to.


def share_dashboard(
    dashboard_id: str,
    shared_by: Optional[str],
) -> Optional[Dict[str, Any]]:
    """Issue the public link for a dashboard, or return the one it has.

    Only a published version is ever served publicly, so a dashboard with
    nothing published cannot be shared — there would be nothing to show, and
    sharing a draft would mean handing out something still being worked on.

    Sharing twice returns the same token rather than minting a new one: the
    first link may already have been sent to people, and silently breaking it
    would be a surprising thing for a second click to do.
    """

    with transaction() as cur:
        cur.execute(
            """
            SELECT share_token, publish_version
            FROM dashboard
            WHERE dashboard_id = %s
              AND status = 'Active'
            """,
            (dashboard_id,),
        )

        row = cur.fetchone()

        if row is None:
            return None

        if row["publish_version"] is None:
            raise NotPublished(
                "Publish a version of this dashboard before sharing it."
            )

        if row["share_token"]:
            return {"share_token": row["share_token"]}

        # 32 bytes from the system source, URL-safe: not a guessable id, and
        # not derived from anything about the dashboard.
        token = secrets.token_urlsafe(32)

        cur.execute(
            """
            UPDATE dashboard
            SET    share_token = %s,
                   shared_on   = CURRENT_TIMESTAMP,
                   shared_by   = %s
            WHERE  dashboard_id = %s
            """,
            (token, shared_by, dashboard_id),
        )

    return {"share_token": token}


def unshare_dashboard(dashboard_id: str) -> bool:
    """Withdraw the public link. Every copy of it stops working at once."""

    with transaction() as cur:
        cur.execute(
            """
            UPDATE dashboard
            SET    share_token = NULL,
                   shared_on   = NULL,
                   shared_by   = NULL
            WHERE  dashboard_id = %s
              AND  status = 'Active'
            """,
            (dashboard_id,),
        )

        return cur.rowcount > 0


def get_shared(token: str) -> Optional[Dict[str, Any]]:
    """What a public link resolves to: one published version, or nothing.

    Returns only what a viewer needs to see the dashboard. The author, the
    drafts, the version history and the dashboard's own id stay behind — a link
    is not a way to learn about the installation it came from.
    """

    if not token:
        return None

    with transaction() as cur:
        cur.execute(
            """
            SELECT dashboard_id, title, publish_version
            FROM dashboard
            WHERE share_token = %s
              AND status = 'Active'
              AND publish_version IS NOT NULL
            """,
            (token,),
        )

        row = cur.fetchone()

    if row is None:
        return None

    version = get_version(row["dashboard_id"], row["publish_version"])

    if version is None:
        return None

    return {
        "title": row["title"],
        "version_no": row["publish_version"],
        "dashboard_json": version["dashboard_json"],
    }


# ── Dashboard CRUD (updated for versioning) ─────────────────────


def create_dashboard(
    title: str,
    dashboard_json: Dict[str, Any],
    created_by: Optional[str] = None,
) -> Dict[str, Any]:
    """Create and persist a dashboard with an initial draft version."""

    dashboard_id = _generate_dashboard_id()

    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO dashboard (
                dashboard_id,
                title,
                dashboard_json,
                created_by,
                latest_version
            )
            VALUES (%s, %s, %s, %s, 1)
            RETURNING
                dashboard_id,
                title,
                dashboard_json,
                status,
                created_on,
                updated_on,
                created_by,
                latest_version,
                publish_version
            """,
            (
                dashboard_id,
                title,
                Json(dashboard_json),
                created_by,
            ),
        )

        row = cur.fetchone()

        # Create version 1 as a draft.
        cur.execute(
            """
            INSERT INTO dashboard_version (
                dashboard_id,
                version_no,
                title,
                dashboard_json,
                status,
                created_by
            )
            VALUES (%s, 1, %s, %s, 'draft', %s)
            """,
            (
                dashboard_id,
                title,
                Json(dashboard_json),
                created_by,
            ),
        )

    return dict(row)


def list_dashboards() -> list[Dict[str, Any]]:
    """Return all active dashboards."""

    with transaction() as cur:
        cur.execute(
            """
            SELECT
                dashboard_id,
                title,
                status,
                created_on,
                updated_on,
                created_by,
                latest_version,
                publish_version
            FROM dashboard
            WHERE status = 'Active'
            ORDER BY updated_on DESC, created_on DESC
            """
        )

        rows = cur.fetchall()

    return [dict(row) for row in rows]


def get_dashboard(
    dashboard_id: str,
) -> Optional[Dict[str, Any]]:
    """Return an active dashboard by ID, including version metadata."""

    with transaction() as cur:
        cur.execute(
            """
            SELECT
                dashboard_id,
                title,
                dashboard_json,
                status,
                created_on,
                updated_on,
                created_by,
                latest_version,
                publish_version,
                share_token
            FROM dashboard
            WHERE dashboard_id = %s
              AND status = 'Active'
            """,
            (dashboard_id,),
        )

        row = cur.fetchone()

    if row is None:
        return None

    return dict(row)


def update_dashboard(
    dashboard_id: str,
    title: str,
    dashboard_json: Dict[str, Any],
    created_by: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Create a new draft version of an existing active dashboard.

    Atomically increments the version counter to avoid races, then
    inserts a new immutable version row.  ``dashboard.dashboard_json``
    and ``dashboard.title`` are kept in sync for backward compatibility.
    """

    with transaction() as cur:
        # Atomically claim the next version number.
        cur.execute(
            """
            UPDATE dashboard
            SET
                latest_version = latest_version + 1,
                title          = %s,
                dashboard_json = %s,
                updated_on     = CURRENT_TIMESTAMP
            WHERE dashboard_id = %s
              AND status = 'Active'
            RETURNING
                dashboard_id,
                title,
                dashboard_json,
                status,
                created_on,
                updated_on,
                created_by,
                latest_version,
                publish_version
            """,
            (
                title,
                Json(dashboard_json),
                dashboard_id,
            ),
        )

        row = cur.fetchone()

        if row is None:
            return None

        new_version = row["latest_version"]

        # Insert the new immutable version row.
        cur.execute(
            """
            INSERT INTO dashboard_version (
                dashboard_id,
                version_no,
                title,
                dashboard_json,
                status,
                created_by
            )
            VALUES (%s, %s, %s, %s, 'draft', %s)
            """,
            (
                dashboard_id,
                new_version,
                title,
                Json(dashboard_json),
                created_by,
            ),
        )

    return dict(row)


def delete_dashboard(
    dashboard_id: str,
) -> bool:
    """Soft-delete an active dashboard.

    Version rows are cleaned up by the ``ON DELETE CASCADE`` on the
    foreign key — they disappear only if the dashboard row itself is
    hard-deleted (which this application never does).
    """

    with transaction() as cur:
        cur.execute(
            """
            UPDATE dashboard
            SET
                status     = 'Deleted',
                updated_on = CURRENT_TIMESTAMP
            WHERE dashboard_id = %s
              AND status = 'Active'
            """,
            (dashboard_id,),
        )

        return cur.rowcount > 0


# ── Version operations ──────────────────────────────────────────


def list_versions(
    dashboard_id: str,
) -> List[Dict[str, Any]]:
    """Return all versions for a dashboard, newest first.

    Lightweight — omits ``dashboard_json`` to keep the payload small.
    """

    with transaction() as cur:
        cur.execute(
            """
            SELECT
                version_no,
                title,
                status,
                created_on,
                created_by
            FROM dashboard_version
            WHERE dashboard_id = %s
            ORDER BY version_no DESC
            """,
            (dashboard_id,),
        )

        rows = cur.fetchall()

    return [dict(row) for row in rows]


def get_version(
    dashboard_id: str,
    version_no: int,
) -> Optional[Dict[str, Any]]:
    """Return a specific version with full dashboard JSON."""

    with transaction() as cur:
        cur.execute(
            """
            SELECT
                version_no,
                title,
                dashboard_json,
                status,
                created_on,
                created_by
            FROM dashboard_version
            WHERE dashboard_id = %s
              AND version_no   = %s
            """,
            (dashboard_id, version_no),
        )

        row = cur.fetchone()

    if row is None:
        return None

    return dict(row)


def publish_version(
    dashboard_id: str,
    version_no: int,
) -> Optional[Dict[str, Any]]:
    """Publish a version.

    Exactly three things change:
    1. The target version's status → ``'published'``.
    2. The previously published version's status → ``'draft'``.
    3. ``dashboard.publish_version`` → target ``version_no``.

    Nothing else is modified.
    """

    with transaction() as cur:
        # Verify the target version exists.
        cur.execute(
            """
            SELECT version_no
            FROM   dashboard_version
            WHERE  dashboard_id = %s
              AND  version_no   = %s
            """,
            (dashboard_id, version_no),
        )

        if cur.fetchone() is None:
            return None

        # Demote the currently published version (if any).
        cur.execute(
            """
            UPDATE dashboard_version
            SET    status = 'draft'
            WHERE  dashboard_id = %s
              AND  status = 'published'
            """,
            (dashboard_id,),
        )

        # Promote the target version.
        cur.execute(
            """
            UPDATE dashboard_version
            SET    status = 'published'
            WHERE  dashboard_id = %s
              AND  version_no   = %s
            """,
            (dashboard_id, version_no),
        )

        # Update the dashboard pointer.
        cur.execute(
            """
            UPDATE dashboard
            SET    publish_version = %s,
                   updated_on     = CURRENT_TIMESTAMP
            WHERE  dashboard_id   = %s
            """,
            (version_no, dashboard_id),
        )

        # Return the published version for the response.
        cur.execute(
            """
            SELECT
                dv.version_no,
                dv.title,
                dv.status,
                dv.created_on,
                dv.created_by,
                d.publish_version
            FROM dashboard_version dv
            JOIN dashboard d ON d.dashboard_id = dv.dashboard_id
            WHERE dv.dashboard_id = %s
              AND dv.version_no   = %s
            """,
            (dashboard_id, version_no),
        )

        row = cur.fetchone()

    if row is None:
        return None

    result = dict(row)
    result["dashboard_id"] = dashboard_id
    return result


def restore_version(
    dashboard_id: str,
    source_version_no: int,
    created_by: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Create a new draft version by copying configuration from an existing one.

    The source version is **never modified**.
    """

    with transaction() as cur:
        # Read the source version — do NOT modify it.
        cur.execute(
            """
            SELECT title, dashboard_json
            FROM   dashboard_version
            WHERE  dashboard_id = %s
              AND  version_no   = %s
            """,
            (dashboard_id, source_version_no),
        )

        source = cur.fetchone()

        if source is None:
            return None

        source_title = source["title"]
        source_json = source["dashboard_json"]

        # Atomically claim the next version number and sync the
        # dashboard's top-level columns to the restored content.
        cur.execute(
            """
            UPDATE dashboard
            SET    latest_version = latest_version + 1,
                   title          = %s,
                   dashboard_json = %s,
                   updated_on     = CURRENT_TIMESTAMP
            WHERE  dashboard_id   = %s
              AND  status         = 'Active'
            RETURNING latest_version, publish_version
            """,
            (
                source_title,
                Json(source_json),
                dashboard_id,
            ),
        )

        dash_row = cur.fetchone()

        if dash_row is None:
            return None

        new_version = dash_row["latest_version"]

        # Insert the new draft version.
        cur.execute(
            """
            INSERT INTO dashboard_version (
                dashboard_id,
                version_no,
                title,
                dashboard_json,
                status,
                created_by
            )
            VALUES (%s, %s, %s, %s, 'draft', %s)
            RETURNING
                version_no,
                title,
                dashboard_json,
                status,
                created_on,
                created_by
            """,
            (
                dashboard_id,
                new_version,
                source_title,
                Json(source_json),
                created_by,
            ),
        )

        version_row = cur.fetchone()

    result = dict(version_row)
    result["dashboard_id"] = dashboard_id
    result["latest_version"] = new_version
    result["publish_version"] = dash_row["publish_version"]
    return result