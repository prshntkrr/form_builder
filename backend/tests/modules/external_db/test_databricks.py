"""Databricks as an import source, and the import history.

Databricks is never called: `databricks.transport` is an httpx MockTransport
playing a SQL warehouse — statements, polling, inline results for metadata and
previews, and for imports EXTERNAL_LINKS chunks served from a fake cloud-storage
host that must never see the token. The token is a made-up string, and every
test that could leak it checks that it did not.

The copy itself lands in this installation's own PostgreSQL, so the load tests
are real about the local side: the table is created, filled and recorded.
"""
import json
import logging
import uuid

import httpx
import pytest
from psycopg2 import sql

from app.core import auth_service
from app.core.config import settings
from app.core.database import ping, table_exists, transaction
from app.modules.external_db import connections, databricks, import_service
from app.modules.external_db.connections import ExternalDbError

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

TOKEN = "dapiFAKE0123456789abcdef-not-a-real-token"
HOST = "dbc-1234abcd-5678.cloud.databricks.com"
PASSWORD = "correct horse battery"


def spec(**change):
    return {"db_type": "databricks", "host": HOST, "warehouse_id": "abc123def456",
            "catalog": "main", "token": TOKEN, "name": "Field ops lake", **change}


FARMERS_COLUMNS = [
    {"name": "id", "type_name": "INT"}, {"name": "farmer_name", "type_name": "STRING"},
    {"name": "acres", "type_name": "DECIMAL"}, {"name": "active", "type_name": "BOOLEAN"},
    {"name": "registered_on", "type_name": "DATE"}, {"name": "tags", "type_name": "ARRAY"},
]
FARMERS = [
    ["1", "Ramesh", "2.50", "true", "2026-01-05", '["maize"]'],
    ["2", "Lucía", "13.75", "false", "2026-02-10", "[]"],
    ["3", "Grace", None, "true", None, None],
]


