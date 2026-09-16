"""Reading another database, and copying a table out of it.

The "external" database in these tests is this installation's own PostgreSQL,
reached the way any other would be — over TCP, with a host, a port and
credentials, through the same driver and the same code path. That is a real
integration test of everything except the MySQL dialect, which is covered by
unit tests on the type mapping so that the suite never depends on a MySQL
server being there.
"""
import logging
import re
import uuid

import pytest
from psycopg2 import sql

from app.core import auth_service
from app.core.config import settings
from app.core.database import ping, table_exists, transaction
from app.modules.external_db import connections, import_service

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"
SECRET = settings.db_password or "unset"

# The rows the source table holds, and what should arrive.
FARMERS = [
    (1, "Ramesh", "IN", "MAIZE", 2.5, True),
    (2, "Lucía", "MX", "WHEAT", 13.75, False),
    (3, "Grace", "KE", "RICE", None, True),
]


@pytest.fixture(scope="module", autouse=True)
def permission_seeded():
    """The administrator holds every permission — including a new one.

    Startup does this (`bootstrap.ensure_roles` -> `ensure_admin_holds_everything`),
    and a test client does not run startup. Calling the same function here is
    what makes these tests self-contained rather than dependent on the database
    having been through a server restart since this module was written.
    """
    from app.core.bootstrap import ensure_admin_holds_everything

    ensure_admin_holds_everything()


def source_connection() -> dict:
    """This database, described as though it were somebody else's."""
    return {"db_type": "postgresql", "host": settings.db_host,
            "port": settings.db_port, "database": settings.db_name,
            "username": settings.db_user, "password": settings.db_password}


@pytest.fixture
def source():
    """A table to copy, and its name."""
    name = f"ext_src_{uuid.uuid4().hex[:8]}"
    with transaction() as cur:
        cur.execute(sql.SQL("""
            CREATE TABLE {} (
                id INTEGER, farmer_name TEXT, country VARCHAR(2), crop TEXT,
                land_acres NUMERIC(6,2), active BOOLEAN,
                registered_on DATE DEFAULT CURRENT_DATE
            )""").format(sql.Identifier(name)))
        for row in FARMERS:
            cur.execute(sql.SQL(
                "INSERT INTO {} (id, farmer_name, country, crop, land_acres, active) "
                "VALUES (%s, %s, %s, %s, %s, %s)").format(sql.Identifier(name)), row)

    yield name

    with transaction() as cur:
        cur.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(sql.Identifier(name)))


@pytest.fixture
def destinations():
    """Whatever a test imported, dropped afterwards."""
    made = []
    yield made
    with transaction() as cur:
        for name in made:
            cur.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(
                sql.Identifier(name)))


@pytest.fixture
def standard_client():
    """An account with no `external_db.import`."""
    from fastapi.testclient import TestClient

    from app.main import app

    email = f"nobody.{uuid.uuid4().hex[:8]}@example.test"
    user = auth_service.create_user(email, PASSWORD, role="standard", full_name="Nobody")
    try:
        yield TestClient(app, headers={
            "Authorization": f"Bearer {auth_service.login(email, PASSWORD)['token']}"})
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user["user_id"],))


def rows_of(table: str):
    with transaction() as cur:
        cur.execute(sql.SQL("SELECT * FROM {} ORDER BY id").format(sql.Identifier(table)))
        return [dict(r) for r in cur.fetchall()]


def columns_of(table: str):
    with transaction() as cur:
        cur.execute("SELECT column_name, data_type FROM information_schema.columns "
                    "WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position",
                    (settings.db_schema, table))
        return {r["column_name"]: r["data_type"] for r in cur.fetchall()}


# --------------------------------------------------------------------------- #
# who may use it
# --------------------------------------------------------------------------- #
def test_an_account_without_the_permission_is_refused(standard_client):
    for path, body in (
        ("test-connection", source_connection()),
        ("schemas", {"connection": source_connection()}),
        ("tables", {"connection": source_connection(), "schema": "public"}),
        ("preview", {"connection": source_connection(), "schema": "public",
                     "table": "forms"}),
        ("load", {"connection": source_connection(), "schema": "public",
                  "table": "forms", "destination_table": "stolen"}),
    ):
        answer = standard_client.post(f"/api/external-db/{path}", json=body)
        assert answer.status_code == 403, path
        assert "permission" in answer.text.lower()


