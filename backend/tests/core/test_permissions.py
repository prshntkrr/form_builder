"""What each role can reach through the API."""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.core import auth_service
from app.core.auth_service import ROLE_ADMIN, ROLE_EDITOR, ROLE_FIELD, ROLE_STANDARD
from app.core.database import ping, transaction
from app.main import app

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


@pytest.fixture(scope="module")
def people(client):
    """One account per role, each with a live session."""
    made, tokens = [], {}
    for role in (ROLE_FIELD, ROLE_EDITOR, ROLE_ADMIN):
        email = f"{role}.{uuid.uuid4().hex[:8]}@example.test"
        user = auth_service.create_user(email, PASSWORD, role=role, full_name=f"A {role}")
        made.append(user["user_id"])
        tokens[role] = client.post(
            "/api/auth/login", json={"email": email, "password": PASSWORD}
        ).json()["token"]

    yield tokens

    with transaction() as cur:
        for user_id in made:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))


def as_role(tokens, role):
    return {"Authorization": f"Bearer {tokens[role]}"}


def call(client, method, path, headers=None):
    """GET takes no body; POST needs one even when it is ignored."""
    if method == "get":
        return client.get(path, headers=headers)
    return client.post(path, json={}, headers=headers)


# --- signed out ------------------------------------------------------------ #
@pytest.mark.parametrize("method,path", [
    ("get", "/api/forms"),
    ("post", "/api/forms"),
    ("get", "/api/forms/live/list"),
    ("get", "/api/standard-forms"),
    ("get", "/api/users"),
    ("get", "/api/roles"),
    ("get", "/api/auth/me"),
])
def test_everything_needs_a_session(client, method, path):
    assert call(client, method, path).status_code == 401


def test_health_stays_open(client):
    """A monitor must be able to reach it without credentials."""
    assert client.get("/api/health").status_code == 200


def test_a_bad_token_is_not_a_session(client):
    response = client.get("/api/auth/me", headers={"Authorization": "Bearer nonsense"})
    assert response.status_code == 401


def test_a_token_without_the_bearer_scheme_is_ignored(client, people):
    assert client.get(
        "/api/auth/me", headers={"Authorization": people[ROLE_ADMIN]}
    ).status_code == 401


# --- field officers -------------------------------------------------------- #
def test_a_field_officer_sees_only_live_forms(client, people):
    response = client.get("/api/forms/live/list", headers=as_role(people, ROLE_FIELD))
    assert response.status_code == 200
    for form in response.json():
        assert set(form) == {"form_id", "form_title", "form_description", "field_count"}, \
            "the builder's view must not leak through"


@pytest.mark.parametrize("method,path", [
    ("get", "/api/forms"),
    ("post", "/api/forms"),
    ("get", "/api/standard-forms"),
    ("post", "/api/forms/generate"),
])
def test_a_field_officer_cannot_reach_the_builder(client, people, method, path):
    response = call(client, method, path, as_role(people, ROLE_FIELD))
    assert response.status_code == 403
    # The refusal names the permission, not a role — roles are the installation's
    # to define, permissions are the app's.
    assert "permission" in response.json()["detail"]


def test_a_field_officer_cannot_manage_people(client, people):
    assert client.get("/api/users", headers=as_role(people, ROLE_FIELD)).status_code == 403


# --- editors --------------------------------------------------------------- #
def test_an_editor_can_use_the_builder(client, people):
    assert client.get("/api/forms", headers=as_role(people, ROLE_EDITOR)).status_code == 200
    assert client.get("/api/standard-forms",
                      headers=as_role(people, ROLE_EDITOR)).status_code == 200


def test_an_editor_cannot_manage_people(client, people):
    response = client.get("/api/users", headers=as_role(people, ROLE_EDITOR))
    assert response.status_code == 403
    assert "Manage users" in response.json()["detail"]


def test_an_editor_cannot_manage_roles(client, people):
    assert client.get("/api/roles", headers=as_role(people, ROLE_EDITOR)).status_code == 403


def test_an_editor_can_still_fill_forms(client, people):
    assert client.get("/api/forms/live/list",
                      headers=as_role(people, ROLE_EDITOR)).status_code == 200


# --- admins ---------------------------------------------------------------- #
def test_an_admin_reaches_everything(client, people):
    for path in ("/api/forms", "/api/standard-forms", "/api/users", "/api/roles",
                 "/api/forms/live/list"):
        assert client.get(path, headers=as_role(people, ROLE_ADMIN)).status_code == 200, path


def test_the_author_comes_from_the_session_not_the_body(client, people):
    """A caller cannot claim to be somebody else."""
    config = {"title": f"Authored {uuid.uuid4().hex[:6]}",
              "fields": [{"label": "A note", "type": "text"}]}
    created = client.post(
        "/api/forms",
        json={"form_json": config, "created_by": "somebody-else"},
        headers=as_role(people, ROLE_EDITOR),
    ).json()

    try:
        assert created["created_by"] != "somebody-else"
        assert created["created_by"] == "A editor"
    finally:
        from psycopg2 import sql
        from app.modules.forms.tabular_service import tabular_name
        table = created["table"]["table_name"]
        with transaction() as cur:
            for name in (tabular_name(table), table):
                cur.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(
                    sql.Identifier(name)))
            cur.execute(sql.SQL("DROP SEQUENCE IF EXISTS {}").format(
                sql.Identifier(f"{table[:43]}_survey_seq")))
            cur.execute("DELETE FROM forms WHERE form_id = %s", (created["form_id"],))


