"""Uploads, and where a form was filled in.

Two features that share nothing except the submission they hang off:

    media       the bytes go to S3, a `form_media` row says what and where.
                Keyed by `survey_id` — the identifier a submitted record
                already has. There is deliberately no second one.

    location    the browser reports a position; whether it is usable, and
                whether it is inside the form's own area, is decided here.

S3 is stubbed throughout: what is being tested is the key that would be signed,
the row that is written and who is allowed to ask — not that AWS returns a URL.
"""
import uuid
from unittest.mock import patch

import pytest
from psycopg2 import sql

from app.core import auth_service
from app.core.database import ping, transaction
from app.modules.forms import (
    form_service, geolocation, media_service, submission_service,
)
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.tabular_service import tabular_name
from app.modules.projects import project_service

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"

MEDIA_FIELDS = [
    {"name": "farmer_name", "label": "Farmer name", "type": "text"},
    {"name": "farmer_photo", "label": "Farmer photo", "type": "image"},
    {"name": "interview_audio", "label": "Interview audio", "type": "audio"},
    {"name": "identity_document", "label": "Identity document", "type": "file"},
]

# A small ring around Mexico City, in GeoJSON order: [longitude, latitude].
MEXICO = [[-99.20, 19.40], [-99.10, 19.40], [-99.10, 19.50], [-99.20, 19.50]]
INSIDE = {"latitude": 19.4326, "longitude": -99.1332, "accuracy": 12.4,
          "captured_at": "2026-09-04T12:30:00Z"}
OUTSIDE = {"latitude": 28.6139, "longitude": 77.2090, "accuracy": 8.0}


@pytest.fixture
def forms():
    made = []
    yield made
    with transaction() as cur:
        for form_id, table in made:
            cur.execute("DELETE FROM form_media WHERE form_id = %s", (form_id,))
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
        token = auth_service.login(email, PASSWORD)["token"]
        made.append(user["user_id"])
        return {**user, "token": token}

    yield make

    with transaction() as cur:
        for user_id in made:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))


def client_for(person):
    from fastapi.testclient import TestClient

    from app.main import app
    return TestClient(app, headers={"Authorization": f"Bearer {person['token']}"})


def _role_id(name):
    with transaction() as cur:
        cur.execute("SELECT role_id FROM app_role WHERE name = %s", (name,))
        return cur.fetchone()["role_id"]


def _form(forms, fields=None, project=None, **config):
    definition = normalize_form({
        "title": f"Media {uuid.uuid4().hex[:6]}",
        "table_name": f"ml_{uuid.uuid4().hex[:8]}",
        "fields": fields or MEDIA_FIELDS,
        **config,
    })
    created = form_service.create_form(definition, created_by="tests", status="Active")
    forms.append((created["form_id"], created["table"]["table_name"]))
    if project:
        project_service.set_form_project(created["form_id"], project)
    return created["form_id"]


def _submit(form_id, data=None, **kw):
    return submission_service.submit(form_service.get_form(form_id),
                                     data or {"farmer_name": "A"},
                                     created_by=kw.pop("created_by", "tests"), **kw)


@pytest.fixture
def stub_s3():
    """S3, without S3. The key is what matters; the URL is AWS's business."""
    with patch.object(media_service, "presign_upload",
                      lambda key, ctype: f"https://s3.test/PUT/{key}"), \
         patch.object(media_service, "presign_download",
                      lambda key, filename="": f"https://s3.test/GET/{key}"):
        yield


# --------------------------------------------------------------------------- #
# the field types
# --------------------------------------------------------------------------- #
def test_a_form_can_ask_for_a_photo_a_recording_and_a_document(forms):
    definition = form_service.get_form(_form(forms))["form_json"]

    assert [f["type"] for f in definition["fields"]] == [
        "text", "image", "audio", "file"]


def test_the_words_people_use_reach_the_right_type():
    from app.modules.forms.field_types import get_type

    assert get_type("photo").name == "image"
    assert get_type("voice").name == "audio"
    # `file` keeps every alias it had, so a definition already saved is unmoved.
    assert get_type("upload").name == "file"
    assert get_type("attachment").name == "file"


# --------------------------------------------------------------------------- #
# asking for somewhere to put an upload
# --------------------------------------------------------------------------- #
def test_an_upload_url_is_issued_for_each_kind(forms, projects, stub_s3, admin_client):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project)
    survey_id = _submit(form_id)["survey_id"]

    for field, filename, content_type, kind in (
            ("farmer_photo", "photo.jpg", "image/jpeg", "image"),
            ("interview_audio", "voice.mp3", "audio/mpeg", "audio"),
            ("identity_document", "document.pdf", "application/pdf", "file")):
        answer = admin_client.post(
            f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
            json={"field_name": field, "filename": filename,
                  "content_type": content_type})

        assert answer.status_code == 200, answer.text
        body = answer.json()
        assert body["media_type"] == kind
        assert body["s3_key"] == (
            f"projects/{project}/forms/{form_id}/{survey_id}/{kind}/{filename}")
        assert body["upload_url"].startswith("https://")


