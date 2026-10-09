"""Execute dashboard queries against a live Databricks connection.

The same interface as query_service.py but routes through the Databricks SQL
Statement Execution API instead of local PostgreSQL. No data is stored; every
call fetches fresh results.
"""
import logging
import time
from typing import Any, Dict, List, Optional

from app.modules.external_db import databricks
from app.modules.external_db.connection_store import spec_for
from app.modules.dashboards.schemas import DashboardDataBinding
from app.modules.dashboards.services.live_query_builder import (
    build_live_count,
    build_live_distinct,
    build_live_dependent_distinct,
    build_live_query,
)

logger = logging.getLogger(__name__)

_meta_cache: Dict[str, Any] = {}
META_TTL = 300


def _cache_key(connection_id: int, schema: str, table: str) -> str:
    return f"{connection_id}:{schema}:{table}"


def live_columns(
    user: Dict[str, Any],
    connection_id: int,
    schema: str,
    table: str,
) -> List[Dict[str, Any]]:
    key = _cache_key(connection_id, schema, table)
    now = time.monotonic()
    cached = _meta_cache.get(key)
    if cached and now - cached["at"] < META_TTL:
        return cached["columns"]

    spec = spec_for(user, connection_id)
    cols = databricks.columns(spec, schema, table)
    _meta_cache[key] = {"columns": cols, "at": now}
    return cols


def execute_live_query(
    user: Dict[str, Any],
    connection_id: int,
    catalog: str,
    schema: str,
    table: str,
    binding: DashboardDataBinding,
    page: int = None,
    page_size: int = None,
) -> List[Dict[str, Any]]:
    spec = spec_for(user, connection_id)
    sql, params = build_live_query(catalog, schema, table, binding,
                                   page=page, page_size=page_size)
    columns, chunks, _ = databricks.execute(spec, sql, parameters=params or None,
                                            row_limit=10000)
    names = [c["name"] for c in columns]
    rows = [dict(zip(names, row)) for chunk in chunks for row in chunk]
    return rows


def count_live_rows(
    user: Dict[str, Any],
    connection_id: int,
    catalog: str,
    schema: str,
    table: str,
    binding: DashboardDataBinding,
) -> int:
    spec = spec_for(user, connection_id)
    sql, params = build_live_count(catalog, schema, table, binding)
    _, chunks, _ = databricks.execute(spec, sql, parameters=params or None)
    for chunk in chunks:
        if chunk:
            return int(chunk[0][0]) if chunk[0] else 0
    return 0


def live_distinct_values(
    user: Dict[str, Any],
    connection_id: int,
    catalog: str,
    schema: str,
    table: str,
    field: str,
) -> List[Any]:
    spec = spec_for(user, connection_id)
    sql, params = build_live_distinct(catalog, schema, table, field)
    _, rows = databricks._all(spec, sql, parameters=params or None)
    return [r["value"] for r in rows if r.get("value") not in (None, "")]


def live_dependent_values(
    user: Dict[str, Any],
    connection_id: int,
    catalog: str,
    schema: str,
    table: str,
    field: str,
    parent_filters: list,
) -> List[Any]:
    spec = spec_for(user, connection_id)
    sql, params = build_live_dependent_distinct(
        catalog, schema, table, field, parent_filters)
    _, rows = databricks._all(spec, sql, parameters=params or None)
    return [r["value"] for r in rows if r.get("value") not in (None, "")]
