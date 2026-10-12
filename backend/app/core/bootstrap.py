"""Making sure the tables exist, at every startup.

There is no migration tool here on purpose. `schema.sql` is the desired state
for a fresh database; anything that has to change a table which already exists
is an idempotent `ensure_*` function that checks whether its work is done and
returns early. Existing deployments migrate on their next boot.

Core owns the accounts, roles and sessions. Every module brings its own
`schema.sql` and its own `ensure_*` functions through its manifest, so this file
does not change when a module is added.

Set AUTO_CREATE_TABLES=false to turn the DDL off and apply the files yourself —
useful where the application's database user is not allowed to run DDL.
"""
import logging
from pathlib import Path
from typing import List, Optional

from app.core import registry
from app.core.config import settings
from app.core.database import table_exists, transaction

logger = logging.getLogger(__name__)

SCHEMA_FILE = Path(__file__).resolve().parent / "schema.sql"
CORE_TABLES = (
    "app_role", "role_permission", "app_user", "user_session", "password_reset",
)


def required_tables() -> List[str]:
    """Core's tables, plus whatever the installed modules declare."""
    return list(CORE_TABLES) + registry.required_tables()


def missing_tables() -> List[str]:
    with transaction() as cur:
        return [t for t in required_tables() if not table_exists(cur, t)]


def _run(path: Path, label: str) -> bool:
    """Apply one schema file in its own transaction.

    Its own transaction so that a module with a broken schema takes only itself
    down — the rest of the application still comes up, and the log says which.
    """
    if not path.exists():
        logger.error("Cannot create tables: %s not found", path)
        return False
    try:
        with transaction() as cur:
            cur.execute(path.read_text(encoding="utf-8"))
        return True
    except Exception:
        logger.exception("Schema for %s failed", label)
        return False


def ensure_base_tables() -> List[str]:
    """Create anything missing. Returns the tables that were absent beforehand."""
    missing = missing_tables()
    if not missing:
        return []

    if not settings.auto_create_tables:
        logger.warning(
            "Missing table(s): %s. AUTO_CREATE_TABLES is off — apply the schema "
            "files manually.", ", ".join(missing),
        )
        return missing

    logger.info("Creating missing table(s): %s", ", ".join(missing))
    _run(SCHEMA_FILE, "core")
    for module in registry.modules():
        if module.schema_file:
            _run(module.schema_file, module.name)

    still_missing = missing_tables()
    if still_missing:
        logger.error("Still missing after running the schema files: %s",
                     ", ".join(still_missing))
    else:
        logger.info("Schema ready")
    return missing


def run_module_migrations() -> None:
    """Every module's idempotent `ensure_*`, in registration order."""
    for fn in registry.migrations():
        try:
            fn()
        except Exception:
            logger.exception("Migration %s failed", getattr(fn, "__name__", fn))
def ensure_admin_holds_everything() -> List[str]:
    """Give the admin role any permission it does not yet have.

    Roles are seeded once and never re-seeded, so an admin who narrows a role
    keeps their choice. The admin role is the exception, and has to be: install a
    module and its permissions are brand new, held by nobody. Without this, the
    only account that could grant them cannot grant them either, and the module
    is unreachable until someone edits the database.
    """
    from app.core import permissions as perms

    every = perms.ALL
    with transaction() as cur:
        cur.execute("SELECT role_id FROM app_role WHERE name = 'admin'")
        role = cur.fetchone()
        if not role:
            return []

        cur.execute("SELECT permission FROM role_permission WHERE role_id = %s",
                    (role["role_id"],))
        held = {r["permission"] for r in cur.fetchall()}
        gained = sorted(every - held)
        for key in gained:
            cur.execute(
                "INSERT INTO role_permission (role_id, permission) VALUES (%s, %s) "
                "ON CONFLICT DO NOTHING",
                (role["role_id"], key),
            )

    if gained:
        logger.info("Admin role gained: %s", ", ".join(gained))
    return gained


def ensure_roles() -> List[str]:
    """Create the built-in roles, and move accounts onto them.

    The first version of this app had a fixed `app_user.role` column holding one
    of three names. Roles are now rows with their own permissions, so the column
    becomes a foreign key — matched by name, which is why the built-in roles keep
    the names they had.
    """
    from app.core.role_service import ensure_built_in

    try:
        with transaction() as cur:
            if not table_exists(cur, "app_role"):
                return []

        made = ensure_built_in()

        # Onto the two system roles, before anything reads them. Idempotent, and
        # it never touches a project membership — see role_migration.py.
        from app.core.role_migration import migrate_system_roles
        migrate_system_roles()

        ensure_built_in()          # `standard` may only now be missing
        ensure_admin_holds_everything()

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

    from app.core import permissions
    from app.core.auth_service import ROLE_ADMIN, create_user

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



