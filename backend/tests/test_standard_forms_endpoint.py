"""The library through the API, including the whole add → reuse → save loop."""
import copy
import uuid

import pytest
from fastapi.testclient import TestClient
from psycopg2 import sql

from app.database import ping, transaction
from app.main import app
from app.tabular_service import tabular_name

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def cleanup(form_id: str, table: str) -> None:
    with transaction() as cur:
        cur.execute("DELETE FROM standard_form_library WHERE form_id = %s", (form_id,))
        for name in (tabular_name(table), table):
            cur.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(sql.Identifier(name)))
        cur.execute(sql.SQL("DROP SEQUENCE IF EXISTS {}").format(
            sql.Identifier(f"{table[:43]}_survey_seq")))
        cur.execute("DELETE FROM forms WHERE form_id = %s", (form_id,))


@pytest.fixture
def saved(client, valid_config):
    config = copy.deepcopy(valid_config)
    suffix = uuid.uuid4().hex[:8]
    config["title"] = f"Endpoint Test {suffix}"
    config["table_name"] = f"endpoint_test_{suffix}"

    created = client.post("/api/forms", json={"form_json": config}).json()
    yield created
    cleanup(created["form_id"], created["table"]["table_name"])


@pytest.fixture
def listed(client, saved):
    entry = client.post("/api/standard-forms", json={
        "form_id": saved["form_id"], "category": "Survey",
        "tags": ["endpoint"], "summary": "Added through the API.", "added_by": "tests",
    }).json()
    yield saved, entry
    client.delete(f"/api/standard-forms/{entry['standard_id']}")


# --- adding ---------------------------------------------------------------- #
def test_a_form_can_be_added(client, listed):
    saved, entry = listed
    assert entry["form_id"] == saved["form_id"]
    assert entry["field_count"] == 3

    body = client.get(f"/api/standard-forms/{entry['standard_id']}").json()
    assert body["category"] == "Survey"
    assert body["tags"] == ["endpoint"]
    assert body["added_by"] == "tests"
    assert body["form_json"]["fields"]


def test_it_appears_in_the_listing(client, listed):
    _, entry = listed
    catalogue = client.get("/api/standard-forms").json()
    assert entry["standard_id"] in [f["standard_id"] for f in catalogue["forms"]]
    assert "Survey" in catalogue["categories"]


def test_search_and_category_filter(client, listed):
    _, entry = listed
    found = client.get("/api/standard-forms?search=endpoint").json()["forms"]
    assert entry["standard_id"] in [f["standard_id"] for f in found]

    by_category = client.get("/api/standard-forms?category=Survey").json()["forms"]
    assert all(f["category"] == "Survey" for f in by_category)


def test_adding_the_same_form_twice_is_refused(client, listed):
    saved, _ = listed
    response = client.post("/api/standard-forms", json={
        "form_id": saved["form_id"], "standard_id": "another_name"})
    assert response.status_code == 409
    assert "already in the library" in response.json()["detail"]


def test_adding_an_unknown_form_is_404(client):
    assert client.post("/api/standard-forms", json={"form_id": "FRM99999"}).status_code == 404


def test_adding_an_unknown_version_is_400(client, saved):
    response = client.post("/api/standard-forms",
                           json={"form_id": saved["form_id"], "version_no": 99})
    assert response.status_code == 400


# --- withdrawing ----------------------------------------------------------- #
def test_withdrawing_removes_it(client, saved):
    entry = client.post("/api/standard-forms", json={"form_id": saved["form_id"]}).json()
    assert client.delete(f"/api/standard-forms/{entry['standard_id']}").status_code == 200
    assert client.get(f"/api/standard-forms/{entry['standard_id']}").status_code == 404
    assert client.get(f"/api/forms/{saved['form_id']}").status_code == 200, "the form survives"


def test_withdrawing_something_absent_is_404(client):
    assert client.delete("/api/standard-forms/not_there").status_code == 404


# --- reuse ----------------------------------------------------------------- #
def test_start_returns_an_editable_draft(client, listed):
    _, entry = listed
    draft = client.post(f"/api/standard-forms/{entry['standard_id']}/start", json={}).json()["form_json"]
    assert draft["standard_id"] == entry["standard_id"]
    assert client.post("/api/forms/validate", json={"form_json": draft}).status_code == 200