class Warehouse:
    """A SQL warehouse, as far as the Statement Execution API shows one."""

    def __init__(self, tables=("farmers", "plots", "visits", "crops", "yields"),
                 pending=1, total=None, fail=None, status=200, columns=None,
                 catalog="main", schema="field_ops"):
        self.catalog, self.schema = catalog, schema
        # The import side (EXTERNAL_LINKS): its rows, how many to a chunk, and
        # what goes wrong. `broken` chunks always fail to download; `expired`
        # ones fail once, as a link past its expiry does.
        self.ext_columns = None
        self.ext_rows, self.chunk_rows = FARMERS, 2
        self.bytes_truncated, self.row_limit = False, None
        self.broken, self.expired, self.downloads, self.link_calls = set(), set(), [], []
        self.drop_total = self.bad_offset = self.bad_link = False
        self.tables, self.pending, self.fail, self.status = tables, pending, fail, status
        self.total = len(FARMERS) if total is None else total
        self.columns = columns or FARMERS_COLUMNS
        self.requests, self.bodies, self.cancelled, self.tokens = [], [], [], []

    def done(self, sid, columns, rows, chunks=None):
        result = {"chunk_index": 0, "row_count": len(rows), "data_array": rows}
        if chunks:
            result["next_chunk_index"] = 1
        return {"statement_id": sid, "status": {"state": "SUCCEEDED"},
                "manifest": {"schema": {"columns": columns}, "total_row_count": self.total},
                "result": result}

    def answer(self, statement):
        cols = self.columns
        if self.fail:
            return {"statement_id": "s-f", "status": {"state": "FAILED", "error": {
                "error_code": self.fail,
                "message": f"[{self.fail}] near {statement} token={TOKEN}"}}}
        if statement == "SELECT 1":
            return self.done("s-1", [{"name": "1", "type_name": "INT"}], [["1"]])
        if statement == f"SHOW SCHEMAS IN `{self.catalog}`":
            return self.done("s-s", [{"name": "databaseName", "type_name": "STRING"}],
                             [["default"], [self.schema], ["information_schema"]])
        if statement == f"SHOW TABLES IN `{self.catalog}`.`{self.schema}`":
            return self.done("s-t", [{"name": n, "type_name": "STRING"}
                                     for n in ("database", "tableName", "isTemporary")],
                             [[self.schema, t, "false"] for t in self.tables]
                             + [["", "scratch", "true"]])
        if statement.endswith("LIMIT 0"):
            return self.done("s-c", cols, [])
        if statement.startswith("SELECT * FROM"):
            return {"statement_id": "s-rows", "status": {"state": "PENDING"}}
        raise AssertionError(f"unexpected statement {statement}")

    # ---- the import side ------------------------------------------------- #
    def ext_chunks(self):
        rows = self.ext_rows[:self.row_limit]
        return [rows[i:i + self.chunk_rows] for i in range(0, len(rows), self.chunk_rows)]

    def ext_manifest(self):
        cols = self.ext_columns or self.columns
        rows = self.ext_rows[:self.row_limit]
        manifest = {"schema": {"columns": cols}, "total_row_count": len(rows),
                    "total_chunk_count": len(self.ext_chunks()),
                    "truncated": len(self.ext_rows) > self.row_limit or self.bytes_truncated}
        if self.drop_total:
            del manifest["total_row_count"]
        return {"statement_id": "s-ext", "status": {"state": "SUCCEEDED"}, "manifest": manifest}

    def ext_link(self, index):
        self.link_calls.append(index)
        chunks = self.ext_chunks()
        offset = sum(len(c) for c in chunks[:index]) + (1 if self.bad_offset and index else 0)
        url = (f"https://field-results.s3.us-west-2.amazonaws.com/res/{index}"
               f"?X-Amz-Signature=SIGNED{index}")
        if self.bad_link:
            url = f"https://169.254.169.254/latest/meta-data?chunk={index}"
        return {"external_links": [{
            "chunk_index": index, "row_offset": offset, "row_count": len(chunks[index]),
            "byte_count": 0, "external_link": url, "expiration": "2026-09-19T12:00:00Z",
            **({"next_chunk_index": index + 1} if index + 1 < len(chunks) else {})}]}

    def storage(self, request):
        assert "authorization" not in request.headers, "the token went to cloud storage"
        assert request.url.host == "field-results.s3.us-west-2.amazonaws.com"
        index = int(request.url.path.rsplit("/", 1)[1])
        self.downloads.append(index)
        if index in self.broken:
            return httpx.Response(500, text="storage unavailable")
        if index in self.expired:
            self.expired.discard(index)
            return httpx.Response(403, text="Request has expired")
        return httpx.Response(200, content=json.dumps(self.ext_chunks()[index]).encode())

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert request.url.scheme == "https"
        if request.url.host != HOST:
            return self.storage(request)
        assert request.url.host == HOST
        # Whatever token was sent — a rotation sends a different one — it goes
        # in the header and never in the URL.
        sent = request.headers["authorization"]
        assert sent.startswith("Bearer ") and len(sent) > len("Bearer ")
        self.tokens.append(sent[len("Bearer "):])
        assert TOKEN not in str(request.url)
        if self.status != 200:
            return httpx.Response(self.status, json={"message": f"bad token {TOKEN}"})

        path = request.url.path
        if request.method == "POST" and path == "/api/2.0/sql/statements":
            body = json.loads(request.content)
            self.bodies.append(body)
            assert TOKEN not in request.content.decode()
            if body.get("disposition") == "EXTERNAL_LINKS" and not self.fail:
                self.row_limit = body.get("row_limit") or len(self.ext_rows)
                return httpx.Response(200, json={"statement_id": "s-ext",
                                                 "status": {"state": "PENDING"}})
            return httpx.Response(200, json=self.answer(body["statement"]))
        if path.endswith("/cancel"):
            self.cancelled.append(path)
            return httpx.Response(200, json={})
        if request.method == "GET" and path == "/api/2.0/sql/statements/s-rows":
            if self.pending > 0:
                self.pending -= 1
                return httpx.Response(200, json={"statement_id": "s-rows",
                                                 "status": {"state": "RUNNING"}})
            return httpx.Response(200, json=self.done("s-rows", self.columns, FARMERS[:2], chunks=True))
        if request.method == "GET" and path == "/api/2.0/sql/statements/s-ext":
            return httpx.Response(200, json=self.ext_manifest())
        if path.startswith("/api/2.0/sql/statements/s-ext/result/chunks/"):
            return httpx.Response(200, json=self.ext_link(int(path.rsplit("/", 1)[1])))
        if path == "/api/2.0/sql/statements/s-rows/result/chunks/1":
            return httpx.Response(200, json={"chunk_index": 1, "data_array": FARMERS[2:]})
        raise AssertionError(f"unexpected {request.method} {path}")


@pytest.fixture
def warehouse(monkeypatch):
    fake = Warehouse()
    monkeypatch.setattr(databricks, "transport", httpx.MockTransport(fake))
    monkeypatch.setattr(databricks, "POLL_SECONDS", 0)
    return fake


@pytest.fixture(autouse=True)
def history_cleaned():
    """Import attempts these tests make are removed from the history after."""
    with transaction() as cur:
        cur.execute("SELECT COALESCE(MAX(import_id), 0) AS top FROM external_import")
        top = cur.fetchone()["top"]
    yield
    with transaction() as cur:
        cur.execute("DELETE FROM external_import WHERE import_id > %s", (top,))


@pytest.fixture
def destination():
    name = f"dbx_{uuid.uuid4().hex[:8]}"
    yield name
    with transaction() as cur:
        cur.execute(sql.SQL("DROP TABLE IF EXISTS {}").format(sql.Identifier(name)))


