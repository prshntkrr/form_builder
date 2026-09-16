from typing import Any, Dict, List, Optional

from app.core.database import fetch_all
from app.modules.forms.form_service import list_forms


TABULAR_SUFFIX = "_tabular"


def list_tabular_tables() -> List[Dict[str, Any]]:
    rows = fetch_all(
        """
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_type = 'BASE TABLE'
          AND table_name LIKE %s
        ORDER BY table_name
        """,
        ("%\\_tabular",),
    )

    return [
        {
            "name": row["table_name"],
            "type": "postgresql_tabular",
        }
        for row in rows
    ]


def _source_table_name(tabular_name: str) -> str:
    return tabular_name[: -len(TABULAR_SUFFIX)]


def _find_form_for_table(table_name: str) -> Optional[Dict[str, Any]]:
    """
    Resolve a tabular table through the Forms module service.

    Dashboard does not query the Forms module's tables directly.
    """
    forms = list_forms(limit=1000, offset=0)

    for form in forms:
        if form.get("table_name") == table_name:
            return form

    return None


def get_tabular_metadata(tabular_name: str) -> Dict[str, Any]:
    if not tabular_name.endswith(TABULAR_SUFFIX):
        raise ValueError("Only _tabular data sources are supported")

    source_table = _source_table_name(tabular_name)

    form = _find_form_for_table(source_table)

    if not form:
        raise ValueError(
            f"No form definition found for data source '{tabular_name}'"
        )

    form_json = form.get("form_json") or {}
    active_fields = form_json.get("fields") or []

    # Read the actual PostgreSQL column types from the selected _tabular table.
    rows = fetch_all(
        """
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = %s
        ORDER BY ordinal_position
        """,
        (tabular_name,),
    )

    postgres_types = {
        row["column_name"]: row["data_type"]
        for row in rows
    }

    fields = []

    for field in active_fields:
        name = field.get("name")

        if not name:
            continue

        # Only expose fields that actually exist in the _tabular table.
        if name not in postgres_types:
            continue

        fields.append(
            {
                "name": name,
                "label": field.get("label") or name,
                "type": field.get("type"),
                "postgres_type": postgres_types[name],
                "required": bool(field.get("required")),
                "order": field.get("order"),
            }
        )

    return {
        "name": tabular_name,
        "type": "postgresql_tabular",
        "form_id": form.get("form_id"),
        "form_title": form.get("form_title"),
        "form_version": form.get("version_no"),
        "fields": fields,
    }


def list_table_columns(
    table_name: str,
    schema_name: str = "public",
) -> List[Dict[str, Any]]:
    """
    Return column metadata for a PostgreSQL table.

    Only metadata is returned. No table rows are read.
    """

    rows = fetch_all(
        """
        SELECT
            column_name,
            data_type
        FROM information_schema.columns
        WHERE table_schema = %s
          AND table_name = %s
        ORDER BY ordinal_position
        """,
        [schema_name, table_name],
    )

    return [
        {
            "name": row["column_name"],
            "type": row["data_type"],
        }
        for row in rows
    ]