def test_the_key_is_built_from_ids_and_the_survey(forms, projects):
    """No names, no usernames — a project renamed tomorrow does not strip the
    bucket of its history."""
    key = media_service.object_key("PRJ00001", "FRM00019", "000001",
                                   "image", "photo.jpg")

    assert key == "projects/PRJ00001/forms/FRM00019/000001/image/photo.jpg"


def test_a_form_outside_every_project_is_filed_apart():
    key = media_service.object_key(None, "FRM00001", "000001", "file", "doc.pdf")

    assert key == "system/forms/FRM00001/000001/file/doc.pdf"
    assert "projects/" not in key


def test_a_filename_cannot_climb_out_of_its_folder():
    key = media_service.object_key("PRJ1", "F1", "S1", "image", "../../etc/passwd")

    assert ".." not in key
    # projects / id / forms / id / survey / kind / filename
    assert key.count("/") == 6
    assert key.endswith("/etc_passwd")


def test_survey_id_is_the_identifier_and_there_is_no_second_one(forms, stub_s3,
                                                                editor_client):
    """The record already has an identity. Nothing here invents another."""
    form_id = _form(forms)
    survey_id = _submit(form_id)["survey_id"]

    editor_client.post(
        f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
        json={"field_name": "farmer_photo", "filename": "p.jpg",
              "content_type": "image/jpeg"})

    with transaction() as cur:
        cur.execute("SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = 'form_media'")
        columns = {row["column_name"] for row in cur.fetchall()}

    assert "survey_id" in columns
    assert "submission_id" not in columns


def test_the_row_records_what_and_where_but_never_the_bytes(forms, stub_s3,
                                                            editor_client):
    form_id = _form(forms)
    survey_id = _submit(form_id)["survey_id"]

    made = editor_client.post(
        f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
        json={"field_name": "farmer_photo", "filename": "photo.jpg",
              "content_type": "image/jpeg"}).json()

    row = media_service.get(made["media_id"])
    assert row["field_name"] == "farmer_photo"
    assert row["media_type"] == "image"
    assert row["content_type"] == "image/jpeg"
    assert row["survey_id"] == survey_id
    # Nowhere to put bytes even if somebody tried.
    assert "data" not in row and "content" not in row


def test_an_upload_is_not_served_until_it_has_arrived(forms, stub_s3, editor_client):
    form_id = _form(forms)
    survey_id = _submit(form_id)["survey_id"]
    base = f"/api/forms/{form_id}/submissions/{survey_id}/media"

    made = editor_client.post(f"{base}/upload-url", json={
        "field_name": "farmer_photo", "filename": "photo.jpg",
        "content_type": "image/jpeg"}).json()

    # Started, not finished: not in the list, and not readable.
    assert editor_client.get(base).json()["media"] == []
    assert editor_client.get(f"{base}/{made['media_id']}/url").status_code == 404

    editor_client.post(f"{base}/{made['media_id']}/complete", json={"file_size": 2048})

    listed = editor_client.get(base).json()["media"]
    assert [m["field_name"] for m in listed] == ["farmer_photo"]
    assert listed[0]["file_size"] == 2048
    assert editor_client.get(f"{base}/{made['media_id']}/url").status_code == 200


# --------------------------------------------------------------------------- #
# what the form will not accept
# --------------------------------------------------------------------------- #
def _refused(client, form_id, survey_id, **body):
    answer = client.post(
        f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
        json={"filename": "x.bin", "content_type": "image/jpeg", **body})
    return answer.status_code, str(answer.json().get("detail"))


def test_a_field_the_form_does_not_have_is_refused(forms, stub_s3, editor_client):
    form_id = _form(forms)
    survey_id = _submit(form_id)["survey_id"]

    code, why = _refused(editor_client, form_id, survey_id, field_name="nope")
    assert code == 422
    assert "no question called" in why


def test_a_field_that_is_not_a_media_field_is_refused(forms, stub_s3, editor_client):
    form_id = _form(forms)
    survey_id = _submit(form_id)["survey_id"]

    code, why = _refused(editor_client, form_id, survey_id, field_name="farmer_name")
    assert code == 422
    assert "does not take an upload" in why


def test_the_wrong_kind_of_media_for_the_field_is_refused(forms, stub_s3,
                                                          editor_client):
    """An audio file offered to a photo question."""
    form_id = _form(forms)
    survey_id = _submit(form_id)["survey_id"]

    code, why = _refused(editor_client, form_id, survey_id,
                         field_name="farmer_photo", content_type="audio/mpeg")
    assert code == 422
    assert "not something this question accepts" in why


def test_a_content_type_nobody_asked_for_is_refused(forms, stub_s3, editor_client):
    form_id = _form(forms)
    survey_id = _submit(form_id)["survey_id"]

    code, _ = _refused(editor_client, form_id, survey_id,
                       field_name="identity_document",
                       content_type="application/x-msdownload")
    assert code == 422


def test_something_too_large_is_refused_before_it_is_uploaded(forms, stub_s3,
                                                              editor_client):
    from app.core.config import settings

    form_id = _form(forms)
    survey_id = _submit(form_id)["survey_id"]

    code, why = _refused(editor_client, form_id, survey_id,
                         field_name="farmer_photo",
                         file_size=(settings.media_max_mb + 1) * 1024 * 1024)
    assert code == 422
    assert "larger than" in why


