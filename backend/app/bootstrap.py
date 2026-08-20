"""Making sure the base tables exist.

`forms` and `form_version` are the only tables that have to be there before the
application can do anything; every form's own data table is created on demand.
Running `schema.sql` at startup means a fresh server needs no manual step, and
because the file is idempotent it is a no-op on an existing database.

Set AUTO_CREATE_TABLES=false to turn this off and apply `schema.sql` yourself —
useful where the application's database user is not allowed to run DDL.
"""
import logging
from pathlib import Path
from typing import List, Optional

from psycopg2.extras import Json

from .config import settings
from .database import transaction
from .table_service import table_exists

logger = logging.getLogger(__name__)

SCHEMA_FILE = Path(__file__).resolve().parent.parent / "schema.sql"
REQUIRED_TABLES = (
    "forms", "form_version", "standard_form_library",
    "app_user", "app_role", "role_permission", "user_session",
    "password_reset", "form_view",
)

# The statuses the application writes. 'Deleted' is a soft delete: the form and
# every response it collected are kept, the form just leaves the list.
FORM_STATUSES = ("Active", "Inactive", "Deleted")
FORM_TYPES = ("parent", "child")


def missing_tables() -> List[str]:
    with transaction() as cur:
        return [t for t in REQUIRED_TABLES if not table_exists(cur, t)]


def ensure_base_tables() -> List[str]:
    """Create anything missing. Returns the tables that were absent beforehand."""
    missing = missing_tables()
    if not missing:
        return []

    if not settings.auto_create_tables:
        logger.warning(
            "Missing table(s): %s. AUTO_CREATE_TABLES is off — apply %s manually.",
            ", ".join(missing),
            SCHEMA_FILE.name,
        )
        return missing

    if not SCHEMA_FILE.exists():
        logger.error("Cannot create tables: %s not found", SCHEMA_FILE)
        return missing

    logger.info("Creating missing table(s): %s", ", ".join(missing))
    with transaction() as cur:
        cur.execute(SCHEMA_FILE.read_text(encoding="utf-8"))

    still_missing = missing_tables()
    if still_missing:
        logger.error("Still missing after running schema.sql: %s", ", ".join(still_missing))
    else:
        logger.info("Base schema ready")
    return missing


def ensure_status_values() -> bool:
    """Let `forms.form_status` hold every status the application writes.

    The table ships with a CHECK limited to Active/Inactive, but a form is
    soft-deleted by setting 'Deleted' — the row and its collected responses are
    kept, it just leaves the list. Without widening the constraint that write
    fails. Idempotent: a no-op once the constraint already allows all three.
    """
    from psycopg2 import sql

    try:
        with transaction() as cur:
            cur.execute(
                """
                SELECT conname, pg_get_constraintdef(oid) AS definition
                FROM   pg_constraint
                WHERE  conrelid = %s::regclass AND contype = 'c'
                  AND  pg_get_constraintdef(oid) ILIKE %s
                """,
                (f"{settings.db_schema}.forms", "%form_status%"),
            )
            row = cur.fetchone()
            if row and all(f"'{s}'" in row["definition"] for s in FORM_STATUSES):
                return False

            if row:
                cur.execute(
                    sql.SQL("ALTER TABLE {}.forms DROP CONSTRAINT {}").format(
                        sql.Identifier(settings.db_schema), sql.Identifier(row["conname"])
                    )
                )
            cur.execute(
                sql.SQL(
                    "ALTER TABLE {}.forms ADD CONSTRAINT forms_form_status_check "
                    "CHECK (form_status IN ({}))"
                ).format(
                    sql.Identifier(settings.db_schema),
                    sql.SQL(", ").join(sql.Literal(s) for s in FORM_STATUSES),
                )
            )
        logger.info("Widened forms_form_status_check to %s", ", ".join(FORM_STATUSES))
        return True
    except Exception as exc:
        logger.warning("Could not widen forms_form_status_check: %s", exc)
        return False