def test_signing_in_is_required():
    from fastapi.testclient import TestClient

    from app.main import app

    assert TestClient(app).post("/api/external-db/schemas", json={
        "connection": source_connection()}).status_code == 401


# --------------------------------------------------------------------------- #
# connecting
# --------------------------------------------------------------------------- #
def test_a_working_connection_says_so(admin_client):
    answer = admin_client.post("/api/external-db/test-connection",
                               json=source_connection())

    assert answer.status_code == 200
    assert answer.json() == {"success": True, "message": "Connection successful",
                             "db_type": "postgresql"}


def test_a_database_that_is_not_there_fails_without_driver_internals(admin_client):
    answer = admin_client.post("/api/external-db/test-connection", json={
        **source_connection(), "port": 1})

    assert answer.status_code == 502
    detail = answer.json()["detail"]
    assert detail["code"] == "EXTERNAL_DB_CONNECTION_FAILED"
    assert "Verify the host" in detail["message"]
    # Nothing from the driver, and nothing from the credentials.
    assert "Traceback" not in answer.text and "psycopg2" not in answer.text


@pytest.mark.parametrize("db_type", ["sqlserver", "oracle", "mongodb", "", "postgres;"])
def test_a_database_this_cannot_read_is_refused(db_type, admin_client):
    answer = admin_client.post("/api/external-db/test-connection",
                               json={**source_connection(), "db_type": db_type})

    assert answer.status_code == 422
    assert answer.json()["detail"]["code"] == "UNSUPPORTED_DB_TYPE"


@pytest.mark.parametrize("change, why", [
    ({"port": 0}, "between 1 and 65535"),
    ({"port": 99999}, "between 1 and 65535"),
    ({"host": ""}, "host name"),
    ({"host": "db.example.org; rm -rf /"}, "host name"),
    ({"database": ""}, "database name is required"),
])
def test_connection_details_that_cannot_be_used_are_refused(change, why, admin_client):
    answer = admin_client.post("/api/external-db/test-connection",
                               json={**source_connection(), **change})

    assert answer.status_code == 422
    assert why in answer.json()["detail"]["message"]


# --------------------------------------------------------------------------- #
# looking around
# --------------------------------------------------------------------------- #
def test_the_schemas_are_listed_without_the_servers_own(admin_client):
    body = admin_client.post("/api/external-db/schemas",
                             json={"connection": source_connection()}).json()

    assert settings.db_schema in body["schemas"]
    for internal in connections.POSTGRES_INTERNAL:
        assert internal not in body["schemas"]


def test_the_tables_of_one_schema_are_listed(source, admin_client):
    body = admin_client.post("/api/external-db/tables", json={
        "connection": source_connection(), "schema": settings.db_schema}).json()

    assert source in [t["name"] for t in body["tables"]]


def test_a_preview_shows_the_columns_and_a_few_rows(source, admin_client):
    body = admin_client.post("/api/external-db/preview", json={
        "connection": source_connection(), "schema": settings.db_schema,
        "table": source, "limit": 2}).json()

    assert body["table"] == source
    assert [c["name"] for c in body["columns"]] == [
        "id", "farmer_name", "country", "crop", "land_acres", "active", "registered_on"]
    assert body["columns"][0]["source_type"] == "integer"
    assert len(body["rows"]) == 2
    assert body["rows"][0]["farmer_name"] == "Ramesh"


def test_a_preview_is_never_the_whole_table(source, admin_client):
    body = admin_client.post("/api/external-db/preview", json={
        "connection": source_connection(), "schema": settings.db_schema,
        "table": source, "limit": 10_000}).json()

    assert body["row_limit"] == settings.external_db_preview_max


def test_a_table_that_is_not_there_says_so(admin_client):
    answer = admin_client.post("/api/external-db/preview", json={
        "connection": source_connection(), "schema": settings.db_schema,
        "table": "no_such_table_here", "limit": 5})

    assert answer.status_code == 404
    assert answer.json()["detail"]["code"] == "RESOURCE_NOT_FOUND"


