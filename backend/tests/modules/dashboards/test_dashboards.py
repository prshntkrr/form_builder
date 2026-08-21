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
