"""The MCDC mobile contract: list, download, submit.

    GET  /api/mcdc/forms                       what this account may fill on a phone
    GET  /api/forms/{id}/package?language=     the whole published form, to keep
    POST /api/forms/{id}/submissions           the answers, through the one pipeline

The app renders and stores everything itself; what is tested here is that the
server hands it the right thing, only to the right account, and takes the
answers back through exactly the path every other channel uses.
"""
import json
import uuid

import pytest
from psycopg2 import sql

from app.core.config import settings
from app.core.database import ping, transaction
from app.modules.forms import form_service, ingestion, mobile_package
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.tabular_service import tabular_name
from app.modules.projects import project_service

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"

NAME = {"name": "farmer_name", "label": "Farmer name", "type": "text", "required": True,
        "help_text": "As on the ID card", "validation": {"min_length": 2}}
CROP = {"name": "crop", "label": "Crop", "type": "select", "required": True,
        "options": [{"label": "Maize", "value": "MAIZE"}, {"label": "Rice", "value": "RICE"}]}
AREA = {"name": "area", "label": "Area (ha)", "type": "decimal",
        "validation": {"min": 0, "max": 500}, "section": "plot"}
RULES = [{"conditions": [{"field": "crop", "operator": "equals", "value": "RICE"}],
          "logic": "AND", "action": "show", "target": {"type": "field", "name": "area"}}]
TRANSLATIONS = {"es": {"title": "Registro", "fields": {"farmer_name": {"label": "Nombre"}},
                       "sections": {"plot": {"title": "Parcela"}}}}


# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture
def forms():
    made = []
    yield made
    with transaction() as cur:
        for form_id, table in made:
            cur.execute("DELETE FROM submission_receipt WHERE form_id = %s", (form_id,))
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
def catalogs():
    made = []
    yield made
    with transaction() as cur:
        for catalog_id in made:
            cur.execute("DELETE FROM client_catalog WHERE catalog_id = %s", (catalog_id,))


@pytest.fixture
def people():
    from app.core import auth_service
    made = []

    def make(label, role="standard"):
        email = f"{label.lower()}.{uuid.uuid4().hex[:8]}@example.test"
        user = auth_service.create_user(email, PASSWORD, role=role, full_name=label)
        made.append(user["user_id"])
        return {**user, "token": auth_service.login(email, PASSWORD)["token"]}

    yield make
    with transaction() as cur:
        for user_id in made:
            cur.execute("DELETE FROM project_member WHERE user_id = %s", (user_id,))
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))


def client_for(token=None):
    from fastapi.testclient import TestClient
    from app.main import app
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return TestClient(app, headers=headers)


def _form(forms, fields=None, status="Active", project=None, **extra):
    created = form_service.create_form(normalize_form({
        "title": f"Mobile {uuid.uuid4().hex[:6]}",
        "table_name": f"mob_{uuid.uuid4().hex[:8]}",
        "fields": fields or [NAME, CROP, AREA],
        "sections": [{"key": "plot", "title": "Plot"}],
        "rules": RULES,
        "languages": ["en", "es"],
        "translations": TRANSLATIONS,
        **extra,
    }), created_by="tests", status=status)
    forms.append((created["form_id"], created["table"]["table_name"]))
    if project:
        project_service.set_form_project(created["form_id"], project)
    return created["form_id"]


def _listed(client):
    answer = client.get("/api/mcdc/forms")
    assert answer.status_code == 200, answer.text
    return {f["form_id"]: f for f in answer.json()}


# --------------------------------------------------------------------------- #
# 1-5  listing
# --------------------------------------------------------------------------- #
def test_an_account_lists_the_forms_it_may_fill_on_mobile(forms, editor_client):
    form_id = _form(forms, channel="web_mobile")
    item = _listed(editor_client)[form_id]

    assert item["channel"] == "web_mobile"
    assert item["version"] == 1
    assert item["default_language"] == "en" and item["languages"] == ["en", "es"]
    assert item["package_url"] == f"/api/forms/{form_id}/package"
    assert item["form_title"] and "updated_on" in item
    # A list item never carries storage details.
    assert "table_name" not in item and "form_json" not in item