@pytest.mark.parametrize("name", [
    "farmers; DROP TABLE forms",
    'farmers" ; DELETE FROM app_user --',
    "public.farmers",
    "*",
    "",
])
def test_a_name_that_is_not_a_name_never_reaches_a_query(name, admin_client):
    """The only SQL that runs is the SQL in this module."""
    for field in ("schema", "table"):
        body = {"connection": source_connection(), "schema": settings.db_schema,
                "table": "forms", "limit": 5}
        body[field] = name

        answer = admin_client.post("/api/external-db/preview", json=body)
        assert answer.status_code in (404, 422), (field, name)

    # And this application's own tables are still here.
    with transaction() as cur:
        assert table_exists(cur, "forms")
        assert table_exists(cur, "app_user")


# --------------------------------------------------------------------------- #
# copying it
# --------------------------------------------------------------------------- #
def test_a_table_is_copied_with_its_rows_and_sensible_types(source, destinations,
                                                            admin_client):
    into = f"imported_{uuid.uuid4().hex[:8]}"
    destinations.append(into)

    answer = admin_client.post("/api/external-db/load", json={
        "connection": source_connection(), "schema": settings.db_schema,
        "table": source, "destination_table": into})

    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["success"] is True
    assert body["rows_loaded"] == len(FARMERS)
    assert body["columns_loaded"] == 7
    assert body["destination"]["table"] == into
    assert body["source"] == {"schema": settings.db_schema, "table": source,
                              "db_type": "postgresql"}

    # The data itself, not just the count.
    copied = rows_of(into)
    assert [r["farmer_name"] for r in copied] == ["Ramesh", "Lucía", "Grace"]
    assert [r["country"] for r in copied] == ["IN", "MX", "KE"]
    assert float(copied[1]["land_acres"]) == 13.75
    assert copied[2]["land_acres"] is None          # a null stays a null
    assert copied[0]["active"] is True

    # Types a person would expect, not everything as text.
    types = columns_of(into)
    assert types["id"] == "integer"
    assert types["farmer_name"] == "text"
    assert types["country"] == "text"               # varchar(2) -> TEXT
    assert types["land_acres"] == "numeric"
    assert types["active"] == "boolean"
    assert types["registered_on"] == "date"


def test_the_source_is_not_touched(source, destinations, admin_client):
    before = rows_of(source)
    into = f"imported_{uuid.uuid4().hex[:8]}"
    destinations.append(into)

    admin_client.post("/api/external-db/load", json={
        "connection": source_connection(), "schema": settings.db_schema,
        "table": source, "destination_table": into})

    assert rows_of(source) == before


def test_an_empty_table_copies_as_an_empty_table(destinations, admin_client):
    empty = f"ext_empty_{uuid.uuid4().hex[:8]}"
    into = f"imported_{uuid.uuid4().hex[:8]}"
    destinations.extend([empty, into])
    with transaction() as cur:
        cur.execute(sql.SQL("CREATE TABLE {} (id INTEGER, note TEXT)").format(
            sql.Identifier(empty)))

    body = admin_client.post("/api/external-db/load", json={
        "connection": source_connection(), "schema": settings.db_schema,
        "table": empty, "destination_table": into}).json()

    assert body["rows_loaded"] == 0
    assert body["columns_loaded"] == 2
    assert rows_of(into) == []


def test_a_table_larger_than_one_batch_arrives_whole(destinations, admin_client,
                                                     monkeypatch):
    """The copy is batched, so the batching has to be right."""
    monkeypatch.setattr(settings, "external_db_batch_size", 50)
    big = f"ext_big_{uuid.uuid4().hex[:8]}"
    into = f"imported_{uuid.uuid4().hex[:8]}"
    destinations.extend([big, into])

    with transaction() as cur:
        cur.execute(sql.SQL("CREATE TABLE {} (id INTEGER, note TEXT)").format(
            sql.Identifier(big)))
        cur.execute(sql.SQL(
            "INSERT INTO {} SELECT g, 'row ' || g FROM generate_series(1, 537) g"
        ).format(sql.Identifier(big)))

    body = admin_client.post("/api/external-db/load", json={
        "connection": source_connection(), "schema": settings.db_schema,
        "table": big, "destination_table": into}).json()

    assert body["rows_loaded"] == 537
    with transaction() as cur:
        cur.execute(sql.SQL("SELECT count(*) n, min(id) lo, max(id) hi FROM {}").format(
            sql.Identifier(into)))
        counted = dict(cur.fetchone())
    assert (counted["n"], counted["lo"], counted["hi"]) == (537, 1, 537)