def ensure_user_identifiers() -> bool:
    """Give `app_user` a username and a phone number to sign in with.

    Both are optional and both are unique. Optional because every account that
    exists signs in by email and must keep doing so untouched; unique because an
    identifier that matched two accounts would be a way in to whichever one the
    query happened to return first.

    Postgres allows many NULLs under a UNIQUE constraint, so "most accounts have
    neither" costs nothing and needs no backfill.

    Idempotent, and returns whether it changed anything.
    """
    from psycopg2 import sql

    changed = False

    with transaction() as cur:
        if not table_exists(cur, "app_user"):
            return False                      # schema.sql will create it first

        for column, declared in (("username", "VARCHAR(50)"),
                                 ("phone", "VARCHAR(20)")):
            cur.execute(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_schema = %s AND table_name = 'app_user' "
                "  AND column_name = %s",
                (settings.db_schema, column),
            )
            if cur.fetchone() is not None:
                continue

            cur.execute(sql.SQL("ALTER TABLE {}.app_user ADD COLUMN {} {}").format(
                sql.Identifier(settings.db_schema), sql.Identifier(column),
                sql.SQL(declared)))
            # Named, so re-running finds it rather than adding a second one.
            cur.execute(sql.SQL(
                "ALTER TABLE {}.app_user ADD CONSTRAINT {} UNIQUE ({})").format(
                sql.Identifier(settings.db_schema),
                sql.Identifier(f"uq_app_user_{column}"),
                sql.Identifier(column)))
            changed = True

        # Email stops being required once there is another way to sign in.
        # An account may have any one of the three; which ones it has is
        # `ensure_one_identifier` below, not a NOT NULL on one of them.
        cur.execute(
            "SELECT is_nullable FROM information_schema.columns "
            "WHERE table_schema = %s AND table_name = 'app_user' "
            "  AND column_name = 'email'",
            (settings.db_schema,),
        )
        held = cur.fetchone()
        if held and held["is_nullable"] == "NO":
            cur.execute(sql.SQL(
                "ALTER TABLE {}.app_user ALTER COLUMN email DROP NOT NULL"
            ).format(sql.Identifier(settings.db_schema)))
            changed = True

        # At least one way in, whichever it is. In the database rather than only
        # in the service, because an account nobody can sign in to is not a
        # thing any code path should be able to leave behind.
        cur.execute(
            "SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid "
            "WHERE t.relname = 'app_user' AND c.conname = 'ck_app_user_identifier'"
        )
        if cur.fetchone() is None:
            cur.execute(sql.SQL(
                "ALTER TABLE {}.app_user ADD CONSTRAINT ck_app_user_identifier "
                "CHECK (email IS NOT NULL OR username IS NOT NULL "
                "       OR phone IS NOT NULL)"
            ).format(sql.Identifier(settings.db_schema)))
            changed = True

    if changed:
        logger.info("app_user: username, phone, and an optional email")
    return changed


def ensure_voice_enrolment() -> bool:
    """Room on `app_user` for a voiceprint.

    Four columns and no new table, because a voiceprint is 1 KB and there is
    exactly one per account — the same shape as `password_hash`, and it belongs
    in the same place for the same reason.

    What is *not* here is the audio. The recordings are discarded the moment the
    vector exists; see `core/voiceprint.py` for why keeping them would be the
    only genuinely dangerous part of this feature.

    Every column is nullable: an account without a voiceprint is the normal
    case, signs in by password as it always did, and needs no backfill.

    Idempotent, and returns whether it changed anything.
    """
    from psycopg2 import sql

    changed = False

    with transaction() as cur:
        if not table_exists(cur, "app_user"):
            return False                      # schema.sql will create it first

        for column, declared in (
            ("voiceprint", "BYTEA"),
            # Which pipeline produced it. Vectors from two different models are
            # not comparable, so without this a model change would silently
            # invalidate every enrolment with no way to tell which ones.
            ("voiceprint_model", "VARCHAR(40)"),
            ("voiceprint_on", "TIMESTAMP"),
            # Voice is biometric data. When they agreed to it being held is part
            # of the record, not a thing to reconstruct from a log later.
            ("voiceprint_consent_on", "TIMESTAMP"),
        ):
            cur.execute(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_schema = %s AND table_name = 'app_user' "
                "  AND column_name = %s",
                (settings.db_schema, column),
            )
            if cur.fetchone() is not None:
                continue

            cur.execute(sql.SQL("ALTER TABLE {}.app_user ADD COLUMN {} {}").format(
                sql.Identifier(settings.db_schema), sql.Identifier(column),
                sql.SQL(declared)))
            changed = True

    if changed:
        logger.info("app_user: voiceprint columns")
    return changed