def test_nobody_signed_in_lists_or_downloads_anything(forms):
    form_id = _form(forms)
    anonymous = client_for()

    assert anonymous.get("/api/mcdc/forms").status_code == 401
    assert anonymous.get(f"/api/forms/{form_id}/package").status_code == 401
    assert anonymous.post(f"/api/forms/{form_id}/submissions",
                          json={"data": {"farmer_name": "Ramesh"}}).status_code == 401


def test_a_project_form_is_not_offered_to_an_outsider(forms, people):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    try:
        form_id = _form(forms, project=project)
        outsider = client_for(people("Outsider")["token"])

        assert form_id not in _listed(outsider)
        assert outsider.get(f"/api/forms/{form_id}/package").status_code == 404
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM project WHERE project_id = %s", (project,))


@pytest.mark.parametrize("extra", [
    {"channel": "whatsapp"},                                   # WhatsApp-only
    {"channels": {"mobile": False}},                           # mobile switched off
])
def test_a_form_not_open_on_mobile_is_not_offered(forms, editor_client, extra):
    form_id = _form(forms, **extra)

    assert form_id not in _listed(editor_client)
    assert editor_client.get(f"/api/forms/{form_id}/package").status_code == 409


def test_an_ivr_form_is_not_offered(forms, editor_client):
    form_id = _form(forms, fields=[{"name": "q", "label": "Q", "type": "number"}],
                    rules=[], channel="ivr", status="Draft")

    assert form_id not in _listed(editor_client)
    assert editor_client.get(f"/api/forms/{form_id}/package").status_code == 409


def test_a_draft_is_not_offered(forms, editor_client):
    form_id = _form(forms, status="Draft")

    assert form_id not in _listed(editor_client)
    answer = editor_client.get(f"/api/forms/{form_id}/package")
    assert answer.status_code == 409
    # Worded for somebody downloading a form, not exporting one.
    assert answer.json()["detail"] == (
        "This form has not been published, so there is nothing to download yet.")


def test_a_legacy_form_is_a_mobile_form(forms, editor_client):
    form_id = _form(forms)
    assert _listed(editor_client)[form_id]["channel"] == "web_mobile"
    assert editor_client.get(f"/api/forms/{form_id}/package").status_code == 200


# --------------------------------------------------------------------------- #
# 6-9  the package
# --------------------------------------------------------------------------- #
def test_the_package_carries_everything_a_renderer_needs(forms, editor_client):
    form_id = _form(forms, channel="web_mobile",
                    location={"enabled": True, "required": False})
    package = editor_client.get(f"/api/forms/{form_id}/package").json()

    assert package["package_version"] == mobile_package.PACKAGE_VERSION
    assert package["form_id"] == form_id and package["version"] == 1
    assert package["status"] == "published" and package["channel"] == "web_mobile"
    assert len(package["package_hash"]) == 64

    config = package["config"]
    assert [f["name"] for f in config["fields"]] == ["farmer_name", "crop", "area"]
    name = config["fields"][0]
    assert (name["label"], name["type"], name["required"], name["help_text"]) == \
        ("Farmer name", "text", True, "As on the ID card")
    assert name["validation"] == {"min_length": 2}
    assert config["fields"][1]["options"] == CROP["options"]
    assert config["fields"][2]["section"] == "plot"
    assert config["sections"] == [{"key": "plot", "title": "Plot", "description": ""}]
    assert config["rules"][0]["target"] == {"type": "field", "name": "area"}
    assert config["location"] == {"enabled": True, "required": False}
    assert config["translations"]["es"]["fields"]["farmer_name"]["label"] == "Nombre"


