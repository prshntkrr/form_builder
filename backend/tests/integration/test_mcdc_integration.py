"""Our half of the MCDC integration, over a real socket.

**There is no real MCDC service.** `mock_mcdc.py` next door is a stand-in that
speaks the contract we propose, started on a free port for the length of this
session. What these tests prove is what the Form Builder *sends* and how it
behaves when the far end answers well or badly — a real request, real headers,
a real body, a real timeout. They prove nothing about MCDC itself, whose
contract has not been published; see EXPORT_API.md.

The last test is the whole architecture in one:

    build → publish → export → mock MCDC accepts
                            ↓
    phone lists its forms → fetches the published config → submits
                            ↓
                     the row in Postgres
"""
import socket
import threading
import time
import uuid

import httpx
import pytest
from psycopg2 import sql

from app.core import auth_service
from app.core.config import settings
from app.core.database import ping, transaction
from app.modules.forms import connectors, form_service
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.tabular_service import tabular_name
from app.modules.projects import project_service

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"

FIELDS = [
    {"name": "consent", "label": "Consent", "type": "select",
     "options": ["yes", "no"], "required": True},
    {"name": "farmer_name", "label": "Farmer name", "type": "text",
     "required": True, "section": "farmer_details"},
    {"name": "main_crop", "label": "Main crop", "type": "select",
     "options_from": {"source": "client_catalog", "catalog": "crops_list"}},
    {"name": "variety", "label": "Variety", "type": "select",
     "options_from": {"source": "crop_ontology", "kind": "trait",
                      "depends_on": "main_crop"}},
    {"name": "farmer_photo", "label": "Farmer photo", "type": "image"},
]
SECTIONS = [{"key": "farmer_details", "title": "Farmer details"}]
RULES = [{"conditions": [{"field": "consent", "operator": "equals", "value": "yes"}],
          "logic": "AND", "action": "show",
          "target": {"type": "section", "key": "farmer_details"}}]
MEXICO = [[-99.20, 19.40], [-99.10, 19.40], [-99.10, 19.50], [-99.20, 19.50]]
INSIDE = {"latitude": 19.4326, "longitude": -99.1332, "accuracy": 12.4}


# --------------------------------------------------------------------------- #
# the stand-in, on a real port
# --------------------------------------------------------------------------- #
def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def mcdc_url():
    """The mock, running in this process on its own port for the session."""
    import uvicorn

    from tests.integration.mock_mcdc import app

    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                           log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    base = f"http://127.0.0.1:{port}"
    for _ in range(100):                       # up in well under a second
        try:
            httpx.get(f"{base}/__control__/received", timeout=0.5)
            break
        except Exception:
            time.sleep(0.05)
    else:
        pytest.fail("the mock MCDC did not start")

    yield base

    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture
def mcdc(mcdc_url, monkeypatch):
    """Point this installation at the mock, and steer what it answers."""
    monkeypatch.setattr(settings, "mcdc_base_url", mcdc_url)
    monkeypatch.setattr(settings, "mcdc_api_key", "test-mcdc-key")
    monkeypatch.setattr(settings, "mcdc_timeout", 2)
    httpx.post(f"{mcdc_url}/__control__/reset", timeout=5)

    class Mock:
        url = mcdc_url

        @staticmethod
        def answers(status=200, body=None, delay=0.0):
            httpx.post(f"{mcdc_url}/__control__/reply", timeout=5,
                       json={"status": status,
                             "body": body if body is not None else {"id": "MCDC-1"},
                             "delay": delay})

        @staticmethod
        def received():
            return httpx.get(f"{mcdc_url}/__control__/received",
                             timeout=10).json()["requests"]

    return Mock


# --------------------------------------------------------------------------- #
# the usual scaffolding
# --------------------------------------------------------------------------- #
@pytest.fixture
def forms():
    made = []
    yield made
    with transaction() as cur:
        for form_id, table in made:
            for name in ("form_media", "form_export", "channel_form_route",
                         "submission_channel", "form_survey_progress"):
                cur.execute(f"DELETE FROM {name} WHERE form_id = %s", (form_id,))
            for name in (tabular_name(table), table):
                cur.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(
                    sql.Identifier(name)))
            cur.execute(sql.SQL("DROP SEQUENCE IF EXISTS {}").format(
                sql.Identifier(f"{table[:43]}_survey_seq")))
            cur.execute("DELETE FROM form_version WHERE form_id = %s", (form_id,))
            cur.execute("DELETE FROM forms WHERE form_id = %s", (form_id,))


@pytest.fixture
def projects():
    made = []
    yield made
    with transaction() as cur:
        for project_id in made:
            cur.execute("DELETE FROM project WHERE project_id = %s", (project_id,))


