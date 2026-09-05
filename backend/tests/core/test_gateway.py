"""The boundary channel traffic crosses.

What is being tested is what the gateway is *for*: that a request has to be
structurally acceptable and not too frequent before anything expensive happens
to it — and, just as importantly, that it decides nothing else. Whether an
account may fill a form is still `may_fill_form`'s answer, in the handler, and
the tests here that look like authorization tests exist to prove the gateway
did not quietly take that decision over.
"""
import uuid

import pytest
from psycopg2 import sql

from app.core import auth_service, gateway
from app.core.config import settings
from app.core.database import ping, transaction
from app.modules.forms import form_service
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.tabular_service import tabular_name
from app.modules.projects import project_service

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"
FIELDS = [{"name": "farmer_name", "label": "Farmer name", "type": "text",
           "required": True}]


@pytest.fixture(autouse=True)
def clean_limiter():
    """Every test starts with nobody having asked for anything."""
    gateway.limiter.forget()
    yield
    gateway.limiter.forget()


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
        return {**user, "email": email, "password": PASSWORD,
                "token": auth_service.login(email, PASSWORD)["token"]}

    yield make

    with transaction() as cur:
        for user_id in made:
            cur.execute("DELETE FROM channel_identity WHERE user_id = %s", (user_id,))
            cur.execute("DELETE FROM project_member WHERE user_id = %s", (user_id,))
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))


def client_for(token=None):
    from fastapi.testclient import TestClient

    from app.main import app
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return TestClient(app, headers=headers)


def _role_id(name):
    with transaction() as cur:
        cur.execute("SELECT role_id FROM app_role WHERE name = %s", (name,))
        return cur.fetchone()["role_id"]


def _form(forms, project=None, status="Active"):
    created = form_service.create_form(normalize_form({
        "title": f"Gateway {uuid.uuid4().hex[:6]}",
        "table_name": f"gw_{uuid.uuid4().hex[:8]}",
        "fields": FIELDS,
    }), created_by="tests", status=status)
    forms.append((created["form_id"], created["table"]["table_name"]))
    if project:
        project_service.set_form_project(created["form_id"], project)
    return created["form_id"]


