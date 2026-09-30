"""Configured dashboard filters, and what a reader picks from them.

Two separate things. Which columns a dashboard offers as filters is
configuration, saved with the dashboard. What somebody picks is sent with
each request as the `IN` filter the binding has always carried — so most of
what is held here is that the second needed no new filtering engine: the
query builder, the count behind a table's pager and the field checks on the
data endpoint all apply to it unchanged.

The fixture builds a throwaway table and drops it afterwards.
"""
import pytest

from fastapi import HTTPException

from app.core import registry
from app.core.database import get_connection, ping, transaction
from app.modules.dashboards.schemas import (
    DashboardDataBinding,
    DashboardSpecification,
)
from app.modules.dashboards.services.dashboard_validator import (
    DashboardValidationError,
    validate_dashboard_spec,
)
from app.modules.dashboards.services.query_builder import (
    MAX_FILTER_OPTIONS,
    build_distinct_query,
    build_select_query,
)
from app.modules.dashboards.routers.dashboards import get_filter_options
from app.modules.dashboards.services.query_service import (
    count_dashboard_rows,
    distinct_field_values,
    execute_dashboard_query,
)

TABLE = "zz_test_filters_tabular"

needs_db = pytest.mark.skipif(
    not ping() or "dashboards" in registry.disabled(),
    reason="Postgres is not reachable, or dashboards is switched off",
)


@pytest.fixture
def table():
    with transaction() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {TABLE}")
        cur.execute(
            f"CREATE TABLE {TABLE} "
            f"(id BIGINT, district TEXT, municipality TEXT, nothing TEXT)"
        )
        cur.execute(
            f"""INSERT INTO {TABLE} (id, district, municipality)
                VALUES (1, 'Dudhuwa', 'Joshipur'),
                       (2, 'Dudhuwa', 'Raptisonari'),
                       (3, 'Janaki', 'Joshipur'),
                       (4, 'Rampur', 'Joshipur'),
                       (5, 'Rampur', 'Raptisonari')"""
        )

    yield TABLE

    with transaction() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {TABLE}")


FIELDS = {"id": "integer", "district": "text", "municipality": "text"}


def spec(filter_fields=None):
    body = {
        "dashboard": {"name": "Rice"},
        "data_sources": [
            {"id": "source_1", "name": TABLE, "type": "postgresql_tabular"}
        ],
        "layout": {"type": "grid", "columns": 12, "row_height": 64},
        "widgets": [],
    }

    if filter_fields is not None:
        body["filter_fields"] = filter_fields

    return DashboardSpecification(**body)


def listing(filters):
    """Every row, narrowed by these filters, keyed by column name."""
    return DashboardDataBinding(
        dimensions=[{"field": "id"}, {"field": "district"}],
        measures=[],
        filters=filters,
    )


# ── which filters a dashboard offers ────────────────────────────────

class TestConfiguration:
    def test_a_dashboard_saved_before_filters_existed_still_validates(self):
        # No key at all, which is every dashboard already saved.
        assert spec().filter_fields == []

    def test_a_field_carries_the_column_and_the_owners_word_for_it(self):
        configured = spec([{"field": "district", "label": "District"}])

        assert configured.filter_fields[0].field == "district"
        assert configured.filter_fields[0].label == "District"

    def test_an_alias_is_optional(self):
        assert spec([{"field": "district"}]).filter_fields[0].label is None

    def test_the_same_column_cannot_be_offered_twice(self):
        with pytest.raises(Exception, match="already a filter field"):
            spec([{"field": "district"}, {"field": "district"}])

    def test_a_field_must_be_a_column_of_the_dashboards_source(self):
        with pytest.raises(DashboardValidationError, match="not a column"):
            validate_dashboard_spec(
                spec([{"field": "not_a_column"}]), {"source_1": FIELDS},
            )

    def test_and_one_that_is_passes(self):
        assert validate_dashboard_spec(
            spec([{"field": "district", "label": "District"}]),
            {"source_1": FIELDS},
        )

    def test_a_selection_is_never_part_of_the_configuration(self):
        # The runtime shape belongs in a request, not in the specification.
        with pytest.raises(Exception):
            spec([{"field": "district", "values": ["Dudhuwa"]}])


# ── the values to pick from ─────────────────────────────────────────

@needs_db
class TestOptions:
    def test_the_values_a_filter_can_be_set_to(self, table):
        assert distinct_field_values(TABLE, "district") == [
            "Dudhuwa", "Janaki", "Rampur",
        ]

    def test_a_column_with_nothing_in_it_offers_nothing(self, table):
        assert distinct_field_values(TABLE, "nothing") == []

    def test_the_column_never_reaches_the_sql_as_text(self, table):
        query, params = build_distinct_query(TABLE, "district")

        with get_connection() as conn:
            rendered = query.as_string(conn)

        # An identifier, quoted, and the cap bound rather than written in.
        assert '"district"' in rendered
        assert "%s" in rendered
        assert params == [MAX_FILTER_OPTIONS]

    def test_and_the_list_is_capped(self, table):
        _, params = build_distinct_query(TABLE, "district", limit=10_000)

        assert params == [MAX_FILTER_OPTIONS]


