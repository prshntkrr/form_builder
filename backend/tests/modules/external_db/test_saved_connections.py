"""Saved connections: usable again later, and never handing the credential back.

Two kinds of source are saved here: this installation's own PostgreSQL,
described as though it were somebody else's (so a saved connection is really
opened), and a Databricks workspace played by an httpx MockTransport. Every
credential in this file is made up, and most of these tests exist to prove that
one never comes out again — not from a route, not from a log line, not from an
error, not from the import history.
"""
import json
import logging
import uuid

import httpx
import pytest
from psycopg2 import sql

from app.core import auth_service, secrets
from app.core.config import settings
from app.core.database import ping, transaction
from app.modules.external_db import connection_store, connections, databricks, import_service
from app.modules.external_db.connections import ExternalDbError

from test_databricks import HOST, TOKEN, Warehouse, spec as dbx_spec

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"
KEY = "test-secret-key-that-is-long-enough-for-sealing-values"


@pytest.fixture(autouse=True)
def key(monkeypatch):
    """A key to seal with. A real installation sets SECRET_KEY; a test says so."""
    monkeypatch.setattr(settings, "secret_key", KEY)


@pytest.fixture
def warehouse(monkeypatch):
    fake = Warehouse()
    monkeypatch.setattr(databricks, "transport", httpx.MockTransport(fake))
    monkeypatch.setattr(databricks, "POLL_SECONDS", 0)
    return fake


@pytest.fixture(autouse=True)
def cleaned():
    """Whatever these tests saved or imported, removed afterwards."""
    with transaction() as cur:
        cur.execute("SELECT COALESCE(MAX(connection_id), 0) AS c, "
                    "(SELECT COALESCE(MAX(import_id), 0) FROM external_import) AS i "
                    "FROM external_connection")
        top = dict(cur.fetchone())
    yield
    with transaction() as cur:
        cur.execute("DELETE FROM external_import WHERE import_id > %s", (top["i"],))
        cur.execute("DELETE FROM external_connection WHERE connection_id > %s", (top["c"],))


def people(name, role="admin"):
    """An account, and a client signed in as it."""
    from fastapi.testclient import TestClient

    from app.core.bootstrap import ensure_admin_holds_everything
    from app.main import app

    ensure_admin_holds_everything()
    email = f"{name}.{uuid.uuid4().hex[:8]}@example.test"
    user = auth_service.create_user(email, PASSWORD, role=role, full_name=name)
    client = TestClient(app, headers={
        "Authorization": f"Bearer {auth_service.login(email, PASSWORD)['token']}"})
    return user, client


@pytest.fixture
def admin():
    user, client = people("Importer")
    try:
        yield user, client
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user["user_id"],))


def local_source(**change):
    """This database, described as though it were somebody else's."""
    return {"db_type": "postgresql", "host": settings.db_host, "port": settings.db_port,
            "database": settings.db_name, "username": settings.db_user,
            "password": settings.db_password, "name": "Local Postgres", **change}


def stored_secret(connection_id):
    with transaction() as cur:
        cur.execute("SELECT secret FROM external_connection WHERE connection_id = %s",
                    (connection_id,))
        row = cur.fetchone()
    return row["secret"] if row else None


# --------------------------------------------------------------------------- #
# sealing, on its own
# --------------------------------------------------------------------------- #
def test_a_sealed_value_comes_back_and_looks_like_nothing(key):
    sealed = secrets.seal("dapi-super-secret", aad="external_connection:1")
    assert "dapi-super-secret" not in sealed
    assert secrets.unseal(sealed, aad="external_connection:1") == "dapi-super-secret"
    # Sealing the same thing twice gives different bytes: fresh salt and nonce.
    assert secrets.seal("dapi-super-secret", aad="external_connection:1") != sealed


