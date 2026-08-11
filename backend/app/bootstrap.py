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
from typing import List

from .config import settings
from .database import transaction
from .table_service import table_exists

logger = logging.getLogger(__name__)

SCHEMA_FILE = Path(__file__).resolve().parent.parent / "schema.sql"
REQUIRED_TABLES = ("forms", "form_version")


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