def last_import():
    with transaction() as cur:
        cur.execute("SELECT * FROM external_import ORDER BY import_id DESC LIMIT 1")
        return dict(cur.fetchone())


# --------------------------------------------------------------------------- #
# the host: only a Databricks workspace, only over HTTPS
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("given,expected", [
    (HOST, HOST),
    (f"https://{HOST}/", HOST),
    ("ADB-123456789.12.AzureDatabricks.net", "adb-123456789.12.azuredatabricks.net"),
    ("1234567890.1.gcp.databricks.com", "1234567890.1.gcp.databricks.com"),
])
def test_workspace_hosts_are_accepted(given, expected):
    assert databricks.check_host(given) == expected


@pytest.mark.parametrize("host", [
    "localhost", "127.0.0.1", "169.254.169.254", "10.0.0.5", "internal-db",
    "example.com", "cloud.databricks.com", "evil.com/.cloud.databricks.com",
    f"{HOST}.evil.com", f"{HOST}:8443", f"{HOST}/api", f"http://{HOST}",
    f"user@{HOST}", f"{HOST}#x", "", "..cloud.databricks.com",
])
def test_anything_else_is_refused_before_a_request(host, warehouse):
    with pytest.raises(ExternalDbError) as refused:
        connections.test(spec(host=host))
    assert refused.value.code == "VALIDATION_ERROR"
    assert warehouse.requests == []


@pytest.mark.parametrize("change", [
    {"warehouse_id": ""}, {"warehouse_id": "abc/../x"}, {"token": ""},
    {"catalog": "main`; DROP"}, {"catalog": ""},
])
def test_incomplete_or_unsafe_details_are_refused(change, warehouse):
    with pytest.raises(ExternalDbError):
        connections.test(spec(**change))
    assert warehouse.requests == []


def test_redirects_are_not_followed(monkeypatch):
    """A redirect would carry the Authorization header to another host."""
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(302, headers={"location": "https://evil.example/steal"})

    monkeypatch.setattr(databricks, "transport", httpx.MockTransport(handler))
    with pytest.raises(ExternalDbError):
        connections.test(spec())
    assert len(calls) == 1 and "evil" not in calls[0]


# --------------------------------------------------------------------------- #
# connecting and discovering
# --------------------------------------------------------------------------- #
def test_testing_a_connection_runs_select_1_on_that_warehouse(warehouse):
    answer = connections.test(spec())
    assert answer == {"success": True, "message": "Connection successful",
                      "db_type": "databricks"}
    body = warehouse.bodies[0]
    assert body["statement"] == "SELECT 1"
    assert body["warehouse_id"] == "abc123def456" and body["catalog"] == "main"
    assert TOKEN not in json.dumps(answer)


def test_schemas_and_tables_are_discovered_not_assumed(warehouse):
    assert connections.schemas(spec()) == ["default", "field_ops"]
    found = connections.tables(spec(), "field_ops")
    assert [t["name"] for t in found] == ["crops", "farmers", "plots", "visits", "yields"]

    warehouse.tables = ("soil_samples",)
    assert [t["name"] for t in connections.tables(spec(), "field_ops")] == ["soil_samples"]


def test_an_unsafe_table_name_never_reaches_databricks(warehouse):
    for bad in ("farmers`; DROP TABLE x; --", "a.b", "farmers x", ""):
        with pytest.raises(ExternalDbError):
            connections.preview(spec(), "field_ops", bad)
    assert warehouse.bodies == []


def test_preview_waits_for_the_statement_and_limits_rows(warehouse):
    shown = connections.preview(spec(), "field_ops", "farmers", 2)
    assert shown["rows"][0]["farmer_name"] == "Ramesh"
    assert len(shown["rows"]) <= 2 and shown["row_limit"] == 2
    assert [c["name"] for c in shown["columns"]][:2] == ["id", "farmer_name"]
    select = [b for b in warehouse.bodies if b["statement"].startswith("SELECT * FROM `main`")]
    assert select[0]["row_limit"] == 2
    assert select[0]["statement"] == "SELECT * FROM `main`.`field_ops`.`farmers`"


# --------------------------------------------------------------------------- #
# importing
# --------------------------------------------------------------------------- #
def test_a_table_is_copied_across_chunks_and_recorded(warehouse, destination, caplog):
    caplog.set_level(logging.DEBUG)
    result = import_service.load(spec(), "field_ops", "farmers", destination, loaded_by="QA")

    assert result["rows_loaded"] == 3 and result["columns_loaded"] == 6
    with transaction() as cur:
        cur.execute(sql.SQL("SELECT * FROM {} ORDER BY id").format(sql.Identifier(destination)))
        rows = [dict(r) for r in cur.fetchall()]
    assert [r["farmer_name"] for r in rows] == ["Ramesh", "Lucía", "Grace"]
    assert rows[0]["active"] is True and rows[0]["tags"] == ["maize"]
    assert float(rows[1]["acres"]) == 13.75 and rows[2]["acres"] is None

    record = last_import()
    assert record["status"] == "succeeded" and record["rows_loaded"] == 3
    assert record["source_type"] == "databricks"
    assert record["source_label"] == f"{HOST} / main"
    assert record["connection_name"] == "Field ops lake"
    assert TOKEN not in json.dumps(record, default=str)
    assert TOKEN not in caplog.text


