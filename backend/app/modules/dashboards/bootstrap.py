"""Idempotent migrations owned by the dashboards module.

``schema.sql`` next door creates the tables on a fresh database; this handles
the databases that already have them.  Runs at every startup and returns early
once its work is done.
"""
import logging

from app.core.database import table_exists, transaction

logger = logging.getLogger(__name__)


def ensure_version_columns() -> bool:
    """Add *latest_version* and *publish_version* to ``dashboard`` if missing.

    Both are needed by the versioning feature.  Existing rows get
    ``latest_version = 0`` (the back-fill step below promotes this to 1)
    and ``publish_version = NULL`` (nothing published yet).
    """
    with transaction() as cur:
        if not table_exists(cur, "dashboard"):
            return False

        cur.execute(
            """
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'dashboard'
              AND column_name IN ('latest_version', 'publish_version')
            """
        )
        present = {row["column_name"] for row in cur.fetchall()}

        if "latest_version" not in present:
            cur.execute(
                "ALTER TABLE dashboard ADD COLUMN latest_version "
                "INTEGER NOT NULL DEFAULT 0"
            )
            logger.info("Added dashboard.latest_version")

        if "publish_version" not in present:
            cur.execute(
                "ALTER TABLE dashboard ADD COLUMN publish_version INTEGER"
            )
            logger.info("Added dashboard.publish_version")

    return True


def ensure_dashboard_version_table() -> bool:
    """Create ``dashboard_version`` and back-fill version 1 for existing rows.

    Any active dashboard that predates versioning (has no rows in
    ``dashboard_version``) gets a version-1 snapshot from its current
    ``dashboard_json``, with status ``'draft'``.
    """
    with transaction() as cur:
        if not table_exists(cur, "dashboard"):
            return False

        # The table itself is created by schema.sql on a fresh database.
        # For databases that already had the dashboard table before
        # versioning was added, create it here.
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS dashboard_version (
                dashboard_id   VARCHAR(20)   NOT NULL
                               REFERENCES dashboard(dashboard_id)
                               ON DELETE CASCADE,
                version_no     INTEGER       NOT NULL,
                title          VARCHAR(255)  NOT NULL,
                dashboard_json JSONB         NOT NULL,
                status         VARCHAR(20)   NOT NULL DEFAULT 'draft',
                created_on     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
                created_by     VARCHAR(50),
                PRIMARY KEY (dashboard_id, version_no)
            )
            """
        )

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_dashboard_version_lookup
                ON dashboard_version (dashboard_id, version_no DESC)
            """
        )

        # Back-fill version 1 for every active dashboard that has none.
        cur.execute(
            """
            INSERT INTO dashboard_version (
                dashboard_id, version_no, title, dashboard_json,
                status, created_on, created_by
            )
            SELECT
                d.dashboard_id, 1, d.title, d.dashboard_json,
                'draft',
                COALESCE(d.created_on, CURRENT_TIMESTAMP),
                d.created_by
            FROM dashboard d
            WHERE d.status = 'Active'
              AND NOT EXISTS (
                  SELECT 1 FROM dashboard_version dv
                  WHERE dv.dashboard_id = d.dashboard_id
              )
            """
        )

        backfilled = cur.rowcount
        if backfilled:
            logger.info(
                "Back-filled %d dashboard(s) with version 1", backfilled
            )

        # Bring latest_version up to 1 for back-filled rows still at 0.
        cur.execute(
            """
            UPDATE dashboard
            SET    latest_version = 1
            WHERE  status = 'Active'
              AND  latest_version = 0
              AND  EXISTS (
                       SELECT 1 FROM dashboard_version dv
                       WHERE dv.dashboard_id = dashboard.dashboard_id
                   )
            """
        )

    return True
