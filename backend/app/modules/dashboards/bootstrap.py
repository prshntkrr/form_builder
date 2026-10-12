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


def ensure_share_columns() -> bool:
    """Add the public-link columns to ``dashboard`` if they are missing.

    Every existing dashboard comes out of this unshared — the token is NULL,
    and a NULL token is matched by nothing — so switching this on publishes
    nothing that was not published before.
    """
    with transaction() as cur:
        if not table_exists(cur, "dashboard"):
            return False

        cur.execute(
            """
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'dashboard'
              AND column_name IN ('share_token', 'shared_on', 'shared_by')
            """
        )
        present = {row["column_name"] for row in cur.fetchall()}

        if "share_token" not in present:
            cur.execute(
                "ALTER TABLE dashboard ADD COLUMN share_token VARCHAR(64)"
            )
            logger.info("Added dashboard.share_token")

        if "shared_on" not in present:
            cur.execute(
                "ALTER TABLE dashboard ADD COLUMN shared_on TIMESTAMP"
            )

        if "shared_by" not in present:
            cur.execute(
                "ALTER TABLE dashboard ADD COLUMN shared_by VARCHAR(50)"
            )

        # Partial: unshared dashboards stay out of the index entirely.
        cur.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_share_token
                ON dashboard (share_token)
                WHERE share_token IS NOT NULL
            """
        )

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


def ensure_dashboard_project() -> bool:
    """Give a dashboard a project to live in, and move the old ones into one.

    Every dashboard belongs to exactly one project now — it is only ever
    reachable from inside that project. A dashboard that predates this has no
    project, so it is assigned to the oldest one the installation has (the
    choice the user signed off on: "assign all existing dashboards to any single
    project"). If there is no project at all, the column stays NULL and those
    dashboards wait until there is one to put them in; nothing is lost.
    """
    with transaction() as cur:
        if not table_exists(cur, "dashboard"):
            return False

        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'dashboard' AND column_name = 'project_id'
            """
        )
        if not cur.fetchone():
            cur.execute("ALTER TABLE dashboard ADD COLUMN project_id VARCHAR(20)")
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_dashboard_project "
                "ON dashboard (project_id)"
            )
            logger.info("Added dashboard.project_id")

        # Backfill once: only rows that have no project, and only if there is a
        # project to give them. The oldest project is a stable, arbitrary pick.
        if table_exists(cur, "project"):
            cur.execute(
                """
                UPDATE dashboard
                SET    project_id = (
                           SELECT project_id FROM project
                           ORDER BY created_on, project_id
                           LIMIT 1
                       )
                WHERE  project_id IS NULL
                  AND  EXISTS (SELECT 1 FROM project)
                """
            )
            if cur.rowcount:
                logger.info(
                    "Assigned %d existing dashboard(s) to the oldest project",
                    cur.rowcount,
                )

    return True


def ensure_dashboard_project_key() -> bool:
    """The foreign key, once both tables exist.

    A dashboard whose project is deleted goes with it — a dashboard outside
    every project is unreachable by design, so there is nothing to keep.
    """
    with transaction() as cur:
        if not table_exists(cur, "dashboard") or not table_exists(cur, "project"):
            return False

        cur.execute(
            """
            SELECT 1 FROM information_schema.table_constraints
            WHERE table_name = 'dashboard' AND constraint_name = 'fk_dashboard_project'
            """
        )
        if cur.fetchone():
            return True

        cur.execute(
            """
            ALTER TABLE dashboard ADD CONSTRAINT fk_dashboard_project
            FOREIGN KEY (project_id) REFERENCES project (project_id) ON DELETE CASCADE
            """
        )
        logger.info("Added dashboard.project_id -> project")

    return True


def ensure_data_source_table() -> bool:
    """Create ``dashboard_data_source`` on a database that predates it.

    schema.sql creates it on a fresh database; this handles the ones that
    already have the dashboard tables. Idempotent.
    """
    with transaction() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS dashboard_data_source (
                table_name   VARCHAR(128) NOT NULL PRIMARY KEY,
                project_id   VARCHAR(20)  NOT NULL,
                source_type  VARCHAR(20)  NOT NULL,
                source_id    VARCHAR(50),
                created_on   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                created_by   VARCHAR(50)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_dashboard_data_source_project "
            "ON dashboard_data_source (project_id)"
        )

    return True


def ensure_data_source_project_key() -> bool:
    """The registry's foreign key to project, once both tables exist.

    A project's imported sources disappear with the project, same as its
    dashboards and forms.
    """
    with transaction() as cur:
        if not table_exists(cur, "dashboard_data_source") or not table_exists(
            cur, "project"
        ):
            return False

        cur.execute(
            """
            SELECT 1 FROM information_schema.table_constraints
            WHERE table_name = 'dashboard_data_source'
              AND constraint_name = 'fk_dashboard_data_source_project'
            """
        )
        if cur.fetchone():
            return True

        cur.execute(
            """
            ALTER TABLE dashboard_data_source
            ADD CONSTRAINT fk_dashboard_data_source_project
            FOREIGN KEY (project_id) REFERENCES project (project_id)
            ON DELETE CASCADE
            """
        )
        logger.info("Added dashboard_data_source.project_id -> project")

    return True


def ensure_data_source_backfill() -> bool:
    """Attribute existing external imports to a project, once.

    An external import that came through a saved connection with a project can
    be placed: the connection says which project. An ad-hoc import (no saved
    connection) and every existing Excel upload cannot — nothing recorded where
    they belonged — so they are left out and reappear when re-imported. Only
    imports whose destination table still exists are registered.

    Idempotent: ``ON CONFLICT DO NOTHING`` leaves a table that is already
    registered where it is (the live registration is authoritative over this
    one-time guess).
    """
    with transaction() as cur:
        if not table_exists(cur, "dashboard_data_source"):
            return False
        if not table_exists(cur, "external_import") or not table_exists(
            cur, "external_connection"
        ):
            return True

        cur.execute(
            """
            INSERT INTO dashboard_data_source
                   (table_name, project_id, source_type, source_id)
            SELECT DISTINCT ON (i.destination_table)
                   i.destination_table, c.project_id, 'import', i.import_id::text
            FROM   external_import i
            JOIN   external_connection c ON c.connection_id = i.connection_id
            WHERE  i.status = 'succeeded'
              AND  c.project_id IS NOT NULL
              AND  EXISTS (
                       SELECT 1 FROM information_schema.tables t
                       WHERE t.table_schema = current_schema()
                         AND t.table_name = i.destination_table
                   )
            ORDER BY i.destination_table, i.import_id DESC
            ON CONFLICT (table_name) DO NOTHING
            """
        )
        if cur.rowcount:
            logger.info(
                "Backfilled %d imported data source(s) into their project",
                cur.rowcount,
            )

    return True
