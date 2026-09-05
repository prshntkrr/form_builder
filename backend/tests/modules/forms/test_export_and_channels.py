"""Published configurations going out, and answers coming back in.

Two halves of one integration, and they meet nowhere:

    configuration     form ─publish─> frozen version ─connector─> MCDC
    data              mobile/whatsapp/ivr ─adapter─> submission service

The architectural claim under test is that the second half has exactly one
pipeline. Three channels sending equivalent answers must produce equivalent
rows: same validation, same survey id sequence, same table, same everything but
the note saying how each arrived.
"""
import uuid
from unittest.mock import patch

import pytest
from psycopg2 import sql

from app.core import auth_service
from app.core.database import ping, transaction
from app.modules.forms import (
    connectors, form_service, ingestion, publishing, submission_service,
)
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.tabular_service import tabular_name
from app.modules.projects import project_service

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"

FIELDS = [
    {"name": "farmer_name", "label": "Farmer name", "type": "text", "required": True},
    {"name": "main_crop", "label": "Main crop", "type": "select",
     "options": ["MAIZE", "WHEAT", "RICE"]},
]


@pytest.fixture
def forms():
    made = []
    yield made
    with transaction() as cur:
        for form_id, table in made:
            cur.execute("DELETE FROM form_export WHERE form_id = %s", (form_id,))
            cur.execute("DELETE FROM submission_channel WHERE form_id = %s", (form_id,))
            cur.execute("DELETE FROM form_survey_progress WHERE form_id = %s", (form_id,))
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
        return {**user, "token": auth_service.login(email, PASSWORD)["token"]}

    yield make

    with transaction() as cur:
        for user_id in made:
            cur.execute("DELETE FROM project_member WHERE user_id = %s", (user_id,))
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))


def client_for(person):
    from fastapi.testclient import TestClient

    from app.main import app
    return TestClient(app, headers={"Authorization": f"Bearer {person['token']}"})


def _role_id(name):
    with transaction() as cur:
        cur.execute("SELECT role_id FROM app_role WHERE name = %s", (name,))
        return cur.fetchone()["role_id"]


def _form(forms, fields=None, project=None, status="Active", **config):
    created = form_service.create_form(normalize_form({
        "title": f"Channel {uuid.uuid4().hex[:6]}",
        "table_name": f"ch_{uuid.uuid4().hex[:8]}",
        "fields": fields or FIELDS,
        **config,
    }), created_by="tests", status=status)
    forms.append((created["form_id"], created["table"]["table_name"]))
    if project:
        project_service.set_form_project(created["form_id"], project)
    return created["form_id"]


def _rows(form_id):
    table = form_service.get_form(form_id)["form_json"]["table_name"]
    with transaction() as cur:
        cur.execute(sql.SQL(
            "SELECT survey_id, form_data, created_by FROM {} ORDER BY survey_id"
        ).format(sql.Identifier(table)))
        return [dict(r) for r in cur.fetchall()]


@pytest.fixture
def sent():
    """The echo connector, watched — what a connector was handed."""
    seen = []
    real = connectors.EchoConnector.export

    def watching(self, published):
        seen.append(published)
        return real(self, published)

    with patch.object(connectors.EchoConnector, "export", watching):
        yield seen


# --------------------------------------------------------------------------- #
# the published configuration
# --------------------------------------------------------------------------- #
def test_a_published_form_hands_out_its_configuration(forms, editor_client):
    form_id = _form(forms)

    answer = editor_client.get(f"/api/forms/{form_id}/published")

    assert answer.status_code == 200
    body = answer.json()
    assert body["form_id"] == form_id
    assert body["status"] == "published"
    assert body["version"] == 1
    assert [f["name"] for f in body["config"]["fields"]] == ["farmer_name", "main_crop"]


def test_a_draft_has_no_published_configuration(forms, editor_client):
    """The one thing this must never hand out."""
    form_id = _form(forms, status="Draft")

    answer = editor_client.get(f"/api/forms/{form_id}/published")

    assert answer.status_code == 409
    assert "draft" in answer.json()["detail"].lower()


def test_the_published_configuration_does_not_move_when_the_form_does(forms,
                                                                     editor_client):
    """Version 1 is exactly what it was after version 2 is published."""
    form_id = _form(forms)
    was = editor_client.get(f"/api/forms/{form_id}/published").json()

    definition = form_service.get_form(form_id)["form_json"]
    form_service.update_form(form_id, normalize_form({
        **definition,
        "fields": definition["fields"] + [
            {"name": "village", "label": "Village", "type": "text"}],
    }), updated_by="tests")

    now = editor_client.get(f"/api/forms/{form_id}/published").json()

    assert was["version"] == 1 and now["version"] == 2
    assert len(was["config"]["fields"]) == 2
    assert len(now["config"]["fields"]) == 3
    # And the frozen copy of version 1 still reads as it did.
    frozen = publishing.config_of(form_service.get_form(form_id), 1)
    assert [f["name"] for f in frozen["fields"]] == ["farmer_name", "main_crop"]