def test_a_sealed_value_will_not_open_elsewhere_or_under_another_key(key, monkeypatch):
    sealed = secrets.seal("token", aad="external_connection:1")
    with pytest.raises(secrets.SecretTampered):
        secrets.unseal(sealed, aad="external_connection:2")     # moved to another row
    with pytest.raises(secrets.SecretTampered):
        secrets.unseal(sealed[:-4] + "AAAA", aad="external_connection:1")   # edited
    monkeypatch.setattr(settings, "secret_key", "another-key-of-more-than-32-characters!!")
    with pytest.raises(secrets.SecretTampered):
        secrets.unseal(sealed, aad="external_connection:1")


def test_without_a_key_nothing_is_stored_in_the_clear(monkeypatch, admin, warehouse):
    monkeypatch.setattr(settings, "secret_key", "")
    _, client = admin
    answer = client.post("/api/external-db/connections", json=dbx_spec(name="No key"))
    assert answer.status_code == 422
    assert "SECRET_KEY" in answer.json()["detail"]["message"]
    with transaction() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM external_connection WHERE name = 'No key'")
        assert cur.fetchone()["n"] == 0


# --------------------------------------------------------------------------- #
# saving, listing, reading
# --------------------------------------------------------------------------- #
def test_saving_tests_the_credential_first(admin, warehouse):
    _, client = admin
    warehouse.status = 401

    answer = client.post("/api/external-db/connections", json=dbx_spec(name="Bad token"))

    assert answer.status_code == 502
    assert TOKEN not in answer.text
    with transaction() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM external_connection WHERE name = 'Bad token'")
        assert cur.fetchone()["n"] == 0


def test_a_saved_connection_answers_with_metadata_and_never_the_credential(admin, warehouse):
    _, client = admin
    made = client.post("/api/external-db/connections",
                       json=dbx_spec(name="Client Databricks", db_schema="e-agrology"))
    assert made.status_code == 201
    body = made.json()
    saved_id = body["connection_id"]

    assert body["name"] == "Client Databricks" and body["db_type"] == "databricks"
    assert body["host"] == HOST and body["catalog"] == "main"
    assert body["db_schema"] == "e-agrology" and body["warehouse_id"] == "abc123def456"
    assert body["credential_configured"] is True and body["enabled"] is True
    assert body["created_by"] == "Importer" and body["created_on"] and body["updated_on"]

    listed = client.get("/api/external-db/connections")
    one = client.get(f"/api/external-db/connections/{saved_id}")
    for answer in (made, listed, one):
        assert TOKEN not in answer.text
        assert "token" not in answer.json() if answer is one else True
    for shown in (one.json(), listed.json()["connections"][0]):
        assert set(shown) & {"token", "password", "secret"} == set()
        assert shown["credential_configured"] is True

    # What is in the table is sealed, and opens only with the key.
    sealed = stored_secret(saved_id)
    assert sealed and TOKEN not in sealed
    assert secrets.unseal(sealed, aad=f"external_connection:{saved_id}") == TOKEN


def test_nothing_written_to_the_log_carries_a_stored_credential(admin, warehouse, caplog):
    caplog.set_level(logging.DEBUG)
    _, client = admin
    made = client.post("/api/external-db/connections", json=dbx_spec(name="Logged"))
    saved = made.json()["connection_id"]
    client.post("/api/external-db/tables",
                json={"connection": {"connection_id": saved}, "schema": "field_ops"})
    client.patch(f"/api/external-db/connections/{saved}", json={"name": "Logged twice"})
    assert TOKEN not in caplog.text


# --------------------------------------------------------------------------- #
# using one
# --------------------------------------------------------------------------- #
def test_the_browser_sends_only_an_id_and_everything_still_works(admin, warehouse):
    _, client = admin
    saved = client.post("/api/external-db/connections",
                        json=dbx_spec(name="By id")).json()["connection_id"]
    body = {"connection": {"connection_id": saved}}

    assert client.post("/api/external-db/test-connection",
                       json={"connection_id": saved}).json()["success"] is True
    assert "field_ops" in client.post("/api/external-db/schemas", json=body).json()["schemas"]
    tables = client.post("/api/external-db/tables", json={**body, "schema": "field_ops"})
    assert "farmers" in [t["name"] for t in tables.json()["tables"]]
    shown = client.post("/api/external-db/preview",
                        json={**body, "schema": "field_ops", "table": "farmers"})
    assert shown.json()["rows"]
    # The token went to Databricks in a header, and nowhere else.
    assert all(r.headers.get("authorization") == f"Bearer {TOKEN}"
               for r in warehouse.requests if r.url.host == HOST)
    for answer in (tables, shown):
        assert TOKEN not in answer.text


