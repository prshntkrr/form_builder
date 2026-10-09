"""Build Databricks SQL from a DashboardDataBinding.

The same semantics as query_builder.py — dimensions, measures, filters, paging —
expressed as a SQL string with backtick-quoted identifiers for Databricks,
instead of psycopg2.sql objects for PostgreSQL.

Every identifier passes through databricks.check_name and quote, so nothing a
caller sends can be anything but a name. Values are returned as a list and
sent to Databricks as statement parameters.
"""
from typing import Any, Dict, List, Tuple

from app.modules.external_db.databricks import check_name, quote
from app.modules.dashboards.schemas import DashboardDataBinding, FilterBinding
from app.modules.dashboards.services.query_builder import (
    MAX_PAGE_SIZE,
    MAX_FILTER_OPTIONS,
    SUPPORTED_AGGREGATIONS,
)


def _col(field: str) -> str:
    return f"`{check_name(field, 'field').replace('`', '``')}`"


def build_live_query(
    catalog: str,
    schema: str,
    table: str,
    binding: DashboardDataBinding,
    page: int = None,
    page_size: int = None,
) -> Tuple[str, List[Dict[str, str]]]:
    """A SELECT over a Databricks table, with statement parameters.

    Returns (sql_string, parameters) where parameters is a list of
    {"name": "p0", "value": "...", "type": "STRING"} dicts for the
    Databricks SQL Statement Execution API.
    """
    select_parts = []
    group_by_parts = []
    params: List[Dict[str, str]] = []
    param_idx = 0

    for dim in binding.dimensions:
        col = _col(dim.field)
        select_parts.append(col)
        group_by_parts.append(col)

    for measure in binding.measures:
        if measure.aggregation not in SUPPORTED_AGGREGATIONS:
            raise ValueError(f"Unsupported aggregation: {measure.aggregation}")
        col = _col(measure.field)
        if measure.aggregation == "NONE":
            expr = col
        elif measure.aggregation == "COUNT_DISTINCT":
            expr = f"COUNT(DISTINCT {col})"
        else:
            expr = f"{measure.aggregation}({col})"
        alias = f"`{measure.field}_{measure.aggregation.lower()}`"
        select_parts.append(f"{expr} AS {alias}")

    if not select_parts:
        raise ValueError("At least one dimension or measure is required")

    fqn = quote(check_name(catalog, "catalog"),
                check_name(schema, "schema"),
                check_name(table, "table"))

    sql = f"SELECT {', '.join(select_parts)} FROM {fqn}"

    filter_parts = []
    for f in binding.filters:
        expr, param_idx = _filter(f, params, param_idx)
        filter_parts.append(expr)

    if filter_parts:
        sql += f" WHERE {' AND '.join(filter_parts)}"

    if group_by_parts:
        sql += f" GROUP BY {', '.join(group_by_parts)}"

    if page is not None and page_size is not None:
        size = max(1, min(int(page_size), MAX_PAGE_SIZE))
        number = max(1, int(page))
        positions = ", ".join(str(i + 1) for i in range(len(select_parts)))
        sql += f" ORDER BY {positions}"
        sql += f" LIMIT {size} OFFSET {(number - 1) * size}"

    return sql, params


def build_live_count(
    catalog: str,
    schema: str,
    table: str,
    binding: DashboardDataBinding,
) -> Tuple[str, List[Dict[str, str]]]:
    inner, params = build_live_query(catalog, schema, table, binding)
    return f"SELECT COUNT(*) AS total FROM ({inner})", params


def build_live_distinct(
    catalog: str,
    schema: str,
    table: str,
    field: str,
    limit: int = MAX_FILTER_OPTIONS,
) -> Tuple[str, List[Dict[str, str]]]:
    col = _col(field)
    fqn = quote(check_name(catalog, "catalog"),
                check_name(schema, "schema"),
                check_name(table, "table"))
    cap = max(1, min(int(limit), MAX_FILTER_OPTIONS))
    sql = (f"SELECT DISTINCT {col} AS value FROM {fqn} "
           f"WHERE {col} IS NOT NULL ORDER BY 1 LIMIT {cap}")
    return sql, []


def build_live_dependent_distinct(
    catalog: str,
    schema: str,
    table: str,
    field: str,
    parent_filters: list,
    limit: int = MAX_FILTER_OPTIONS,
) -> Tuple[str, List[Dict[str, str]]]:
    col = _col(field)
    fqn = quote(check_name(catalog, "catalog"),
                check_name(schema, "schema"),
                check_name(table, "table"))
    parts = [f"{col} IS NOT NULL"]
    params: List[Dict[str, str]] = []
    param_idx = 0

    for pf in parent_filters:
        pf_field = (pf.get("field") or "").strip()
        pf_values = pf.get("values") or []
        if not pf_field or not pf_values:
            continue
        parent_col = _col(pf_field)
        placeholders = []
        for v in pf_values:
            name = f"p{param_idx}"
            params.append({"name": name, "value": str(v), "type": "STRING"})
            placeholders.append(f":{name}")
            param_idx += 1
        parts.append(f"{parent_col} IN ({', '.join(placeholders)})")

    where = " AND ".join(parts)
    cap = max(1, min(int(limit), MAX_FILTER_OPTIONS))
    sql = (f"SELECT DISTINCT {col} AS value FROM {fqn} "
           f"WHERE {where} ORDER BY 1 LIMIT {cap}")
    return sql, params


def _filter(
    f: FilterBinding,
    params: List[Dict[str, str]],
    idx: int,
) -> Tuple[str, int]:
    col = _col(f.field)
    op = f.operator

    if op == "IS_NULL":
        return f"{col} IS NULL", idx
    if op == "IS_NOT_NULL":
        return f"{col} IS NOT NULL", idx

    if op == "IN":
        values = f.value
        if not isinstance(values, (list, tuple)) or not values:
            raise ValueError("IN filter requires a non-empty list")
        placeholders = []
        for v in values:
            name = f"p{idx}"
            params.append({"name": name, "value": str(v), "type": "STRING"})
            placeholders.append(f":{name}")
            idx += 1
        return f"{col} IN ({', '.join(placeholders)})", idx

    ops = {
        "EQUALS": "=", "NOT_EQUALS": "<>",
        "GREATER_THAN": ">", "GREATER_THAN_OR_EQUAL": ">=",
        "LESS_THAN": "<", "LESS_THAN_OR_EQUAL": "<=",
    }
    if op not in ops:
        raise ValueError(f"Unsupported filter operator: {op}")

    name = f"p{idx}"
    params.append({"name": name, "value": str(f.value), "type": "STRING"})
    return f"{col} {ops[op]} :{name}", idx + 1
