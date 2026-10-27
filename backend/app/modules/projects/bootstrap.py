"""Idempotent migrations owned by the projects module.

`schema.sql` creates the tables on a fresh database; these bring an existing one
forward. Both run at every startup and return early once their work is done.
"""
import logging

from app.core.database import table_exists, transaction

logger = logging.getLogger(__name__)


def ensure_form_project() -> bool:
    """Let a form belong to a project.

    Nullable, and left null on every form that already exists. A form built
    before projects is not silently swept into one — it stays reachable through
    the system-wide form permissions exactly as it was, and somebody moves it
    into a project deliberately. Filling this in by guessing would change who
    can see existing forms, which is the one thing a migration must not do.
    """
    with transaction() as cur:
        if not table_exists(cur, "forms"):
            return False

        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'forms' AND column_name = 'project_id'
            """
        )
        if cur.fetchone():
            return True

        cur.execute("ALTER TABLE forms ADD COLUMN project_id VARCHAR(20)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_forms_project ON forms (project_id)")
        logger.info("Added forms.project_id")

    return True


def ensure_form_project_key() -> bool:
    """The foreign key, once both tables exist.

    Separate from the column because `project` is created by this module's own
    schema file, which may run after the column is added on an installation that
    predates it.
    """
    with transaction() as cur:
        if not table_exists(cur, "forms") or not table_exists(cur, "project"):
            return False

        cur.execute(
            """
            SELECT 1 FROM information_schema.table_constraints
            WHERE table_name = 'forms' AND constraint_name = 'fk_forms_project'
            """
        )
        if cur.fetchone():
            return True

        cur.execute(
            """
            ALTER TABLE forms ADD CONSTRAINT fk_forms_project
            FOREIGN KEY (project_id) REFERENCES project (project_id) ON DELETE SET NULL
            """
        )
        logger.info("Added forms.project_id -> project")

    return True


def ensure_project_api_key() -> bool:
    """Create the project_api_key table on installations that predate it."""
    with transaction() as cur:
        if not table_exists(cur, "project"):
            return False
        if table_exists(cur, "project_api_key"):
            return True

        cur.execute(
            """
            CREATE TABLE project_api_key (
                key_id      VARCHAR(20)  NOT NULL PRIMARY KEY,
                project_id  VARCHAR(20)  NOT NULL REFERENCES project (project_id) ON DELETE CASCADE,
                key_hash    VARCHAR(64)  NOT NULL UNIQUE,
                key_prefix  VARCHAR(10)  NOT NULL,
                label       VARCHAR(200) NOT NULL DEFAULT '',
                created_on  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                created_by  VARCHAR(50)  NOT NULL DEFAULT '',
                revoked_on  TIMESTAMP
            )
            """
        )
        cur.execute(
            "CREATE INDEX idx_project_api_key_project ON project_api_key (project_id)"
        )
        logger.info("Created project_api_key table")

    return True


def ensure_standard_library_project() -> bool:
    """Let a standard form library entry belong to a project.

    Nullable — existing entries keep project_id = NULL and remain visible in
    every project as a shared baseline.  New entries created inside a project
    are scoped to that project.
    """
    with transaction() as cur:
        if not table_exists(cur, "standard_form_library"):
            return False

        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'standard_form_library' AND column_name = 'project_id'
            """
        )
        if cur.fetchone():
            return True

        cur.execute("ALTER TABLE standard_form_library ADD COLUMN project_id VARCHAR(20)")
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_standard_library_project "
            "ON standard_form_library (project_id)"
        )
        logger.info("Added standard_form_library.project_id")

    return True


def ensure_standard_library_project_key() -> bool:
    """FK from standard_form_library.project_id to project."""
    with transaction() as cur:
        if not table_exists(cur, "standard_form_library") or not table_exists(cur, "project"):
            return False

        cur.execute(
            """
            SELECT 1 FROM information_schema.table_constraints
            WHERE table_name = 'standard_form_library'
              AND constraint_name = 'fk_standard_library_project'
            """
        )
        if cur.fetchone():
            return True

        cur.execute(
            """
            ALTER TABLE standard_form_library ADD CONSTRAINT fk_standard_library_project
            FOREIGN KEY (project_id) REFERENCES project (project_id) ON DELETE SET NULL
            """
        )
        logger.info("Added standard_form_library.project_id -> project")

    return True


def unsystem_project_roles() -> bool:
    """Mark the old seeded project roles as non-system so they are editable.

    Previous versions seeded project_manager, surveyor and reviewer with
    is_system=TRUE. They are project roles, not system roles, and admins
    should be able to edit and delete them from the Roles page.
    """
    names = ("project_manager", "surveyor", "reviewer")
    with transaction() as cur:
        if not table_exists(cur, "app_role"):
            return False
        cur.execute(
            "UPDATE app_role SET is_system = FALSE "
            "WHERE name IN %s AND is_system = TRUE",
            (names,),
        )
        if cur.rowcount:
            logger.info("Marked %d project role(s) as non-system", cur.rowcount)
    return True