def test_a_table_over_the_row_limit_is_refused_and_nothing_is_written(
        warehouse, destination, monkeypatch):
    monkeypatch.setattr(settings, "external_db_databricks_max_rows", 2)
    warehouse.total = 3
    with pytest.raises(ExternalDbError) as refused:
        import_service.load(spec(), "field_ops", "farmers", destination)
    assert "more than 2 rows" in str(refused.value)
    assert warehouse.bodies[-1]["row_limit"] == 3
    with transaction() as cur:
        assert not table_exists(cur, destination)
    record = last_import()
    assert record["status"] == "failed" and record["rows_loaded"] is None
    assert "more than 2 rows" in record["error"]


def test_an_unsupported_column_is_named_and_nothing_is_written(warehouse, destination):
    warehouse.columns = FARMERS_COLUMNS + [{"name": "photo", "type_name": "BINARY"}]
    with pytest.raises(ExternalDbError) as refused:
        import_service.load(spec(), "field_ops", "farmers", destination)
    assert "'photo'" in str(refused.value)
    with transaction() as cur:
        assert not table_exists(cur, destination)


def test_an_existing_table_is_never_overwritten(warehouse, destination):
    import_service.load(spec(), "field_ops", "farmers", destination)
    with pytest.raises(ExternalDbError) as refused:
        import_service.load(spec(), "field_ops", "farmers", destination)
    assert refused.value.code == "CONFLICT"


# --------------------------------------------------------------------------- #
# failures say what, never the secret
# --------------------------------------------------------------------------- #
def test_a_refused_token_is_a_connection_failure_without_the_token(warehouse, caplog):
    warehouse.status = 401
    with pytest.raises(ExternalDbError) as refused:
        connections.test(spec())
    assert refused.value.code == "EXTERNAL_DB_CONNECTION_FAILED"
    assert TOKEN not in str(refused.value) and TOKEN not in caplog.text


def test_a_failed_statement_gives_its_code_not_its_message(warehouse):
    warehouse.fail = "TABLE_OR_VIEW_NOT_FOUND"
    with pytest.raises(ExternalDbError) as refused:
        connections.preview(spec(), "field_ops", "farmers")
    assert refused.value.code == "RESOURCE_NOT_FOUND"
    assert "TABLE_OR_VIEW_NOT_FOUND" in str(refused.value)
    assert TOKEN not in str(refused.value) and "SELECT" not in str(refused.value)


def test_a_statement_that_runs_too_long_is_cancelled(warehouse, monkeypatch):
    monkeypatch.setattr(settings, "external_db_databricks_wait_seconds", -1)
    with pytest.raises(ExternalDbError) as refused:
        connections.preview(spec(), "field_ops", "farmers")
    assert "did not finish the query within" in str(refused.value)
    assert refused.value.code == "IMPORT_LIMIT"
    assert warehouse.cancelled == ["/api/2.0/sql/statements/s-rows/cancel"]


def test_an_unreachable_workspace_is_said_plainly(monkeypatch):
    def handler(request):
        raise httpx.ConnectError(f"failed to reach {request.url}")

    monkeypatch.setattr(databricks, "transport", httpx.MockTransport(handler))
    with pytest.raises(ExternalDbError) as refused:
        connections.test(spec())
    assert refused.value.code == "EXTERNAL_DB_CONNECTION_FAILED"


# --------------------------------------------------------------------------- #
# over HTTP: the routes, and the history list
# --------------------------------------------------------------------------- #
@pytest.fixture
def admin_client():
    from fastapi.testclient import TestClient

    from app.core.bootstrap import ensure_admin_holds_everything
    from app.main import app

    ensure_admin_holds_everything()
    email = f"xdb.admin.{uuid.uuid4().hex[:8]}@example.test"
    user = auth_service.create_user(email, PASSWORD, role="admin", full_name="Importer")
    try:
        yield TestClient(app, headers={
            "Authorization": f"Bearer {auth_service.login(email, PASSWORD)['token']}"})
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user["user_id"],))