def test_an_import_by_id_records_the_connection_without_the_credential(admin, warehouse):
    _, client = admin
    made = client.post("/api/external-db/connections", json=dbx_spec(name="Client lake")).json()
    destination = f"dbx_saved_{uuid.uuid4().hex[:8]}"
    try:
        done = client.post("/api/external-db/load", json={
            "connection": {"connection_id": made["connection_id"]},
            "schema": "field_ops", "table": "farmers", "destination_table": destination})
        assert done.status_code == 200 and done.json()["rows_loaded"] == 3

        history = client.get("/api/external-db/imports").json()["imports"]
        mine = next(i for i in history if i["destination_table"] == destination)
        assert mine["connection_id"] == made["connection_id"]
        assert mine["connection"] == "Client lake" and mine["status"] == "succeeded"
        assert set(mine) & {"token", "password", "secret"} == set()
        assert TOKEN not in json.dumps(history)
    finally:
        with transaction() as cur:
            cur.execute(sql.SQL("DROP TABLE IF EXISTS {}").format(sql.Identifier(destination)))


def test_a_saved_postgres_connection_is_really_opened(admin):
    """Not only Databricks: the same store holds a password, and it works."""
    user, client = admin
    made = client.post("/api/external-db/connections", json=local_source())
    assert made.status_code == 201
    saved = made.json()["connection_id"]
    assert settings.db_password not in made.text

    schemas = client.post("/api/external-db/schemas", json={"connection": {"connection_id": saved}})
    assert "public" in schemas.json()["schemas"]
    assert settings.db_password not in schemas.text
    assert connection_store.spec_for(user, saved)["password"] == settings.db_password


# --------------------------------------------------------------------------- #
# changing one
# --------------------------------------------------------------------------- #
def test_an_update_without_a_credential_keeps_the_stored_one(admin, warehouse):
    _, client = admin
    saved = client.post("/api/external-db/connections",
                        json=dbx_spec(name="Before")).json()["connection_id"]
    before = stored_secret(saved)

    changed = client.patch(f"/api/external-db/connections/{saved}", json={
        "name": "After", "catalog": "silver", "db_schema": "e-agrology"})

    assert changed.status_code == 200
    assert changed.json()["name"] == "After" and changed.json()["catalog"] == "silver"
    assert changed.json()["credential_configured"] is True
    assert stored_secret(saved) == before
    assert TOKEN not in changed.text


def test_a_new_credential_replaces_the_old_one_only_after_it_works(admin, warehouse):
    _, client = admin
    saved = client.post("/api/external-db/connections",
                        json=dbx_spec(name="Rotating")).json()["connection_id"]
    before = stored_secret(saved)

    # A token Databricks refuses changes nothing.
    warehouse.status = 401
    refused = client.patch(f"/api/external-db/connections/{saved}", json={"token": "dapiWRONG"})
    assert refused.status_code == 502
    assert stored_secret(saved) == before
    assert "dapiWRONG" not in refused.text

    # One it accepts replaces it.
    warehouse.status = 200
    accepted = client.patch(f"/api/external-db/connections/{saved}", json={"token": TOKEN + "-new"})
    assert accepted.status_code == 200 and accepted.json()["credential_configured"] is True
    assert stored_secret(saved) != before
    assert secrets.unseal(stored_secret(saved),
                          aad=f"external_connection:{saved}") == TOKEN + "-new"
    assert TOKEN not in accepted.text