@pytest.mark.parametrize("name", [
    "imported farmers", "imported-farmers", "1farmers", "farmers; DROP TABLE forms",
    'far"mers', "public.farmers", "",
])
def test_a_destination_name_that_is_not_safe_is_refused(name, source, admin_client):
    answer = admin_client.post("/api/external-db/load", json={
        "connection": source_connection(), "schema": settings.db_schema,
        "table": source, "destination_table": name})

    assert answer.status_code == 422
    assert answer.json()["detail"]["code"] == "VALIDATION_ERROR"
    with transaction() as cur:
        assert table_exists(cur, "forms")


@pytest.mark.parametrize("name", ["forms", "app_user", "project_member"])
def test_one_of_this_applications_own_tables_cannot_be_the_destination(
        name, source, admin_client):
    answer = admin_client.post("/api/external-db/load", json={
        "connection": source_connection(), "schema": settings.db_schema,
        "table": source, "destination_table": name})

    assert answer.status_code == 422
    assert "this application's own tables" in answer.json()["detail"]["message"]


def test_an_existing_destination_is_a_conflict_not_an_overwrite(source, destinations,
                                                                admin_client):
    into = f"imported_{uuid.uuid4().hex[:8]}"
    destinations.append(into)
    with transaction() as cur:
        cur.execute(sql.SQL("CREATE TABLE {} (keep_me TEXT)").format(sql.Identifier(into)))
        cur.execute(sql.SQL("INSERT INTO {} VALUES ('do not lose this')").format(
            sql.Identifier(into)))

    answer = admin_client.post("/api/external-db/load", json={
        "connection": source_connection(), "schema": settings.db_schema,
        "table": source, "destination_table": into})

    assert answer.status_code == 409
    assert answer.json()["detail"]["code"] == "CONFLICT"
    # Untouched: not dropped, not added to.
    with transaction() as cur:
        cur.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(into)))
        assert [dict(r) for r in cur.fetchall()] == [{"keep_me": "do not lose this"}]


def test_a_column_this_cannot_map_stops_the_import_and_names_it(destinations,
                                                                admin_client):
    odd = f"ext_odd_{uuid.uuid4().hex[:8]}"
    destinations.append(odd)
    into = f"imported_{uuid.uuid4().hex[:8]}"
    with transaction() as cur:
        cur.execute(sql.SQL("CREATE TABLE {} (id INTEGER, where_it_is POINT)").format(
            sql.Identifier(odd)))

    answer = admin_client.post("/api/external-db/load", json={
        "connection": source_connection(), "schema": settings.db_schema,
        "table": odd, "destination_table": into})

    assert answer.status_code == 422
    detail = answer.json()["detail"]
    assert detail["code"] == "UNSUPPORTED_COLUMN_TYPE"
    assert "where_it_is" in detail["message"] and "point" in detail["message"]
    # Refused before anything was created.
    with transaction() as cur:
        assert not table_exists(cur, into)


def test_a_failure_part_way_through_leaves_nothing_behind(source, admin_client,
                                                          monkeypatch):
    """The reason the copy is one transaction."""
    into = f"imported_{uuid.uuid4().hex[:8]}"

    def fails_after_one_batch(*args, **kwargs):
        yield [(1, "Ramesh", "IN", "MAIZE", 2.5, True, None)]
        raise RuntimeError("the source went away")

    monkeypatch.setattr(connections, "rows", fails_after_one_batch)

    answer = admin_client.post("/api/external-db/load", json={
        "connection": source_connection(), "schema": settings.db_schema,
        "table": source, "destination_table": into})

    assert answer.status_code == 500
    assert answer.json()["detail"]["code"] == "IMPORT_FAILED"
    assert "nothing was written" in answer.json()["detail"]["message"]
    # No half-built table to find later.
    with transaction() as cur:
        assert not table_exists(cur, into)