def test_the_routes_never_echo_the_token(admin_client, warehouse, destination):
    for path, body in (
        ("test-connection", spec()),
        ("test-connection", spec(host="169.254.169.254")),
        ("test-connection", {k: v for k, v in spec().items() if k not in ("db_type", "host")}),
        ("schemas", {"connection": spec()}),
        ("tables", {"connection": spec(), "schema": "field_ops"}),
        ("preview", {"connection": spec(), "schema": "field_ops", "table": "farmers"}),
        ("load", {"connection": spec(), "schema": "field_ops", "table": "farmers",
                  "destination_table": destination}),
        ("load", {"connection": spec(), "schema": "field_ops", "table": "farmers",
                  "destination_table": destination}),
    ):
        answer = admin_client.post(f"/api/external-db/{path}", json=body)
        assert TOKEN not in answer.text, (path, answer.status_code)


def test_the_history_lists_imports_with_metadata_only(admin_client, warehouse, destination):
    admin_client.post("/api/external-db/load", json={
        "connection": spec(), "schema": "field_ops", "table": "farmers",
        "destination_table": destination})
    warehouse.fail = "PERMISSION_DENIED"
    admin_client.post("/api/external-db/load", json={
        "connection": spec(), "schema": "field_ops", "table": "farmers",
        "destination_table": destination + "_b"})

    answer = admin_client.get("/api/external-db/imports")
    assert answer.status_code == 200
    mine = [i for i in answer.json()["imports"] if i["destination_table"].startswith(destination)]
    failed, done = mine
    assert done["status"] == "succeeded" and done["rows_loaded"] == 3
    assert done["table_present"] is True and done["imported_by"] == "Importer"
    assert done["started_on"] and done["finished_on"]
    assert failed["status"] == "failed" and failed["rows_loaded"] is None
    assert "PERMISSION_DENIED" in failed["error"] and failed["table_present"] is False
    assert TOKEN not in answer.text
    assert not {"token", "password", "username"} & set(done)


def test_the_history_needs_the_permission():
    from fastapi.testclient import TestClient

    from app.main import app

    email = f"nobody.{uuid.uuid4().hex[:8]}@example.test"
    user = auth_service.create_user(email, PASSWORD, role="standard", full_name="Nobody")
    try:
        client = TestClient(app, headers={
            "Authorization": f"Bearer {auth_service.login(email, PASSWORD)['token']}"})
        assert client.get("/api/external-db/imports").status_code == 403
        assert TestClient(app).get("/api/external-db/imports").status_code == 401
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user["user_id"],))


def test_an_import_cut_off_by_a_restart_is_marked_failed():
    with transaction() as cur:
        cur.execute("""INSERT INTO external_import (destination_table, source_type, status)
                       VALUES ('cut_off', 'databricks', 'running') RETURNING import_id""")
        import_id = cur.fetchone()["import_id"]
    assert import_service.mark_interrupted() >= 1
    with transaction() as cur:
        cur.execute("SELECT status, error FROM external_import WHERE import_id = %s", (import_id,))
        row = cur.fetchone()
    assert row["status"] == "failed" and row["error"].startswith("Interrupted")


# --------------------------------------------------------------------------- #
# regression: catalog `bronze`, schema `e-agrology` — connected, then 422
# --------------------------------------------------------------------------- #
@pytest.fixture
def bronze(monkeypatch):
    """A warehouse whose schema and tables have hyphens, as Unity Catalog allows."""
    fake = Warehouse(catalog="bronze", schema="e-agrology",
                     tables=("farm-plots", "soil_samples", "2026_visits"))
    monkeypatch.setattr(databricks, "transport", httpx.MockTransport(fake))
    monkeypatch.setattr(databricks, "POLL_SECONDS", 0)
    return fake


def bronze_spec(**change):
    return spec(**{"catalog": "bronze", **change})


def test_the_reported_workspace_host_is_accepted():
    assert (databricks.check_host("https://dbc-ec9fc1c3-e7c2.cloud.databricks.com/")
            == "dbc-ec9fc1c3-e7c2.cloud.databricks.com")


def test_a_connection_is_tested_without_any_schema_or_table(bronze):
    assert connections.test(bronze_spec())["success"] is True
    assert [b["statement"] for b in bronze.bodies] == ["SELECT 1"]


def test_a_hyphenated_schema_is_discovered_and_its_tables_listed(bronze):
    assert "e-agrology" in connections.schemas(bronze_spec())
    found = connections.tables(bronze_spec(), "e-agrology")
    assert [t["name"] for t in found] == ["2026_visits", "farm-plots", "soil_samples"]
    assert bronze.bodies[-1]["statement"] == "SHOW TABLES IN `bronze`.`e-agrology`"


def test_a_hyphenated_table_is_previewed_quoted(bronze):
    shown = connections.preview(bronze_spec(), "e-agrology", "farm-plots", 5)
    assert shown["schema"] == "e-agrology" and shown["table"] == "farm-plots"
    assert any(b["statement"] == "SELECT * FROM `bronze`.`e-agrology`.`farm-plots`"
               for b in bronze.bodies)