def test_without_a_bucket_the_answer_says_so_rather_than_failing(forms, editor_client):
    """And says nothing about AWS."""
    from app.core.config import settings

    form_id = _form(forms)
    survey_id = _submit(form_id)["survey_id"]

    with patch.object(settings, "aws_s3_bucket", ""):
        answer = editor_client.post(
            f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
            json={"field_name": "farmer_photo", "filename": "p.jpg",
                  "content_type": "image/jpeg"})

    assert answer.status_code == 503
    assert "AWS_S3_BUCKET" in answer.json()["detail"]


# --------------------------------------------------------------------------- #
# who may upload, and who may read one back
# --------------------------------------------------------------------------- #
def test_somebody_outside_the_project_can_neither_upload_nor_read(
        forms, projects, people, stub_s3, admin_client):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project)
    survey_id = _submit(form_id)["survey_id"]

    made = admin_client.post(
        f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
        json={"field_name": "farmer_photo", "filename": "p.jpg",
              "content_type": "image/jpeg"}).json()
    admin_client.post(
        f"/api/forms/{form_id}/submissions/{survey_id}/media/{made['media_id']}/complete",
        json={})

    outsider = client_for(people("Nobody"))
    base = f"/api/forms/{form_id}/submissions/{survey_id}/media"

    # 404 throughout: a project they are not in is one that does not exist.
    assert outsider.post(f"{base}/upload-url", json={
        "field_name": "farmer_photo", "filename": "p.jpg",
        "content_type": "image/jpeg"}).status_code == 404
    assert outsider.get(base).status_code == 404
    assert outsider.get(f"{base}/{made['media_id']}/url").status_code == 404


def test_a_surveyor_assigned_the_form_may_upload_to_it(forms, projects, people,
                                                       stub_s3):
    """The existing fill permission decides, unchanged."""
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project)
    project_service.assign_form(form_id, "everyone")

    surveyor = people("Shrishti")
    project_service.add_member(project, surveyor["user_id"], _role_id("surveyor"))

    api = client_for(surveyor)
    survey_id = api.post(f"/api/forms/{form_id}/submissions",
                         json={"data": {"farmer_name": "A"}}).json()["survey_id"]

    answer = api.post(f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
                      json={"field_name": "farmer_photo", "filename": "p.jpg",
                            "content_type": "image/jpeg"})
    assert answer.status_code == 200


def test_an_upload_belonging_to_another_submission_is_not_reachable(
        forms, stub_s3, editor_client):
    """Changing the id in the URL reaches nothing."""
    form_id = _form(forms)
    mine = _submit(form_id)["survey_id"]
    theirs = _submit(form_id)["survey_id"]

    made = editor_client.post(
        f"/api/forms/{form_id}/submissions/{theirs}/media/upload-url",
        json={"field_name": "farmer_photo", "filename": "p.jpg",
              "content_type": "image/jpeg"}).json()
    editor_client.post(
        f"/api/forms/{form_id}/submissions/{theirs}/media/{made['media_id']}/complete",
        json={})

    assert editor_client.get(
        f"/api/forms/{form_id}/submissions/{mine}/media/{made['media_id']}/url"
    ).status_code == 404


# --------------------------------------------------------------------------- #
# where the form was filled in
# --------------------------------------------------------------------------- #
def test_a_form_that_does_not_ask_needs_no_location(forms):
    form_id = _form(forms, fields=[{"name": "a", "label": "A", "type": "text"}])

    assert _submit(form_id, {"a": "x"})["location"] is None
    # And a client sending one anyway does not get a column added to the form.
    assert _submit(form_id, {"a": "x"}, location=INSIDE)["location"] is None

    table = form_service.get_form(form_id)["form_json"]["table_name"]
    with transaction() as cur:
        cur.execute("SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = %s", (table,))
        assert "location" not in {r["column_name"] for r in cur.fetchall()}


def test_only_a_form_that_asks_gets_the_column(forms):
    asking = _form(forms, location={"enabled": True})
    table = form_service.get_form(asking)["form_json"]["table_name"]

    with transaction() as cur:
        cur.execute("SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = %s", (table,))
        assert "location" in {r["column_name"] for r in cur.fetchall()}


def test_a_required_location_that_is_missing_is_refused(forms):
    form_id = _form(forms, location={"enabled": True, "required": True})

    with pytest.raises(submission_service.ValidationFailed) as refused:
        _submit(form_id)

    assert "_location" in refused.value.errors


def test_an_optional_location_may_be_left_out(forms):
    form_id = _form(forms, location={"enabled": True})

    assert _submit(form_id)["location"] is None


def test_a_position_is_stored_as_given(forms):
    form_id = _form(forms, location={"enabled": True})
    made = _submit(form_id, location=INSIDE)

    stored = submission_service.one_submission(
        form_service.get_form(form_id), made["survey_id"])

    assert stored["location"] == {
        "latitude": 19.4326, "longitude": -99.1332,
        "accuracy": 12.4, "captured_at": "2026-09-04T12:30:00Z"}


@pytest.mark.parametrize("bad", [
    {"latitude": 91, "longitude": 0},
    {"latitude": -91, "longitude": 0},
    {"latitude": 0, "longitude": 181},
    {"latitude": "north", "longitude": 0},
])
def test_coordinates_that_are_not_places_are_refused(forms, bad):
    form_id = _form(forms, location={"enabled": True, "required": True})

    with pytest.raises(submission_service.ValidationFailed):
        _submit(form_id, location=bad)