def test_start_can_rename(client, listed):
    _, entry = listed
    draft = client.post(f"/api/standard-forms/{entry['standard_id']}/start",
                        json={"title": "Renamed On The Way Out"}).json()["form_json"]
    assert draft["title"] == "Renamed On The Way Out"
    assert draft["table_name"] == "renamed_on_the_way_out"


def test_start_from_an_unknown_standard_is_404(client):
    assert client.post("/api/standard-forms/nope/start", json={}).status_code == 404


def test_borrow_merges_into_a_draft(client, listed):
    _, entry = listed
    mine = {"title": "Mine", "fields": [{"name": "own", "label": "Own", "type": "text"}]}

    merged = client.post(f"/api/standard-forms/{entry['standard_id']}/borrow",
                         json={"form_json": mine, "section": "basics"}).json()["form_json"]
    names = [f["name"] for f in merged["fields"]]
    assert names[0] == "own"
    assert "farmer_name" in names
    assert client.post("/api/forms/validate", json={"form_json": merged}).status_code == 200


def test_borrowing_twice_does_not_collide(client, listed):
    _, entry = listed
    mine = {"title": "Mine", "fields": [{"name": "own", "label": "Own", "type": "text"}]}

    once = client.post(f"/api/standard-forms/{entry['standard_id']}/borrow",
                       json={"form_json": mine, "section": "basics"}).json()["form_json"]
    twice = client.post(f"/api/standard-forms/{entry['standard_id']}/borrow",
                        json={"form_json": once, "section": "basics"}).json()["form_json"]

    names = [f["name"] for f in twice["fields"]]
    assert len(names) == len(set(names))
    assert "farmer_name" in names and "farmer_name_2" in names


def test_borrow_an_unknown_section_is_404(client, listed):
    _, entry = listed
    response = client.post(f"/api/standard-forms/{entry['standard_id']}/borrow",
                           json={"form_json": {"title": "M", "fields": [
                               {"name": "a", "label": "A", "type": "text"}]},
                                 "section": "nope"})
    assert response.status_code == 404


# --- the whole loop -------------------------------------------------------- #
def test_add_start_edit_and_save(client, listed):
    """A standard becomes a new form that is nothing like it any more."""
    _, entry = listed
    draft = client.post(f"/api/standard-forms/{entry['standard_id']}/start",
                        json={"title": f"Derived {uuid.uuid4().hex[:6]}"}).json()["form_json"]

    # Edit everything a person could edit.
    draft["description"] = "Reworded after loading"
    draft["fields"][0]["label"] = "Renamed Question"
    draft["fields"][0]["required"] = False
    draft["fields"] = draft["fields"][:1] + [{
        "name": "extra", "label": "Extra", "type": "boolean",
        "options": [], "validation": {}, "section": None, "order": 2}]

    created = client.post("/api/forms", json={"form_json": draft, "created_by": "tests"}).json()
    try:
        assert created["field_count"] == 2
        assert created["form_json"]["fields"][0]["label"] == "Renamed Question"
        assert created["form_json"]["standard_id"] == entry["standard_id"], "provenance kept"

        drift = client.get(f"/api/forms/{created['form_id']}/standard-diff").json()
        assert drift["available"] is True
        assert drift["summary"]["identical"] is False
        assert [f["name"] for f in drift["added"]] == ["extra"]
    finally:
        cleanup(created["form_id"], created["table"]["table_name"])


def test_a_form_from_a_withdrawn_standard_still_works(client, saved):
    entry = client.post("/api/standard-forms", json={"form_id": saved["form_id"]}).json()
    draft = client.post(f"/api/standard-forms/{entry['standard_id']}/start",
                        json={"title": f"Orphan {uuid.uuid4().hex[:6]}"}).json()["form_json"]
    created = client.post("/api/forms", json={"form_json": draft}).json()

    try:
        client.delete(f"/api/standard-forms/{entry['standard_id']}")
        assert client.get(f"/api/forms/{created['form_id']}").status_code == 200

        drift = client.get(f"/api/forms/{created['form_id']}/standard-diff").json()
        assert drift["available"] is False
        assert "no longer in the library" in drift["message"]
    finally:
        cleanup(created["form_id"], created["table"]["table_name"])