def test_a_hyphenated_table_is_imported_and_recorded(bronze, destination):
    result = import_service.load(bronze_spec(), "e-agrology", "farm-plots", destination)
    assert result["rows_loaded"] == 3
    record = last_import()
    assert record["status"] == "succeeded"
    assert (record["source_schema"], record["source_table"]) == ("e-agrology", "farm-plots")
    assert record["source_label"] == f"{HOST} / bronze"


def test_a_missing_table_is_refused_only_by_table_operations(bronze, destination):
    connections.test(bronze_spec())
    connections.tables(bronze_spec(), "e-agrology")
    sent = len(bronze.bodies)
    for operation in (lambda: connections.preview(bronze_spec(), "e-agrology", ""),
                      lambda: import_service.load(bronze_spec(), "e-agrology", "", destination)):
        with pytest.raises(ExternalDbError) as refused:
            operation()
        assert refused.value.code == "VALIDATION_ERROR"
        assert "table name" in str(refused.value)
    assert len(bronze.bodies) == sent


@pytest.mark.parametrize("name", [
    "e agrology", "e.agrology", "e`agrology", "-agrology", "e;agrology", "e/agrology", "",
])
def test_hyphens_are_allowed_but_nothing_else_new(name, bronze):
    with pytest.raises(ExternalDbError):
        connections.tables(bronze_spec(), name)
    with pytest.raises(ExternalDbError):
        connections.test(bronze_spec(catalog=name))
    assert bronze.bodies == []


def test_postgres_and_mysql_names_are_as_strict_as_before():
    with pytest.raises(ExternalDbError):
        connections.check_identifier("e-agrology", "schema")


@pytest.mark.parametrize("warehouse_id", ["bb14f6b8-9228", "bb14 f6b8", "../bb14", "x" * 65])
def test_an_invalid_warehouse_id_is_still_refused(warehouse_id, bronze):
    with pytest.raises(ExternalDbError) as refused:
        connections.test(bronze_spec(warehouse_id=warehouse_id))
    assert refused.value.code == "VALIDATION_ERROR"
    assert bronze.requests == []


def test_the_route_flow_works_and_a_refusal_names_the_field(admin_client, bronze):
    for path, body in (("test-connection", bronze_spec()),
                       ("schemas", {"connection": bronze_spec()}),
                       ("tables", {"connection": bronze_spec(), "schema": "e-agrology"})):
        answer = admin_client.post(f"/api/external-db/{path}", json=body)
        assert answer.status_code == 200, (path, answer.text)
        assert TOKEN not in answer.text

    refused = admin_client.post("/api/external-db/preview", json={
        "connection": bronze_spec(), "schema": "e-agrology", "table": "farm plots"})
    assert refused.status_code == 422
    detail = refused.json()["detail"]
    assert detail["code"] == "VALIDATION_ERROR"
    assert detail["message"] == "'farm plots' is not a valid table name."
    assert TOKEN not in refused.text


# --------------------------------------------------------------------------- #
# large imports: EXTERNAL_LINKS, chunk by chunk
# --------------------------------------------------------------------------- #
MiB = 1024 * 1024
NOTE_COLUMNS = [{"name": "id", "type_name": "BIGINT"}, {"name": "note", "type_name": "STRING"}]


def wide(warehouse, megabytes, chunk_rows):
    """`megabytes` of result in rows of about 1 KB each, `chunk_rows` to a chunk."""
    note = "x" * 1000
    count = int(megabytes * MiB) // (len(note) + 12)
    warehouse.columns = warehouse.ext_columns = NOTE_COLUMNS
    warehouse.ext_rows = [[str(i), note] for i in range(count)]
    warehouse.chunk_rows = chunk_rows
    return count


def imported(table):
    with transaction() as cur:
        cur.execute(sql.SQL("SELECT COUNT(*) AS n, COUNT(DISTINCT id) AS distinct_ids, "
                            "MIN(id) AS lo, MAX(id) AS hi FROM {}").format(sql.Identifier(table)))
        return dict(cur.fetchone())


def result_bytes(warehouse):
    return sum(len(json.dumps(c)) for c in warehouse.ext_chunks())


def test_A_a_small_table_is_imported_through_chunk_links(warehouse, destination):
    result = import_service.load(spec(), "field_ops", "farmers", destination)
    assert result["rows_loaded"] == 3
    body = warehouse.bodies[-1]
    assert body["disposition"] == "EXTERNAL_LINKS" and body["format"] == "JSON_ARRAY"
    assert body["row_limit"] == settings.external_db_databricks_max_rows + 1
    assert body["byte_limit"] == settings.external_db_databricks_max_bytes
    assert warehouse.downloads == [0, 1]
    assert last_import()["status"] == "succeeded"