def test_the_configuration_keeps_the_form_as_it_was_written(forms, editor_client):
    """Rules, references and ordering survive the trip out intact."""
    form_id = _form(forms, fields=[
        {"name": "consent", "label": "Consent", "type": "select",
         "options": ["yes", "no"]},
        {"name": "farmer_name", "label": "Farmer name", "type": "text",
         "section": "farmer_details"},
        {"name": "main_crop", "label": "Main crop", "type": "select",
         "options_from": {"source": "client_catalog",
                          "catalog": "Municipios_mx_list"}},
    ], sections=[{"key": "farmer_details", "title": "Farmer details"}],
        rules=[{"conditions": [{"field": "consent", "operator": "equals",
                                "value": "yes"}],
                "logic": "AND", "action": "show",
                "target": {"type": "section", "key": "farmer_details"}}])

    config = editor_client.get(f"/api/forms/{form_id}/published").json()["config"]

    # Ordering is the fields array, not a sort key.
    assert [f["name"] for f in config["fields"]] == [
        "consent", "farmer_name", "main_crop"]
    # The rule is the rule, in the shape it was written.
    assert config["rules"][0]["action"] == "show"
    assert config["rules"][0]["target"] == {"type": "section", "key": "farmer_details"}
    assert config["sections"][0]["key"] == "farmer_details"
    # A catalogue reference stays a reference — not the values behind it.
    crop = next(f for f in config["fields"] if f["name"] == "main_crop")
    assert crop["options_from"] == {"source": "client_catalog",
                                    "catalog": "Municipios_mx_list"}
    # A reference, not a copy of what it points at.
    assert not crop.get("options")


def test_a_project_form_is_out_of_reach_of_an_outsider(forms, projects, people):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project)

    outsider = client_for(people("Nobody"))

    assert outsider.get(f"/api/forms/{form_id}/published").status_code == 404
    assert outsider.post(f"/api/forms/{form_id}/exports",
                         json={"connector": "echo"}).status_code == 404


def test_a_system_form_needs_the_account_permission(forms, people, editor_client):
    """Belonging to a project reaches no form outside every project."""
    form_id = _form(forms)                       # no project

    member = people("Member")
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    project_service.add_member(project, member["user_id"], _role_id("project_manager"))
    try:
        assert client_for(member).get(
            f"/api/forms/{form_id}/published").status_code == 403
        assert editor_client.get(f"/api/forms/{form_id}/published").status_code == 200
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM project WHERE project_id = %s", (project,))


# --------------------------------------------------------------------------- #
# sending it somewhere
# --------------------------------------------------------------------------- #
def test_a_published_form_can_be_exported(forms, sent, editor_client):
    form_id = _form(forms)

    answer = editor_client.post(f"/api/forms/{form_id}/exports",
                                json={"connector": "echo"})

    assert answer.status_code == 201
    body = answer.json()
    assert body["status"] == "EXPORTED"
    assert body["already_exported"] is False
    assert body["version"] == 1
    assert body["connector"] == "echo"
    # A record of the delivery, with what was sent digested.
    assert body["export_id"] and len(body["request_hash"]) == 64
    assert body["error_message"] == ""


def test_a_draft_cannot_be_exported(forms, sent, editor_client):
    form_id = _form(forms, status="Draft")

    answer = editor_client.post(f"/api/forms/{form_id}/exports",
                                json={"connector": "echo"})

    assert answer.status_code == 409
    assert sent == []


def test_an_unknown_connector_is_refused(forms, editor_client):
    form_id = _form(forms)

    answer = editor_client.post(f"/api/forms/{form_id}/exports",
                                json={"connector": "carrier-pigeon"})

    assert answer.status_code == 400
    assert "carrier-pigeon" in answer.json()["detail"]


def test_exporting_takes_its_own_permission(forms, people):
    """Filling a form in is not permission to hand its definition out."""
    form_id = _form(forms)
    standard = client_for(people("Standard"))

    assert standard.post(f"/api/forms/{form_id}/exports",
                         json={"connector": "echo"}).status_code == 403


