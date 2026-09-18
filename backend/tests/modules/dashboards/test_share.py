"""Public links to dashboards.

These are the only routes in the application that take no session, so what
matters here is less that they work than that they give away nothing else:
no draft, no author, no other dashboard, and above all no way to name a table.

Anything a test creates, it removes.
"""
import pytest

from app.core import registry
from app.core.database import ping

pytestmark = [
    pytest.mark.skipif(not ping(), reason="Postgres is not reachable"),
    pytest.mark.skipif("dashboards" in registry.disabled(),
                       reason="dashboards is switched off (DISABLED_MODULES)"),
]


SPEC = {
    "schema_version": 1,
    "dashboard": {"name": "Shared link test"},
    "data_sources": [
        {"id": "src", "type": "postgresql_tabular", "name": "absent_tabular"},
    ],
    "widgets": [],
}


@pytest.fixture(scope="module")
def anonymous():
    """A client with no session at all — what someone opening a link has."""
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


@pytest.fixture
def dashboard(admin_client):
    """A saved dashboard, removed afterwards."""
    created = admin_client.post("/api/dashboards", json=SPEC)
    assert created.status_code in (200, 201), created.text

    dashboard_id = created.json()["dashboard_id"]

    yield dashboard_id

    admin_client.delete(f"/api/dashboards/{dashboard_id}")


@pytest.fixture
def published(admin_client, dashboard):
    """That dashboard, with its version published."""
    current = admin_client.get(f"/api/dashboards/{dashboard}").json()
    version = current.get("latest_version") or 1

    admin_client.post(f"/api/dashboards/{dashboard}/versions/{version}/publish")

    return dashboard


def _share(admin_client, dashboard_id):
    response = admin_client.post(f"/api/dashboards/{dashboard_id}/share")
    assert response.status_code == 200, response.text
    return response.json()["share_token"]


# ── issuing one ─────────────────────────────────────────────────

def test_a_draft_cannot_be_shared(admin_client, dashboard):
    """Nothing published means nothing to show."""
    response = admin_client.post(f"/api/dashboards/{dashboard}/share")

    assert response.status_code == 409
    assert "publish" in response.json()["detail"].lower()


def test_sharing_twice_keeps_the_same_link(admin_client, published):
    """A second click must not break a link already sent to people."""
    first = _share(admin_client, published)
    second = _share(admin_client, published)

    assert first == second


def test_the_token_is_not_guessable(admin_client, published):
    token = _share(admin_client, published)

    assert len(token) >= 32
    assert published not in token


def test_sharing_something_that_is_not_there(admin_client):
    response = admin_client.post("/api/dashboards/nosuchdashboard/share")

    assert response.status_code == 404


# ── following one ───────────────────────────────────────────────

def test_a_link_opens_without_a_session(anonymous, admin_client, published):
    token = _share(admin_client, published)

    response = anonymous.get(f"/api/dashboards/shared/{token}")

    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Shared link test"
    assert body["dashboard_json"]["dashboard"]["name"] == "Shared link test"


def test_a_link_gives_away_nothing_else(anonymous, admin_client, published):
    """Not the author, not the drafts, not which dashboard this is."""
    token = _share(admin_client, published)

    body = anonymous.get(f"/api/dashboards/shared/{token}").json()

    assert "created_by" not in body
    assert "shared_by" not in body
    assert "dashboard_id" not in body
    assert "latest_version" not in body


def test_a_token_that_names_nothing_is_a_404(anonymous):
    response = anonymous.get("/api/dashboards/shared/not-a-real-token")

    assert response.status_code == 404


def test_withdrawing_the_link_breaks_it(anonymous, admin_client, published):
    token = _share(admin_client, published)
    assert anonymous.get(f"/api/dashboards/shared/{token}").status_code == 200

    removed = admin_client.delete(f"/api/dashboards/{published}/share")
    assert removed.status_code == 204

    assert anonymous.get(f"/api/dashboards/shared/{token}").status_code == 404


def test_the_rest_of_the_module_still_needs_a_session(anonymous):
    """One open door, not an open building."""
    assert anonymous.get("/api/dashboards").status_code in (401, 403)
    assert anonymous.get("/api/dashboards/data-sources").status_code in (401, 403)


# ── asking it for data ──────────────────────────────────────────

def test_a_public_caller_cannot_name_a_table(anonymous, admin_client, published):
    """The whole point of the widget-id-only request body.

    A binding names a table, its columns and its filters. Accepting one here
    would let anyone holding a link query anything in the database.
    """
    token = _share(admin_client, published)

    response = anonymous.post(
        f"/api/dashboards/shared/{token}/data",
        json={"widget_id": "w1", "table_name": "app_user_tabular"},
    )

    assert response.status_code == 422


def test_a_public_caller_cannot_send_a_binding(anonymous, admin_client, published):
    token = _share(admin_client, published)

    response = anonymous.post(
        f"/api/dashboards/shared/{token}/data",
        json={
            "widget_id": "w1",
            "binding": {
                "dimensions": [{"field": "email"}],
                "measures": [{"field": "email", "aggregation": "COUNT"}],
                "filters": [],
            },
        },
    )

    assert response.status_code == 422


def test_a_widget_not_on_the_dashboard_is_a_404(anonymous, admin_client, published):
    token = _share(admin_client, published)

    response = anonymous.post(
        f"/api/dashboards/shared/{token}/data",
        json={"widget_id": "not_a_widget"},
    )

    assert response.status_code == 404


def test_data_needs_a_valid_token_too(anonymous):
    response = anonymous.post(
        "/api/dashboards/shared/not-a-real-token/data",
        json={"widget_id": "w1"},
    )

    assert response.status_code == 404