# --------------------------------------------------------------------------- #
# the credentials
# --------------------------------------------------------------------------- #
def test_no_answer_ever_carries_the_password(source, destinations, admin_client):
    into = f"imported_{uuid.uuid4().hex[:8]}"
    destinations.append(into)

    answers = [
        admin_client.post("/api/external-db/test-connection", json=source_connection()),
        admin_client.post("/api/external-db/schemas",
                          json={"connection": source_connection()}),
        admin_client.post("/api/external-db/tables", json={
            "connection": source_connection(), "schema": settings.db_schema}),
        admin_client.post("/api/external-db/preview", json={
            "connection": source_connection(), "schema": settings.db_schema,
            "table": source, "limit": 2}),
        admin_client.post("/api/external-db/load", json={
            "connection": source_connection(), "schema": settings.db_schema,
            "table": source, "destination_table": into}),
        # And a failure, which is where a driver would otherwise say too much.
        admin_client.post("/api/external-db/test-connection",
                          json={**source_connection(), "port": 1}),
    ]

    for answer in answers:
        # The credential itself, and any field claiming to be one. Not the bare
        # word: `/tables` lists this database's own tables, and one of them is
        # called `password_reset`.
        assert SECRET not in answer.text
        assert not re.search(r'"password"\s*:', answer.text)


def test_nothing_written_to_the_log_carries_the_password(source, destinations,
                                                         admin_client, caplog):
    into = f"imported_{uuid.uuid4().hex[:8]}"
    destinations.append(into)

    with caplog.at_level(logging.DEBUG):
        admin_client.post("/api/external-db/load", json={
            "connection": source_connection(), "schema": settings.db_schema,
            "table": source, "destination_table": into})
        admin_client.post("/api/external-db/test-connection",
                          json={**source_connection(), "port": 1})

    written = "\n".join(r.getMessage() for r in caplog.records)
    assert SECRET not in written
    # The operation is logged, which is the point of logging it.
    assert into in written and source in written
    # And no row of anybody's data.
    assert "Ramesh" not in written


def test_what_is_logged_about_a_connection_is_safe():
    described = connections.describe(connections.check_connection({
        "db_type": "mysql", "host": "db.example.org", "port": 3306,
        "database": "farm", "username": "reader", "password": "hunter2"}))

    assert described == "mysql://reader@db.example.org:3306/farm"
    assert "hunter2" not in described


# --------------------------------------------------------------------------- #
# MySQL, without a MySQL server
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("source_type, declared, expected", [
    ("int", "int(11)", "INTEGER"),
    ("bigint", "bigint(20)", "BIGINT"),
    ("decimal", "decimal(10,2)", "NUMERIC"),
    ("tinyint", "tinyint(1)", "BOOLEAN"),      # MySQL's boolean
    ("tinyint", "tinyint(4)", "SMALLINT"),     # and a small number, which is not
    ("varchar", "varchar(255)", "TEXT"),
    ("longtext", "longtext", "TEXT"),
    ("date", "date", "DATE"),
    ("datetime", "datetime", "TIMESTAMP"),
    ("timestamp", "timestamp", "TIMESTAMP"),
    ("json", "json", "JSONB"),
    ("blob", "blob", "BYTEA"),
    ("enum", "enum('a','b')", "TEXT"),
])
def test_mysql_types_map_to_something_sensible(source_type, declared, expected):
    mapped = import_service.map_type("mysql", {
        "name": "c", "source_type": source_type, "declared": declared})

    assert mapped == expected


@pytest.mark.parametrize("db_type, source_type", [
    ("mysql", "geometry"), ("mysql", "polygon"),
    ("postgresql", "point"), ("postgresql", "tsvector"), ("postgresql", "array"),
])
def test_a_type_that_cannot_be_mapped_is_refused_rather_than_guessed(db_type,
                                                                     source_type):
    with pytest.raises(import_service.ImportRefused) as refused:
        import_service.map_type(db_type, {"name": "odd_one",
                                          "source_type": source_type})

    assert refused.value.code == "UNSUPPORTED_COLUMN_TYPE"
    assert "odd_one" in str(refused.value)


@pytest.mark.parametrize("source_type, expected", [
    ("integer", "INTEGER"), ("bigint", "BIGINT"), ("numeric", "NUMERIC"),
    ("boolean", "BOOLEAN"), ("date", "DATE"),
    ("timestamp without time zone", "TIMESTAMP"),
    ("timestamp with time zone", "TIMESTAMPTZ"),
    ("character varying", "TEXT"), ("text", "TEXT"),
    ("json", "JSONB"), ("jsonb", "JSONB"), ("uuid", "UUID"),
])
def test_postgresql_types_map_to_something_sensible(source_type, expected):
    assert import_service.map_type(
        "postgresql", {"name": "c", "source_type": source_type}) == expected
