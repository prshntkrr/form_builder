"""Idempotent migrations owned by the external_db module.

`schema.sql` next door builds both tables on a fresh database; this handles the
databases that already have `external_import` from before saved connections
existed.
"""
import logging

from app.core.database import table_exists, transaction

logger = logging.getLogger(__name__)


def ensure_import_connection() -> bool:
    """Let an import remember which saved connection it came from.

    A column and a foreign key, added once. Existing rows keep NULL: they were
    imported from a connection somebody typed in, and there is nothing to link
    them to.
    """
    with transaction() as cur:
        if not table_exists(cur, "external_import") or not table_exists(cur, "external_connection"):
            return False
        cur.execute("""SELECT 1 FROM information_schema.columns
                        WHERE table_schema = current_schema()
                          AND table_name = 'external_import'
                          AND column_name = 'connection_id'""")
        if cur.fetchone():
            return False
        cur.execute("""ALTER TABLE external_import
                         ADD COLUMN connection_id INTEGER
                         REFERENCES external_connection (connection_id) ON DELETE SET NULL""")
    logger.info("external_import.connection_id added")
    return True