def test_the_version_that_is_live_is_the_version_that_is_sent(forms, sent,
                                                              editor_client):
    form_id = _form(forms)
    definition = form_service.get_form(form_id)["form_json"]
    form_service.update_form(form_id, normalize_form({
        **definition,
        "fields": definition["fields"] + [
            {"name": "village", "label": "Village", "type": "text"}],
    }), updated_by="tests")

    answer = editor_client.post(f"/api/forms/{form_id}/exports",
                                json={"connector": "echo"})

    assert answer.json()["version"] == 2
    assert len(sent) == 1
    assert sent[0]["version"] == 2
    assert [f["name"] for f in sent[0]["config"]["fields"]] == [
        "farmer_name", "main_crop", "village"]


def test_exporting_the_same_version_twice_sends_it_once(forms, sent, editor_client):
    form_id = _form(forms)

    first = editor_client.post(f"/api/forms/{form_id}/exports", json={"connector": "echo"})
    second = editor_client.post(f"/api/forms/{form_id}/exports", json={"connector": "echo"})

    assert first.json()["already_exported"] is False
    assert second.json()["already_exported"] is True
    assert second.json()["status"] == "EXPORTED"
    assert second.json()["version"] == first.json()["version"]
    # One record, not two: the second call found the first one's.
    assert second.json()["export_id"] == first.json()["export_id"]
    # Delivered once, whatever the caller did.
    assert len(sent) == 1


def test_publishing_an_edit_is_a_new_delivery(forms, sent, editor_client):
    form_id = _form(forms)
    editor_client.post(f"/api/forms/{form_id}/exports", json={"connector": "echo"})

    definition = form_service.get_form(form_id)["form_json"]
    form_service.update_form(form_id, normalize_form({
        **definition, "title": "Renamed"}), updated_by="tests")

    again = editor_client.post(f"/api/forms/{form_id}/exports", json={"connector": "echo"})

    assert again.json()["already_exported"] is False
    assert [s["version"] for s in sent] == [1, 2]

    history = editor_client.get(f"/api/forms/{form_id}/exports").json()
    assert sorted(e["version"] for e in history["exports"]) == [1, 2]
    assert {e["status"] for e in history["exports"]} == {"EXPORTED"}


def test_a_platform_that_will_not_take_it_is_reported_not_raised(forms,
                                                                 editor_client):
    form_id = _form(forms)

    def refuse(self, published):
        raise connectors.ExportError("MCDC could not be reached: ConnectError.")

    with patch.object(connectors.EchoConnector, "export", refuse):
        answer = editor_client.post(f"/api/forms/{form_id}/exports",
                                    json={"connector": "echo"})

    assert answer.status_code == 502
    assert "could not be reached" in answer.json()["detail"]
    assert "Traceback" not in answer.text

    # Recorded as FAILED — somebody tried, and the row says what went wrong.
    # Silence would have looked exactly like nobody having tried at all.
    record = connectors.record_of(form_id, 1, "echo")
    assert record["status"] == "FAILED"
    assert "could not be reached" in record["error_message"]


def test_mcdc_without_an_address_says_so_rather_than_inventing_one(forms,
                                                                  editor_client):
    from app.core.config import settings

    with patch.object(settings, "mcdc_base_url", ""):
        answer = editor_client.post(f"/api/forms/{_form(forms)}/exports",
                                    json={"connector": "mcdc"})

    assert answer.status_code == 502
    assert "MCDC_BASE_URL" in answer.json()["detail"]


def test_no_secret_ever_leaves_with_the_configuration(forms, sent, editor_client):
    from app.core.config import settings

    form_id = _form(forms)
    with patch.object(settings, "mcdc_api_key", "mcdc-secret-key"), \
         patch.object(settings, "mcdc_base_url", "https://mcdc.invalid"):
        editor_client.post(f"/api/forms/{form_id}/exports", json={"connector": "echo"})

    body = str(sent[0])
    for secret in ("mcdc-secret-key", settings.aws_secret_access_key,
                   settings.db_password):
        if secret:
            assert secret not in body
    assert "api_key" not in body and "password" not in body

    # Nor in what the caller is told, nor in the history.
    shown = editor_client.get(f"/api/forms/{form_id}/exports").text
    assert "mcdc-secret-key" not in shown


def test_the_mcdc_connector_sends_the_configuration_and_a_header(forms):
    """The one hop that needs a real MCDC: what it would send, stubbed."""
    from app.core.config import settings

    form_id = _form(forms)
    published = publishing.published(form_service.get_form(form_id))
    calls = []

    class Answer:
        status_code = 200

        @staticmethod
        def json():
            return {"id": "MCDC-1"}

    def post(url, json=None, headers=None, timeout=None):
        calls.append((url, json, headers))
        return Answer()

    with patch.object(settings, "mcdc_base_url", "https://mcdc.invalid/api"), \
         patch.object(settings, "mcdc_api_key", "k"), \
         patch("httpx.post", post):
        result = connectors.MCDCConnector().export(published)

    url, body, headers = calls[0]
    assert url == "https://mcdc.invalid/api/forms"
    assert body["form_id"] == form_id and body["version"] == 1
    assert headers["Authorization"] == "Bearer k"
    # The key travels as a header, never inside the configuration.
    assert "k" not in str(body.get("config"))
    assert result["remote_id"] == "MCDC-1"


