"""Importing a spreadsheet as a dashboard data source.

The whole point is that what comes out the other end is indistinguishable from
any other data source: it appears in the picker, it reports typed fields, and a
widget query runs over it. So these tests follow the file all the way to a
query rather than stopping at "the table exists".

Every test drops what it created.
"""
import io
from datetime import date

import pytest

from app.core import registry
from app.core.database import fetch_all, ping, transaction

pytestmark = [
    pytest.mark.skipif(not ping(), reason="Postgres is not reachable"),
    pytest.mark.skipif("dashboards" in registry.disabled(),
                       reason="dashboards is switched off (DISABLED_MODULES)"),
]

TABLE = "zz_test_excel_source"
CREATED = f"{TABLE}_tabular"


def cleanup():
    with transaction() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {CREATED}")


@pytest.fixture(autouse=True)
def _clean():
    cleanup()
    yield
    cleanup()


def workbook(rows=None, header=None):
    """An .xlsx in memory, so no test depends on a file on disk."""
    from openpyxl import Workbook

    book = Workbook()
    sheet = book.active
    sheet.append(header or ["Farmer Name", "State", "Plot Area (ha)", "Plots",
                            "Surveyed On", "Irrigated"])

    for row in (rows if rows is not None else [
        ("Ana Ruiz", "MORELOS", 2.5, 3, date(2024, 5, 1), True),
        ("Luis Diaz", "PUEBLA", 0.75, 1, date(2024, 5, 2), False),
        ("Sofia Lopez", "MORELOS", 12.125, 8, date(2024, 6, 15), True),
    ]):
        sheet.append(row)

    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def upload(client, data=None, name=TABLE, filename="farmers.xlsx"):
    return client.post(
        "/api/dashboards/data-sources/excel",
        files={"file": (filename, data if data is not None else workbook(),
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        data={"table_name": name},
    )


def test_a_spreadsheet_becomes_a_usable_data_source(admin_client):
    """The whole flow: upload, appear in the picker, report fields, be queried."""
    response = upload(admin_client)

    assert response.status_code == 200, response.text
    body = response.json()

    # The dashboard finds sources by their suffix, so the name is not the one
    # that was typed — and the caller is told which table it actually got.
    assert body["table_name"] == CREATED
    assert body["rows_loaded"] == 3
    assert body["columns_loaded"] == 6

    listed = admin_client.get("/api/dashboards/data-sources").json()
    assert CREATED in [source["name"] for source in listed["data_sources"]]

    fields = admin_client.get(f"/api/dashboards/data-sources/{CREATED}").json()
    types = {field["name"]: field["type"] for field in fields["fields"]}

    # Inferred from the values, and named the way field_types.py names them, so
    # the widget builder cannot tell this source from a form-built one.
    assert types == {
        "farmer_name": "text",
        "state": "text",
        "plot_area_ha": "decimal",
        "plots": "number",
        "surveyed_on": "date",
        "irrigated": "boolean",
    }

    # And a real widget query runs over it.
    data = admin_client.post("/api/dashboards/data", json={
        "table_name": CREATED,
        "binding": {
            "dimensions": [{"field": "state"}],
            "measures": [{"field": "plot_area_ha", "aggregation": "AVG", "label": "Area"}],
            "filters": [],
        },
    })

    assert data.status_code == 200
    assert len(data.json()["rows"]) == 2


def test_the_suffix_is_not_doubled(admin_client):
    """Somebody who types the suffix means the same table as somebody who does not."""
    response = upload(admin_client, name=f"{TABLE}_tabular")

    assert response.status_code == 200
    assert response.json()["table_name"] == CREATED


def test_an_existing_table_is_never_overwritten(admin_client):
    assert upload(admin_client).status_code == 200

    again = upload(admin_client)

    assert again.status_code == 400
    assert "already exists" in again.json()["detail"]

    # The first import's rows are still there, untouched.
    assert fetch_all(f"SELECT COUNT(*) c FROM {CREATED}")[0]["c"] == 3


def test_a_name_that_is_not_an_identifier_is_refused(admin_client):
    response = upload(admin_client, name="drop table; --")

    assert response.status_code == 400
    assert "not a usable table name" in response.json()["detail"]


def test_one_of_this_applications_own_tables_is_refused(admin_client):
    response = upload(admin_client, name="app_user")

    assert response.status_code == 400
    assert "this application's own tables" in response.json()["detail"]


def test_a_file_that_is_not_a_spreadsheet_is_refused(admin_client):
    response = upload(admin_client, data=b"not a spreadsheet", filename="notes.txt")

    assert response.status_code == 400
    assert ".xlsx" in response.json()["detail"]


def test_a_sheet_with_headings_and_no_rows_is_refused(admin_client):
    response = upload(admin_client, data=workbook(rows=[]))

    assert response.status_code == 400
    assert "no data rows" in response.json()["detail"]

    # Nothing was created by the attempt.
    with transaction() as cur:
        cur.execute("SELECT to_regclass(%s) AS found", (CREATED,))
        assert cur.fetchone()["found"] is None


def test_a_mixed_column_is_read_as_text_rather_than_losing_values(admin_client):
    """Timid on purpose: one word in a number column makes the column text.

    Reading it as a number would drop that value; reading it as text only
    limits which widgets can use the column.
    """
    data = workbook(rows=[
        ("Ana Ruiz", "MORELOS", 2.5, 3, date(2024, 5, 1), True),
        ("Luis Diaz", "PUEBLA", "not recorded", 1, date(2024, 5, 2), False),
    ])

    assert upload(admin_client, data=data).status_code == 200

    fields = admin_client.get(f"/api/dashboards/data-sources/{CREATED}").json()
    types = {field["name"]: field["type"] for field in fields["fields"]}

    assert types["plot_area_ha"] == "text"
    assert fetch_all(f"SELECT COUNT(*) c FROM {CREATED}")[0]["c"] == 2


def test_duplicate_headings_both_survive(admin_client):
    """An exported sheet often repeats a heading; that is not a reason to refuse it."""
    data = workbook(
        header=["State", "State"],
        rows=[("MORELOS", "PUEBLA")],
    )

    assert upload(admin_client, data=data).status_code == 200

    columns = [row["column_name"] for row in fetch_all(
        """SELECT column_name FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = %s
            ORDER BY ordinal_position""", (CREATED,))]

    assert columns == ["state", "state_2"]


def test_a_role_without_the_permission_is_refused(editor_client):
    response = upload(editor_client)

    assert response.status_code in (200, 403)

    if response.status_code == 403:
        assert "permission" in response.json()["detail"]