def test_nothing_internal_or_secret_is_in_it(forms, editor_client):
    form_id = _form(forms, channel="web_mobile")
    text = json.dumps(editor_client.get(f"/api/forms/{form_id}/package").json())
    config = json.loads(text)["config"]

    for key in ("table_name", "created_by", "import_source", "channels", "channel_config"):
        assert key not in config, key
    for secret in (settings.db_password, settings.openai_api_key, settings.mcdc_api_key,
                   settings.aws_secret_access_key, settings.smtp_password):
        if secret and len(secret) > 3:
            assert secret not in text


def test_language_follows_the_existing_translations(forms, editor_client):
    form_id = _form(forms)

    spanish = editor_client.get(f"/api/forms/{form_id}/package?language=es").json()
    unknown = editor_client.get(f"/api/forms/{form_id}/package?language=xx").json()
    default = editor_client.get(f"/api/forms/{form_id}/package").json()

    assert spanish["language"] == "es"
    assert spanish["config"]["fields"][0]["label"] == "Nombre"
    assert spanish["config"]["sections"][0]["title"] == "Parcela"
    assert unknown["language"] == default["language"] == "en"
    assert default["config"]["fields"][0]["label"] == "Farmer name"
    # Every language travels, so the app can switch without asking again.
    assert [l["code"] for l in spanish["languages"]] == ["en", "es"]
    assert spanish["package_hash"] != default["package_hash"]


def test_the_package_is_the_published_version_not_the_latest_edit(forms, editor_client):
    """Rolled back to version 1 after an edit made version 2: phones get 1."""
    form_id = _form(forms)
    definition = form_service.get_form(form_id)["form_json"]
    form_service.update_form(form_id, normalize_form({
        **definition, "fields": [{**NAME, "label": "Edited later"}, CROP, AREA]}),
        updated_by="tests")
    form_service.rollback(form_id, 1, updated_by="tests")

    package = editor_client.get(f"/api/forms/{form_id}/package").json()
    assert package["version"] == 1
    assert package["config"]["fields"][0]["label"] == "Farmer name"


def test_an_edit_to_a_live_form_is_a_new_version_of_the_package(forms, editor_client):
    form_id = _form(forms)
    before = editor_client.get(f"/api/forms/{form_id}/package").json()
    definition = form_service.get_form(form_id)["form_json"]
    form_service.update_form(form_id, normalize_form({**definition, "title": "Renamed"}),
                             updated_by="tests")

    after = editor_client.get(f"/api/forms/{form_id}/package").json()
    assert (before["version"], after["version"]) == (1, 2)
    assert before["package_hash"] != after["package_hash"]


def test_catalogue_values_are_resolved_with_their_parents(forms, catalogs, editor_client):
    states, districts = f"st_{uuid.uuid4().hex[:6]}", f"di_{uuid.uuid4().hex[:6]}"
    catalogs.extend([districts, states])
    with transaction() as cur:
        cur.execute("INSERT INTO client_catalog (catalog_id, name) VALUES (%s, 'States')", (states,))
        cur.execute("INSERT INTO client_catalog (catalog_id, name, parent_catalog_id) "
                    "VALUES (%s, 'Districts', %s)", (districts, states))
        cur.executemany(
            "INSERT INTO client_catalog_value (catalog_id, code, label, parent_code, display_order) "
            "VALUES (%s, %s, %s, %s, %s)",
            [(states, "MH", "Maharashtra", None, 1), (states, "KA", "Karnataka", None, 2),
             (districts, "PUNE", "Pune", "MH", 1), (districts, "MYS", "Mysuru", "KA", 2)])

    form_id = _form(forms, fields=[
        NAME,
        {"name": "state", "label": "State", "type": "select",
         "options_from": {"source": "client_catalog", "catalog": states}},
        {"name": "district", "label": "District", "type": "select",
         "options_from": {"source": "client_catalog", "catalog": districts,
                          "depends_on": "state"}},
    ], rules=[], translations={}, languages=["en"])

    sets = editor_client.get(f"/api/forms/{form_id}/package").json()["option_sets"]

    assert [o["value"] for o in sets["state"]["options"]] == ["MH", "KA"]
    assert sets["district"]["depends_on"] == "state"
    assert {(o["value"], o["parent_code"]) for o in sets["district"]["options"]} == \
        {("PUNE", "MH"), ("MYS", "KA")}


