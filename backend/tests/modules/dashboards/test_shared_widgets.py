"""What a public link hands back for each kind of widget.

The page behind a public link draws every widget through the renderer
registry, and a KPI card and a table were missing from it — so both read
"Unsupported chart type". Registering them exposed two things the shared
data endpoint had never had to answer: a percentage KPI needs its numerator
counted, and a table needs a page rather than all fifty thousand rows.

The request is unchanged: a widget id and nothing else. Which page, how big,
and whether there is a numerator are read from the published specification.

The fixture builds a throwaway table and drops it afterwards.
"""
import pytest

from fastapi import HTTPException

from app.core import registry
from app.core.database import ping, transaction
from app.modules.dashboards.routers.dashboards import shared_dashboard_data
from app.modules.dashboards.schemas import SharedDataRequest
from app.modules.dashboards.services.query_builder import (
    DEFAULT_TABLE_PAGE_SIZE,
)

TABLE = "zz_test_shared_tabular"
ROWS = 35

needs_db = pytest.mark.skipif(
    not ping() or "dashboards" in registry.disabled(),
    reason="Postgres is not reachable, or dashboards is switched off",
)


@pytest.fixture
def table():
    with transaction() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {TABLE}")
        cur.execute(f"CREATE TABLE {TABLE} (id BIGINT, state TEXT, kept TEXT)")
        cur.execute(
            f"""INSERT INTO {TABLE} (id, state, kept)
                SELECT g,
                       'STATE ' || g,
                       CASE WHEN g % 3 = 0 THEN 'YES' ELSE 'NO' END
                  FROM generate_series(1, {ROWS}) g"""
        )

    yield TABLE

    with transaction() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {TABLE}")


def widget(widget_id, widget_type, **over):
    body = {
        "id": widget_id,
        "type": widget_type,
        "title": widget_id,
        "data_source_id": "src",
        "layout": {"x": 0, "y": 0, "w": 4, "h": 4},
        "data_binding": {
            "dimensions": [{"field": "state"}],
            "measures": [{"field": "id", "aggregation": "COUNT"}],
            "filters": [],
        },
    }
    body.update(over)
    return body


COUNTING = {
    "dimensions": [],
    "measures": [{"field": "id", "aggregation": "COUNT"}],
    "filters": [],
}

SPEC = {
    "dashboard": {"name": "Shared"},
    "data_sources": [
        {"id": "src", "name": TABLE, "type": "postgresql_tabular"}
    ],
    "layout": {"type": "grid", "columns": 12, "row_height": 64},
    "widgets": [
        widget("bar1", "bar"),
        widget("kpi1", "kpi", data_binding=COUNTING),
        widget("kpi2", "kpi", data_binding=COUNTING, kpi={
            "format": "percentage",
            "numerator": {"field": "kept", "operator": "EQUALS", "value": "YES"},
        }),
        widget("tab1", "table"),
        widget("tab2", "table", presentation={"table_page_size": 25}),
    ],
}


def ask(widget_id, monkeypatch):
    """The endpoint, called as a function: it needs no session by design."""
    monkeypatch.setattr(
        "app.modules.dashboards.routers.dashboards.get_shared",
        lambda token: {"dashboard_json": SPEC, "title": "Shared"},
    )

    return shared_dashboard_data("TKN", SharedDataRequest(widget_id=widget_id))


@needs_db
class TestATable:
    def test_one_page_of_rows_rather_than_the_whole_table(self, table, monkeypatch):
        answer = ask("tab1", monkeypatch)

        assert len(answer["rows"]) == DEFAULT_TABLE_PAGE_SIZE
        assert answer["total_rows"] == ROWS

    def test_and_says_which_page_it_is(self, table, monkeypatch):
        answer = ask("tab1", monkeypatch)

        assert answer["page"] == 1
        assert answer["page_size"] == DEFAULT_TABLE_PAGE_SIZE
        assert answer["total_pages"] == 4      # 35 rows, ten at a time

    def test_the_size_is_the_one_the_table_was_arranged_with(self, table, monkeypatch):
        answer = ask("tab2", monkeypatch)

        assert answer["page_size"] == 25
        assert len(answer["rows"]) == 25
        assert answer["total_pages"] == 2

    def test_which_the_caller_cannot_choose(self):
        # The request is a widget id and nothing else, as it always was.
        with pytest.raises(Exception):
            SharedDataRequest(widget_id="tab1", page=2)

        with pytest.raises(Exception):
            SharedDataRequest(widget_id="tab1", page_size=500)


@needs_db
class TestAKpi:
    def test_an_ordinary_one_is_answered_as_it_always_was(self, table, monkeypatch):
        answer = ask("kpi1", monkeypatch)

        assert answer["rows"] == [{"id_count": ROWS}]
        assert "num_rows" not in answer

    def test_a_percentage_one_carries_its_numerator(self, table, monkeypatch):
        answer = ask("kpi2", monkeypatch)

        # Eleven of the thirty-five rows are kept.
        assert answer["rows"] == [{"id_count": ROWS}]
        assert answer["num_rows"] == [{"id_count": 11}]

    def test_the_numerator_comes_from_the_published_dashboard(self, table, monkeypatch):
        # Not from the request, which cannot carry a filter at all.
        with pytest.raises(Exception):
            SharedDataRequest(widget_id="kpi2", filters=[])


@needs_db
class TestEverythingElse:
    def test_a_chart_is_answered_exactly_as_before(self, table, monkeypatch):
        answer = ask("bar1", monkeypatch)

        assert set(answer) == {"rows"}
        assert len(answer["rows"]) == ROWS

    def test_a_widget_that_is_not_on_the_dashboard_is_still_refused(self, monkeypatch):
        with pytest.raises(HTTPException) as refused:
            ask("nope", monkeypatch)

        assert refused.value.status_code == 404

    def test_and_a_link_that_is_not_valid(self, monkeypatch):
        monkeypatch.setattr(
            "app.modules.dashboards.routers.dashboards.get_shared",
            lambda token: None,
        )

        with pytest.raises(HTTPException) as refused:
            shared_dashboard_data("TKN", SharedDataRequest(widget_id="bar1"))

        assert refused.value.status_code == 404