def test_inside_the_fence_is_accepted_and_outside_is_not(forms):
    form_id = _form(forms, location={"enabled": True, "required": True},
                    geofence={"enabled": True, "polygon": MEXICO})

    assert _submit(form_id, location=INSIDE)["survey_id"]

    with pytest.raises(submission_service.ValidationFailed) as refused:
        _submit(form_id, location=OUTSIDE)

    assert "outside the allowed location" in refused.value.errors["_location"]


def test_a_fence_nobody_could_be_inside_is_not_stored(forms):
    """Two points enclose nothing, so the fence normalizes away rather than
    refusing every submission."""
    form_id = _form(forms, location={"enabled": True},
                    geofence={"enabled": True, "polygon": [[1, 2], [3, 4]]})

    assert "geofence" not in form_service.get_form(form_id)["form_json"]
    assert _submit(form_id, location=OUTSIDE)["survey_id"]


def test_without_a_fence_any_real_position_is_accepted(forms):
    form_id = _form(forms, location={"enabled": True, "required": True})

    assert _submit(form_id, location=OUTSIDE)["survey_id"]


def test_the_fence_is_judged_here_whatever_the_browser_claims(forms):
    """A page saying "inside" changes nothing: the ring on the form decides."""
    form_id = _form(forms, location={"enabled": True, "required": True},
                    geofence={"enabled": True, "polygon": MEXICO})

    with pytest.raises(submission_service.ValidationFailed):
        _submit(form_id, location={**OUTSIDE, "inside_geofence": True})


def test_point_in_ring_is_the_ordinary_rule():
    #  a square, and points either side of each edge
    square = [[0, 0], [10, 0], [10, 10], [0, 10]]

    assert geolocation.point_in_ring(5, 5, square) is True
    assert geolocation.point_in_ring(-1, 5, square) is False
    assert geolocation.point_in_ring(11, 5, square) is False
    assert geolocation.point_in_ring(5, -1, square) is False
    assert geolocation.point_in_ring(5, 11, square) is False

    # A concave ring: the notch is outside even though it is within the bounds.
    ell = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]
    assert geolocation.point_in_ring(2, 8, ell) is True
    assert geolocation.point_in_ring(8, 8, ell) is False


def test_the_api_refuses_an_out_of_bounds_submission_with_a_readable_reason(
        forms, editor_client):
    form_id = _form(forms, location={"enabled": True, "required": True},
                    geofence={"enabled": True, "polygon": MEXICO})

    answer = editor_client.post(f"/api/forms/{form_id}/submissions",
                                json={"data": {"farmer_name": "A"},
                                      "location": OUTSIDE})

    assert answer.status_code == 422
    assert "outside the allowed location" in str(answer.json()["detail"])


def test_a_form_in_another_project_is_not_submittable(forms, projects, people):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project, location={"enabled": True})

    outsider = client_for(people("Nobody"))
    assert outsider.post(f"/api/forms/{form_id}/submissions",
                         json={"data": {"farmer_name": "A"},
                               "location": INSIDE}).status_code == 404


def test_the_configuration_travels_with_the_published_version(forms):
    """It is part of the definition, so it versions and rolls back with it."""
    form_id = _form(forms, location={"enabled": True, "required": True},
                    geofence={"enabled": True, "polygon": MEXICO})

    with transaction() as cur:
        cur.execute("SELECT form_json FROM form_version "
                    "WHERE form_id = %s ORDER BY version_no DESC LIMIT 1", (form_id,))
        version = cur.fetchone()["form_json"]

    assert version["location"] == {"enabled": True, "required": True}
    assert version["geofence"]["polygon"] == MEXICO


# --------------------------------------------------------------------------- #
# what a survey_id is
#
# Six digits and nothing else, counted per form. Which form a submission
# belongs to is `form_id`, which is stored beside it — repeating it inside the
# id said the same thing twice, and made the S3 path say it three times.
# --------------------------------------------------------------------------- #
def test_the_first_submission_to_a_form_is_000001(forms):
    form_id = _form(forms)

    assert _submit(form_id)["survey_id"] == "000001"


def test_the_next_one_is_000002(forms):
    form_id = _form(forms)
    _submit(form_id)

    assert _submit(form_id)["survey_id"] == "000002"


def test_the_sequence_is_this_form_s_own(forms):
    """Farmer Register and Plot Register both start at 000001, and neither can
    reach the other's rows: every form has its own table."""
    farmer, plot = _form(forms), _form(forms)

    farmers = [_submit(farmer)["survey_id"] for _ in range(3)]
    plots = [_submit(plot)["survey_id"] for _ in range(2)]

    assert farmers == ["000001", "000002", "000003"]
    assert plots == ["000001", "000002"]

    # And each row is in its own form's table under that id.
    assert submission_service.one_submission(
        form_service.get_form(plot), "000001") is not None


def test_a_survey_id_is_digits_only(forms):
    form_id = _form(forms)

    survey_id = _submit(form_id)["survey_id"]
    assert survey_id.isdigit()
    assert "-" not in survey_id
    assert form_id not in survey_id