def ensure_roles() -> List[str]:
    """Create the built-in roles, and move accounts onto them.

    The first version of this app had a fixed `app_user.role` column holding one
    of three names. Roles are now rows with their own permissions, so the column
    becomes a foreign key — matched by name, which is why the built-in roles keep
    the names they had.
    """
    from psycopg2 import sql

    from .role_service import ensure_built_in

    try:
        with transaction() as cur:
            if not table_exists(cur, "app_role"):
                return []

        made = ensure_built_in()

        with transaction() as cur:
            cur.execute(
                """
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = %s AND table_name = 'app_user' AND column_name = 'role'
                """,
                (settings.db_schema,),
            )
            if not cur.fetchone():
                cur.execute(
                    "CREATE INDEX IF NOT EXISTS idx_app_user_role ON app_user (role_id)")
                return made

            logger.info("Moving accounts from the old role column onto role_id")
            cur.execute("ALTER TABLE app_user ADD COLUMN IF NOT EXISTS role_id VARCHAR(20)")
            cur.execute(
                "UPDATE app_user u SET role_id = r.role_id "
                "FROM app_role r WHERE r.name = u.role AND u.role_id IS NULL"
            )
            # Anything unmatched lands on the least-privileged role rather than
            # being left without one.
            cur.execute("SELECT role_id FROM app_role WHERE name = 'field'")
            fallback = cur.fetchone()
            if fallback:
                cur.execute(
                    "UPDATE app_user SET role_id = %s WHERE role_id IS NULL",
                    (fallback["role_id"],),
                )

            for statement in (
                "ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_role_check",
                "ALTER TABLE app_user DROP COLUMN role",
                "ALTER TABLE app_user ADD CONSTRAINT app_user_role_id_fkey "
                "FOREIGN KEY (role_id) REFERENCES app_role (role_id)",
                "CREATE INDEX IF NOT EXISTS idx_app_user_role ON app_user (role_id)",
            ):
                cur.execute(statement)

        logger.info("Accounts now hold a role_id")
        return made
    except Exception as exc:
        logger.error("Could not set up roles: %s", exc)
        return []


def ensure_admin_account() -> Optional[str]:
    """Make sure somebody can sign in.

    Runs only when there is no admin at all. With no `ADMIN_PASSWORD` set, one is
    generated and written to the log once — there is no other way to see it, and
    an installation nobody can enter is worse than a password in a log file you
    control.
    """
    import secrets

    from . import permissions
    from .auth_service import ROLE_ADMIN, create_user

    try:
        with transaction() as cur:
            if not table_exists(cur, "app_user") or not table_exists(cur, "app_role"):
                return None
            # "Is there anybody who can hand out roles" — not "is there an admin",
            # because the roles that can do so are now up to the installation.
            cur.execute(
                """
                SELECT COUNT(*) AS n
                FROM   app_user u
                JOIN   role_permission p ON p.role_id = u.role_id AND p.permission = %s
                WHERE  u.is_active
                """,
                (permissions.ROLES_MANAGE,),
            )
            if int(cur.fetchone()["n"]):
                return None

        password = settings.admin_password or secrets.token_urlsafe(12)
        create_user(
            settings.admin_email, password,
            full_name="Administrator", role=ROLE_ADMIN, created_by="setup",
        )

        if settings.admin_password:
            logger.info("Created the first admin: %s", settings.admin_email)
        else:
            logger.warning(
                "\n%s\n  No admin account existed, so one was created.\n"
                "    email    %s\n    password %s\n"
                "  Sign in and change it. Set ADMIN_PASSWORD in .env to choose your own.\n%s",
                "=" * 68, settings.admin_email, password, "=" * 68,
            )
        return settings.admin_email
    except Exception as exc:
        logger.error("Could not create the first admin account: %s", exc)
        return None


