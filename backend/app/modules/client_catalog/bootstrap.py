"""Idempotent migrations owned by the client catalog module.

`schema.sql` next door creates the tables on a fresh database; this handles the
databases that already have them. Runs at every startup and returns early once
its work is done.
"""
import logging

from app.core.database import table_exists, transaction

logger = logging.getLogger(__name__)


def ensure_catalog_columns() -> bool:
    """Let a catalogue record who built it and which catalogue it depends on.

    Both arrived with the Catalogue Builder. Neither exists on a database that
    only ever imported catalogues from a workbook, and both are additive: an
    imported catalogue simply has them empty.
    """
    with transaction() as cur:
        if not table_exists(cur, "client_catalog"):
            # Nothing to migrate yet — schema.sql will create it with both.
            return False

        cur.execute(
            """
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'client_catalog'
              AND column_name IN ('created_by', 'parent_catalog_id')
            """
        )
        present = {row["column_name"] for row in cur.fetchall()}

        if "created_by" not in present:
            cur.execute(
                "ALTER TABLE client_catalog ADD COLUMN created_by "
                "VARCHAR(200) NOT NULL DEFAULT ''"
            )
            logger.info("Added client_catalog.created_by")

        if "parent_catalog_id" not in present:
            cur.execute(
                "ALTER TABLE client_catalog ADD COLUMN parent_catalog_id VARCHAR(100) "
                "REFERENCES client_catalog(catalog_id) ON DELETE SET NULL"
            )
            logger.info("Added client_catalog.parent_catalog_id")

    return True


def ensure_value_labels() -> bool:
    """Let one value carry its label in more than one language.

    `Si` is one code with a Spanish label and an English one, not two values.
    `label` is untouched and stays the label shown when no language is asked
    for, so nothing that reads it needs to change.
    """
    with transaction() as cur:
        if not table_exists(cur, "client_catalog_value"):
            return False

        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'client_catalog_value' AND column_name = 'labels'
            """
        )
        if cur.fetchone():
            return True

        cur.execute(
            "ALTER TABLE client_catalog_value "
            "ADD COLUMN labels JSONB NOT NULL DEFAULT '{}'::jsonb"
        )
        logger.info("Added client_catalog_value.labels")

    return True