# --------------------------------------------------------------------------- #
# 10-11  hash and ETag
# --------------------------------------------------------------------------- #
def test_the_hash_is_deterministic(forms, editor_client):
    form_id = _form(forms)
    first = editor_client.get(f"/api/forms/{form_id}/package").json()
    second = editor_client.get(f"/api/forms/{form_id}/package").json()

    assert first["package_hash"] == second["package_hash"]
    assert mobile_package.package_hash(first) == first["package_hash"]
    # Key order does not change it.
    assert mobile_package.package_hash(dict(reversed(list(first.items())))) == first["package_hash"]


def test_pausing_and_resuming_does_not_change_the_hash(forms, editor_client):
    """`published_at` moves with a status change; what a phone draws does not."""
    form_id = _form(forms)
    before = editor_client.get(f"/api/forms/{form_id}/package").json()["package_hash"]
    form_service.set_status(form_id, "Inactive")
    form_service.set_status(form_id, "Active")
    assert editor_client.get(f"/api/forms/{form_id}/package").json()["package_hash"] == before


def test_an_unchanged_package_answers_304(forms, editor_client):
    form_id = _form(forms)
    first = editor_client.get(f"/api/forms/{form_id}/package")
    etag = first.headers["etag"]

    assert etag == f'"{first.json()["package_hash"]}"'
    again = editor_client.get(f"/api/forms/{form_id}/package", headers={"If-None-Match": etag})
    assert again.status_code == 304 and again.content == b""
    assert again.headers["etag"] == etag

    stale = editor_client.get(f"/api/forms/{form_id}/package", headers={"If-None-Match": '"old"'})
    assert stale.status_code == 200


# --------------------------------------------------------------------------- #
# 12-15  submitting
# --------------------------------------------------------------------------- #
ANSWERS = {"farmer_name": "Ramesh", "crop": "RICE", "area": 2.5}


def _rows(form_id):
    table = form_service.get_form(form_id)["form_json"]["table_name"]
    with transaction() as cur:
        cur.execute(sql.SQL("SELECT survey_id, form_data FROM {} ORDER BY survey_id")
                    .format(sql.Identifier(table)))
        return [dict(r) for r in cur.fetchall()]


def test_a_mobile_submission_goes_through_the_one_pipeline(forms, editor_client):
    form_id = _form(forms, channel="web_mobile")
    version = editor_client.get(f"/api/forms/{form_id}/package").json()["version"]

    answer = editor_client.post(f"/api/forms/{form_id}/submissions", json={
        "data": ANSWERS, "channel": "mobile", "form_version": version,
        "client_submission_id": "phone-1:0001"})

    assert answer.status_code == 201, answer.text
    stored = answer.json()
    assert stored["channel"] == "mobile" and stored["replayed"] is False
    # The same row every channel writes, the same validation's output…
    assert _rows(form_id) == [{"survey_id": stored["survey_id"], "form_data": ANSWERS}]
    # …and the note saying how it arrived.
    assert ingestion.channel_of(form_id, stored["survey_id"]) == "mobile"