# --------------------------------------------------------------------------- #
# answers, from wherever they were collected
# --------------------------------------------------------------------------- #
def _ingest(client, form_id, channel, payload, **extra):
    return client.post(f"/api/forms/{form_id}/submissions/ingest",
                       json={"channel": channel, "payload": payload, **extra})


def test_every_channel_ends_up_with_the_same_record(forms, editor_client):
    """The architectural claim, tested directly.

    One logical submission — Ramesh, maize — sent on three channels in three
    shapes. What is stored must differ only in the note saying how it arrived.
    """
    form_id = _form(forms)

    mobile = _ingest(editor_client, form_id, "mobile",
                     {"farmer_name": "Ramesh", "main_crop": "MAIZE"})
    whatsapp = _ingest(editor_client, form_id, "whatsapp",
                       {"messages": ["Ramesh", "1"]})
    ivr = _ingest(editor_client, form_id, "ivr",
                  {"digits": {"farmer_name": "Ramesh", "main_crop": "1"}})

    assert [a.status_code for a in (mobile, whatsapp, ivr)] == [201, 201, 201]

    rows = _rows(form_id)
    assert len(rows) == 3
    # Identical answers. "1" on a keypad and "1" in a chat both mean the first
    # choice, and the choices come from the form.
    assert all(r["form_data"] == {"farmer_name": "Ramesh", "main_crop": "MAIZE"}
               for r in rows)

    # One sequence, shared: no channel has its own numbering.
    assert [r["survey_id"] for r in rows] == ["000001", "000002", "000003"]

    # And the only thing that differs is the note.
    assert [ingestion.channel_of(form_id, r["survey_id"]) for r in rows] == [
        "mobile", "whatsapp", "ivr"]


def test_the_channel_is_remembered_without_becoming_an_answer(forms, editor_client):
    form_id = _form(forms)

    answer = _ingest(editor_client, form_id, "whatsapp", {"messages": ["Ramesh"]})

    assert answer.json()["channel"] == "whatsapp"
    assert ingestion.channel_of(form_id, answer.json()["survey_id"]) == "whatsapp"
    # Metadata about collection, not an answer to a question.
    assert "channel" not in _rows(form_id)[0]["form_data"]


def test_the_ordinary_form_page_is_the_same_pipeline(forms, editor_client):
    form_id = _form(forms)

    editor_client.post(f"/api/forms/{form_id}/submissions",
                       json={"data": {"farmer_name": "Ramesh", "main_crop": "MAIZE"}})
    _ingest(editor_client, form_id, "mobile",
            {"farmer_name": "Ramesh", "main_crop": "MAIZE"})

    rows = _rows(form_id)
    assert rows[0]["form_data"] == rows[1]["form_data"]
    assert [r["survey_id"] for r in rows] == ["000001", "000002"]
    assert ingestion.channel_of(form_id, "000001") == "web"


def test_required_fields_are_the_submission_service_s_business(forms, editor_client):
    """Not the adapter's. Every channel is refused the same way."""
    for channel, payload in (("mobile", {"main_crop": "MAIZE"}),
                             ("whatsapp", {"answers": {"main_crop": "MAIZE"}}),
                             ("ivr", {"digits": {"main_crop": "1"}})):
        form_id = _form(forms)
        answer = _ingest(editor_client, form_id, channel, payload)

        assert answer.status_code == 422, channel
        assert "farmer_name" in str(answer.json()["detail"]["errors"]), channel
        assert _rows(form_id) == []


def test_a_value_no_field_offers_is_refused_whatever_it_arrived_on(forms,
                                                                   editor_client):
    for channel, payload in (
            ("mobile", {"farmer_name": "R", "main_crop": "SORGHUM"}),
            ("whatsapp", {"messages": ["R", "SORGHUM"]}),
            ("ivr", {"digits": {"farmer_name": "R", "main_crop": "9"}})):
        form_id = _form(forms)
        answer = _ingest(editor_client, form_id, channel, payload)

        assert answer.status_code == 422, channel
        assert "main_crop" in str(answer.json()["detail"]["errors"]), channel


