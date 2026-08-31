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


def ensure_project_roles() -> bool:
    """Create the roles a project starts with, once.

    They are ordinary rows in `app_role` — the same table and the same
    permission catalogue as every other role, so there is one role system rather
    than two. Only ever adds: an installation that has narrowed Surveyor keeps
    its choice.
    """
    from app.core import role_service
    from app.modules.projects.permissions import PROJECT_ROLES

    made = []

    with transaction() as cur:
        for name, spec in PROJECT_ROLES.items():
            cur.execute("SELECT role_id FROM app_role WHERE name = %s", (name,))
            if cur.fetchone():
                continue

            role_id = role_service._next_role_id(cur)
            cur.execute(
                """
                INSERT INTO app_role (role_id, name, label, description, is_system, created_by)
                VALUES (%s, %s, %s, %s, TRUE, 'setup')
                """,
                (role_id, name, spec["label"], spec["description"]),
            )
            for permission in spec["permissions"]:
                cur.execute(
                    "INSERT INTO role_permission (role_id, permission) VALUES (%s, %s) "
                    "ON CONFLICT DO NOTHING",
                    (role_id, permission),
                )
            made.append(name)

    if made:
        logger.info("Created project role(s): %s", ", ".join(made))
    return True