def test_a_survey_id_is_six_digits(forms):
    form_id = _form(forms)

    assert len(_submit(form_id)["survey_id"]) == 6


def test_the_s3_path_carries_the_new_id(forms, projects, stub_s3, admin_client):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project)
    survey_id = _submit(form_id)["survey_id"]

    body = admin_client.post(
        f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
        json={"field_name": "farmer_photo", "filename": "photo.jpg",
              "content_type": "image/jpeg"}).json()

    assert survey_id == "000001"
    assert body["s3_key"] == (
        f"projects/{project}/forms/{form_id}/000001/image/photo.jpg")
    # The form id appears once, where it belongs — not again inside the survey.
    assert body["s3_key"].count(form_id) == 1


def test_the_media_endpoints_still_work_end_to_end(forms, stub_s3, editor_client):
    form_id = _form(forms)
    survey_id = _submit(form_id)["survey_id"]
    base = f"/api/forms/{form_id}/submissions/{survey_id}/media"

    made = editor_client.post(f"{base}/upload-url", json={
        "field_name": "identity_document", "filename": "doc.pdf",
        "content_type": "application/pdf"}).json()
    editor_client.post(f"{base}/{made['media_id']}/complete", json={"file_size": 10})

    listed = editor_client.get(base).json()["media"]
    assert [m["field_name"] for m in listed] == ["identity_document"]
    assert editor_client.get(f"{base}/{made['media_id']}/url").status_code == 200

    row = media_service.get(made["media_id"])
    assert row["survey_id"] == "000001"


def test_two_forms_using_the_same_id_do_not_collide(forms, stub_s3, editor_client):
    """`000001` in two forms is two different rows, and two different objects."""
    one, two = _form(forms), _form(forms)
    first = _submit(one)["survey_id"]
    second = _submit(two)["survey_id"]
    assert first == second == "000001"

    keys = []
    for form_id in (one, two):
        body = editor_client.post(
            f"/api/forms/{form_id}/submissions/000001/media/upload-url",
            json={"field_name": "farmer_photo", "filename": "photo.jpg",
                  "content_type": "image/jpeg"}).json()
        keys.append(body["s3_key"])

    assert keys[0] != keys[1]
    assert one in keys[0] and two in keys[1]


def test_authorization_is_unchanged_by_the_new_id(forms, projects, people,
                                                  stub_s3, admin_client):
    """The id got shorter; who may use it did not."""
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project)
    survey_id = _submit(form_id)["survey_id"]

    outsider = client_for(people("Nobody"))
    base = f"/api/forms/{form_id}/submissions/{survey_id}/media"

    assert outsider.post(f"{base}/upload-url", json={
        "field_name": "farmer_photo", "filename": "p.jpg",
        "content_type": "image/jpeg"}).status_code == 404
    assert outsider.get(base).status_code == 404
    # And the same id in a project they *can* reach is still nothing to them.
    assert admin_client.get(base).status_code == 200


# --------------------------------------------------------------------------- #
# when the survey id is handed out
# --------------------------------------------------------------------------- #
def _progress(form_id):
    with transaction() as cur:
        cur.execute("SELECT * FROM form_survey_progress WHERE form_id = %s "
                    "ORDER BY survey_id", (form_id,))
        return [dict(r) for r in cur.fetchall()]


def _rows(form_id):
    table = form_service.get_form(form_id)["form_json"]["table_name"]
    with transaction() as cur:
        cur.execute(sql.SQL("SELECT survey_id FROM {} ORDER BY survey_id").format(
            sql.Identifier(table)))
        return [r["survey_id"] for r in cur.fetchall()]


def test_opening_a_form_takes_no_id_and_leaves_no_record(forms, editor_client):
    """Somebody who opens a form and walks away leaves nothing behind."""
    form_id = _form(forms)

    assert editor_client.get(f"/api/forms/{form_id}/render").status_code == 200
    assert editor_client.get(f"/api/forms/{form_id}/render").status_code == 200

    assert _progress(form_id) == []
    assert _rows(form_id) == []


def test_starting_hands_out_the_first_id_and_marks_it_in_progress(forms, editor_client):
    form_id = _form(forms)

    answer = editor_client.post(f"/api/forms/{form_id}/submissions/start")
    assert answer.status_code == 201
    assert answer.json()["survey_id"] == "000001"

    # In progress: known, but not yet a submission.
    assert [r["survey_id"] for r in _progress(form_id)] == ["000001"]
    assert _rows(form_id) == []


def test_each_start_takes_the_next_id(forms, editor_client):
    form_id = _form(forms)
    ids = [editor_client.post(f"/api/forms/{form_id}/submissions/start").json()["survey_id"]
           for _ in range(3)]

    assert ids == ["000001", "000002", "000003"]


def test_an_upload_is_filed_under_the_started_id(forms, stub_s3, editor_client):
    """The whole point of starting: somewhere to put the photo."""
    form_id = _form(forms)
    survey_id = editor_client.post(
        f"/api/forms/{form_id}/submissions/start").json()["survey_id"]

    made = editor_client.post(
        f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
        json={"field_name": "farmer_photo", "filename": "photo.jpg",
              "content_type": "image/jpeg"})
    assert made.status_code == 200
    assert made.json()["s3_key"].endswith(f"/{form_id}/000001/image/photo.jpg")

    done = editor_client.post(
        f"/api/forms/{form_id}/submissions/{survey_id}/media/"
        f"{made.json()['media_id']}/complete", json={})
    assert done.status_code == 200


