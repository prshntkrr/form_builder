"""Idempotent migrations owned by the forms module.

Each of these runs at every startup and returns early once its work is done.
They are listed in the module manifest, which is the only thing that runs them —
core knows nothing about what is in this file.

`schema.sql` next door creates the tables on a fresh database; these functions
handle databases where the tables already exist and have to change.
"""
import logging
from typing import List

from psycopg2.extras import Json

from app.core.config import settings
from app.core.database import table_exists, transaction
from app.modules.forms.constants import FORM_STATUSES

logger = logging.getLogger(__name__)


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


def ensure_library_snapshots() -> bool:
    """Give every library row its own copy of the definition.

    The library first stored a reference — a form plus a pinned version — which
    meant deleting the form took the standard with it. A standard should outlive
    the form it was taken from, so each row now carries the definition itself and
    form_id is provenance only.

    Idempotent; a no-op once `form_json` is there.
    """
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
            from app.modules.forms.standard_library import to_library_entry
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
    from app.modules.forms.table_service import ensure_foreign_key, table_exists
    from app.modules.forms.tabular_service import tabular_name

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

def ensure_relationship_columns() -> int:
    """Put `forms.form_type` and `forms.parent_id` in step with the definitions.

    Both columns have been on this table since the beginning — the schema
    constrains `form_type` to ('parent', 'child') and `config_validation`
    already refuses a child form that names no parent — but nothing wrote them.
    A form declared a child inside `form_json` left its row saying `parent` with
    a NULL parent, so the row contradicted the definition and the rule never
    fired.

    `form_json.relationship` remains the source of truth. This only brings the
    columns of forms configured before they were written into line, once, and
    then keeps quiet: `form_service` writes them on every create and update.

    Returns how many rows it corrected, so a startup that changes nothing says
    nothing.
    """
    from app.core.database import transaction

    with transaction() as cur:
        cur.execute(
            """
            UPDATE forms
               SET form_type = 'child',
                   parent_id = form_json -> 'relationship' ->> 'parent_form_id'
             WHERE form_json -> 'relationship' ->> 'type' = 'child'
               AND form_json -> 'relationship' ->> 'parent_form_id' IN
                   (SELECT form_id FROM forms)
               AND (form_type <> 'child'
                    OR parent_id IS DISTINCT FROM
                       form_json -> 'relationship' ->> 'parent_form_id')
            """
        )
        corrected = cur.rowcount

        # And the other way: a form that is no longer a child must not keep a
        # parent on its row.
        cur.execute(
            """
            UPDATE forms
               SET form_type = 'parent', parent_id = NULL
             WHERE form_type = 'child'
               AND COALESCE(form_json -> 'relationship' ->> 'type', '') <> 'child'
            """
        )
        corrected += cur.rowcount

    if corrected:
        logger.info("Brought %s form row(s) into line with their relationship", corrected)
    return corrected


def ensure_export_permission() -> int:
    """Give `forms.export` to the roles that already publish forms.

    A permission added after an installation was seeded reaches nobody: roles
    are seeded once and never re-seeded, so without this the upgrade lands with
    a feature no existing role can use — including the administrator who has to
    grant it.

    Anyone who could already edit and publish a form gets it. Nobody else does:
    reading a form, or filling one in, is not permission to hand its definition
    to another platform. Idempotent, and it never takes a permission away.
    """
    from app.modules.forms.permissions import FORMS_EDIT, FORMS_EXPORT

    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO role_permission (role_id, permission)
            SELECT role_id, %s FROM role_permission WHERE permission = %s
            ON CONFLICT DO NOTHING
            """,
            (FORMS_EXPORT, FORMS_EDIT),
        )
        granted = cur.rowcount

    if granted:
        logger.info("Granted %s to %s role(s)", FORMS_EXPORT, granted)
    return granted


def ensure_routing_permissions() -> int:
    """Give `mcdc.manage` to the roles that already publish forms.

    Same reasoning as `ensure_export_permission`: a permission added after an
    installation was seeded reaches nobody, because roles are seeded once.

    `mcdc.integrate` is deliberately *not* handed out here. It is the collection
    platform's own, and it belongs on a dedicated service account with nothing
    else — see the README. An employee's account is not the right thing to run
    an integration as.
    """
    from app.modules.forms.permissions import FORMS_EDIT, MCDC_MANAGE

    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO role_permission (role_id, permission)
            SELECT role_id, %s FROM role_permission WHERE permission = %s
            ON CONFLICT DO NOTHING
            """,
            (MCDC_MANAGE, FORMS_EDIT),
        )
        granted = cur.rowcount

    if granted:
        logger.info("Granted %s to %s role(s)", MCDC_MANAGE, granted)
    return granted


