"""Which project an imported data source belongs to.

A `<form>_tabular` table is not tracked here — a form already carries its
project on `forms.project_id`, and `data_source_service` resolves those through
the forms module. This registry is only for the sources with no other home: an
Excel upload and an external-database import. It is what scopes a dashboard's
data source picker to one project.

`table_name` is the primary key, so registering a table that is already here
moves it to the new project rather than duplicating it.
"""
from typing import List, Optional

from app.core.database import transaction


def register(
    table_name: str,
    project_id: str,
    source_type: str,
    source_id: Optional[str] = None,
    created_by: Optional[str] = None,
) -> None:
    """Record that `table_name` belongs to `project_id`.

    Upsert on the table name: re-importing a name (which the import paths refuse
    anyway unless the table was dropped first) or moving it lands on one row.
    """
    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO dashboard_data_source
                   (table_name, project_id, source_type, source_id, created_by)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (table_name) DO UPDATE
            SET project_id  = EXCLUDED.project_id,
                source_type = EXCLUDED.source_type,
                source_id   = EXCLUDED.source_id
            """,
            (table_name, project_id, source_type, source_id, created_by),
        )


def unregister(table_name: str) -> None:
    """Forget a table — used when its import is undone or the table is dropped."""
    with transaction() as cur:
        cur.execute(
            "DELETE FROM dashboard_data_source WHERE table_name = %s",
            (table_name,),
        )


def tables_for_project(project_id: str) -> List[str]:
    """The registered table names for one project."""
    with transaction() as cur:
        cur.execute(
            "SELECT table_name FROM dashboard_data_source WHERE project_id = %s",
            (project_id,),
        )
        return [row["table_name"] for row in cur.fetchall()]