@pytest.fixture
def people():
    made = []

    def make(label, role="standard"):
        email = f"{label}.{uuid.uuid4().hex[:8]}@example.test"
        user = auth_service.create_user(email, PASSWORD, role=role, full_name=label)
        made.append(user["user_id"])
        return {**user, "email": email, "password": PASSWORD}

    yield make

    with transaction() as cur:
        for user_id in made:
            cur.execute("DELETE FROM project_member WHERE user_id = %s", (user_id,))
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))


def phone(person):
    """A client holding only what a phone would: a token from login."""
    from fastapi.testclient import TestClient

    from app.main import app

    answer = TestClient(app).post("/api/auth/login",
                                  json={"email": person["email"],
                                        "password": person["password"]})
    assert answer.status_code == 200, answer.text
    return TestClient(app, headers={"Authorization": f"Bearer {answer.json()['token']}"})


def _role_id(name):
    with transaction() as cur:
        cur.execute("SELECT role_id FROM app_role WHERE name = %s", (name,))
        return cur.fetchone()["role_id"]


def _form(forms, status="Active", project=None, **config):
    body = {"title": f"Integration {uuid.uuid4().hex[:6]}",
            "table_name": f"it_{uuid.uuid4().hex[:8]}",
            "fields": FIELDS, "sections": SECTIONS, "rules": RULES,
            "location": {"enabled": True}, **config}
    created = form_service.create_form(normalize_form(body), created_by="tests",
                                       status=status)
    forms.append((created["form_id"], created["table"]["table_name"]))
    if project:
        project_service.set_form_project(created["form_id"], project)
    return created["form_id"]


def _rows(form_id):
    table = form_service.get_form(form_id)["form_json"]["table_name"]
    with transaction() as cur:
        cur.execute(sql.SQL("SELECT * FROM {} ORDER BY survey_id").format(
            sql.Identifier(table)))
        return [dict(r) for r in cur.fetchall()]


def export(client, form_id, connector="mcdc"):
    return client.post(f"/api/forms/{form_id}/exports", json={"connector": connector})


# --------------------------------------------------------------------------- #
# what we send
# --------------------------------------------------------------------------- #
def test_the_whole_published_configuration_arrives(forms, editor_client, mcdc):
    mcdc.answers(200, {"id": "MCDC-77"})
    form_id = _form(forms, geofence={"enabled": True, "polygon": MEXICO})

    answer = export(editor_client, form_id)
    assert answer.status_code == 201

    sent = mcdc.received()
    assert len(sent) == 1
    body = sent[0]["body"]

    assert body["form_id"] == form_id
    assert body["version"] == 1
    assert body["status"] == "published"

    config = body["config"]
    # Order is the fields array itself.
    assert [f["name"] for f in config["fields"]] == [
        "consent", "farmer_name", "main_crop", "variety", "farmer_photo"]
    assert config["sections"][0]["key"] == "farmer_details"
    assert config["rules"][0]["target"] == {"type": "section", "key": "farmer_details"}
    assert config["rules"][0]["conditions"][0] == {
        "field": "consent", "operator": "equals", "value": "yes"}

    # References, not copies of the values behind them.
    crop = next(f for f in config["fields"] if f["name"] == "main_crop")
    assert crop["options_from"] == {"source": "client_catalog", "catalog": "crops_list"}
    assert crop["options"] == []
    variety = next(f for f in config["fields"] if f["name"] == "variety")
    assert variety["options_from"]["source"] == "crop_ontology"
    assert variety["options_from"]["depends_on"] == "main_crop"

    assert next(f for f in config["fields"]
                if f["name"] == "farmer_photo")["type"] == "image"
    assert config["location"] == {"enabled": True, "required": False}
    assert config["geofence"]["polygon"] == MEXICO
    assert next(f for f in config["fields"]
                if f["name"] == "farmer_name")["required"] is True


def test_no_answer_anybody_gave_is_ever_sent(forms, editor_client, mcdc):
    """The connector carries what to collect. Never what was collected."""
    mcdc.answers()
    form_id = _form(forms)

    stored = editor_client.post(f"/api/forms/{form_id}/submissions", json={
        "data": {"consent": "yes", "farmer_name": "Ramesh"}})
    assert stored.status_code == 201

    export(editor_client, form_id)
    body = str(mcdc.received()[0]["body"])

    assert "Ramesh" not in body
    assert stored.json()["survey_id"] not in body
    for word in ("survey_id", "form_data", "submission", "created_by\": \"Shrishti"):
        assert word not in body


