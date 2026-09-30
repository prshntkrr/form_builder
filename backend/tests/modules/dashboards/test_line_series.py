"""Several lines on one line chart.

A line chart with three lines is one widget with three measures, which is a
binding the query builder, the validator and the schema have always accepted.
So what these hold is that nothing had to be special-cased for it: one query
per chart with a column per line, a chart of one line unchanged, and the
guidance the model is given so it produces the same shape.
"""
import pytest

from app.core import registry
from app.core.database import get_connection, ping
from app.modules.dashboards.schemas import (
    DashboardDataBinding,
    DashboardSpecification,
)
from app.modules.dashboards.services.dashboard_llm import SYSTEM_PROMPT
from app.modules.dashboards.services.dashboard_validator import (
    DashboardValidationError,
    validate_dashboard_spec,
)
from app.modules.dashboards.services.query_builder import build_select_query


def rendered(binding):
    """The SQL as psycopg2 would send it."""
    query, _ = build_select_query("nepal_rice_tabular", binding)

    with get_connection() as conn:
        return query.as_string(conn)


FIELDS = {
    "month": "text",
    "id": "integer",
    "total_production": "numeric",
    "rice_sold": "numeric",
    "farmer_name": "text",
}


def binding(measures):
    return DashboardDataBinding(
        dimensions=[{"field": "month"}],
        measures=measures,
        filters=[],
    )


THREE_LINES = [
    {"field": "id", "aggregation": "COUNT", "label": "Farmers"},
    {"field": "total_production", "aggregation": "SUM", "label": "Total Production"},
    {"field": "rice_sold", "aggregation": "SUM", "label": "Rice Sold"},
]


def spec(measures):
    return DashboardSpecification(**{
        "dashboard": {"name": "Rice"},
        "data_sources": [
            {"id": "source_1", "name": "nepal_rice_tabular", "type": "postgresql_tabular"}
        ],
        "layout": {"type": "grid", "columns": 12, "row_height": 64},
        "widgets": [{
            "id": "widget_1",
            "type": "line",
            "title": "By Month",
            "data_source_id": "source_1",
            "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
            "data_binding": {
                "dimensions": [{"field": "month"}],
                "measures": measures,
                "filters": [],
            },
        }],
    })


@pytest.mark.skipif(not ping(), reason="Postgres is not reachable")
@pytest.mark.skipif("dashboards" in registry.disabled(),
                    reason="dashboards is switched off (DISABLED_MODULES)")
class TestTheQuery:
    def test_one_query_with_a_column_per_line(self):
        sql = rendered(binding(THREE_LINES))

        for alias in ("id_count", "total_production_sum", "rice_sold_sum"):
            assert alias in sql

    def test_grouped_by_the_axis_alone(self):
        sql = rendered(binding(THREE_LINES))

        group_by = sql.split("GROUP BY")[1]
        assert "month" in group_by
        # The measures are aggregated, so they are not grouped by.
        assert "rice_sold" not in group_by

    def test_one_line_asks_exactly_what_it_always_did(self):
        sql = rendered(binding(THREE_LINES[:1]))

        assert "id_count" in sql
        assert "total_production" not in sql

    def test_two_calculations_of_one_field_are_separate_columns(self):
        sql = rendered(binding([
            {"field": "total_production", "aggregation": "SUM", "label": "Total"},
            {"field": "total_production", "aggregation": "AVG", "label": "Average"},
        ]))

        assert "total_production_sum" in sql
        assert "total_production_avg" in sql


class TestValidation:
    def test_a_chart_of_three_lines_is_accepted(self):
        assert validate_dashboard_spec(spec(THREE_LINES), {"source_1": FIELDS})

    def test_a_chart_of_one_line_still_is(self):
        assert validate_dashboard_spec(spec(THREE_LINES[:1]), {"source_1": FIELDS})

    def test_a_line_may_carry_no_label_at_all(self):
        # Every dashboard saved before this one.
        assert validate_dashboard_spec(
            spec([{"field": "id", "aggregation": "COUNT"}]), {"source_1": FIELDS},
        )

    def test_but_no_line_may_sum_a_word(self):
        with pytest.raises(DashboardValidationError, match="text field"):
            validate_dashboard_spec(
                spec(THREE_LINES + [
                    {"field": "farmer_name", "aggregation": "SUM", "label": "Names"},
                ]),
                {"source_1": FIELDS},
            )

    def test_and_an_unknown_field_is_still_refused(self):
        with pytest.raises(DashboardValidationError):
            validate_dashboard_spec(
                spec([{"field": "not_a_column", "aggregation": "SUM"}]),
                {"source_1": FIELDS},
            )


class TestWhatTheModelIsTold:
    def test_several_quantities_are_one_widget_with_several_measures(self):
        assert "LINE CHARTS WITH SEVERAL LINES" in SYSTEM_PROMPT

    def test_and_that_a_label_is_what_the_legend_shows(self):
        section = SYSTEM_PROMPT.split("LINE CHARTS WITH SEVERAL LINES")[1]
        section = section.split("BUBBLE, HISTOGRAM")[0]

        assert '"label"' in section
        assert "Total Production" in section
        # And that it is not the grouped bar chart, which is the near miss.
        assert "second dimension" in section