def test_conditional_rules_are_shared(forms, editor_client):
    """A question a condition never reached is not answerable on any channel."""
    form_id = _form(forms, fields=[
        {"name": "consent", "label": "Consent", "type": "select",
         "options": ["yes", "no"]},
        {"name": "farmer_name", "label": "Farmer name", "type": "text"},
    ], rules=[{"conditions": [{"field": "consent", "operator": "equals",
                               "value": "yes"}],
               "logic": "AND", "action": "show",
               "target": {"type": "field", "name": "farmer_name"}}])

    refused = _ingest(editor_client, form_id, "mobile",
                      {"consent": "no", "farmer_name": "Ramesh"})
    allowed = _ingest(editor_client, form_id, "whatsapp",
                      {"messages": ["yes", "Ramesh"]})

    assert refused.status_code == 422
    assert allowed.status_code == 201
    assert _rows(form_id)[0]["form_data"]["farmer_name"] == "Ramesh"


def test_answers_collected_against_an_old_version_are_refused(forms, editor_client):
    """Not reinterpreted with today's definition."""
    form_id = _form(forms)
    definition = form_service.get_form(form_id)["form_json"]
    form_service.update_form(form_id, normalize_form({
        **definition, "title": "Renamed"}), updated_by="tests")

    stale = _ingest(editor_client, form_id, "mobile",
                    {"farmer_name": "Ramesh"}, form_version=1)
    current = _ingest(editor_client, form_id, "mobile",
                      {"farmer_name": "Ramesh"}, form_version=2)

    assert stale.status_code == 422
    assert "_form_version" in stale.json()["detail"]["errors"]
    assert current.status_code == 201


def test_a_channel_nobody_has_written_an_adapter_for_is_refused(forms,
                                                               editor_client):
    """Twice over: at the boundary, and in the module that would adapt it.

    The gateway refuses a channel it does not recognise before a handler sees
    it — a name that is not one of the four cannot be a submission. The deeper
    check stays where it was, for anything calling the service directly.
    """
    form_id = _form(forms)

    answer = _ingest(editor_client, form_id, "carrier-pigeon", {"a": 1})

    assert answer.status_code == 400
    assert answer.json()["error"]["code"] == "INVALID_REQUEST"
    assert "carrier-pigeon" in answer.json()["error"]["message"]
    assert _rows(form_id) == []

    with pytest.raises(ingestion.ChannelError):
        ingestion.normalize("carrier-pigeon", {}, {"a": 1})


def test_a_payload_the_channel_cannot_have_sent_is_refused(forms, editor_client):
    form_id = _form(forms)

    assert _ingest(editor_client, form_id, "whatsapp",
                   {"messages": ["a", "b", "c", "d"]}).status_code == 422
    assert _ingest(editor_client, form_id, "ivr", {}).status_code == 422
    assert _ingest(editor_client, form_id, "mobile", ["not", "an", "object"]
                   ).status_code == 422
    assert _rows(form_id) == []


def test_ingestion_is_behind_the_same_project_isolation(forms, projects, people):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project)

    outsider = client_for(people("Nobody"))
    assert _ingest(outsider, form_id, "mobile",
                   {"farmer_name": "R"}).status_code == 404

    # And a surveyor the form is assigned to may send on any channel.
    project_service.assign_form(form_id, "everyone")
    surveyor = people("Shrishti")
    project_service.add_member(project, surveyor["user_id"], _role_id("surveyor"))
    assert _ingest(client_for(surveyor), form_id, "ivr",
                   {"digits": {"farmer_name": "R"}}).status_code == 201


def test_a_form_that_is_not_live_takes_nothing_from_any_channel(forms,
                                                                editor_client):
    form_id = _form(forms, status="Draft")

    for channel, payload in (("mobile", {"farmer_name": "R"}),
                             ("whatsapp", {"messages": ["R"]}),
                             ("ivr", {"digits": ["R"]})):
        assert _ingest(editor_client, form_id, channel, payload).status_code == 422


def test_location_arrives_where_a_channel_has_one(forms, editor_client):
    """Mobile has GPS; a phone call does not. The form decides what is needed."""
    optional = _form(forms, location={"enabled": True})

    with_gps = _ingest(editor_client, optional, "mobile", {"farmer_name": "R"},
                       location={"latitude": 19.4326, "longitude": -99.1332,
                                 "accuracy": 12.4})
    without = _ingest(editor_client, optional, "ivr", {"digits": ["R"]})

    assert with_gps.status_code == 201
    assert with_gps.json()["location"]["latitude"] == 19.4326
    # An optional position is optional on every channel.
    assert without.status_code == 201
    assert without.json()["location"] is None


def test_a_form_that_insists_on_a_position_insists_on_every_channel(forms,
                                                                    editor_client):
    form_id = _form(forms, location={"enabled": True, "required": True})

    answer = _ingest(editor_client, form_id, "ivr", {"digits": ["R"]})

    assert answer.status_code == 422
    assert "_location" in str(answer.json()["detail"]["errors"])


