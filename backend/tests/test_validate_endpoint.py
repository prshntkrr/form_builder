"""The pipeline through the API. /api/forms/validate touches no database."""
import copy

import pytest
from fastapi.testclient import TestClient

from app.config_validation import BUSINESS_RULE, STRUCTURAL
from app.main import app


@pytest.fixture(scope="module")
def client():
    # Not `with TestClient(app)`: the lifespan opens a connection pool, and
    # these cases are pure validation.
    return TestClient(app)


def post(client, config):
    return client.post("/api/forms/validate", json={"form_json": config})


def test_valid_config_is_accepted(client, valid_config):
    response = post(client, valid_config)
    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is True
    assert body["form_json"]["title"] == "Farmer Registration"


def test_structural_failure_returns_422_with_the_stage(client, valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][0]["type"] = "hologram"

    response = post(client, config)
    assert response.status_code == 422

    detail = response.json()["detail"]
    assert detail["valid"] is False
    assert detail["errors"][0] == {
        "type": STRUCTURAL,
        "field": "fields.0.type",
        "message": detail["errors"][0]["message"],
    }
    assert "not a supported field type" in detail["errors"][0]["message"]


def test_business_failure_returns_422_with_the_stage(client, valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][1]["name"] = "farmer_name"

    response = post(client, config)
    assert response.status_code == 422

    detail = response.json()["detail"]
    assert detail["valid"] is False
    assert detail["errors"][0]["type"] == BUSINESS_RULE
    assert detail["errors"][0]["field"] == "fields.1.name"


def test_response_carries_every_issue(client, valid_config):
    config = copy.deepcopy(valid_config)
    config["title"] = "x" * 300
    config["fields"][0]["type"] = "hologram"

    errors = post(client, config).json()["detail"]["errors"]
    assert {e["field"] for e in errors} >= {"title", "fields.0.type"}


def test_field_types_endpoint_is_unchanged(client):
    """The registry the frontend reads still matches what validation accepts."""
    types = {t["name"] for t in client.get("/api/field-types").json()}
    assert {"text", "decimal", "multiselect", "location"} <= types