def test_an_invalid_submission_is_refused_by_the_usual_validation(forms, editor_client):
    form_id = _form(forms)

    bad = editor_client.post(f"/api/forms/{form_id}/submissions", json={
        "data": {"farmer_name": "R", "crop": "SORGHUM", "area": 900}, "channel": "mobile"})
    hidden = editor_client.post(f"/api/forms/{form_id}/submissions", json={
        "data": {"farmer_name": "Ramesh", "crop": "MAIZE", "area": 1}, "channel": "mobile"})

    assert bad.status_code == 422
    # Too short, not a choice, and — since the crop is not rice — an answer to a
    # question that was never asked. Every error at once, keyed by field.
    assert set(bad.json()["detail"]["errors"]) == {"farmer_name", "crop", "area"}
    # `area` is only asked for rice: an answer to it for maize is refused.
    assert hidden.status_code == 422 and "area" in hidden.json()["detail"]["errors"]
    assert _rows(form_id) == []


def test_answers_for_an_old_version_are_refused(forms, editor_client):
    form_id = _form(forms)
    definition = form_service.get_form(form_id)["form_json"]
    form_service.update_form(form_id, normalize_form({**definition, "title": "v2"}),
                             updated_by="tests")

    stale = editor_client.post(f"/api/forms/{form_id}/submissions", json={
        "data": ANSWERS, "channel": "mobile", "form_version": 1})
    assert stale.status_code == 422 and "_form_version" in stale.json()["detail"]["errors"]


def test_a_retried_submission_is_stored_once(forms, editor_client):
    form_id = _form(forms)
    body = {"data": ANSWERS, "channel": "mobile", "client_submission_id": "phone-1:0002"}

    first = editor_client.post(f"/api/forms/{form_id}/submissions", json=body)
    retry = editor_client.post(f"/api/forms/{form_id}/submissions", json=body)
    reused = editor_client.post(f"/api/forms/{form_id}/submissions",
                                json={**body, "data": {**ANSWERS, "farmer_name": "Other"}})

    assert (first.status_code, retry.status_code, reused.status_code) == (201, 200, 409)
    assert retry.json()["survey_id"] == first.json()["survey_id"]
    assert len(_rows(form_id)) == 1


def test_a_whatsapp_form_refuses_mobile_answers(forms, editor_client):
    form_id = _form(forms, channel="whatsapp")
    answer = editor_client.post(f"/api/forms/{form_id}/submissions",
                                json={"data": ANSWERS, "channel": "mobile"})
    assert answer.status_code == 422 and "_channel" in answer.json()["detail"]["errors"]


# =========================================================================== #
# Phase 3C — the contract, verified end to end
# =========================================================================== #
from app.modules.forms.field_types import FIELD_TYPES  # noqa: E402

CHOICES = [{"label": "One", "value": "ONE"}, {"label": "Two", "value": "TWO"}]


def _every_type():
    """One question of every type the builder offers, with what each carries."""
    fields = []
    for field_type in FIELD_TYPES:
        field = {"name": f"q_{field_type}", "label": f"A {field_type} question",
                 "type": field_type, "required": False,
                 "help_text": f"Help for {field_type}", "placeholder": f"e.g. {field_type}"}
        if field_type in ("select", "radio", "multiselect"):
            field["options"] = CHOICES
        if field_type in ("number", "decimal", "rating"):
            field["validation"] = {"min": 1, "max": 5}
        fields.append(field)
    fields[0]["required"] = True
    fields[0]["default"] = "prefilled"
    return fields


#: A valid answer for every type, in the format MOBILE_API.md documents.
#: Media types need an upload first (documented separately) and are left out.
ANSWER_FOR = {
    "text": "Ramesh", "textarea": "Two lines\nof text", "email": "r@example.org",
    "phone": "9876543210", "url": "https://example.org", "number": 3, "decimal": 2.5,
    "rating": 4, "date": "2026-09-19", "datetime": "2026-09-19T10:15:00",
    "time": "10:15:00", "boolean": True, "select": "ONE", "radio": "TWO",
    "multiselect": ["ONE", "TWO"], "signature": "Ramesh Patil",
    "location": {"lat": 20.62, "lng": -103.38},
    "polygon": [[-103.4, 20.6], [-103.3, 20.6], [-103.3, 20.7]],
}
MEDIA = {"image", "audio", "file"}