# --- managing people through the API --------------------------------------- #
def test_an_admin_can_create_and_reassign(client, people):
    email = f"made.{uuid.uuid4().hex[:8]}@example.test"
    created = client.post("/api/users", json={
        "email": email, "password": PASSWORD, "full_name": "Made By Admin", "role": ROLE_FIELD,
    }, headers=as_role(people, ROLE_ADMIN))
    assert created.status_code == 201
    user_id = created.json()["user_id"]

    try:
        promoted = client.patch(f"/api/users/{user_id}", json={"role": ROLE_EDITOR},
                                headers=as_role(people, ROLE_ADMIN))
        assert promoted.status_code == 200
        assert promoted.json()["role"] == ROLE_EDITOR

        # Switching an account off is its own action now: DELETE removes it for
        # good, and the two should not be one button.
        gone = client.post(f"/api/users/{user_id}/deactivate",
                           headers=as_role(people, ROLE_ADMIN))
        assert gone.status_code == 200
        assert gone.json()["is_active"] is False
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))


def test_a_duplicate_account_is_409(client, people):
    email = f"dupe.{uuid.uuid4().hex[:8]}@example.test"
    body = {"email": email, "password": PASSWORD, "role": ROLE_FIELD}
    first = client.post("/api/users", json=body, headers=as_role(people, ROLE_ADMIN))
    try:
        assert client.post("/api/users", json=body,
                           headers=as_role(people, ROLE_ADMIN)).status_code == 409
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (first.json()["user_id"],))


def test_an_admin_cannot_lock_themselves_out(client, people):
    me = client.get("/api/auth/me", headers=as_role(people, ROLE_ADMIN)).json()["user"]

    assert client.patch(f"/api/users/{me['user_id']}", json={"is_active": False},
                        headers=as_role(people, ROLE_ADMIN)).status_code == 400
    assert client.patch(f"/api/users/{me['user_id']}", json={"role": ROLE_FIELD},
                        headers=as_role(people, ROLE_ADMIN)).status_code == 400
    assert client.delete(f"/api/users/{me['user_id']}",
                         headers=as_role(people, ROLE_ADMIN)).status_code == 400


def test_the_roles_endpoint_describes_each_one(client, people):
    """The account-wide roles, and the ones a project membership can carry.

    Both live in `app_role` and draw on one permission catalogue — but they are
    offered separately, because they answer different questions. A system role
    says what an account may do across the installation; a project role says
    what somebody may do inside one project, and means nothing written on an
    account.
    """
    roles = client.get("/api/users/roles", headers=as_role(people, ROLE_ADMIN)).json()
    named = {r["role"] for r in roles}

    # The two system roles an account can be given.
    assert {ROLE_ADMIN, ROLE_STANDARD} <= named
    assert all(r["label"] for r in roles)

    # A project role means something inside one project and nothing on an
    # account, so it is never offered here. It is offered by
    # `GET /api/projects/roles`, where a membership can carry it.
    assert not {"project_manager", "surveyor", "reviewer"} & named

    project_roles = client.get("/api/projects/roles",
                               headers=as_role(people, ROLE_ADMIN)).json()["roles"]
    assert {"project_manager", "surveyor", "reviewer"} <= {r["name"] for r in project_roles}


# --- the session endpoints ------------------------------------------------- #
def test_me_reports_the_permissions_held(client, people):
    from app.modules.forms import permissions as form_perms

    for role, build, manage in ((ROLE_FIELD, False, False),
                                (ROLE_EDITOR, True, False),
                                (ROLE_ADMIN, True, True)):
        body = client.get("/api/auth/me", headers=as_role(people, role)).json()
        assert body["user"]["role"] == role
        assert body["can"]["build_forms"] is build
        assert body["can"]["manage_users"] is manage
        assert (form_perms.RECORDS_VIEW in body["permissions"]) is True


def test_signing_out_invalidates_the_token(client):
    email = f"bye.{uuid.uuid4().hex[:8]}@example.test"
    user = auth_service.create_user(email, PASSWORD, role=ROLE_FIELD)
    try:
        token = client.post("/api/auth/login",
                            json={"email": email, "password": PASSWORD}).json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        assert client.get("/api/auth/me", headers=headers).status_code == 200
        assert client.post("/api/auth/logout", headers=headers).status_code == 200
        assert client.get("/api/auth/me", headers=headers).status_code == 401
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user["user_id"],))


def test_a_wrong_password_is_401_with_one_message(client, people):
    response = client.post("/api/auth/login",
                           json={"email": "nobody@example.test", "password": "wrong"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Email or password is incorrect"


def test_forgot_password_never_says_whether_the_account_exists(client):
    known = client.post("/api/auth/forgot-password",
                        json={"email": "admin@e-agrology.local"}).json()
    unknown = client.post("/api/auth/forgot-password",
                          json={"email": "definitely-nobody@example.test"}).json()
    assert known["message"] == unknown["message"]
    assert "reset_link" not in unknown, "no link for an address with no account"