# ── what a selection does ───────────────────────────────────────────

@needs_db
class TestSelections:
    def test_two_values_of_one_filter_mean_either(self, table):
        rows = execute_dashboard_query(TABLE, listing([
            {"field": "district", "operator": "IN",
             "value": ["Dudhuwa", "Janaki"]},
        ]))

        assert {row["district"] for row in rows} == {"Dudhuwa", "Janaki"}
        assert len(rows) == 3

    def test_two_filters_mean_both(self, table):
        rows = execute_dashboard_query(TABLE, listing([
            {"field": "district", "operator": "IN",
             "value": ["Dudhuwa", "Rampur"]},
            {"field": "municipality", "operator": "IN",
             "value": ["Joshipur"]},
        ]))

        assert [row["id"] for row in rows] == [1, 4]

    def test_a_value_never_reaches_the_query_as_text(self, table):
        query, params = build_select_query(TABLE, listing([
            {"field": "district", "operator": "IN",
             "value": ["Dudhuwa", "Janaki"]},
        ]))

        with get_connection() as conn:
            rendered = query.as_string(conn)

        assert "Dudhuwa" not in rendered
        assert "IN (%s, %s)" in rendered
        assert params == ["Dudhuwa", "Janaki"]

    def test_a_value_that_looks_like_sql_is_only_ever_a_value(self, table):
        rows = execute_dashboard_query(TABLE, listing([
            {"field": "district", "operator": "IN",
             "value": ["Dudhuwa'; DROP TABLE " + TABLE + "; --"]},
        ]))

        assert rows == []

        # And the table it named is still there.
        assert distinct_field_values(TABLE, "district") == [
            "Dudhuwa", "Janaki", "Rampur",
        ]

    def test_an_empty_selection_is_refused_rather_than_matching_nothing(self, table):
        with pytest.raises(ValueError, match="at least one value"):
            execute_dashboard_query(TABLE, listing([
                {"field": "district", "operator": "IN", "value": []},
            ]))

    def test_a_filter_saved_the_old_way_still_works(self, table):
        """EQUALS, which is what the filter bar used to send."""
        rows = execute_dashboard_query(TABLE, listing([
            {"field": "district", "operator": "EQUALS", "value": "Janaki"},
        ]))

        assert [row["id"] for row in rows] == [3]


# ── a table's pager counts the filtered rows ────────────────────────

@needs_db
class TestPaging:
    def test_the_total_is_of_the_filtered_result(self, table):
        assert count_dashboard_rows(TABLE, listing([])) == 5

        narrowed = count_dashboard_rows(TABLE, listing([
            {"field": "district", "operator": "IN",
             "value": ["Dudhuwa", "Janaki"]},
        ]))

        assert narrowed == 3

    def test_and_paging_still_happens_in_the_database(self, table):
        page = execute_dashboard_query(
            TABLE,
            listing([{"field": "district", "operator": "IN",
                      "value": ["Dudhuwa", "Janaki", "Rampur"]}]),
            page=1,
            page_size=2,
        )

        assert len(page) == 2


# ── the endpoint ────────────────────────────────────────────────────

@needs_db
class TestTheEndpoint:
    """The route itself.

    Called as a function rather than over HTTP: this repository has no
    authenticated-client fixture — `admin_client`, which `test_table_paging`
    also asks for, is not defined anywhere in `tests/`. What is worth holding
    here is the checking the route does, which is the same either way.
    """

    def options(self, field, table=TABLE):
        return get_filter_options(table, field, user={"username": "tester"})

    def test_it_answers_with_the_field_and_its_values(self, table):
        assert self.options("district") == {
            "field": "district",
            "values": ["Dudhuwa", "Janaki", "Rampur"],
        }

    def test_a_column_with_no_values_answers_with_an_empty_list(self, table):
        assert self.options("nothing")["values"] == []

    def test_a_field_that_is_not_a_column_is_refused(self, table):
        with pytest.raises(HTTPException) as refused:
            self.options("district; DROP TABLE x")

        assert refused.value.status_code == 422
        assert "Unknown filter field" in refused.value.detail

    def test_a_table_that_is_not_a_dashboard_source_is_refused(self):
        with pytest.raises(HTTPException) as refused:
            self.options("district", table="app_user")

        assert refused.value.status_code == 400

    def test_a_source_that_does_not_exist_is_a_404(self):
        with pytest.raises(HTTPException) as refused:
            self.options("district", table="zz_nope_tabular")

        assert refused.value.status_code == 404

    def test_and_it_is_behind_a_permission_like_every_other_route(self):
        import inspect

        from fastapi import params

        guard = inspect.signature(get_filter_options).parameters["user"].default

        # Declared on the route, so a caller without one never reaches the
        # function called above.
        assert isinstance(guard, params.Depends)
