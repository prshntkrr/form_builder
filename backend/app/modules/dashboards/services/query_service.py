from typing import Any, Dict, List

from app.core.database import fetch_all
from app.modules.dashboards.schemas import DashboardDataBinding
from app.modules.dashboards.services.query_builder import (
    MAX_FILTER_OPTIONS,
    build_count_query,
    build_distinct_query,
    build_select_query,
)

from app.modules.dashboards.services.result_serializer import (
    normalize_rows,
)

def execute_dashboard_query(
    table_name: str,
    binding: DashboardDataBinding,
    page: int = None,
    page_size: int = None,
) -> List[Dict[str, Any]]:
    """
    Build and execute a read-only dashboard query.

    The binding must already have passed dashboard/schema
    and semantic field validation.

    With a page, only that page is read: the LIMIT is the database's, so a
    table of fifty thousand rows sends ten of them.
    """

    query, params = build_select_query(
        table_name,
        binding,
        page=page,
        page_size=page_size,
    )

    # fetch_all() expects a SQL string and separately bound params.
    #
    # The query builder uses psycopg2.sql objects so identifiers
    # are safely quoted. We need a connection to render that SQL.
    from app.core.database import get_connection

    with get_connection() as conn:
        rendered_query = query.as_string(conn)

    rows = fetch_all(
        rendered_query,
        params,
    )

    return normalize_rows(rows)


def count_dashboard_rows(
    table_name: str,
    binding: DashboardDataBinding,
) -> int:
    """How many rows this binding has altogether, for the pager to show.

    Counted by the database over the same grouped and filtered query, so it
    agrees with what paging through the table would actually reach.
    """
    query, params = build_count_query(table_name, binding)

    from app.core.database import get_connection

    with get_connection() as conn:
        rendered_query = query.as_string(conn)

    rows = fetch_all(rendered_query, params)

    return int(rows[0]["total"]) if rows else 0


def distinct_field_values(
    table_name: str,
    field: str,
    limit: int = MAX_FILTER_OPTIONS,
) -> List[Any]:
    """The values a dashboard filter on this column can be set to.

    The caller validates that the field belongs to the table; this asks the
    database for the values themselves. Read-only, one column, capped.
    """
    query, params = build_distinct_query(table_name, field, limit=limit)

    from app.core.database import get_connection

    with get_connection() as conn:
        rendered_query = query.as_string(conn)

    rows = normalize_rows(fetch_all(rendered_query, params))

    return [row["value"] for row in rows if row.get("value") not in (None, "")]