def _upload(client, form_id, survey_id, field="farmer_photo"):
    made = client.post(
        f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
        json={"field_name": field, "filename": "photo.jpg",
              "content_type": "image/jpeg"}).json()
    client.post(f"/api/forms/{form_id}/submissions/{survey_id}/media/"
                f"{made['media_id']}/complete", json={})
    return made["media_id"]


def test_submitting_moves_it_from_in_progress_to_submitted(forms, stub_s3,
                                                           editor_client):
    form_id = _form(forms)
    survey_id = editor_client.post(
        f"/api/forms/{form_id}/submissions/start").json()["survey_id"]
    media_id = _upload(editor_client, form_id, survey_id)

    answer = editor_client.post(
        f"/api/forms/{form_id}/submissions",
        json={"survey_id": survey_id,
              "data": {"farmer_name": "A", "farmer_photo": media_id}})

    assert answer.status_code == 201
    # The same id it was started with — not a second one.
    assert answer.json()["survey_id"] == survey_id
    assert _rows(form_id) == [survey_id]
    assert _progress(form_id) == []


def test_a_failed_submission_stays_in_progress_and_is_retried_with_the_same_id(
        forms, stub_s3, editor_client):
    """The whole reason IN_PROGRESS outlives a failure."""
    form_id = _form(forms, fields=[
        {"name": "farmer_name", "label": "Farmer name", "type": "text",
         "required": True},
        {"name": "farmer_photo", "label": "Farmer photo", "type": "image"}])
    survey_id = editor_client.post(
        f"/api/forms/{form_id}/submissions/start").json()["survey_id"]
    media_id = _upload(editor_client, form_id, survey_id)

    refused = editor_client.post(
        f"/api/forms/{form_id}/submissions",
        json={"survey_id": survey_id, "data": {"farmer_photo": media_id}})
    assert refused.status_code == 422

    # Still in progress, and nothing written.
    assert [r["survey_id"] for r in _progress(form_id)] == [survey_id]
    assert _rows(form_id) == []

    again = editor_client.post(
        f"/api/forms/{form_id}/submissions",
        json={"survey_id": survey_id,
              "data": {"farmer_name": "A", "farmer_photo": media_id}})

    assert again.status_code == 201
    # The retry did not burn a second id, and the photo was not sent twice.
    assert again.json()["survey_id"] == "000001"
    assert _rows(form_id) == ["000001"]


def test_the_same_started_id_cannot_be_submitted_twice(forms, editor_client):
    form_id = _form(forms)
    survey_id = editor_client.post(
        f"/api/forms/{form_id}/submissions/start").json()["survey_id"]
    body = {"survey_id": survey_id, "data": {"farmer_name": "A"}}

    assert editor_client.post(f"/api/forms/{form_id}/submissions",
                              json=body).status_code == 201
    second = editor_client.post(f"/api/forms/{form_id}/submissions", json=body)

    assert second.status_code == 422
    assert "already been sent" in str(second.json())
    assert _rows(form_id) == [survey_id]


def test_an_id_that_was_never_started_is_refused(forms, editor_client):
    form_id = _form(forms)
    answer = editor_client.post(
        f"/api/forms/{form_id}/submissions",
        json={"survey_id": "000042", "data": {"farmer_name": "A"}})

    assert answer.status_code == 422
    assert _rows(form_id) == []


def test_a_form_with_nothing_to_upload_still_submits_in_one_call(forms,
                                                                 editor_client):
    """No files, no start: the id is taken and used in the same statement."""
    form_id = _form(forms)
    answer = editor_client.post(f"/api/forms/{form_id}/submissions",
                                json={"data": {"farmer_name": "A"}})

    assert answer.status_code == 201
    assert answer.json()["survey_id"] == "000001"
    assert _progress(form_id) == []


# --------------------------------------------------------------------------- #
# the media a submission claims
# --------------------------------------------------------------------------- #
def test_a_media_answer_naming_an_upload_that_never_landed_is_refused(
        forms, stub_s3, editor_client):
    form_id = _form(forms)
    survey_id = editor_client.post(
        f"/api/forms/{form_id}/submissions/start").json()["survey_id"]

    # Asked for, never completed.
    started = editor_client.post(
        f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
        json={"field_name": "farmer_photo", "filename": "photo.jpg",
              "content_type": "image/jpeg"}).json()["media_id"]

    answer = editor_client.post(
        f"/api/forms/{form_id}/submissions",
        json={"survey_id": survey_id,
              "data": {"farmer_name": "A", "farmer_photo": started}})

    assert answer.status_code == 422
    assert "did not finish" in str(answer.json())
    # Still retryable.
    assert [r["survey_id"] for r in _progress(form_id)] == [survey_id]


