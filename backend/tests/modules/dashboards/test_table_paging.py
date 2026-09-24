"""Paging a table, and where the paging happens.

The point of these is that the database does the work: a table of tens of
thousands of rows must send ten of them, and the total the pager shows must be
the total of the *filtered* result rather than of the physical table.

The fixture builds a throwaway table with enough rows to page through, and
drops it afterwards.
"""
import pytest

from app.core import registry
from app.core.database import ping, transaction
from app.modules.dashboards.schemas import DashboardDataBinding
from app.modules.dashboards.services.query_builder import build_select_query
from app.modules.dashboards.services.query_service import (
    count_dashboard_rows,
    execute_dashboard_query,
)

pytestmark = [
    pytest.mark.skipif(not ping(), reason="Postgres is not reachable"),
    pytest.mark.skipif("dashboards" in registry.disabled(),
                       reason="dashboards is switched off (DISABLED_MODULES)"),
]

TABLE = "zz_test_paging_tabular"
ROWS = 250


@pytest.fixture(autouse=True)
def table():
    with transaction() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {TABLE}")
        cur.execute(f"CREATE TABLE {TABLE} (id BIGINT, state TEXT, area NUMERIC)")
        cur.execute(
            f"""INSERT INTO {TABLE} (id, state, area)
                SELECT g, CASE WHEN g % 2 = 0 THEN 'east' ELSE 'west' END, g * 1.5
                  FROM generate_series(1, {ROWS}) g"""
        )

    yield TABLE

    with transaction() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {TABLE}")


def listing(**extra):
    """A table listing raw columns, as the editor saves one."""
    return DashboardDataBinding(**{
        "dimensions": [],
        "measures": [
            {"field": "id", "aggregation": "NONE", "label": "ID"},
            {"field": "state", "aggregation": "NONE", "label": "State"},
        ],
        "filters": extra.get("filters", []),
    })


def test_a_page_is_read_by_the_database_not_the_browser():
    """The LIMIT is in the SQL. Without this the whole table crosses the wire."""
    from app.core.database import get_connection

    query, params = build_select_query(TABLE, listing(), page=1, page_size=10)

    with get_connection() as conn:
        rendered = query.as_string(conn)

    assert "LIMIT" in rendered
    assert "OFFSET" in rendered
    # Ordered, or the same row could appear on two pages.
    assert "ORDER BY" in rendered
    assert 10 in params


def test_only_the_asked_for_page_comes_back():
    assert len(execute_dashboard_query(TABLE, listing(), page=1, page_size=10)) == 10


def test_the_second_page_is_the_next_ten_rows():
    first = execute_dashboard_query(TABLE, listing(), page=1, page_size=10)
    second = execute_dashboard_query(TABLE, listing(), page=2, page_size=10)

    assert [row["id_none"] for row in first] == list(range(1, 11))
    assert [row["id_none"] for row in second] == list(range(11, 21))
    # No row is on both pages, which is what an unordered paged query risks.
    assert not set(r["id_none"] for r in first) & set(r["id_none"] for r in second)


def test_every_row_is_reachable_and_reached_once():
    seen = []
    for page in range(1, (ROWS // 25) + 1):
        seen += [row["id_none"] for row in
                 execute_dashboard_query(TABLE, listing(), page=page, page_size=25)]

    assert sorted(seen) == list(range(1, ROWS + 1))


def test_a_larger_page_size_is_honoured():
    assert len(execute_dashboard_query(TABLE, listing(), page=1, page_size=100)) == 100


def test_the_last_page_holds_the_remainder_and_beyond_it_is_empty():
    assert len(execute_dashboard_query(TABLE, listing(), page=25, page_size=10)) == 10
    assert execute_dashboard_query(TABLE, listing(), page=26, page_size=10) == []


def test_the_total_is_the_whole_result():
    assert count_dashboard_rows(TABLE, listing()) == ROWS


def test_a_filter_narrows_the_total_as_well_as_the_page():
    """The pager must count what the filter leaves, not the physical table."""
    filtered = listing(filters=[{"field": "state", "operator": "EQUALS", "value": "east"}])

    assert count_dashboard_rows(TABLE, filtered) == ROWS // 2

    page = execute_dashboard_query(TABLE, filtered, page=1, page_size=10)
    assert len(page) == 10
    assert {row["state_none"] for row in page} == {"east"}


def test_a_grouped_table_is_counted_by_its_groups():
    """Not by its rows: a table of two groups is one page, not 250."""
    grouped = DashboardDataBinding(**{
        "dimensions": [{"field": "state"}],
        "measures": [{"field": "id", "aggregation": "COUNT", "label": "Rows"}],
        "filters": [],
    })

    assert count_dashboard_rows(TABLE, grouped) == 2


def test_asking_for_no_page_reads_everything_as_before():
    """Every other widget type relies on this."""
    assert len(execute_dashboard_query(TABLE, listing())) == ROWS


def test_a_page_size_beyond_the_cap_is_held_to_it():
    rows = execute_dashboard_query(TABLE, listing(), page=1, page_size=10_000)

    assert len(rows) == 200  # MAX_PAGE_SIZE


# --------------------------------------------------------------------------- #
# the reply the browser actually reads
# --------------------------------------------------------------------------- #
def _request(client, **extra):
    return client.post("/api/dashboards/data", json={
        "table_name": TABLE,
        "binding": {
            "dimensions": [],
            "measures": [
                {"field": "id", "aggregation": "NONE", "label": "ID"},
                {"field": "state", "aggregation": "NONE", "label": "State"},
            ],
            "filters": extra.pop("filters", []),
        },
        **extra,
    })


def test_the_reply_carries_what_a_pager_needs(admin_client):
    response = _request(admin_client, page=1, page_size=10)

    assert response.status_code == 200
    body = response.json()

    assert len(body["rows"]) == 10
    assert body["page"] == 1
    assert body["page_size"] == 10
    assert body["total_rows"] == ROWS
    assert body["total_pages"] == ROWS // 10


def test_a_widget_that_does_not_page_gets_the_reply_it_always_got(admin_client):
    """Every other widget type reads this endpoint too."""
    response = _request(admin_client)

    assert response.status_code == 200
    body = response.json()

    assert len(body["rows"]) == ROWS
    # No pagination keys at all, rather than nulls to be interpreted.
    assert "page" not in body
    assert "total_rows" not in body


def test_the_total_in_the_reply_respects_a_filter(admin_client):
    response = _request(
        admin_client, page=1, page_size=10,
        filters=[{"field": "state", "operator": "EQUALS", "value": "east"}],
    )

    body = response.json()
    assert body["total_rows"] == ROWS // 2
    # 125 rows at ten to a page is thirteen pages: the last one holds five.
    assert body["total_pages"] == 13


def test_a_page_size_beyond_the_contract_is_refused(admin_client):
    response = _request(admin_client, page=1, page_size=5000)

    assert response.status_code == 422