def ensure_library_snapshots() -> bool:
    """Give every library row its own copy of the definition.

    The library first stored a reference — a form plus a pinned version — which
    meant deleting the form took the standard with it. A standard should outlive
    the form it was taken from, so each row now carries the definition itself and
    form_id is provenance only.

    Idempotent; a no-op once `form_json` is there.
    """
    from psycopg2 import sql

    try:
        with transaction() as cur:
            if not table_exists(cur, "standard_form_library"):
                return False

            cur.execute(
                """
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = %s AND table_name = 'standard_form_library'
                  AND column_name = 'form_json'
                """,
                (settings.db_schema,),
            )
            if cur.fetchone():
                return False

            logger.info("Migrating standard_form_library to hold its own definitions")
            cur.execute("ALTER TABLE standard_form_library ADD COLUMN form_json JSONB")

            # Copy each row's pinned version across, stripped to a template.
            from .standard_library import to_library_entry
            cur.execute(
                """
                SELECT l.standard_id, v.form_json
                FROM   standard_form_library l
                JOIN   form_version v
                       ON v.form_id = l.form_id AND v.version_no = l.version_no
                """
            )
            for row in [dict(r) for r in cur.fetchall()]:
                template = to_library_entry(row["form_json"] or {})["form"]
                cur.execute(
                    "UPDATE standard_form_library SET form_json = %s WHERE standard_id = %s",
                    (Json(template), row["standard_id"]),
                )

            # Anything that could not be copied has nothing to offer.
            cur.execute("DELETE FROM standard_form_library WHERE form_json IS NULL")
            cur.execute("ALTER TABLE standard_form_library ALTER COLUMN form_json SET NOT NULL")

            # The source form is now only provenance.
            for statement in (
                "ALTER TABLE standard_form_library "
                "DROP CONSTRAINT IF EXISTS standard_form_library_form_id_version_no_fkey",
                "ALTER TABLE standard_form_library "
                "DROP CONSTRAINT IF EXISTS standard_form_library_form_id_fkey",
                "ALTER TABLE standard_form_library ALTER COLUMN form_id DROP NOT NULL",
                "ALTER TABLE standard_form_library ALTER COLUMN version_no DROP NOT NULL",
                "ALTER TABLE standard_form_library ADD CONSTRAINT standard_form_library_form_id_fkey "
                "FOREIGN KEY (form_id) REFERENCES forms (form_id) ON DELETE SET NULL",
            ):
                cur.execute(statement)

        logger.info("standard_form_library now holds its own definitions")
        return True
    except Exception as exc:
        logger.error("Could not migrate standard_form_library: %s", exc)
        return False


def ensure_relations() -> List[str]:
    """Declare the foreign keys on form tables created before they existed.

    A table with a `form_id` column but no constraint is not related to `forms`
    as far as Postgres — or an ERD tool — is concerned. Idempotent, and skips
    quietly if a table holds rows that would violate the constraint.
    """
    from .table_service import ensure_foreign_key, table_exists
    from .tabular_service import tabular_name

    linked: List[str] = []
    with transaction() as cur:
        cur.execute(
            "SELECT form_id, form_json ->> 'table_name' AS t FROM forms "
            "WHERE form_json ->> 'table_name' IS NOT NULL"
        )
        tables = {r["t"] for r in cur.fetchall() if r["t"]}

        for table in sorted(tables):
            if not table_exists(cur, table):
                continue
            if ensure_foreign_key(cur, table, "form_id", "forms", "form_id"):
                linked.append(f"{table}.form_id")

            mirror = tabular_name(table)
            if not table_exists(cur, mirror):
                continue
            if ensure_foreign_key(cur, mirror, "form_id", "forms", "form_id"):
                linked.append(f"{mirror}.form_id")
            if ensure_foreign_key(cur, mirror, "survey_id", table, "survey_id", "CASCADE"):
                linked.append(f"{mirror}.survey_id")

    if linked:
        logger.info("Declared %d missing relationship(s): %s", len(linked), ", ".join(linked))
    return linked