def test_a_position_outside_the_fence_is_refused_on_every_channel(forms,
                                                                  editor_client):
    form_id = _form(forms, location={"enabled": True}, geofence={
        "enabled": True,
        "polygon": [[-99.20, 19.40], [-99.10, 19.40], [-99.10, 19.50],
                    [-99.20, 19.50]]})

    answer = _ingest(editor_client, form_id, "mobile", {"farmer_name": "R"},
                     location={"latitude": 28.6139, "longitude": 77.2090})

    assert answer.status_code == 422
    assert "_location" in str(answer.json()["detail"]["errors"])


def test_media_uploaded_for_a_channel_submission_uses_the_same_service(forms,
                                                                       editor_client):
    """No channel-specific storage: the same start, the same S3 key, the same row."""
    from app.modules.forms import media_service

    form_id = _form(forms, fields=FIELDS + [
        {"name": "farmer_photo", "label": "Farmer photo", "type": "image"}])

    survey_id = editor_client.post(
        f"/api/forms/{form_id}/submissions/start").json()["survey_id"]

    with patch.object(media_service, "presign_upload",
                      lambda key, ctype: f"https://s3.test/PUT/{key}"):
        made = editor_client.post(
            f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
            json={"field_name": "farmer_photo", "filename": "p.jpg",
                  "content_type": "image/jpeg"}).json()
    editor_client.post(f"/api/forms/{form_id}/submissions/{survey_id}/media/"
                       f"{made['media_id']}/complete", json={})

    answer = _ingest(editor_client, form_id, "mobile",
                     {"farmer_name": "R", "farmer_photo": made["media_id"]},
                     survey_id=survey_id)

    assert answer.status_code == 201
    assert made["s3_key"].endswith(f"/{form_id}/000001/image/p.jpg")
    assert media_service.get(made["media_id"])["survey_id"] == "000001"


def test_an_adapter_only_changes_shape(forms):
    """Straight at the adapters: answers out, and no decisions taken."""
    form_json = form_service.get_form(_form(forms))["form_json"]
    wanted = {"farmer_name": "Ramesh", "main_crop": "MAIZE"}

    assert ingestion.normalize("mobile", form_json, wanted) == wanted
    assert ingestion.normalize("whatsapp", form_json,
                               {"messages": ["Ramesh", "1"]}) == wanted
    assert ingestion.normalize("ivr", form_json,
                               {"digits": ["Ramesh", "1"]}) == wanted
    # Said in full rather than chosen by number: passed through for the
    # submission service to judge, not resolved or rejected here.
    assert ingestion.normalize("whatsapp", form_json,
                               {"messages": ["Ramesh", "MAIZE"]}) == wanted
    # A missing required answer is not the adapter's to notice.
    assert ingestion.normalize("mobile", form_json, {}) == {}


# --------------------------------------------------------------------------- #
# how a delivery goes, and what is remembered about it
# --------------------------------------------------------------------------- #
class _Answer:
    """An HTTP answer, as httpx would give one."""

    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body if body is not None else {}

    def json(self):
        return self._body


@pytest.fixture
def mcdc(monkeypatch):
    """MCDC, configured but stubbed. What it answers is the test's business."""
    from app.core.config import settings

    monkeypatch.setattr(settings, "mcdc_base_url", "https://mcdc.invalid/api")
    monkeypatch.setattr(settings, "mcdc_api_key", "mcdc-secret-key")
    monkeypatch.setattr(settings, "mcdc_timeout", 7)

    def answering(reply):
        """Say what MCDC answers next. Returns what it is sent from now on."""
        sent = []

        def post(url, json=None, headers=None, timeout=None):
            sent.append({"url": url, "body": json, "headers": headers,
                         "timeout": timeout})
            if isinstance(reply, Exception):
                raise reply
            return reply

        monkeypatch.setattr("httpx.post", post)
        return sent

    return answering