@pytest.fixture
def surveyor(forms, projects, people):
    project = project_service.create_project(f"G {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project)
    project_service.assign_form(form_id, "everyone")

    person = people("Shrishti")
    project_service.add_member(project, person["user_id"], _role_id("surveyor"))
    return {"project": project, "form_id": form_id, "person": person,
            "client": client_for(person["token"])}


# --------------------------------------------------------------------------- #
# getting in at all
# --------------------------------------------------------------------------- #
def test_no_token_is_refused_in_the_gateways_shape_and_the_applications(surveyor):
    answer = client_for().get("/api/mcdc/forms")

    assert answer.status_code == 401
    assert answer.json()["error"]["code"] == "AUTHENTICATION_REQUIRED"
    # And the field every existing client already reads, unchanged.
    assert answer.json()["detail"]
    assert answer.json()["request_id"]


@pytest.mark.parametrize("token", ["not-a-token", "", "Bearer Bearer", "a" * 500])
def test_a_token_that_is_not_one_is_refused(token, surveyor):
    answer = client_for(token).get("/api/mcdc/forms")

    assert answer.status_code == 401
    assert answer.json()["error"]["code"] == "AUTHENTICATION_REQUIRED"


def test_an_expired_session_is_refused(people, surveyor):
    person = people("Expired")
    auth_service.logout(person["token"])

    answer = client_for(person["token"]).get("/api/mcdc/forms")

    assert answer.status_code == 401


def test_a_valid_account_gets_through(surveyor):
    answer = surveyor["client"].get("/api/mcdc/forms")

    assert answer.status_code == 200
    assert [f["form_id"] for f in answer.json()] == [surveyor["form_id"]]


# --------------------------------------------------------------------------- #
# what the gateway does not decide
# --------------------------------------------------------------------------- #
def test_permission_is_still_the_applications_answer(surveyor, people):
    """The gateway lets the request in. What happens next is not its business."""
    outsider = people("Nobody")

    # Through the boundary, refused by the handler — as an unreachable project.
    assert client_for(outsider["token"]).get(
        f"/api/forms/{surveyor['form_id']}/published").status_code == 404
    # And `mcdc.manage` is still what the routing table takes.
    assert client_for(outsider["token"]).get("/api/mcdc/routes").status_code == 403


def test_another_projects_form_is_no_more_reachable_through_the_gateway(
        surveyor, forms, projects, people):
    other = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(other)
    theirs = _form(forms, project=other)

    answer = surveyor["client"].post(f"/api/forms/{theirs}/submissions",
                                     json={"data": {"farmer_name": "R"}})

    assert answer.status_code == 404


def test_nothing_in_the_body_moves_the_boundary(surveyor, forms, projects):
    """A role in a payload is text. Identity comes from the token."""
    other = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(other)
    theirs = _form(forms, project=other)

    answer = surveyor["client"].post(
        f"/api/forms/{theirs}/submissions",
        json={"data": {"farmer_name": "R"}, "role": "admin",
              "permissions": ["*"], "user_id": "USR00001",
              "project_id": surveyor["project"]})

    assert answer.status_code == 404


def test_the_author_is_the_token_not_the_body(surveyor):
    surveyor["client"].post(f"/api/forms/{surveyor['form_id']}/submissions",
                            json={"data": {"farmer_name": "Ramesh"},
                                  "created_by": "Somebody Else"})

    table = form_service.get_form(surveyor["form_id"])["form_json"]["table_name"]
    with transaction() as cur:
        cur.execute(sql.SQL("SELECT created_by FROM {}").format(sql.Identifier(table)))
        assert cur.fetchone()["created_by"] == "Shrishti"


# --------------------------------------------------------------------------- #
# where a request may go
# --------------------------------------------------------------------------- #
def test_something_unrecognised_in_the_channel_namespace_is_not_served(surveyor):
    answer = surveyor["client"].get("/api/mcdc/anything-else")

    assert answer.status_code == 404
    assert answer.json()["error"]["code"] == "ROUTE_NOT_ALLOWED"


def test_the_builders_own_routes_are_not_behind_this_boundary(surveyor, forms,
                                                              editor_client):
    """Guarding all of /api/forms/ would have put the builder behind a channel's
    throttle — and refused every builder route this allowlist does not name."""
    # A system form, so this is about the boundary and not about membership.
    system_form = _form(forms)
    versions = editor_client.get(f"/api/forms/{system_form}/versions")

    assert versions.status_code == 200
    assert isinstance(versions.json(), list)
    # And a project form the account cannot reach is refused by the handler,
    # in the handler's own words — not turned into a gateway error.
    theirs = editor_client.get(f"/api/forms/{surveyor['form_id']}/versions")
    assert theirs.status_code == 404
    assert "error" not in theirs.json()


@pytest.mark.parametrize("path", [
    "/api/mcdc/../users",
    "/api/mcdc/forms/../../users",
    "/api/forms/FRM1/submissions/../../../users",
    "/api/mcdc/http://example.com/x",
    "/api/mcdc/forms%2F..%2F..%2Fusers",
    "/api/forms/..%2F..%2Fadmin/published",
])
def test_no_path_reaches_something_it_was_not_meant_to(path, surveyor):
    """There is nothing to point anywhere: the allowlist is exact patterns."""
    answer = surveyor["client"].get(path)

    # Either the client resolved the dots before sending — in which case the
    # path was never a traversal — or the boundary refused it. Neither reaches
    # anything it was not meant to.
    assert answer.status_code in (307, 403, 404)
    if answer.status_code == 404 and "error" in answer.json():
        assert answer.json()["error"]["code"] == "ROUTE_NOT_ALLOWED"
    assert "user_id" not in answer.text and "email" not in answer.text


def test_there_is_no_endpoint_that_takes_a_destination():
    """No open proxy, because there is nowhere to name."""
    from app.main import app

    for route in app.routes:
        path = getattr(route, "path", "")
        assert "{url}" not in path and "{target}" not in path
        assert not path.startswith("/gateway/")

    # And nothing in the boundary calls out over HTTP at all: there is no
    # upstream to point at, because the upstream is this process.
    import inspect

    source = inspect.getsource(gateway)
    for calling_out in ("httpx.", "requests.get", "requests.post", "urlopen",
                        "aiohttp"):
        assert calling_out not in source


def test_the_administration_of_forms_is_not_behind_this_boundary(surveyor,
                                                                 editor_client):
    """Building a form is not channel traffic, and is not throttled as if it were."""
    listed = editor_client.get("/api/forms")
    assert listed.status_code == 200
    assert "X-Request-ID" in listed.headers


# --------------------------------------------------------------------------- #
# the shape of a request
# --------------------------------------------------------------------------- #
def test_a_body_that_is_not_json_is_refused_before_anything_else(surveyor):
    answer = surveyor["client"].post(
        f"/api/forms/{surveyor['form_id']}/submissions",
        content=b"{not json at all",
        headers={"Content-Type": "application/json"})

    assert answer.status_code == 400
    assert answer.json()["error"]["code"] == "INVALID_REQUEST"


def test_a_body_that_is_not_an_object_is_refused(surveyor):
    answer = surveyor["client"].post(f"/api/forms/{surveyor['form_id']}/submissions",
                                     json=["not", "an", "object"])

    assert answer.status_code == 400
    assert answer.json()["error"]["code"] == "INVALID_REQUEST"


def test_a_content_type_that_is_not_json_is_refused(surveyor):
    answer = surveyor["client"].post(
        f"/api/forms/{surveyor['form_id']}/submissions",
        content=b"farmer_name=Ramesh",
        headers={"Content-Type": "application/x-www-form-urlencoded"})

    assert answer.status_code == 415
    assert answer.json()["error"]["code"] == "INVALID_REQUEST"


def test_a_body_too_large_is_refused_without_being_processed(surveyor,
                                                             monkeypatch):
    monkeypatch.setattr(settings, "mcdc_gateway_max_body_mb", 1)

    answer = surveyor["client"].post(
        f"/api/forms/{surveyor['form_id']}/submissions",
        json={"data": {"farmer_name": "R" * (1024 * 1024 + 100)}})

    assert answer.status_code == 413
    assert answer.json()["error"]["code"] == "REQUEST_TOO_LARGE"
    assert "presigned" in answer.json()["error"]["message"]

    table = form_service.get_form(surveyor["form_id"])["form_json"]["table_name"]
    with transaction() as cur:
        cur.execute(sql.SQL("SELECT count(*) n FROM {}").format(sql.Identifier(table)))
        assert cur.fetchone()["n"] == 0


@pytest.mark.parametrize("body, why", [
    ({"channel": "telegram", "data": {}}, "channel"),
    ({"channel": "mobile", "form_version": "three", "data": {}}, "form_version"),
    ({"survey_id": "../../etc/passwd", "data": {}}, "survey id"),
    ({"data": "not an object"}, "object of answers"),
])
def test_an_envelope_that_could_not_be_a_submission_is_refused(body, why, surveyor):
    answer = surveyor["client"].post(
        f"/api/forms/{surveyor['form_id']}/submissions", json=body)

    assert answer.status_code == 400
    assert answer.json()["error"]["code"] == "INVALID_REQUEST"
    assert why in answer.json()["error"]["message"]


def test_a_form_id_that_is_not_one_never_reaches_a_handler(surveyor):
    answer = surveyor["client"].post(
        "/api/forms/not a form id at all/submissions", json={"data": {}})

    assert answer.status_code == 404
    assert answer.json()["error"]["code"] == "ROUTE_NOT_ALLOWED"


def test_the_gateway_does_not_do_the_forms_validation_for_it(surveyor):
    """Structurally fine, and still refused — by the submission service."""
    answer = surveyor["client"].post(
        f"/api/forms/{surveyor['form_id']}/submissions",
        json={"channel": "mobile", "form_version": 1, "data": {}})

    assert answer.status_code == 422
    assert "farmer_name" in str(answer.json()["detail"]["errors"])


def test_an_idempotency_key_is_checked_for_shape_and_left_alone(surveyor):
    bad = surveyor["client"].post(
        f"/api/forms/{surveyor['form_id']}/submissions/start",
        headers={"Idempotency-Key": "a key with spaces and \\n newlines"})
    assert bad.status_code == 400
    assert bad.json()["error"]["code"] == "INVALID_REQUEST"

    good = surveyor["client"].post(
        f"/api/forms/{surveyor['form_id']}/submissions/start",
        headers={"Idempotency-Key": "mobile:2026-09-05:abc123"})
    assert good.status_code == 201


# --------------------------------------------------------------------------- #
# how often
# --------------------------------------------------------------------------- #
def test_under_the_limit_everything_goes_through(surveyor, monkeypatch):
    monkeypatch.setattr(settings, "mcdc_gateway_rate_limit", 5)

    for _ in range(5):
        assert surveyor["client"].get("/api/mcdc/forms").status_code == 200


def test_over_the_limit_is_refused_with_how_long_to_wait(surveyor, monkeypatch):
    monkeypatch.setattr(settings, "mcdc_gateway_rate_limit", 3)
    monkeypatch.setattr(settings, "mcdc_gateway_rate_window_seconds", 60)

    for _ in range(3):
        assert surveyor["client"].get("/api/mcdc/forms").status_code == 200

    answer = surveyor["client"].get("/api/mcdc/forms")

    assert answer.status_code == 429
    assert answer.json()["error"]["code"] == "RATE_LIMITED"
    assert 1 <= int(answer.headers["Retry-After"]) <= 61
    assert answer.json()["request_id"]


def test_one_busy_caller_does_not_throttle_everybody(surveyor, people,
                                                     monkeypatch):
    """The whole reason the counter is per principal."""
    monkeypatch.setattr(settings, "mcdc_gateway_rate_limit", 2)

    other = people("Piyush")
    project_service.add_member(surveyor["project"], other["user_id"],
                               _role_id("surveyor"))

    for _ in range(2):
        surveyor["client"].get("/api/mcdc/forms")
    assert surveyor["client"].get("/api/mcdc/forms").status_code == 429

    # Somebody else's allowance is their own.
    assert client_for(other["token"]).get("/api/mcdc/forms").status_code == 200


def test_two_callers_on_one_platform_credential_are_counted_apart(monkeypatch):
    """A platform holds one token for thousands of people.

    Counting the token alone would let one talkative caller use up everybody's
    allowance, which is why the caller is part of the key.
    """
    monkeypatch.setattr(settings, "mcdc_gateway_rate_limit", 1)

    class FakeRequest:
        def __init__(self, identity=None):
            self.headers = {"authorization": "Bearer platform-token"}
            self.query_params = {"identity": identity} if identity else {}
            self.client = None

    first = gateway.principal(FakeRequest("+52155500111"), None)
    second = gateway.principal(FakeRequest("+52155500222"), None)
    same_again = gateway.principal(FakeRequest("+52155500111"), None)

    assert first != second
    assert first == same_again
    assert gateway.limiter.check(first) is None
    assert gateway.limiter.check(second) is None      # not the same allowance
    assert gateway.limiter.check(first) is not None   # this one is spent


def test_a_key_never_contains_the_credential_it_counts():
    class FakeRequest:
        headers = {"authorization": "Bearer super-secret-token"}
        query_params = {"identity": "+521555000111"}
        client = None

    key = gateway.principal(FakeRequest(), {"channel_identity": "+521555000111"})

    assert "super-secret-token" not in key
    assert "+521555000111" not in key


def test_throttling_can_be_switched_off(surveyor, monkeypatch):
    monkeypatch.setattr(settings, "mcdc_gateway_rate_limit", 0)

    for _ in range(30):
        assert surveyor["client"].get("/api/mcdc/forms").status_code == 200


def test_the_limiter_is_an_abstraction_a_shared_one_can_replace():
    """Documented in MCDC_GATEWAY.md: more than one instance needs a shared store."""
    assert isinstance(gateway.limiter, gateway.RateLimiter)
    assert isinstance(gateway.limiter, gateway.InMemoryRateLimiter)
    assert hasattr(gateway.RateLimiter, "check")


# --------------------------------------------------------------------------- #
# what comes back
# --------------------------------------------------------------------------- #
def test_every_answer_carries_a_request_id(surveyor):
    answer = surveyor["client"].get("/api/mcdc/forms")

    assert answer.headers["X-Request-ID"]
    assert answer.headers["Cache-Control"] == "no-store"


def test_a_client_may_bring_its_own_request_id(surveyor):
    answer = surveyor["client"].get("/api/mcdc/forms",
                                    headers={"X-Request-ID": "mobile-42:abc"})

    assert answer.headers["X-Request-ID"] == "mobile-42:abc"


def test_a_request_id_that_could_forge_a_log_line_is_replaced(surveyor):
    answer = surveyor["client"].get(
        "/api/mcdc/forms",
        headers={"X-Request-ID": "abc\\nWARNING gateway: fake line"})

    assert "\\n" not in answer.headers["X-Request-ID"]
    assert "fake line" not in answer.headers["X-Request-ID"]


def test_nothing_anybody_answered_reaches_the_log(surveyor, caplog):
    import logging

    with caplog.at_level(logging.INFO, logger="gateway"):
        surveyor["client"].post(
            f"/api/forms/{surveyor['form_id']}/submissions",
            headers={"Authorization": f"Bearer {surveyor['person']['token']}"},
            json={"channel": "mobile", "data": {"farmer_name": "Ramesh Kumar"}})

    written = "\\n".join(r.message for r in caplog.records if r.name == "gateway")

    assert written                              # something was logged
    # The metadata an operator needs...
    assert surveyor["form_id"] in written and "'status_code': 201" in written
    assert "'channel': 'mobile'" in written
    # ...and nothing that belongs to the person who answered.
    assert "Ramesh" not in written
    assert surveyor["person"]["token"] not in written
    assert "farmer_name" not in written


def test_an_error_says_what_went_wrong_and_nothing_else(surveyor, monkeypatch):
    monkeypatch.setattr(settings, "mcdc_gateway_rate_limit", 1)
    surveyor["client"].get("/api/mcdc/forms")

    answer = surveyor["client"].get("/api/mcdc/forms")

    body = answer.text
    assert "Traceback" not in body and "psycopg2" not in body
    assert settings.db_password not in body if settings.db_password else True
    assert set(answer.json()) == {"error", "request_id"}
    assert set(answer.json()["error"]) == {"code", "message"}


# --------------------------------------------------------------------------- #
# and it changed nothing about the way in
# --------------------------------------------------------------------------- #
def test_the_web_application_fills_forms_in_exactly_as_before(surveyor):
    client = surveyor["client"]
    form_id = surveyor["form_id"]

    assert client.get("/api/mcdc/forms").status_code == 200
    assert client.get(f"/api/forms/{form_id}/published").status_code == 200

    stored = client.post(f"/api/forms/{form_id}/submissions",
                         json={"data": {"farmer_name": "Ramesh"}})

    assert stored.status_code == 201
    assert stored.json()["survey_id"] == "000001"


def test_media_control_requests_pass_and_the_bytes_never_do(surveyor):
    """The upload itself goes to S3 on a presigned URL, around this boundary."""
    from unittest.mock import patch

    from app.modules.forms import media_service

    client = surveyor["client"]
    form_id = surveyor["form_id"]
    survey_id = client.post(
        f"/api/forms/{form_id}/submissions/start").json()["survey_id"]

    with patch.object(media_service, "presign_upload",
                      lambda key, ctype: f"https://s3.test/PUT/{key}"):
        asked = client.post(
            f"/api/forms/{form_id}/submissions/{survey_id}/media/upload-url",
            json={"field_name": "farmer_name", "filename": "p.jpg",
                  "content_type": "image/jpeg"})

    # Refused because that field takes no upload — by the media service, having
    # passed the boundary. What matters is that the request got there.
    assert asked.status_code == 422
    assert "does not take an upload" in str(asked.json())