def test_a_media_answer_belonging_to_another_survey_is_refused(forms, stub_s3,
                                                              editor_client):
    form_id = _form(forms)
    theirs = editor_client.post(
        f"/api/forms/{form_id}/submissions/start").json()["survey_id"]
    media_id = _upload(editor_client, form_id, theirs)

    mine = editor_client.post(
        f"/api/forms/{form_id}/submissions/start").json()["survey_id"]
    answer = editor_client.post(
        f"/api/forms/{form_id}/submissions",
        json={"survey_id": mine,
              "data": {"farmer_name": "A", "farmer_photo": media_id}})

    assert answer.status_code == 422
    assert "farmer_photo" in str(answer.json())


def test_a_made_up_media_id_is_refused(forms, editor_client):
    form_id = _form(forms)
    survey_id = editor_client.post(
        f"/api/forms/{form_id}/submissions/start").json()["survey_id"]

    answer = editor_client.post(
        f"/api/forms/{form_id}/submissions",
        json={"survey_id": survey_id,
              "data": {"farmer_name": "A", "farmer_photo": "MEDdeadbeef"}})

    assert answer.status_code == 422


def test_starting_is_guarded_exactly_like_submitting(forms, projects, people):
    """Same permission, same form, same 404 for anybody else."""
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project)

    outsider = client_for(people("Nobody"))
    assert outsider.post(f"/api/forms/{form_id}/submissions/start").status_code == 404
    assert _progress(form_id) == []

    project_service.assign_form(form_id, "everyone")
    surveyor = people("Shrishti")
    project_service.add_member(project, surveyor["user_id"], _role_id("surveyor"))

    assert client_for(surveyor).post(
        f"/api/forms/{form_id}/submissions/start").status_code == 201


# --------------------------------------------------------------------------- #
# how the URL is signed
# --------------------------------------------------------------------------- #
# Signing is arithmetic, not a call: these build real URLs with throwaway
# credentials and never touch AWS.
LEGACY = ("AWSAccessKeyId=", "&Signature=", "&Expires=")
V4 = ("X-Amz-Algorithm=AWS4-HMAC-SHA256", "X-Amz-Credential=", "X-Amz-Date=",
      "X-Amz-Expires=", "X-Amz-SignedHeaders=", "X-Amz-Signature=")


@pytest.fixture
def fake_aws(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "aws_s3_bucket", "e-agro-test")
    monkeypatch.setattr(settings, "aws_region", "ap-south-1")
    monkeypatch.setattr(settings, "aws_access_key_id", "AKIAIOSFODNN7EXAMPLE")
    monkeypatch.setattr(settings, "aws_secret_access_key", "wJalrXUtnFEMI/EXAMPLEKEY")
    return settings


def test_an_upload_url_is_signed_with_signature_version_4(fake_aws):
    url = media_service.presign_upload("system/forms/F/000001/image/a.jpg", "image/jpeg")

    assert all(part in url for part in V4)
    # And not the legacy scheme, which newer regions refuse outright.
    assert not any(part in url for part in LEGACY)


def test_a_download_url_is_signed_the_same_way(fake_aws):
    url = media_service.presign_download("system/forms/F/000001/image/a.jpg", "a.jpg")

    assert all(part in url for part in V4)
    assert not any(part in url for part in LEGACY)


def test_the_url_is_signed_for_the_buckets_own_regional_host(fake_aws):
    """The global host answers a browser PUT with a 307 it cannot follow."""
    url = media_service.presign_upload("system/forms/F/000001/image/a.jpg", "image/jpeg")

    assert url.startswith("https://e-agro-test.s3.ap-south-1.amazonaws.com/")
    # The signature is scoped to the same region as the host it is sent to.
    assert "%2Fap-south-1%2Fs3%2F" in url


def test_the_secret_key_is_never_in_a_signed_url(fake_aws):
    for url in (media_service.presign_upload("k", "image/jpeg"),
                media_service.presign_download("k")):
        assert fake_aws.aws_secret_access_key not in url
        # The access key *id* is in there, which is how a presigned URL works.
        assert fake_aws.aws_access_key_id in url


# --------------------------------------------------------------------------- #
# what the object ends up called
# --------------------------------------------------------------------------- #
def test_a_filename_that_already_has_an_extension_keeps_exactly_that_one():
    """Nothing appends an extension. `photo.jpg` is not `photo.jpg.jpeg`."""
    for filename in ("Diagrama_Mexico_ENG.jpg", "voice.mp3", "identity.pdf",
                     "report.final.xlsx"):
        key = media_service.object_key("PRJ1", "FRM1", "000001", "image", filename)
        assert key.endswith(f"/{filename}")

    assert media_service.safe_filename("Diagrama_Mexico_ENG.jpg") == "Diagrama_Mexico_ENG.jpg"


def test_the_content_type_does_not_rename_the_file(fake_aws):
    """image/jpeg does not turn a .jpg into a .jpeg on the way to the bucket."""
    key = media_service.object_key("PRJ1", "FRM1", "000001", "image",
                                   "Diagrama_Mexico_ENG.jpg")

    assert key == "projects/PRJ1/forms/FRM1/000001/image/Diagrama_Mexico_ENG.jpg"
    assert media_service.presign_upload(key, "image/jpeg").split("?")[0].endswith(
        "Diagrama_Mexico_ENG.jpg")