def ensure_export_columns() -> List[str]:
    """Bring `form_export` up to the shape an export record needs.

    The first version of this table recorded only that a delivery happened:
    form, version, connector, a remote id. What it could not say was that one
    had been *attempted* — a failure left no row at all, so "has anybody tried
    to send this?" had no answer, and a platform that timed out looked exactly
    like one nobody had contacted.

    This adds the lifecycle (PENDING/EXPORTED/FAILED), what was sent
    (`request_hash`) and what came back (`external_id`, `response_metadata`,
    `error_message`), and backfills anything already recorded as EXPORTED.

    Idempotent: each column is added only if it is missing, and the whole thing
    returns early once there is nothing left to do.
    """
    from psycopg2 import sql

    wanted = [
        ("export_id", "SERIAL"),
        ("form_version", "INTEGER"),
        ("idempotency_key", "VARCHAR(80)"),
        ("status", "VARCHAR(10) NOT NULL DEFAULT 'PENDING'"),
        ("request_hash", "VARCHAR(64) NOT NULL DEFAULT ''"),
        ("external_id", "VARCHAR(200) NOT NULL DEFAULT ''"),
        ("response_metadata", "JSONB NOT NULL DEFAULT '{}'::jsonb"),
        ("error_message", "TEXT NOT NULL DEFAULT ''"),
        ("created_on", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
        ("updated_on", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
    ]
    added: List[str] = []

    with transaction() as cur:
        if not table_exists(cur, "form_export"):
            return added                      # schema.sql will create it whole

        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = %s AND table_name = 'form_export'",
            (settings.db_schema,),
        )
        have = {r["column_name"] for r in cur.fetchall()}

        for column, definition in wanted:
            if column in have:
                continue
            # The definition goes in as SQL, not as part of the template: a
            # default of '{}'::jsonb is braces, and `format` would read them.
            cur.execute(
                sql.SQL("ALTER TABLE {}.form_export ADD COLUMN {} {}").format(
                    sql.Identifier(settings.db_schema), sql.Identifier(column),
                    sql.SQL(definition)))
            added.append(column)

        if not added:
            return added

        # What the old shape recorded was, by definition, a delivery that
        # succeeded — there was no other kind of row.
        if "version_no" in have:
            cur.execute("UPDATE form_export SET form_version = version_no "
                        "WHERE form_version IS NULL")
        if "remote_id" in have:
            cur.execute("UPDATE form_export SET external_id = COALESCE(remote_id, '') "
                        "WHERE external_id = ''")
        if "detail" in have:
            cur.execute("UPDATE form_export SET response_metadata = COALESCE(detail, "
                        "'{}'::jsonb) WHERE response_metadata = '{}'::jsonb")
        if "exported_on" in have:
            cur.execute("UPDATE form_export SET created_on = COALESCE(exported_on, "
                        "CURRENT_TIMESTAMP) WHERE created_on IS NULL")

        cur.execute("UPDATE form_export SET status = 'EXPORTED' WHERE status = 'PENDING'")
        cur.execute("UPDATE form_export SET idempotency_key = "
                    "form_id || ':' || form_version || ':' || connector "
                    "WHERE idempotency_key IS NULL")
        cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_form_export_key "
                    "ON form_export (idempotency_key)")

        # The identity of a row moved: it was (form_id, version_no, connector)
        # as a primary key, and it is now `export_id` with the same triple as a
        # unique key by another name. The old columns are left in place with
        # their data — a primary key forbids nulls, so it has to go before new
        # rows can be written without them.
        cur.execute(
            "SELECT conname FROM pg_constraint "
            "WHERE conrelid = %s::regclass AND contype = 'p'",
            (f"{settings.db_schema}.form_export",),
        )
        row = cur.fetchone()
        if row and row["conname"] != "form_export_pkey":
            cur.execute(sql.SQL("ALTER TABLE {}.form_export DROP CONSTRAINT {}").format(
                sql.Identifier(settings.db_schema), sql.Identifier(row["conname"])))
            row = None
        elif row:
            cur.execute(
                "SELECT a.attname FROM pg_index i "
                "JOIN pg_attribute a ON a.attrelid = i.indrelid "
                " AND a.attnum = ANY(i.indkey) "
                "WHERE i.indrelid = %s::regclass AND i.indisprimary",
                (f"{settings.db_schema}.form_export",),
            )
            if {r["attname"] for r in cur.fetchall()} != {"export_id"}:
                cur.execute(sql.SQL(
                    "ALTER TABLE {}.form_export DROP CONSTRAINT form_export_pkey"
                ).format(sql.Identifier(settings.db_schema)))
                row = None

        if row is None:
            cur.execute(sql.SQL(
                "ALTER TABLE {}.form_export ADD PRIMARY KEY (export_id)"
            ).format(sql.Identifier(settings.db_schema)))

        # Whatever the old shape insisted on, the new one fills in instead.
        for legacy in ("version_no", "remote_id"):
            if legacy in have:
                cur.execute(sql.SQL(
                    "ALTER TABLE {}.form_export ALTER COLUMN {} DROP NOT NULL"
                ).format(sql.Identifier(settings.db_schema), sql.Identifier(legacy)))

    logger.info("form_export gained: %s", ", ".join(added))
    return added
