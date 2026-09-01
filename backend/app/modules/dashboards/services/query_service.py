from typing import Any, Dict, List

from app.core.database import fetch_all
from app.modules.dashboards.schemas import DashboardDataBinding
from app.modules.dashboards.services.query_builder import build_select_query

from app.modules.dashboards.services.result_serializer import (
    normalize_rows,
)

def execute_dashboard_query(
    table_name: str,
    binding: DashboardDataBinding,
) -> List[Dict[str, Any]]:
    """
    Build and execute a read-only dashboard query.

    The binding must already have passed dashboard/schema
    and semantic field validation.
    """

    query, params = build_select_query(
        table_name,
        binding,
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