def test_the_request_carries_its_credentials_and_its_identity(forms, editor_client,
                                                              mcdc):
    mcdc.answers()
    form_id = _form(forms)

    export(editor_client, form_id)
    sent = mcdc.received()[0]

    assert sent["headers"]["authorization"] == "Bearer test-mcdc-key"
    assert sent["headers"]["content-type"] == "application/json"
    # This delivery's identity, on the wire: form, version, connector.
    assert sent["headers"]["idempotency-key"] == f"{form_id}:1:mcdc"
    # The key is a header and nothing else.
    assert "test-mcdc-key" not in str(sent["body"])


def test_a_second_version_is_a_second_key(forms, editor_client, mcdc):
    mcdc.answers()
    form_id = _form(forms)
    export(editor_client, form_id)

    definition = form_service.get_form(form_id)["form_json"]
    form_service.update_form(form_id, normalize_form({**definition, "title": "V2"}),
                             updated_by="tests")
    export(editor_client, form_id)

    keys = [r["headers"]["idempotency-key"] for r in mcdc.received()]
    assert keys == [f"{form_id}:1:mcdc", f"{form_id}:2:mcdc"]
    assert [r["body"]["version"] for r in mcdc.received()] == [1, 2]


# --------------------------------------------------------------------------- #
# how it answers
# --------------------------------------------------------------------------- #
def test_a_good_answer_is_recorded_as_exported(forms, editor_client, mcdc):
    mcdc.answers(200, {"id": "MCDC-500"})
    form_id = _form(forms)

    body = export(editor_client, form_id).json()

    assert body["status"] == "EXPORTED"
    assert body["external_id"] == "MCDC-500"
    assert body["response_metadata"] == {"http_status": 200}
    assert connectors.record_of(form_id, 1, "mcdc")["status"] == "EXPORTED"


@pytest.mark.parametrize("status, expected", [
    (400, "refused the configuration (400)"),
    (401, "refused the credentials"),
    (403, "refused the credentials"),
    (409, "refused the configuration (409)"),
])
def test_a_refusal_is_recorded_as_failed(forms, editor_client, mcdc, status, expected):
    mcdc.answers(status, {"error": "their words, not repeated back"})
    form_id = _form(forms)

    answer = export(editor_client, form_id)

    assert answer.status_code == 502
    assert expected in answer.json()["detail"]
    assert "their words" not in answer.text
    record = connectors.record_of(form_id, 1, "mcdc")
    assert record["status"] == "FAILED"
    assert expected in record["error_message"]


@pytest.mark.parametrize("status", [500, 503])
def test_trouble_at_their_end_is_recorded_as_failed(forms, editor_client, mcdc,
                                                    status):
    mcdc.answers(status)
    form_id = _form(forms)

    answer = export(editor_client, form_id)

    assert answer.status_code == 502
    assert "having trouble" in answer.json()["detail"]
    assert connectors.record_of(form_id, 1, "mcdc")["status"] == "FAILED"


def test_a_real_timeout_fails_and_the_retry_succeeds(forms, editor_client, mcdc):
    """A slow socket, not a patched function: the connector's own clock ends it."""
    mcdc.answers(200, delay=4)                 # the connector waits 2s
    form_id = _form(forms)

    answer = export(editor_client, form_id)
    assert answer.status_code == 502
    assert "did not answer within 2s" in answer.json()["detail"]

    failed = connectors.record_of(form_id, 1, "mcdc")
    assert failed["status"] == "FAILED"
    # The published form is untouched by a delivery that did not land.
    assert form_service.get_form(form_id)["form_status"] == "Active"
    assert editor_client.get(f"/api/forms/{form_id}/published").json()["version"] == 1

    mcdc.answers(200, {"id": "MCDC-AFTER-RETRY"})
    again = export(editor_client, form_id)

    assert again.status_code == 201
    assert again.json()["status"] == "EXPORTED"
    assert again.json()["external_id"] == "MCDC-AFTER-RETRY"
    # The same record, not a second one.
    assert again.json()["export_id"] == failed["export_id"]
    assert again.json()["error_message"] == ""
    assert len(connectors.history(form_id)) == 1


def test_a_delivered_version_is_never_sent_twice(forms, editor_client, mcdc):
    mcdc.answers(200, {"id": "MCDC-ONCE"})
    form_id = _form(forms)

    first = export(editor_client, form_id).json()
    second = export(editor_client, form_id).json()
    third = export(editor_client, form_id).json()

    assert first["already_exported"] is False
    assert second["already_exported"] is True and third["already_exported"] is True
    assert second["external_id"] == "MCDC-ONCE"
    # One request left this application, whatever the caller did.
    assert len(mcdc.received()) == 1


def test_a_draft_never_reaches_the_wire(forms, editor_client, mcdc):
    mcdc.answers()
    draft = _form(forms, status="Draft")

    answer = export(editor_client, draft)

    assert answer.status_code == 409
    assert mcdc.received() == []