def test_every_field_type_arrives_complete(forms, editor_client):
    """The package carries each question exactly as it was published: nothing
    a renderer needs is left behind for a second request."""
    form_id = _form(forms, fields=_every_type(), rules=[], translations={}, languages=["en"])
    stored = form_service.get_form(form_id)["form_json"]["fields"]

    package = editor_client.get(f"/api/forms/{form_id}/package").json()
    fields = package["config"]["fields"]

    assert fields == stored
    assert {f["type"] for f in fields} == set(FIELD_TYPES)
    for field in fields:
        for key in ("name", "type", "label", "required", "help_text", "placeholder",
                    "default", "options", "validation", "order"):
            assert key in field, (field["type"], key)
        if field["type"] in ("select", "radio", "multiselect"):
            assert field["options"] == CHOICES
    assert fields[0]["default"] == "prefilled" and fields[0]["required"] is True
    rating = next(f for f in fields if f["type"] == "rating")
    assert rating["validation"] == {"min": 1, "max": 5}
    assert package["config"]["submit_label"] and package["config"]["success_message"]


def test_every_documented_answer_format_is_accepted(forms, editor_client):
    """An app following MOBILE_API.md can answer every non-media type."""
    assert set(ANSWER_FOR) | MEDIA == set(FIELD_TYPES)
    form_id = _form(forms, fields=_every_type(), rules=[], translations={}, languages=["en"])

    data = {f"q_{t}": v for t, v in ANSWER_FOR.items()}
    answer = editor_client.post(f"/api/forms/{form_id}/submissions", json={
        "data": data, "channel": "mobile", "form_version": 1,
        "client_submission_id": "every-type-1"})

    assert answer.status_code == 201, answer.text
    stored = _rows(form_id)[0]["form_data"]
    assert stored["q_location"] == {"lat": 20.62, "lng": -103.38}
    assert stored["q_multiselect"] == ["ONE", "TWO"]
    assert stored["q_polygon"][0] == stored["q_polygon"][-1]      # closed on the way in


# --------------------------------------------------------------------------- #
# the channel mapping: form channel web_mobile, submission channel mobile
# --------------------------------------------------------------------------- #
def test_mobile_answers_are_refused_by_a_form_not_open_on_mobile(forms, editor_client):
    ivr = _form(forms, fields=[{"name": "q", "label": "Q", "type": "number"}], rules=[],
                channel="ivr", status="Draft")
    closed = _form(forms, channels={"mobile": False})

    for form_id, data in ((ivr, {"q": 1}), (closed, ANSWERS)):
        answer = editor_client.post(f"/api/forms/{form_id}/submissions",
                                    json={"data": data, "channel": "mobile"})
        assert answer.status_code == 422, form_id
        assert "_channel" in answer.json()["detail"]["errors"], form_id


def test_the_form_channel_name_is_not_a_submission_channel(forms, editor_client):
    """`web_mobile` names what a form is for; a submission says `mobile`."""
    form_id = _form(forms, channel="web_mobile")
    answer = editor_client.post(f"/api/forms/{form_id}/submissions",
                                json={"data": ANSWERS, "channel": "web_mobile"})
    assert answer.status_code == 400
    assert answer.json()["error"]["code"] == "INVALID_REQUEST"


def test_form_version_is_a_whole_number(forms, editor_client):
    form_id = _form(forms)
    answer = editor_client.post(f"/api/forms/{form_id}/submissions",
                                json={"data": ANSWERS, "channel": "mobile", "form_version": "1"})
    assert answer.status_code == 400


# --------------------------------------------------------------------------- #
# the list
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("status", ["Inactive", "Deleted"])
def test_paused_and_deleted_forms_are_not_offered(forms, editor_client, status):
    form_id = _form(forms)
    form_service.set_status(form_id, status)

    assert form_id not in _listed(editor_client)
    assert editor_client.get(f"/api/forms/{form_id}/package").status_code == 409


