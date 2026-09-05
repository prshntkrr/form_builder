"""The whole of what a phone does, against the APIs it will actually call.

    login → the forms I may fill → the published configuration → the lists a
    question offers → start → upload → submit

There is nothing mobile-specific in here to test, and that is the point: every
call below is an endpoint the web application or MCDC already uses, and the row
that comes out the end is stored by the same service, in the same table, with
the same survey id sequence. A second pipeline for phones is what these tests
exist to prevent.
"""
import uuid
from unittest.mock import patch

import pytest
from psycopg2 import sql

from app.core import auth_service
from app.core.database import ping, transaction
from app.modules.forms import form_service, media_service
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.tabular_service import tabular_name
from app.modules.projects import project_service

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"

FIELDS = [
    {"name": "farmer_name", "label": "Farmer name", "type": "text", "required": True},
    {"name": "consent", "label": "Consent", "type": "select", "options": ["yes", "no"]},
    {"name": "village", "label": "Village", "type": "text"},
    {"name": "farmer_photo", "label": "Farmer photo", "type": "image"},
]

# Shown only when consent is yes. The backend decides that again on arrival.
RULES = [{"conditions": [{"field": "consent", "operator": "equals", "value": "yes"}],
          "logic": "AND", "action": "show",
          "target": {"type": "field", "name": "village"}}]

MEXICO = [[-99.20, 19.40], [-99.10, 19.40], [-99.10, 19.50], [-99.20, 19.50]]
INSIDE = {"latitude": 19.4326, "longitude": -99.1332, "accuracy": 12.4}
OUTSIDE = {"latitude": 28.6139, "longitude": 77.2090, "accuracy": 8.0}


