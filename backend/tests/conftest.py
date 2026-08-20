"""Shared fixtures.

The validation stages are pure, so those tests need no database. Anything that
goes through the API needs a session, since every endpoint but `/api/health` is
behind authentication — hence the signed-in clients below.
"""
import sys
import uuid
from pathlib import Path
from typing import Any, Dict

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

TEST_PASSWORD = "correct horse battery"


def _signed_in(role: str):
    """A TestClient carrying a session for a throwaway account of `role`."""
    from fastapi.testclient import TestClient

    from app import auth_service
    from app.main import app

    email = f"fixture.{role}.{uuid.uuid4().hex[:8]}@example.test"
    user = auth_service.create_user(
        email, TEST_PASSWORD, role=role, full_name=f"Fixture {role}")
    token = auth_service.login(email, TEST_PASSWORD)["token"]

    client = TestClient(app, headers={"Authorization": f"Bearer {token}"})
    return client, user["user_id"]


def _drop_user(user_id: str) -> None:
    from app.database import transaction
    with transaction() as cur:
        cur.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))


@pytest.fixture(scope="module")
def editor_client():
    """Signed in as an editor — enough for anything in the builder."""
    from app.auth_service import ROLE_EDITOR
    from app.database import ping

    if not ping():
        pytest.skip("Postgres is not reachable")

    client, user_id = _signed_in(ROLE_EDITOR)
    yield client
    _drop_user(user_id)


@pytest.fixture(scope="module")
def admin_client():
    """Signed in as an admin — adds managing people."""
    from app.auth_service import ROLE_ADMIN
    from app.database import ping

    if not ping():
        pytest.skip("Postgres is not reachable")

    client, user_id = _signed_in(ROLE_ADMIN)
    yield client
    _drop_user(user_id)


@pytest.fixture
def valid_config() -> Dict[str, Any]:
    """A config that passes both stages. Tests mutate a copy of it."""
    return {
        "title": "Farmer Registration",
        "description": "Baseline details for new farmers",
        "table_name": "farmer_registration",
        "submit_label": "Submit",
        "success_message": "Thanks, that's recorded.",
        "sections": [
            {"key": "basics", "title": "Basic details", "description": ""},
            {"key": "land", "title": "Land", "description": ""},
        ],
        "fields": [
            {
                "name": "farmer_name",
                "label": "Farmer Name",
                "type": "text",
                "required": True,
                "section": "basics",
                "options": [],
                "validation": {"min_length": 2, "max_length": 80},
                "order": 1,
            },
            {
                "name": "land_area",
                "label": "Land (acres)",
                "type": "decimal",
                "required": False,
                "section": "land",
                "options": [],
                "validation": {"min": 0, "max": 500},
                "order": 2,
            },
            {
                "name": "irrigation",
                "label": "Irrigation",
                "type": "multiselect",
                "required": False,
                "section": "land",
                "default": ["canal"],
                "options": [
                    {"label": "Canal", "value": "canal"},
                    {"label": "Borewell", "value": "borewell"},
                ],
                "validation": {},
                "order": 3,
            },
        ],
    }