def test_the_configuration_reaches_mcdc_intact(forms, editor_client, mcdc):
    """Everything the renderer needs, in the shape it was published in."""
    form_id = _form(forms, fields=[
        {"name": "consent", "label": "Consent", "type": "select",
         "options": ["yes", "no"]},
        {"name": "farmer_name", "label": "Farmer name", "type": "text",
         "required": True, "section": "farmer_details"},
        {"name": "main_crop", "label": "Main crop", "type": "select",
         "options_from": {"source": "client_catalog", "catalog": "crops_list"}},
        {"name": "variety", "label": "Variety", "type": "select",
         "options_from": {"source": "crop_ontology", "kind": "trait",
                          "depends_on": "main_crop"}},
        {"name": "farmer_photo", "label": "Farmer photo", "type": "image"},
    ], sections=[{"key": "farmer_details", "title": "Farmer details"}],
        rules=[{"conditions": [{"field": "consent", "operator": "equals",
                                "value": "yes"}],
                "logic": "AND", "action": "show",
                "target": {"type": "section", "key": "farmer_details"}}],
        location={"enabled": True, "required": True},
        geofence={"enabled": True,
                  "polygon": [[-99.2, 19.4], [-99.1, 19.4], [-99.1, 19.5]]})

    sent = mcdc(_Answer(200, {"id": "MCDC-77"}))
    answer = editor_client.post(f"/api/forms/{form_id}/exports",
                                json={"connector": "mcdc"})

    assert answer.status_code == 201
    assert answer.json()["external_id"] == "MCDC-77"

    config = sent[0]["body"]["config"]
    # Order is the fields array, not a sort key.
    assert [f["name"] for f in config["fields"]] == [
        "consent", "farmer_name", "main_crop", "variety", "farmer_photo"]
    assert config["sections"][0]["key"] == "farmer_details"
    # The rule, as written.
    assert config["rules"][0]["target"] == {"type": "section", "key": "farmer_details"}
    assert config["rules"][0]["conditions"][0]["field"] == "consent"
    # References, not copies of what they point at.
    crop = next(f for f in config["fields"] if f["name"] == "main_crop")
    assert crop["options_from"] == {"source": "client_catalog", "catalog": "crops_list"}
    assert not crop["options"]
    variety = next(f for f in config["fields"] if f["name"] == "variety")
    assert variety["options_from"]["source"] == "crop_ontology"
    assert variety["options_from"]["depends_on"] == "main_crop"
    # Media, position and fence.
    assert next(f for f in config["fields"] if f["name"] == "farmer_photo")["type"] == "image"
    assert config["location"] == {"enabled": True, "required": True}
    assert len(config["geofence"]["polygon"]) == 3
    # Required stays required.
    assert next(f for f in config["fields"] if f["name"] == "farmer_name")["required"] is True


def test_the_key_travels_as_a_header_and_nowhere_else(forms, editor_client, mcdc):
    form_id = _form(forms)
    sent = mcdc(_Answer(200, {"id": "MCDC-1"}))

    answer = editor_client.post(f"/api/forms/{form_id}/exports",
                                json={"connector": "mcdc"})

    assert sent[0]["headers"]["Authorization"] == "Bearer mcdc-secret-key"
    assert sent[0]["timeout"] == 7
    # Not in the body, and not in what the caller is told.
    assert "mcdc-secret-key" not in str(sent[0]["body"])
    assert "mcdc-secret-key" not in answer.text
    assert "Authorization" not in str(sent[0]["body"])


def test_no_submission_ever_travels_with_a_configuration(forms, editor_client, mcdc):
    """This connector carries what to collect, never what was collected."""
    form_id = _form(forms)
    editor_client.post(f"/api/forms/{form_id}/submissions",
                       json={"data": {"farmer_name": "Ramesh", "main_crop": "MAIZE"}})

    sent = mcdc(_Answer(200, {"id": "MCDC-1"}))
    editor_client.post(f"/api/forms/{form_id}/exports", json={"connector": "mcdc"})

    body = str(sent[0]["body"])
    assert "Ramesh" not in body
    assert "survey_id" not in body and "form_data" not in body


def test_a_timeout_is_recorded_and_retried_not_lost(forms, editor_client, mcdc):
    import httpx

    form_id = _form(forms)
    mcdc(httpx.ReadTimeout("too slow"))

    answer = editor_client.post(f"/api/forms/{form_id}/exports",
                                json={"connector": "mcdc"})

    assert answer.status_code == 502
    assert "did not answer within 7s" in answer.json()["detail"]

    record = connectors.record_of(form_id, 1, "mcdc")
    assert record["status"] == "FAILED"
    assert "did not answer" in record["error_message"]
    # The published form is untouched by a delivery that did not happen.
    assert form_service.get_form(form_id)["form_status"] == "Active"

    # And the same call tries again, in the same row.
    sent = mcdc(_Answer(200, {"id": "MCDC-9"}))
    again = editor_client.post(f"/api/forms/{form_id}/exports",
                               json={"connector": "mcdc"})

    assert again.status_code == 201
    assert again.json()["status"] == "EXPORTED"
    assert again.json()["export_id"] == record["export_id"]
    assert again.json()["error_message"] == ""
    assert len(sent) == 1

    # One record for one delivery, however many attempts it took.
    assert len(connectors.history(form_id)) == 1