def test_B_a_result_just_under_25_mb_is_imported(warehouse, destination):
    count = wide(warehouse, 24.9, chunk_rows=10000)
    assert 24 * MiB < result_bytes(warehouse) < 25 * MiB

    result = import_service.load(spec(), "field_ops", "farmers", destination)

    assert result["rows_loaded"] == count
    assert imported(destination) == {"n": count, "distinct_ids": count, "lo": 0, "hi": count - 1}


def test_C_D_a_result_over_25_mb_arrives_whole_across_many_chunks(warehouse, destination):
    count = wide(warehouse, 40, chunk_rows=5000)
    assert result_bytes(warehouse) > 25 * MiB
    chunks = len(warehouse.ext_chunks())
    assert chunks >= 8

    result = import_service.load(spec(), "field_ops", "farmers", destination)

    assert result["rows_loaded"] == count
    # Every chunk fetched once, in order; every row there once: none missing,
    # none twice.
    assert warehouse.downloads == list(range(chunks))
    assert imported(destination) == {"n": count, "distinct_ids": count, "lo": 0, "hi": count - 1}
    record = last_import()
    assert record["status"] == "succeeded" and record["rows_loaded"] == count


@pytest.mark.parametrize("broken_chunk", [1, 2, 4])
def test_E_a_chunk_that_cannot_be_fetched_fails_the_whole_import(
        broken_chunk, warehouse, destination, caplog):
    caplog.set_level(logging.DEBUG)
    warehouse.ext_rows = [[str(i), f"n{i}"] for i in range(10)]
    warehouse.columns = warehouse.ext_columns = NOTE_COLUMNS
    warehouse.broken = {broken_chunk}

    with pytest.raises(ExternalDbError) as refused:
        import_service.load(spec(), "field_ops", "farmers", destination)

    assert f"chunk {broken_chunk + 1} of 5" in str(refused.value)
    # Chunks before it were fetched and inserted — and rolled back with it.
    with transaction() as cur:
        assert not table_exists(cur, destination)
    record = last_import()
    assert record["status"] == "failed" and record["rows_loaded"] is None
    assert f"chunk {broken_chunk + 1} of 5" in record["error"]
    for text in (str(refused.value), record["error"], caplog.text):
        assert TOKEN not in text and "SIGNED" not in text


def test_E_an_expired_link_is_fetched_again_once(warehouse, destination):
    warehouse.expired = {1}
    result = import_service.load(spec(), "field_ops", "farmers", destination)
    assert result["rows_loaded"] == 3
    assert warehouse.link_calls == [0, 1, 1] and warehouse.downloads == [0, 1, 1]


@pytest.mark.parametrize("fault,said", [
    ("bad_offset", "inconsistently"),
    ("drop_total", "did not describe the result"),
])
def test_D_a_chunk_that_would_repeat_or_skip_rows_is_refused(fault, said, warehouse, destination):
    setattr(warehouse, fault, True)
    with pytest.raises(ExternalDbError) as refused:
        import_service.load(spec(), "field_ops", "farmers", destination)
    assert said in str(refused.value)
    with transaction() as cur:
        assert not table_exists(cur, destination)
    assert last_import()["status"] == "failed"


def test_F_a_table_over_the_row_limit_says_which_limit(warehouse, destination, monkeypatch):
    monkeypatch.setattr(settings, "external_db_databricks_max_rows", 4)
    warehouse.ext_rows = [[str(i), f"n{i}"] for i in range(10)]
    warehouse.columns = warehouse.ext_columns = NOTE_COLUMNS

    with pytest.raises(ExternalDbError) as refused:
        import_service.load(spec(), "field_ops", "farmers", destination)

    assert refused.value.code == "IMPORT_LIMIT"
    assert "more than 4 rows" in str(refused.value)
    assert "EXTERNAL_DB_DATABRICKS_MAX_ROWS" in str(refused.value)
    assert "25 MB" not in str(refused.value) and "smaller table" not in str(refused.value)
    assert warehouse.downloads == []
    with transaction() as cur:
        assert not table_exists(cur, destination)


def test_F_a_result_cut_short_by_the_byte_limit_says_which_limit(warehouse, destination):
    warehouse.bytes_truncated = True
    with pytest.raises(ExternalDbError) as refused:
        import_service.load(spec(), "field_ops", "farmers", destination)
    assert refused.value.code == "IMPORT_LIMIT"
    assert "EXTERNAL_DB_DATABRICKS_MAX_BYTES" in str(refused.value)
    assert warehouse.downloads == []


def test_F_the_byte_limit_is_also_counted_while_downloading(warehouse, destination, monkeypatch):
    monkeypatch.setattr(settings, "external_db_databricks_max_bytes", 100)
    with pytest.raises(ExternalDbError) as refused:
        import_service.load(spec(), "field_ops", "farmers", destination)
    assert refused.value.code == "IMPORT_LIMIT"
    with transaction() as cur:
        assert not table_exists(cur, destination)