def test_a_disabled_connection_cannot_be_used(admin, warehouse):
    _, client = admin
    saved = client.post("/api/external-db/connections",
                        json=dbx_spec(name="Paused")).json()["connection_id"]

    off = client.patch(f"/api/external-db/connections/{saved}", json={"enabled": False})
    assert off.json()["enabled"] is False

    refused = client.post("/api/external-db/schemas",
                          json={"connection": {"connection_id": saved}})
    assert refused.status_code == 409
    assert "turned off" in refused.json()["detail"]["message"]
    # Still listed, still holding its credential, ready to be turned back on.
    assert client.get(f"/api/external-db/connections/{saved}").json()["credential_configured"]
    assert client.patch(f"/api/external-db/connections/{saved}",
                        json={"enabled": True}).json()["enabled"] is True
    assert client.post("/api/external-db/schemas",
                       json={"connection": {"connection_id": saved}}).status_code == 200


def test_a_deleted_connection_takes_its_credential_and_cannot_be_used(admin, warehouse):
    _, client = admin
    saved = client.post("/api/external-db/connections",
                        json=dbx_spec(name="Going")).json()["connection_id"]

    gone = client.delete(f"/api/external-db/connections/{saved}")

    assert gone.status_code == 200 and gone.json()["deleted"] is True
    assert stored_secret(saved) is None
    assert client.get(f"/api/external-db/connections/{saved}").status_code == 404
    refused = client.post("/api/external-db/schemas", json={"connection": {"connection_id": saved}})
    assert refused.status_code == 404


def test_deleting_a_connection_keeps_what_it_imported(admin, warehouse):
    _, client = admin
    saved = client.post("/api/external-db/connections",
                        json=dbx_spec(name="Temporary")).json()["connection_id"]
    destination = f"dbx_keep_{uuid.uuid4().hex[:8]}"
    try:
        client.post("/api/external-db/load", json={
            "connection": {"connection_id": saved}, "schema": "field_ops",
            "table": "farmers", "destination_table": destination})
        client.delete(f"/api/external-db/connections/{saved}")

        with transaction() as cur:
            cur.execute(sql.SQL("SELECT COUNT(*) AS n FROM {}").format(sql.Identifier(destination)))
            assert cur.fetchone()["n"] == 3
        mine = next(i for i in client.get("/api/external-db/imports").json()["imports"]
                    if i["destination_table"] == destination)
        assert mine["status"] == "succeeded" and mine["connection_id"] is None
    finally:
        with transaction() as cur:
            cur.execute(sql.SQL("DROP TABLE IF EXISTS {}").format(sql.Identifier(destination)))


def test_a_connection_survives_a_restart(admin, warehouse):
    """Nothing is held in memory: a fresh read of the row is enough to use it."""
    user, client = admin
    saved = client.post("/api/external-db/connections",
                        json=dbx_spec(name="Persistent")).json()["connection_id"]

    # As a new process would: straight from the table, with only the key.
    spec = connection_store.spec_for(user, saved)
    assert spec["token"] == TOKEN and spec["host"] == HOST
    assert connections.test(spec)["success"] is True


# --------------------------------------------------------------------------- #
# whose it is
# --------------------------------------------------------------------------- #
@pytest.fixture
def importer_role():
    """A role that may import, and nothing else — an account outside a project.

    Not an administrator: an administrator reaches every project by design
    (`projects.view_all`), so the one who must be shut out of a project's
    connection is somebody whose reach comes only from membership.
    """
    from app.core import role_service
    from app.modules.external_db.permissions import EXTERNAL_DB_IMPORT

    role = role_service.create_role(f"Importer {uuid.uuid4().hex[:6]}",
                                    permission_keys=[EXTERNAL_DB_IMPORT],
                                    created_by="tests")
    yield role["name"]
    with transaction() as cur:
        cur.execute("DELETE FROM role_permission WHERE role_id = %s", (role["role_id"],))
        cur.execute("DELETE FROM app_role WHERE role_id = %s", (role["role_id"],))