# --------------------------------------------------------------------------- #
# what the records table is told about an upload
# --------------------------------------------------------------------------- #
def _record_with_a_photo(client, form_id, filename="farmer.jpg"):
    """Start a survey, upload a photo, submit it. Returns (survey_id, media_id)."""
    survey_id = client.post(
        f"/api/forms/{form_id}/submissions/start").json()["survey_id"]
    made = client.post(
        f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
        json={"field_name": "farmer_photo", "filename": filename,
              "content_type": "image/jpeg", "file_size": 1234}).json()
    client.post(f"/api/forms/{form_id}/submissions/{survey_id}/media/"
                f"{made['media_id']}/complete", json={"file_size": 1234})
    client.post(f"/api/forms/{form_id}/submissions",
                json={"survey_id": survey_id,
                      "data": {"farmer_name": "A", "farmer_photo": made["media_id"]}})
    return survey_id, made["media_id"]


def test_records_carry_what_each_upload_is_called(forms, stub_s3, editor_client):
    """So the table can show a filename instead of a media id."""
    form_id = _form(forms)
    survey_id, media_id = _record_with_a_photo(editor_client, form_id)

    row = editor_client.get(f"/api/forms/{form_id}/records").json()["rows"][0]

    # The answer is untouched — an existing caller reading form_data is unmoved.
    assert row["form_data"]["farmer_photo"] == media_id
    # And beside it, what that id is.
    assert row["media"]["farmer_photo"] == [{
        "media_id": media_id, "field_name": "farmer_photo", "media_type": "image",
        "filename": "farmer.jpg", "content_type": "image/jpeg", "size": 1234}]


def test_the_records_response_never_carries_a_key_or_a_credential(
        forms, stub_s3, editor_client):
    from app.core.config import settings

    form_id = _form(forms)
    _record_with_a_photo(editor_client, form_id)

    body = editor_client.get(f"/api/forms/{form_id}/records").text

    assert "s3_key" not in body
    assert "forms/" + form_id + "/000001/image" not in body
    for secret in (settings.aws_secret_access_key, settings.aws_access_key_id):
        if secret:
            assert secret not in body


def test_a_record_without_an_upload_says_nothing_about_media(forms, editor_client):
    form_id = _form(forms)
    editor_client.post(f"/api/forms/{form_id}/submissions",
                       json={"data": {"farmer_name": "A"}})

    row = editor_client.get(f"/api/forms/{form_id}/records").json()["rows"][0]

    assert row["media"] == {}


def test_an_upload_that_never_landed_is_not_offered_to_the_table(
        forms, stub_s3, editor_client):
    form_id = _form(forms)
    survey_id = editor_client.post(
        f"/api/forms/{form_id}/submissions/start").json()["survey_id"]
    # Asked for, never completed.
    editor_client.post(
        f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
        json={"field_name": "farmer_photo", "filename": "half.jpg",
              "content_type": "image/jpeg"})
    editor_client.post(f"/api/forms/{form_id}/submissions",
                       json={"survey_id": survey_id, "data": {"farmer_name": "A"}})

    row = editor_client.get(f"/api/forms/{form_id}/records").json()["rows"][0]

    assert row["media"] == {}


def test_media_for_a_hidden_answer_is_hidden_too(forms, projects, people, stub_s3,
                                                 admin_client):
    """A question an admin hid takes its uploads with it."""
    from app.modules.forms import view_service

    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project)
    project_service.assign_form(form_id, "everyone")
    _record_with_a_photo(admin_client, form_id)

    view_service.set_visible_fields(
        form_id, ["farmer_name"], form_service.get_form(form_id)["form_json"])

    surveyor = people("Shrishti")
    project_service.add_member(project, surveyor["user_id"], _role_id("surveyor"))
    row = client_for(surveyor).get(
        f"/api/forms/{form_id}/records").json()["rows"][0]

    assert "farmer_photo" not in row["form_data"]
    assert "farmer_photo" not in row["media"]


def test_the_whole_page_of_records_costs_one_query_for_its_media(forms, stub_s3,
                                                                editor_client):
    """A table of records with a photo each is one lookup, not one per row."""
    form_id = _form(forms)
    wanted = {}
    for n in range(3):
        survey_id, media_id = _record_with_a_photo(editor_client, form_id, f"p{n}.jpg")
        wanted[survey_id] = media_id

    found = media_service.for_submissions(form_id, list(wanted))

    assert set(found) == set(wanted)
    for survey_id, media_id in wanted.items():
        assert found[survey_id]["farmer_photo"][0]["media_id"] == media_id
    assert media_service.for_submissions(form_id, []) == {}


def test_reading_an_upload_still_goes_through_the_same_authorization(
        forms, projects, people, stub_s3, admin_client):
    """The table shows a filename to anyone who may see the record; the file
    itself is still one authorized request away."""
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project)
    survey_id, media_id = _record_with_a_photo(admin_client, form_id)

    outsider = client_for(people("Nobody"))
    assert outsider.get(f"/api/forms/{form_id}/records").status_code == 404
    assert outsider.get(f"/api/forms/{form_id}/submissions/{survey_id}/media/"
                        f"{media_id}/url").status_code == 404

    signed = admin_client.get(f"/api/forms/{form_id}/submissions/{survey_id}/media/"
                              f"{media_id}/url")
    assert signed.status_code == 200
    assert signed.json()["url"].startswith("https://s3.test/GET/")