def test_the_version_on_the_wire_is_the_one_that_is_live(forms, editor_client, mcdc):
    mcdc.answers()
    form_id = _form(forms)

    definition = form_service.get_form(form_id)["form_json"]
    for title in ("Second", "Third"):
        definition = form_service.update_form(
            form_id, normalize_form({**definition, "title": title}),
            updated_by="tests")["form_json"]

    export(editor_client, form_id)
    body = mcdc.received()[0]["body"]

    assert body["version"] == 3
    assert body["config"]["version"] == 3
    assert body["config"]["title"] == "Third"


def test_an_account_without_the_permission_sends_nothing(forms, people, mcdc):
    mcdc.answers()
    form_id = _form(forms)

    assert export(phone(people("Standard")), form_id).status_code == 403
    assert mcdc.received() == []


# --------------------------------------------------------------------------- #
# the whole thing
# --------------------------------------------------------------------------- #
def test_build_publish_export_then_collect_on_a_phone(forms, projects, people,
                                                      admin_client, mcdc):
    """One journey, end to end, through every part of the architecture.

        build → publish → export → the mock accepts
        phone: list → published config → submit → the row in Postgres

    The point being proved at the end: what the phone filled in is the
    configuration that was exported, and what it submitted went through the
    ordinary submission service into the form's own table. Configuration goes
    out one way; data comes back the other; they meet nowhere.
    """
    mcdc.answers(200, {"id": "MCDC-JOURNEY"})

    # --- build, in a project, with everything a form can carry ---------------
    project = project_service.create_project(
        f"Journey {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project,
                    geofence={"enabled": True, "polygon": MEXICO})
    project_service.assign_form(form_id, "everyone")

    # --- publish, and export -------------------------------------------------
    exported = export(admin_client, form_id)
    assert exported.status_code == 201
    assert exported.json()["status"] == "EXPORTED"
    assert exported.json()["external_id"] == "MCDC-JOURNEY"

    delivered = mcdc.received()[0]["body"]
    assert delivered["form_id"] == form_id and delivered["version"] == 1

    # --- a surveyor picks it up on a phone -----------------------------------
    surveyor = people("Shrishti")
    project_service.add_member(project, surveyor["user_id"], _role_id("surveyor"))
    client = phone(surveyor)

    offered = client.get("/api/mcdc/forms").json()
    assert [f["form_id"] for f in offered] == [form_id]
    assert offered[0]["version"] == delivered["version"]

    published = client.get(f"/api/forms/{form_id}/published").json()
    # The phone is filling in exactly what was exported — one configuration,
    # not two copies that could drift.
    assert published["config"] == delivered["config"]

    # --- fill it in, with a photo and a position -----------------------------
    from unittest.mock import patch

    from app.modules.forms import media_service

    survey_id = client.post(
        f"/api/forms/{form_id}/submissions/start").json()["survey_id"]

    with patch.object(media_service, "presign_upload",
                      lambda key, ctype: f"https://s3.test/PUT/{key}"):
        upload = client.post(
            f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
            json={"field_name": "farmer_photo", "filename": "farmer.jpg",
                  "content_type": "image/jpeg", "file_size": 2048}).json()
    client.post(f"/api/forms/{form_id}/submissions/{survey_id}/media/"
                f"{upload['media_id']}/complete", json={"file_size": 2048})

    submitted = client.post(f"/api/forms/{form_id}/submissions", json={
        "survey_id": survey_id,
        "form_version": published["version"],
        "channel": "mobile",
        "data": {"consent": "yes", "farmer_name": "Ramesh",
                 "farmer_photo": upload["media_id"]},
        "location": INSIDE})

    assert submitted.status_code == 201, submitted.text
    assert submitted.json()["survey_id"] == "000001"

    # --- and it is in the database, in the form's own table ------------------
    rows = _rows(form_id)
    assert len(rows) == 1
    assert rows[0]["survey_id"] == "000001"
    assert rows[0]["form_data"]["farmer_name"] == "Ramesh"
    assert rows[0]["form_data"]["farmer_photo"] == upload["media_id"]
    assert rows[0]["created_by"] == "Shrishti"
    assert rows[0]["location"]["latitude"] == 19.4326

    # The photo is in the media table and the bucket, not in the answers.
    assert media_service.get(upload["media_id"])["survey_id"] == "000001"
    assert upload["s3_key"].endswith(f"/{form_id}/000001/image/farmer.jpg")

    # --- and none of that ever went to MCDC ---------------------------------
    everything_sent = str(mcdc.received())
    assert len(mcdc.received()) == 1
    for word in ("Ramesh", "000001", upload["media_id"], "19.4326"):
        assert word not in everything_sent