def _role(name):
    with transaction() as cur:
        cur.execute("SELECT role_id FROM app_role WHERE name = %s", (name,))
        return cur.fetchone()["role_id"]


def test_project_forms_follow_membership_role_and_assignment(forms, people):
    """The mobile list is exactly what this account may fill: assigned, and a
    role there that fills. Being in the project is not enough; reading is not
    filling."""
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    try:
        assigned = _form(forms, project=project)
        unassigned = _form(forms, project=project)

        surveyor, bystander, reviewer = (people(n) for n in ("Surveyor", "Bystander", "Reviewer"))
        project_service.add_member(project, surveyor["user_id"], _role("surveyor"))
        project_service.add_member(project, bystander["user_id"], _role("surveyor"))
        project_service.add_member(project, reviewer["user_id"], _role("reviewer"))
        project_service.assign_form(assigned, "user", user_id=surveyor["user_id"])
        project_service.assign_form(assigned, "user", user_id=reviewer["user_id"])

        phone = client_for(surveyor["token"])
        listed = _listed(phone)
        assert assigned in listed and unassigned not in listed
        assert listed[assigned]["project_id"] == project

        assert phone.get(f"/api/forms/{assigned}/package").status_code == 200
        assert phone.get(f"/api/forms/{unassigned}/package").status_code == 404
        sent = phone.post(f"/api/forms/{assigned}/submissions",
                          json={"data": ANSWERS, "channel": "mobile", "form_version": 1})
        assert sent.status_code == 201, sent.text
        assert phone.post(f"/api/forms/{unassigned}/submissions",
                          json={"data": ANSWERS, "channel": "mobile"}).status_code == 404

        assert _listed(client_for(bystander["token"])) == {}
        # A reviewer reads the project's forms; that is not being asked to fill them.
        reviewing = client_for(reviewer["token"])
        assert assigned not in _listed(reviewing)
        assert reviewing.get(f"/api/forms/{assigned}/package").status_code == 404
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM form_assignment WHERE form_id = ANY(%s)",
                        ([f for f, _ in forms],))
            cur.execute("DELETE FROM project WHERE project_id = %s", (project,))


# --------------------------------------------------------------------------- #
# authentication
# --------------------------------------------------------------------------- #
def test_login_gives_a_token_the_mobile_endpoints_accept(forms, people):
    form_id = _form(forms)
    person = people("Signer", role="editor")
    login = client_for().post("/api/auth/login",
                              json={"email": person["email"], "password": PASSWORD})

    assert login.status_code == 200
    body = login.json()
    assert set(body) >= {"token", "expires_on", "user"}
    phone = client_for(body["token"])
    assert phone.get("/api/auth/me").json()["user"]["user_id"] == person["user_id"]
    assert form_id in _listed(phone)

    assert phone.post("/api/auth/logout").status_code == 200
    assert client_for(body["token"]).get("/api/mcdc/forms").status_code == 401
    assert client_for().post("/api/auth/login", json={
        "email": person["email"], "password": "wrong"}).status_code == 401


def test_a_token_that_is_not_one_is_401(forms):
    form_id = _form(forms)
    stranger = client_for("not-a-real-token")
    assert stranger.get("/api/mcdc/forms").status_code == 401
    assert stranger.get(f"/api/forms/{form_id}/package").status_code == 401


def test_an_account_that_may_not_fill_is_refused(forms, people):
    """A role without the fill permission gets the ordinary 403."""
    form_id = _form(forms)
    reader = client_for(people("Reader", role="reviewer")["token"])

    assert reader.get("/api/mcdc/forms").status_code == 403
    assert reader.get(f"/api/forms/{form_id}/package").status_code == 403
    assert reader.post(f"/api/forms/{form_id}/submissions",
                       json={"data": ANSWERS, "channel": "mobile"}).status_code == 403