def test_G_an_import_past_its_time_limit_fails_safely(warehouse, destination, monkeypatch):
    monkeypatch.setattr(settings, "external_db_databricks_import_seconds", -1)
    with pytest.raises(ExternalDbError) as refused:
        import_service.load(spec(), "field_ops", "farmers", destination)
    assert refused.value.code == "IMPORT_LIMIT"
    assert "EXTERNAL_DB_DATABRICKS_IMPORT_SECONDS" in str(refused.value)
    with transaction() as cur:
        assert not table_exists(cur, destination)
    assert last_import()["status"] == "failed"


def test_G_a_query_past_its_wait_limit_is_cancelled(warehouse, destination, monkeypatch):
    monkeypatch.setattr(settings, "external_db_databricks_wait_seconds", -1)
    with pytest.raises(ExternalDbError) as refused:
        import_service.load(spec(), "field_ops", "farmers", destination)
    assert refused.value.code == "IMPORT_LIMIT"
    assert last_import()["status"] == "failed"


def test_a_link_to_anywhere_but_cloud_storage_is_not_followed(warehouse, destination):
    warehouse.bad_link = True
    with pytest.raises(ExternalDbError) as refused:
        import_service.load(spec(), "field_ops", "farmers", destination)
    assert "unexpected place" in str(refused.value)
    assert warehouse.downloads == []
    assert not [r for r in warehouse.requests if r.url.host == "169.254.169.254"]


@pytest.mark.parametrize("url", [
    "http://field-results.s3.us-west-2.amazonaws.com/res/0",
    "https://field-results.s3.us-west-2.amazonaws.com:8443/res/0",
    "https://user@field-results.s3.us-west-2.amazonaws.com/res/0",
    "https://evil.example/res/0", "https://amazonaws.com.evil.example/x",
    "https://ec2-1-2-3-4.compute.amazonaws.com/x", "https://10.0.0.1/x", "",
])
def test_chunk_links_must_be_https_cloud_storage(url):
    with pytest.raises(ExternalDbError):
        databricks.check_link(url)


@pytest.mark.parametrize("url", [
    "https://bucket.s3.us-west-2.amazonaws.com/a?X-Amz-Signature=x",
    "https://s3.amazonaws.com/bucket/a", "https://bucket.s3-us-gov-west-1.amazonaws.com/a",
    "https://account.blob.core.windows.net/c/a?sig=x",
    "https://account.dfs.core.windows.net/c/a", "https://storage.googleapis.com/b/a",
])
def test_cloud_storage_links_are_accepted(url):
    databricks.check_link(url)


def test_preview_stays_small_and_inline(warehouse):
    connections.preview(spec(), "field_ops", "farmers", 20)
    select = [b for b in warehouse.bodies if b["statement"].startswith("SELECT * FROM `main`")]
    assert select[0]["disposition"] == "INLINE" and select[0]["row_limit"] == 20
    assert warehouse.link_calls == [] and warehouse.downloads == []


def test_a_preview_cut_short_by_its_row_limit_is_not_an_error(warehouse, monkeypatch):
    """The old code called any `truncated` result 'larger than 25 MB'."""
    original = warehouse.done

    def truncated(sid, columns, rows, chunks=None):
        answer = original(sid, columns, rows, chunks)
        answer["manifest"]["truncated"] = True
        return answer

    monkeypatch.setattr(warehouse, "done", truncated)
    shown = connections.preview(spec(), "field_ops", "farmers", 2)
    assert len(shown["rows"]) == 2


def test_H_the_token_and_link_signatures_stay_out_of_everything(
        admin_client, warehouse, destination, caplog):
    caplog.set_level(logging.DEBUG)
    ok = admin_client.post("/api/external-db/load", json={
        "connection": spec(), "schema": "field_ops", "table": "farmers",
        "destination_table": destination})
    assert ok.status_code == 200
    warehouse.broken = {1}
    failed = admin_client.post("/api/external-db/load", json={
        "connection": spec(), "schema": "field_ops", "table": "farmers",
        "destination_table": destination + "_b"})
    assert failed.status_code == 502
    history = admin_client.get("/api/external-db/imports")
    for text in (ok.text, failed.text, history.text, caplog.text):
        assert TOKEN not in text
        assert "SIGNED" not in text and "X-Amz-Signature" not in text


def test_the_route_reports_a_limit_as_a_422_naming_it(admin_client, warehouse, destination,
                                                      monkeypatch):
    monkeypatch.setattr(settings, "external_db_databricks_max_rows", 2)
    answer = admin_client.post("/api/external-db/load", json={
        "connection": spec(), "schema": "field_ops", "table": "farmers",
        "destination_table": destination})
    assert answer.status_code == 422
    assert answer.json()["detail"]["code"] == "IMPORT_LIMIT"
    assert "more than 2 rows" in answer.json()["detail"]["message"]