@pytest.fixture
def forms():
    made = []
    yield made
    with transaction() as cur:
        for form_id, table in made:
            for name in ("form_media", "channel_form_route", "form_export",
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
    """A client holding nothing but what a phone would: a token from login."""
    from fastapi.testclient import TestClient

    from app.main import app

    signing_in = TestClient(app).post("/api/auth/login",
                                      json={"email": person["email"],
                                            "password": person["password"]})
    assert signing_in.status_code == 200, signing_in.text
    return TestClient(app, headers={
        "Authorization": f"Bearer {signing_in.json()['token']}"})


def _role_id(name):
    with transaction() as cur:
        cur.execute("SELECT role_id FROM app_role WHERE name = %s", (name,))
        return cur.fetchone()["role_id"]


def _form(forms, project=None, status="Active", fields=None, title=None, **config):
    created = form_service.create_form(normalize_form({
        "title": title or f"Mobile {uuid.uuid4().hex[:6]}",
        "table_name": f"mb_{uuid.uuid4().hex[:8]}",
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
def stub_s3():
    with patch.object(media_service, "presign_upload",
                      lambda key, ctype: f"https://s3.test/PUT/{key}"), \
         patch.object(media_service, "presign_download",
                      lambda key, filename="": f"https://s3.test/GET/{key}"):
        yield


@pytest.fixture
def field(forms, projects, people):
    """A surveyor with a phone, in a project, assigned one form."""
    project = project_service.create_project(
        f"Mobile {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project, title="Farmer Registration", rules=RULES)
    project_service.assign_form(form_id, "everyone")

    surveyor = people("Shrishti")
    project_service.add_member(project, surveyor["user_id"], _role_id("surveyor"))

    return {"project": project, "form_id": form_id, "surveyor": surveyor,
            "client": phone(surveyor)}


# --------------------------------------------------------------------------- #
# 1. signing in
# --------------------------------------------------------------------------- #
def test_a_phone_signs_in_and_is_told_who_it_is(field):
    me = field["client"].get("/api/auth/me")

    assert me.status_code == 200
    assert me.json()["user"]["email"] == field["surveyor"]["email"].lower()
    # A token, never a password, and nothing about how it is stored.
    assert "password" not in me.text and "hash" not in me.text


def test_no_token_reaches_nothing(field):
    from fastapi.testclient import TestClient

    from app.main import app

    anonymous = TestClient(app)
    for path in ("/api/mcdc/forms",
                 f"/api/forms/{field['form_id']}/published",
                 f"/api/forms/{field['form_id']}/submissions"):
        assert anonymous.get(path).status_code in (401, 405), path


# --------------------------------------------------------------------------- #
# 2. the forms this account may fill
# --------------------------------------------------------------------------- #
def test_the_list_is_what_this_account_may_fill(field):
    offered = field["client"].get("/api/mcdc/forms").json()

    assert [f["form_id"] for f in offered] == [field["form_id"]]
    # Enough to draw a list and fetch the right configuration.
    assert offered[0]["form_title"] == "Farmer Registration"
    assert offered[0]["version"] == 1
    assert offered[0]["project_id"] == field["project"]
    assert offered[0]["project_name"].startswith("Mobile")
    # Not the definition — that is one call away, and one copy.
    assert "fields" not in offered[0] and "form_json" not in offered[0]


def test_a_reviewer_is_offered_nothing_to_fill(field, people):
    """Being able to read a project's forms is not being able to answer them."""
    reviewer = people("Piyush")
    project_service.add_member(field["project"], reviewer["user_id"],
                               _role_id("reviewer"))

    assert phone(reviewer).get("/api/mcdc/forms").json() == []


def test_an_unassigned_form_is_not_offered(field, forms):
    _form(forms, project=field["project"])          # in the project, unassigned

    offered = field["client"].get("/api/mcdc/forms").json()

    assert [f["form_id"] for f in offered] == [field["form_id"]]


def test_another_projects_forms_are_not_offered(field, forms, projects):
    other = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(other)
    theirs = _form(forms, project=other)
    project_service.assign_form(theirs, "everyone")

    offered = field["client"].get("/api/mcdc/forms").json()

    assert theirs not in [f["form_id"] for f in offered]


def test_a_draft_is_not_offered(field, forms):
    draft = _form(forms, project=field["project"], status="Draft")
    project_service.assign_form(draft, "everyone")

    assert draft not in [f["form_id"]
                         for f in field["client"].get("/api/mcdc/forms").json()]


def test_the_same_list_answers_the_web_app(field):
    """One list, one implementation. A phone and a browser cannot disagree."""
    on_the_phone = field["client"].get("/api/mcdc/forms").json()
    in_the_browser = field["client"].get("/api/forms/live/list").json()

    assert ([f["form_id"] for f in on_the_phone]
            == [f["form_id"] for f in in_the_browser])


# --------------------------------------------------------------------------- #
# 3. the published configuration
# --------------------------------------------------------------------------- #
def test_a_form_it_may_fill_hands_over_its_configuration(field):
    answer = field["client"].get(f"/api/forms/{field['form_id']}/published")

    assert answer.status_code == 200
    body = answer.json()
    assert body["version"] == 1 and body["status"] == "published"
    config = body["config"]
    # Everything a renderer needs, in the order the form asks it.
    assert [f["name"] for f in config["fields"]] == [
        "farmer_name", "consent", "village", "farmer_photo"]
    assert config["fields"][0]["required"] is True
    assert config["fields"][3]["type"] == "image"
    assert config["rules"][0]["target"] == {"type": "field", "name": "village"}


def test_another_projects_form_is_not_there_to_be_read(field, forms, projects):
    other = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(other)
    theirs = _form(forms, project=other)

    answer = field["client"].get(f"/api/forms/{theirs}/published")

    assert answer.status_code == 404
    assert "Traceback" not in answer.text


def test_the_version_handed_over_is_the_one_that_is_live(field):
    """Never a draft, and never an edit nobody has published."""
    client = field["client"]
    assert client.get(f"/api/forms/{field['form_id']}/published").json()["version"] == 1

    definition = form_service.get_form(field["form_id"])["form_json"]
    form_service.update_form(field["form_id"], normalize_form({
        **definition, "title": "Renamed"}), updated_by="tests")

    body = client.get(f"/api/forms/{field['form_id']}/published").json()
    assert body["version"] == 2
    assert body["config"]["version"] == 2


def test_a_draft_hands_over_nothing(field, forms):
    draft = _form(forms, project=field["project"], status="Draft")
    project_service.assign_form(draft, "everyone")

    answer = field["client"].get(f"/api/forms/{draft}/published")

    assert answer.status_code == 409
    assert "draft" in answer.json()["detail"].lower()


# --------------------------------------------------------------------------- #
# 4. the lists a question offers
# --------------------------------------------------------------------------- #
def test_a_surveyor_can_read_the_catalogue_a_question_is_backed_by(field):
    """Without this the question is a select with no options and no explanation.

    It was exactly that until now: `client_catalog.view` was seeded to editors
    only, so every Surveyor on every installation met an empty list — on the
    web as much as on a phone.
    """
    with transaction() as cur:
        cur.execute("SELECT catalog_id FROM client_catalog LIMIT 1")
        row = cur.fetchone()
    if row is None:
        pytest.skip("no catalogue imported on this installation")

    answer = field["client"].get(f"/api/client-catalogs/{row['catalog_id']}/options")

    assert answer.status_code == 200
    assert isinstance(answer.json(), list)


def test_a_surveyor_can_read_the_ontology_a_question_is_backed_by(field):
    answer = field["client"].get("/api/crop-ontology/options?kind=crop")

    assert answer.status_code == 200


def test_reading_a_list_is_not_managing_one(field):
    """The fix opened the lists, and nothing else."""
    client = field["client"]

    assert client.post("/api/client-catalogs", json={"name": "Mine"}).status_code == 403
    assert client.post("/api/forms", json={}).status_code == 403
    assert client.get("/api/users").status_code in (403, 404)
    assert client.get("/api/mcdc/routes").status_code == 403


# --------------------------------------------------------------------------- #
# 5. looking up another form's records
# --------------------------------------------------------------------------- #
def test_a_child_form_offers_the_parents_this_account_may_attach_to(
        forms, projects, people):
    """The record lookup a phone needs, narrowed by the backend."""
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)

    parent = _form(forms, project=project, title="Farmer Registration")
    child = _form(forms, project=project, title="Plot Registration",
                  relationship={"type": "child", "parent_form_id": parent})
    for form_id in (parent, child):
        project_service.assign_form(form_id, "everyone")

    surveyor = people("Shrishti")
    project_service.add_member(project, surveyor["user_id"], _role_id("surveyor"))
    client = phone(surveyor)

    made = client.post(f"/api/forms/{parent}/submissions",
                       json={"data": {"farmer_name": "Ramesh", "consent": "yes"}})
    assert made.status_code == 201

    relationship = client.get(f"/api/forms/{child}/relationship").json()
    assert relationship["is_child"] is True
    assert relationship["parent_form"]["form_id"] == parent

    offered = client.get(f"/api/forms/{child}/parent-options").json()
    assert offered["parent_form_id"] == parent
    assert [p["survey_id"] for p in offered["submissions"]] == [
        made.json()["survey_id"]]
    # A record to choose from, described — never a table to query.
    assert set(offered["submissions"][0]) == {
        "survey_id", "summary", "created_by", "created_on"}


def test_a_lookup_does_not_reach_another_projects_records(forms, projects, people):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    parent = _form(forms, project=project)
    child = _form(forms, project=project,
                  relationship={"type": "child", "parent_form_id": parent})
    project_service.assign_form(child, "everyone")

    outsider = people("Nobody")
    assert phone(outsider).get(
        f"/api/forms/{child}/parent-options").status_code == 404


# --------------------------------------------------------------------------- #
# 6. filling one in
# --------------------------------------------------------------------------- #
def test_a_form_with_no_uploads_is_one_call(field):
    answer = field["client"].post(f"/api/forms/{field['form_id']}/submissions",
                                  json={"data": {"farmer_name": "Ramesh",
                                                 "consent": "no"}})

    assert answer.status_code == 201
    assert answer.json()["survey_id"] == "000001"
    assert _rows(field["form_id"])[0]["form_data"]["farmer_name"] == "Ramesh"


def test_a_missing_required_answer_is_refused_with_the_field_named(field):
    answer = field["client"].post(f"/api/forms/{field['form_id']}/submissions",
                                  json={"data": {"consent": "no"}})

    assert answer.status_code == 422
    assert "farmer_name" in answer.json()["detail"]["errors"]
    assert _rows(field["form_id"]) == []


def test_an_answer_to_a_question_the_form_did_not_ask_is_refused(field):
    """The rules are evaluated again here. A phone deciding otherwise changes
    nothing."""
    refused = field["client"].post(f"/api/forms/{field['form_id']}/submissions",
                                   json={"data": {"farmer_name": "R",
                                                  "consent": "no",
                                                  "village": "Somewhere"}})
    assert refused.status_code == 422
    assert "village" in str(refused.json()["detail"]["errors"])

    allowed = field["client"].post(f"/api/forms/{field['form_id']}/submissions",
                                   json={"data": {"farmer_name": "R",
                                                  "consent": "yes",
                                                  "village": "Somewhere"}})
    assert allowed.status_code == 201


def test_a_value_the_question_does_not_offer_is_refused(field):
    answer = field["client"].post(f"/api/forms/{field['form_id']}/submissions",
                                  json={"data": {"farmer_name": "R",
                                                 "consent": "maybe"}})

    assert answer.status_code == 422
    assert "consent" in answer.json()["detail"]["errors"]


def test_a_form_this_account_may_not_fill_is_not_there(field, forms, projects,
                                                       people):
    other = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(other)
    theirs = _form(forms, project=other)

    answer = field["client"].post(f"/api/forms/{theirs}/submissions",
                                  json={"data": {"farmer_name": "R"}})

    assert answer.status_code == 404
    assert _rows(theirs) == []


def test_nothing_in_the_body_can_widen_what_this_account_may_do(field, forms,
                                                                projects):
    """Identity comes from the token. The body is answers, and only answers."""
    other = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(other)
    theirs = _form(forms, project=other)

    answer = field["client"].post(
        f"/api/forms/{theirs}/submissions",
        json={"data": {"farmer_name": "R"},
              "user_id": "USR00001", "role": "admin",
              "project_id": field["project"], "permissions": ["*"]})

    assert answer.status_code == 404
    assert _rows(theirs) == []


def test_the_author_is_the_signed_in_account(field):
    field["client"].post(f"/api/forms/{field['form_id']}/submissions",
                         json={"data": {"farmer_name": "Ramesh", "consent": "no"},
                               "created_by": "Somebody Else"})

    assert _rows(field["form_id"])[0]["created_by"] == "Shrishti"


# --------------------------------------------------------------------------- #
# 7. photos
# --------------------------------------------------------------------------- #
def test_a_form_with_a_photo_is_start_upload_submit(field, stub_s3):
    client = field["client"]
    form_id = field["form_id"]

    started = client.post(f"/api/forms/{form_id}/submissions/start")
    assert started.status_code == 201
    survey_id = started.json()["survey_id"]
    assert survey_id == "000001"

    asked = client.post(
        f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
        json={"field_name": "farmer_photo", "filename": "farmer.jpg",
              "content_type": "image/jpeg", "file_size": 1234})
    assert asked.status_code == 200
    body = asked.json()
    # A link to PUT to, and no credential anywhere near the phone.
    assert body["upload_url"].startswith("https://s3.test/PUT/")
    assert "aws" not in asked.text.lower() and "secret" not in asked.text.lower()

    assert client.post(f"/api/forms/{form_id}/submissions/{survey_id}/media/"
                       f"{body['media_id']}/complete",
                       json={"file_size": 1234}).status_code == 200

    stored = client.post(f"/api/forms/{form_id}/submissions", json={
        "survey_id": survey_id,
        "data": {"farmer_name": "Ramesh", "consent": "no",
                 "farmer_photo": body["media_id"]}})

    assert stored.status_code == 201
    assert stored.json()["survey_id"] == survey_id
    assert _rows(form_id)[0]["form_data"]["farmer_photo"] == body["media_id"]


def test_a_photo_cannot_be_hung_on_somebody_elses_survey(field, forms, projects,
                                                         people, stub_s3):
    other = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(other)
    theirs = _form(forms, project=other)

    answer = field["client"].post(
        f"/api/forms/{theirs}/submissions/000001/media/upload-url",
        json={"field_name": "farmer_photo", "filename": "p.jpg",
              "content_type": "image/jpeg"})

    assert answer.status_code == 404


def test_an_upload_that_never_landed_cannot_be_claimed_as_an_answer(field, stub_s3):
    client = field["client"]
    form_id = field["form_id"]
    survey_id = client.post(
        f"/api/forms/{form_id}/submissions/start").json()["survey_id"]

    started = client.post(
        f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
        json={"field_name": "farmer_photo", "filename": "p.jpg",
              "content_type": "image/jpeg"}).json()

    answer = client.post(f"/api/forms/{form_id}/submissions", json={
        "survey_id": survey_id,
        "data": {"farmer_name": "R", "consent": "no",
                 "farmer_photo": started["media_id"]}})

    assert answer.status_code == 422
    assert "did not finish" in str(answer.json())


def test_a_survey_started_by_somebody_else_cannot_be_finished(field, people,
                                                              stub_s3):
    """A survey id is not a bearer token."""
    theirs = field["client"].post(
        f"/api/forms/{field['form_id']}/submissions/start").json()["survey_id"]

    intruder = people("Nobody")
    answer = phone(intruder).post(f"/api/forms/{field['form_id']}/submissions",
                                  json={"survey_id": theirs,
                                        "data": {"farmer_name": "R"}})

    assert answer.status_code == 404
    assert _rows(field["form_id"]) == []


# --------------------------------------------------------------------------- #
# 8. where the form was filled in
# --------------------------------------------------------------------------- #
def test_a_form_that_records_a_position_takes_the_one_sent(forms, projects, people):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project, location={"enabled": True})
    project_service.assign_form(form_id, "everyone")
    surveyor = people("Shrishti")
    project_service.add_member(project, surveyor["user_id"], _role_id("surveyor"))

    answer = phone(surveyor).post(f"/api/forms/{form_id}/submissions",
                                  json={"data": {"farmer_name": "R"},
                                        "location": INSIDE})

    assert answer.status_code == 201
    assert answer.json()["location"]["latitude"] == 19.4326


def test_a_required_position_is_enforced_here_not_on_the_phone(forms, projects,
                                                               people):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project,
                    location={"enabled": True, "required": True})
    project_service.assign_form(form_id, "everyone")
    surveyor = people("Shrishti")
    project_service.add_member(project, surveyor["user_id"], _role_id("surveyor"))

    answer = phone(surveyor).post(f"/api/forms/{form_id}/submissions",
                                  json={"data": {"farmer_name": "R"}})

    assert answer.status_code == 422
    assert "_location" in str(answer.json()["detail"]["errors"])


def test_a_fence_is_checked_here_whatever_the_phone_believed(forms, projects,
                                                             people):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project, location={"enabled": True},
                    geofence={"enabled": True, "polygon": MEXICO})
    project_service.assign_form(form_id, "everyone")
    surveyor = people("Shrishti")
    project_service.add_member(project, surveyor["user_id"], _role_id("surveyor"))
    client = phone(surveyor)

    # The phone can claim whatever it likes about being inside.
    refused = client.post(f"/api/forms/{form_id}/submissions",
                          json={"data": {"farmer_name": "R"},
                                "location": {**OUTSIDE, "inside": True}})
    assert refused.status_code == 422
    assert "_location" in str(refused.json()["detail"]["errors"])

    assert client.post(f"/api/forms/{form_id}/submissions",
                       json={"data": {"farmer_name": "R"},
                             "location": INSIDE}).status_code == 201


# --------------------------------------------------------------------------- #
# 9. one pipeline
# --------------------------------------------------------------------------- #
def test_a_phone_and_the_web_app_write_the_same_rows(field):
    """The architectural requirement, from the phone's side."""
    client = field["client"]
    form_id = field["form_id"]

    client.post(f"/api/forms/{form_id}/submissions",
                json={"data": {"farmer_name": "Ramesh", "consent": "no"}})
    client.post(f"/api/forms/{form_id}/submissions/ingest",
                json={"channel": "mobile",
                      "payload": {"farmer_name": "Ramesh", "consent": "no"}})

    rows = _rows(form_id)
    # One table, one sequence, one shape.
    assert [r["survey_id"] for r in rows] == ["000001", "000002"]
    assert rows[0]["form_data"] == rows[1]["form_data"]

    # And one place the data lives: no mobile table was created.
    with transaction() as cur:
        cur.execute("SELECT tablename FROM pg_tables WHERE tablename LIKE %s",
                    ("%mobile%",))
        assert cur.fetchall() == []


def test_starting_and_abandoning_leaves_no_record(field):
    """Opening a form and walking away costs an id and nothing else."""
    client = field["client"]
    survey_id = client.post(
        f"/api/forms/{field['form_id']}/submissions/start").json()["survey_id"]

    assert _rows(field["form_id"]) == []
    with transaction() as cur:
        cur.execute("SELECT * FROM form_survey_progress WHERE form_id = %s AND "
                    "survey_id = %s", (field["form_id"], survey_id))
        held = cur.fetchone()

    # Known as in progress, so the same id can be finished later.
    assert held is not None
    finished = client.post(f"/api/forms/{field['form_id']}/submissions",
                           json={"survey_id": survey_id,
                                 "data": {"farmer_name": "R", "consent": "no"}})
    assert finished.json()["survey_id"] == survey_id


def test_a_failed_submission_can_be_retried_with_the_same_id(field):
    client = field["client"]
    survey_id = client.post(
        f"/api/forms/{field['form_id']}/submissions/start").json()["survey_id"]

    refused = client.post(f"/api/forms/{field['form_id']}/submissions",
                          json={"survey_id": survey_id, "data": {"consent": "no"}})
    assert refused.status_code == 422

    again = client.post(f"/api/forms/{field['form_id']}/submissions",
                        json={"survey_id": survey_id,
                              "data": {"farmer_name": "R", "consent": "no"}})

    assert again.status_code == 201
    assert again.json()["survey_id"] == survey_id
    assert [r["survey_id"] for r in _rows(field["form_id"])] == ["000001"]