# --------------------------------------------------------------------------- #
# published version, through draft and back
# --------------------------------------------------------------------------- #
def test_draft_changes_never_reach_a_phone(forms, editor_client):
    form_id = _form(forms)
    assert editor_client.get(f"/api/forms/{form_id}/package").json()["version"] == 1

    # Taken back to draft and edited: out of circulation, nothing half-made shown.
    form_service.set_status(form_id, "Draft")
    definition = form_service.get_form(form_id)["form_json"]
    form_service.update_form(form_id, normalize_form({
        **definition, "fields": [{**NAME, "label": "Work in progress"}, CROP, AREA]}),
        updated_by="tests", status="Draft")
    assert form_id not in _listed(editor_client)
    assert editor_client.get(f"/api/forms/{form_id}/package").status_code == 409

    # Published again: that version, and only then.
    form_service.set_status(form_id, "Active")
    package = editor_client.get(f"/api/forms/{form_id}/package").json()
    assert package["version"] == 2
    assert package["config"]["fields"][0]["label"] == "Work in progress"


# --------------------------------------------------------------------------- #
# catalogue and ontology values
# --------------------------------------------------------------------------- #
def test_crop_ontology_lists_arrive_with_their_dependencies(forms, editor_client):
    from app.modules.standards.crop_ontology import dynamic_options

    crops = dynamic_options.crop_options()
    if not crops:
        pytest.skip("no crop ontology imported")
    form_id = _form(forms, fields=[
        NAME,
        {"name": "crop_co", "label": "Crop", "type": "select",
         "options_from": {"source": "crop_ontology", "kind": "crop"}},
        {"name": "trait", "label": "Trait", "type": "select",
         "options_from": {"source": "crop_ontology", "kind": "trait", "depends_on": "crop_co"}},
    ], rules=[], translations={}, languages=["en"])

    sets = editor_client.get(f"/api/forms/{form_id}/package").json()["option_sets"]

    assert sets["crop_co"]["options"] == crops
    by_parent = sets["trait"]["by_parent"]
    assert sets["trait"]["depends_on"] == "crop_co"
    assert list(by_parent) == [c["value"] for c in crops][:mobile_package.MAX_PARENT_VALUES]
    first = crops[0]["value"]
    assert by_parent[first] == dynamic_options.options_for("trait", first)


def test_a_catalogue_change_changes_the_hash_but_not_the_version(forms, catalogs, editor_client):
    catalog = f"cx_{uuid.uuid4().hex[:6]}"
    catalogs.append(catalog)
    with transaction() as cur:
        cur.execute("INSERT INTO client_catalog (catalog_id, name) VALUES (%s, 'C')", (catalog,))
        cur.execute("INSERT INTO client_catalog_value (catalog_id, code, label) "
                    "VALUES (%s, 'A', 'Alpha')", (catalog,))
    form_id = _form(forms, fields=[NAME, {"name": "pick", "label": "Pick", "type": "select",
                                          "options_from": {"source": "client_catalog",
                                                           "catalog": catalog}}],
                    rules=[], translations={}, languages=["en"])
    before = editor_client.get(f"/api/forms/{form_id}/package")

    with transaction() as cur:
        cur.execute("INSERT INTO client_catalog_value (catalog_id, code, label) "
                    "VALUES (%s, 'B', 'Beta')", (catalog,))
    after = editor_client.get(f"/api/forms/{form_id}/package",
                              headers={"If-None-Match": before.headers["etag"]})

    assert after.status_code == 200                       # not 304: it changed
    assert after.json()["version"] == before.json()["version"] == 1
    assert after.json()["package_hash"] != before.json()["package_hash"]
    assert [o["value"] for o in after.json()["option_sets"]["pick"]["options"]] == ["A", "B"]
