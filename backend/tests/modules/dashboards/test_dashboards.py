"""Dashboards module tests.

The shared fixtures — `editor_client`, `admin_client`, `valid_config` — come
from tests/conftest.py. Use them rather than building your own; they create a
throwaway account and remove it afterwards.

Anything a test creates, it removes: rows, tables, sequences. A test that leaves
data behind fails for someone else, on their machine, later.
"""
import pytest

from app.core import registry
from app.core.database import ping

# A module's tests skip when the module is switched off, so DISABLED_MODULES in
# .env does not turn the suite red. Copy this pair into any module's tests.
pytestmark = [
    pytest.mark.skipif(not ping(), reason="Postgres is not reachable"),
    pytest.mark.skipif("dashboards" in registry.disabled(),
                       reason="dashboards is switched off (DISABLED_MODULES)"),
]


def test_the_module_is_mounted(admin_client):
    """The route exists and answers, before anything is built on it."""
    response = admin_client.get("/api/dashboards")
    assert response.status_code == 200
    assert response.json() == []


def test_its_permissions_are_in_the_catalogue():
    from app.core import permissions
    from app.modules.dashboards.permissions import DASHBOARDS_VIEW

    assert DASHBOARDS_VIEW in permissions.ALL
    assert DASHBOARDS_VIEW in permissions.BUILT_IN["admin"]["permissions"]


def test_a_role_without_the_permission_is_refused(editor_client):
    """Installing a module does not widen roles that already exist.

    Only the admin role is topped up at startup. An installation's editor role
    was seeded before this module existed, so somebody has to grant it in the
    Roles screen — which is the point: an admin's decision about a role is not
    overwritten by a deployment.
    """
    response = editor_client.get("/api/dashboards")
    assert response.status_code in (200, 403)
    if response.status_code == 403:
        assert "permission" in response.json()["detail"]


@pytest.fixture
def imported_table():
    """A table shaped like one the external database import leaves behind.

    Its name ends in `_tabular`, so the dashboard offers it as a data source,
    but no form ever defined it and none ever will.
    """
    from app.core.database import transaction

    name = "zz_test_imported_source_tabular"

    with transaction() as cur:
        cur.execute(
            f"""CREATE TABLE {name} (
                    id           BIGINT,
                    farmer_state VARCHAR(255),
                    sown_area_ha NUMERIC(18, 4),
                    surveyed_on  TIMESTAMP
                )"""
        )

    yield name

    with transaction() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {name}")


def test_an_imported_table_is_described_by_its_columns(admin_client, imported_table):
    """A source with no form behind it still lists fields.

    The import creates the table and nothing else — there is no form_json to
    read field types from. Describing it used to raise, which the builder showed
    as "Internal Server Error" on a table the import had just reported loaded.
    """
    response = admin_client.get(f"/api/dashboards/data-sources/{imported_table}")

    assert response.status_code == 200

    body = response.json()
    fields = {field["name"]: field for field in body["fields"]}

    assert set(fields) == {"id", "farmer_state", "sown_area_ha", "surveyed_on"}
    # The types are the ones field_types.py names, so a widget cannot tell this
    # source apart from one a form built.
    assert fields["id"]["type"] == "number"
    assert fields["farmer_state"]["type"] == "text"
    assert fields["sown_area_ha"]["type"] == "decimal"
    assert fields["surveyed_on"]["type"] == "datetime"
    assert body["form_id"] is None


def test_a_data_source_that_does_not_exist_is_a_404(admin_client):
    """Not the server failing — the caller naming a table that is not there."""
    response = admin_client.get(
        "/api/dashboards/data-sources/zz_no_such_table_tabular"
    )

    assert response.status_code == 404