@pytest.fixture
def project(importer_role):
    """A project with one member, and somebody outside it who may still import."""
    from app.modules.projects import project_service

    owner, owner_client = people("Owner", role=importer_role)
    outsider, outsider_client = people("Outsider", role=importer_role)
    made = project_service.create_project(f"Saved {uuid.uuid4().hex[:6]}", created_by="tests")
    project_id = made["project_id"]
    with transaction() as cur:
        cur.execute("SELECT role_id FROM app_role WHERE name = %s", ("project_manager",))
        role_id = cur.fetchone()["role_id"]
    project_service.add_member(project_id, owner["user_id"], role_id, added_by="tests")
    try:
        yield project_id, owner_client, outsider_client
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM project_member WHERE project_id = %s", (project_id,))
            cur.execute("DELETE FROM project WHERE project_id = %s", (project_id,))
            for account in (owner, outsider):
                cur.execute("DELETE FROM app_user WHERE user_id = %s", (account["user_id"],))


def test_a_projects_connection_is_not_another_accounts_to_use(project, warehouse):
    project_id, owner, outsider = project
    saved = owner.post("/api/external-db/connections",
                       json=dbx_spec(name="Project lake", project_id=project_id))
    assert saved.status_code == 201, saved.text
    connection_id = saved.json()["connection_id"]

    # The member sees it and can use it.
    assert [c["connection_id"] for c in owner.get("/api/external-db/connections").json()
            ["connections"]].count(connection_id) == 1
    assert owner.post("/api/external-db/schemas",
                      json={"connection": {"connection_id": connection_id}}).status_code == 200

    # Somebody outside the project is answered as though it did not exist —
    # listing it, reading it, using it, changing it or deleting it.
    assert connection_id not in [c["connection_id"] for c in
                                 outsider.get("/api/external-db/connections").json()["connections"]]
    assert outsider.get(f"/api/external-db/connections/{connection_id}").status_code == 404
    assert outsider.post("/api/external-db/schemas",
                         json={"connection": {"connection_id": connection_id}}).status_code == 404
    assert outsider.patch(f"/api/external-db/connections/{connection_id}",
                          json={"name": "Mine now"}).status_code == 404
    assert outsider.delete(f"/api/external-db/connections/{connection_id}").status_code == 404
    assert stored_secret(connection_id)


def test_a_connection_cannot_be_saved_into_a_project_you_are_not_in(project, warehouse):
    project_id, _owner, outsider = project
    refused = outsider.post("/api/external-db/connections",
                            json=dbx_spec(name="Sneaking", project_id=project_id))
    assert refused.status_code == 422
    assert "not a member" in refused.json()["detail"]["message"]


def test_the_routes_need_the_permission():
    from fastapi.testclient import TestClient

    from app.main import app

    user, client = people("Nobody", role="standard")
    try:
        for method, path in (("get", "/api/external-db/connections"),
                             ("get", "/api/external-db/connections/1"),
                             ("delete", "/api/external-db/connections/1")):
            assert getattr(client, method)(path).status_code == 403
        assert client.post("/api/external-db/connections", json=local_source()).status_code == 403
        assert client.patch("/api/external-db/connections/1", json={}).status_code == 403
        assert TestClient(app).get("/api/external-db/connections").status_code == 401
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user["user_id"],))


def test_a_connection_that_was_never_saved_is_not_found(admin):
    _, client = admin
    assert client.get("/api/external-db/connections/999999").status_code == 404
    assert client.post("/api/external-db/schemas",
                       json={"connection": {"connection_id": 999999}}).status_code == 404


def test_typing_the_details_in_still_works_and_stores_nothing(admin):
    """The old way is untouched: nothing is saved unless somebody saves it."""
    _, client = admin
    with transaction() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM external_connection")
        before = cur.fetchone()["n"]

    answer = client.post("/api/external-db/test-connection", json=local_source())

    assert answer.status_code == 200 and answer.json()["success"] is True
    with transaction() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM external_connection")
        assert cur.fetchone()["n"] == before


def test_a_credential_sealed_under_another_key_is_said_plainly(admin, warehouse, monkeypatch):
    user, client = admin
    saved = client.post("/api/external-db/connections",
                        json=dbx_spec(name="Rotated key")).json()["connection_id"]

    monkeypatch.setattr(settings, "secret_key", "a-different-key-of-at-least-32-characters")
    with pytest.raises(ExternalDbError) as refused:
        connection_store.spec_for(user, saved)
    assert "different SECRET_KEY" in str(refused.value)
    assert TOKEN not in str(refused.value)
