from typing import Any, List, Sequence, Tuple

from psycopg2 import sql

from app.modules.dashboards.schemas import (
    DashboardDataBinding,
    FilterBinding,
)


SUPPORTED_AGGREGATIONS = {
    "COUNT",
    "COUNT_DISTINCT",
    "SUM",
    "AVG",
    "MIN",
    "MAX",
    "NONE",
}


# A page a table asks for. Capped so a caller cannot ask for the whole table
# by naming a very large page: the point of paging is that the browser never
# holds more than a screenful.
MAX_PAGE_SIZE = 200


def build_select_query(
    table_name: str,
    binding: DashboardDataBinding,
    page: int = None,
    page_size: int = None,
) -> Tuple[sql.Composed, List[Any]]:
    """
    Build a read-only PostgreSQL SELECT query from a validated
    DashboardDataBinding.

    Returns:
        (query, params)

    Identifiers are represented with psycopg2.sql.Identifier.
    Values are returned separately as bound parameters.

    This function never accepts raw SQL.

    With `page` and `page_size`, the database returns that page and nothing
    else — LIMIT and OFFSET, not a slice taken afterwards. Paging also adds an
    ORDER BY over every selected column, because without one PostgreSQL may
    return rows in a different order for each page and a row could appear on
    two pages or on none. An unpaged query is built exactly as it always was.
    """

    if not table_name:
        raise ValueError("Table name is required")

    select_parts = []
    group_by_parts = []

    # ---------------------------------------------------------
    # Dimensions
    # ---------------------------------------------------------

    for dimension in binding.dimensions:
        field = sql.Identifier(dimension.field)

        select_parts.append(field)
        group_by_parts.append(field)

    # ---------------------------------------------------------
    # Measures
    # ---------------------------------------------------------

    for measure in binding.measures:
        if measure.aggregation not in SUPPORTED_AGGREGATIONS:
            raise ValueError(
                f"Unsupported aggregation: {measure.aggregation}"
            )

        field = sql.Identifier(measure.field)

        if measure.aggregation == "NONE":
            expression = field
        elif measure.aggregation == "COUNT_DISTINCT":
            expression = sql.SQL(
                "COUNT(DISTINCT {})"
            ).format(field)
        else:
            expression = sql.SQL(
                "{}({})"
            ).format(
                sql.SQL(measure.aggregation),
                field,
            )

        alias = sql.Identifier(
            f"{measure.field}_{measure.aggregation.lower()}"
        )

        select_parts.append(
            sql.SQL("{} AS {}").format(
                expression,
                alias,
            )
        )

    if not select_parts:
        raise ValueError(
            "At least one dimension or measure is required"
        )

    # ---------------------------------------------------------
    # SELECT
    # ---------------------------------------------------------

    query = sql.SQL("SELECT {}").format(
        sql.SQL(", ").join(select_parts)
    )

    # ---------------------------------------------------------
    # FROM
    # ---------------------------------------------------------

    query += sql.SQL(" FROM {}").format(
        sql.Identifier(table_name)
    )

    # ---------------------------------------------------------
    # Filters
    # ---------------------------------------------------------

    filter_parts = []
    params: List[Any] = []

    for filter_item in binding.filters:
        expression, filter_params = build_filter_expression(
            filter_item
        )

        filter_parts.append(expression)
        params.extend(filter_params)

    if filter_parts:
        query += sql.SQL(" WHERE {}").format(
            sql.SQL(" AND ").join(filter_parts)
        )

    # ---------------------------------------------------------
    # GROUP BY
    # ---------------------------------------------------------

    if group_by_parts:
        query += sql.SQL(" GROUP BY {}").format(
            sql.SQL(", ").join(group_by_parts)
        )

    # ---------------------------------------------------------
    # Paging
    # ---------------------------------------------------------

    if page is not None and page_size is not None:
        size = max(1, min(int(page_size), MAX_PAGE_SIZE))
        number = max(1, int(page))

        # By position, so this orders by the same expressions the SELECT
        # already computes rather than repeating them — and works for an
        # aggregate column, which cannot be named in ORDER BY by its alias in
        # every PostgreSQL version.
        query += sql.SQL(" ORDER BY {}").format(
            sql.SQL(", ").join(
                sql.SQL(str(index + 1)) for index in range(len(select_parts))
            )
        )

        query += sql.SQL(" LIMIT %s OFFSET %s")
        params.append(size)
        params.append((number - 1) * size)

    return query, params


def build_count_query(
    table_name: str,
    binding: DashboardDataBinding,
) -> Tuple[sql.Composed, List[Any]]:
    """How many rows the same binding returns in total.

    The very same query, wrapped — so the count is of the grouped, filtered
    result the table is paging through, and not of the physical table. A
    dashboard filter narrows both or neither.
    """
    inner, params = build_select_query(table_name, binding)

    return (
        sql.SQL("SELECT COUNT(*) AS total FROM ({}) AS counted").format(inner),
        params,
    )


def build_filter_expression(
    filter_item: FilterBinding,
) -> Tuple[sql.Composed, List[Any]]:
    """
    Build a filter expression and its bound parameters.
    """

    field = sql.Identifier(filter_item.field)

    operator = filter_item.operator

    if operator == "EQUALS":
        return (
            sql.SQL("{} = %s").format(field),
            [filter_item.value],
        )

    if operator == "NOT_EQUALS":
        return (
            sql.SQL("{} <> %s").format(field),
            [filter_item.value],
        )

    if operator == "GREATER_THAN":
        return (
            sql.SQL("{} > %s").format(field),
            [filter_item.value],
        )

    if operator == "GREATER_THAN_OR_EQUAL":
        return (
            sql.SQL("{} >= %s").format(field),
            [filter_item.value],
        )

    if operator == "LESS_THAN":
        return (
            sql.SQL("{} < %s").format(field),
            [filter_item.value],
        )

    if operator == "LESS_THAN_OR_EQUAL":
        return (
            sql.SQL("{} <= %s").format(field),
            [filter_item.value],
        )

    if operator == "IS_NULL":
        return (
            sql.SQL("{} IS NULL").format(field),
            [],
        )

    if operator == "IS_NOT_NULL":
        return (
            sql.SQL("{} IS NOT NULL").format(field),
            [],
        )

    if operator == "IN":
        values = filter_item.value

        if not isinstance(values, (list, tuple)):
            raise ValueError(
                "IN filter value must be a list or tuple"
            )

        if not values:
            raise ValueError(
                "IN filter requires at least one value"
            )

        placeholders = sql.SQL(", ").join(
            [sql.SQL("%s")] * len(values)
        )

        return (
            sql.SQL("{} IN ({})").format(
                field,
                placeholders,
            ),
            list(values),
        )

    raise ValueError(
        f"Unsupported filter operator: {operator}"
    )