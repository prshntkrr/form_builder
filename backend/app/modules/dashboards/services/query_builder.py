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
}


def build_select_query(
    table_name: str,
    binding: DashboardDataBinding,
) -> Tuple[sql.Composed, List[Any]]:
    """
    Build a read-only PostgreSQL SELECT query from a validated
    DashboardDataBinding.

    Returns:
        (query, params)

    Identifiers are represented with psycopg2.sql.Identifier.
    Values are returned separately as bound parameters.

    This function never accepts raw SQL.
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

        if measure.aggregation == "COUNT_DISTINCT":
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

    return query, params


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
        raise NotImplementedError(
            "IN filters will be added with parameter handling"
        )

    raise ValueError(
        f"Unsupported filter operator: {operator}"
    )