def test_mcdc_refusing_the_configuration_is_a_4xx_that_says_so(forms, editor_client,
                                                                mcdc):
    form_id = _form(forms)
    mcdc(_Answer(422, {"error": "unknown field type"}))

    answer = editor_client.post(f"/api/forms/{form_id}/exports",
                                json={"connector": "mcdc"})

    assert answer.status_code == 502
    assert "(422)" in answer.json()["detail"]
    assert connectors.record_of(form_id, 1, "mcdc")["status"] == "FAILED"
    # Their body is not repeated back — only which end refused, and how.
    assert "unknown field type" not in answer.text


def test_mcdc_being_broken_is_reported_as_theirs_to_fix(forms, editor_client, mcdc):
    form_id = _form(forms)
    mcdc(_Answer(503))

    answer = editor_client.post(f"/api/forms/{form_id}/exports",
                                json={"connector": "mcdc"})

    assert answer.status_code == 502
    assert "having trouble" in answer.json()["detail"]
    assert "Try again" in answer.json()["detail"]
    assert connectors.record_of(form_id, 1, "mcdc")["status"] == "FAILED"


def test_credentials_mcdc_will_not_take_are_named_as_credentials(forms,
                                                                 editor_client, mcdc):
    form_id = _form(forms)
    mcdc(_Answer(401))

    answer = editor_client.post(f"/api/forms/{form_id}/exports",
                                json={"connector": "mcdc"})

    assert answer.status_code == 502
    assert "credentials" in answer.json()["detail"]
    # The key itself is not in the message.
    assert "mcdc-secret-key" not in answer.text


def test_an_already_delivered_version_is_not_sent_again_even_after_a_failure(
        forms, editor_client, mcdc):
    """Idempotency survives a mixed history."""
    form_id = _form(forms)

    mcdc(_Answer(500))
    editor_client.post(f"/api/forms/{form_id}/exports", json={"connector": "mcdc"})

    sent = mcdc(_Answer(200, {"id": "MCDC-3"}))
    editor_client.post(f"/api/forms/{form_id}/exports", json={"connector": "mcdc"})
    again = editor_client.post(f"/api/forms/{form_id}/exports",
                               json={"connector": "mcdc"})

    assert again.json()["already_exported"] is True
    assert again.json()["external_id"] == "MCDC-3"
    # Delivered exactly once, whatever the caller did.
    assert len(sent) == 1


def test_the_digest_says_what_was_sent(forms, editor_client, mcdc):
    form_id = _form(forms)
    mcdc(_Answer(200, {"id": "MCDC-1"}))

    body = editor_client.post(f"/api/forms/{form_id}/exports",
                              json={"connector": "mcdc"}).json()

    from app.modules.forms import publishing

    expected = connectors.request_hash(
        publishing.published(form_service.get_form(form_id)))
    assert body["request_hash"] == expected
    # A different version is a different digest.
    definition = form_service.get_form(form_id)["form_json"]
    form_service.update_form(form_id, normalize_form({**definition, "title": "New"}),
                             updated_by="tests")
    assert connectors.request_hash(
        publishing.published(form_service.get_form(form_id))) != expected


def test_a_configuration_that_is_not_valid_is_refused_before_it_leaves(forms,
                                                                       sent,
                                                                       editor_client):
    """Caught here, not by the platform receiving it."""
    form_id = _form(forms)

    # A definition damaged after publication — by hand, or by an older version
    # of this application.
    with transaction() as cur:
        cur.execute("UPDATE form_version SET form_json = form_json || "
                    "'{\"fields\": []}'::jsonb WHERE form_id = %s", (form_id,))

    answer = editor_client.post(f"/api/forms/{form_id}/exports",
                                json={"connector": "echo"})

    assert answer.status_code == 422
    assert "no questions" in answer.json()["detail"]
    assert sent == []
    # Nothing claimed, so nothing to clean up.
    assert connectors.record_of(form_id, 1, "echo") is None


def test_an_export_record_carries_no_secret(forms, editor_client, mcdc):
    from app.core.config import settings

    form_id = _form(forms)
    mcdc(_Answer(200, {"id": "MCDC-1", "token": "should-not-be-kept"}))
    editor_client.post(f"/api/forms/{form_id}/exports", json={"connector": "mcdc"})

    shown = editor_client.get(f"/api/forms/{form_id}/exports").text
    for secret in (settings.mcdc_api_key, settings.aws_secret_access_key,
                   settings.db_password):
        if secret:
            assert secret not in shown
    # Only what this end recorded about the delivery.
    record = connectors.record_of(form_id, 1, "mcdc")
    assert record["response_metadata"] == {"http_status": 200}
    assert "token" not in str(record)
