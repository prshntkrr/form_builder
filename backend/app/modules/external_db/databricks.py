"""Reading a Databricks SQL warehouse, through the SQL Statement Execution API.

    POST /api/2.0/sql/statements                      run one statement
    GET  /api/2.0/sql/statements/{id}                 until it has finished
    GET  /api/2.0/sql/statements/{id}/result/chunks/n the rest of its rows
    POST /api/2.0/sql/statements/{id}/cancel          when it takes too long

The same five questions `connections.py` answers for PostgreSQL and MySQL —
test, schemas, tables, columns, rows — asked over HTTPS instead of a socket.

The access token is a request-only secret, exactly like a database password: it
is used for the calls one request makes and then forgotten. It is sent in the
Authorization header and nowhere else — never in a URL, a log line, a stored
row or an error message — and only ever to a Databricks workspace host, over
HTTPS, with redirects refused (a redirect would carry the header elsewhere).

Names are checked against a strict pattern and backtick-quoted; the one value
that is not a name (a schema to list tables of) is sent as a statement
parameter. Nothing a caller types is pasted into SQL as text.

Two ways results come back:

    metadata, previews   INLINE — in the response, capped by Databricks at 25 MiB
    imports              EXTERNAL_LINKS — chunk by chunk, each chunk a presigned
                         cloud-storage link downloaded without the token

25 MiB is Databricks' limit on an inline response, not on a table. An import is
bounded by this installation's own limits instead: rows
(`EXTERNAL_DB_DATABRICKS_MAX_ROWS`), bytes (`…_MAX_BYTES`), time waiting for
the query (`…_WAIT_SECONDS`) and time downloading it (`…_IMPORT_SECONDS`).
"""
import json
import logging
import re
import time
from typing import Any, Dict, Iterator, List, Optional, Tuple

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# httpx logs every request's full URL at INFO. A presigned chunk URL carries its
# signature in the query string — a short-lived credential — so its request
# lines are kept out of the log. Warnings and errors still come through.
logging.getLogger("httpx").setLevel(logging.WARNING)

DATABRICKS = "databricks"

# The workspace hosts Databricks serves: AWS, Azure and GCP. Anything else — an
# IP address, localhost, an internal name, a look-alike — is refused before a
# single request is made, which is what keeps the token from being sent to a
# server that is not Databricks (and this server from being pointed inward).
HOST = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*"
    r"\.(?:cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com)$")
WAREHOUSE = re.compile(r"^[A-Za-z0-9]{1,64}$")
# A catalog, schema or table name as this module is willing to quote. Unity
# Catalog allows hyphens and a leading digit (`e-agrology`) when the name is
# backtick-quoted, which `quote` always does. Still no backtick, dot, space or
# anything else that could end a quoted name or add a part to it.
NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]{0,254}$")

DONE, FAILED = "SUCCEEDED", ("FAILED", "CANCELED", "CLOSED")

# Seconds between polls of a statement that is still running. A module value so
# tests can make it zero.
POLL_SECONDS = 1.0
# How the calls are made. None is the real network; tests put a mock here.
transport: Optional[httpx.BaseTransport] = None

# Databricks type -> PostgreSQL type. JSON_ARRAY sends every value as a string
# (or null), which PostgreSQL casts on insert. Anything not here is refused
# with the column named rather than guessed at.
TYPES = {
    "BYTE": "SMALLINT", "TINYINT": "SMALLINT", "SHORT": "SMALLINT",
    "SMALLINT": "SMALLINT", "INT": "INTEGER", "INTEGER": "INTEGER",
    "LONG": "BIGINT", "BIGINT": "BIGINT", "FLOAT": "REAL", "DOUBLE": "DOUBLE PRECISION",
    "DECIMAL": "NUMERIC", "BOOLEAN": "BOOLEAN",
    "STRING": "TEXT", "CHAR": "TEXT", "VARCHAR": "TEXT",
    "DATE": "DATE", "TIMESTAMP": "TIMESTAMPTZ", "TIMESTAMP_NTZ": "TIMESTAMP",
    # Nested values arrive as JSON text.
    "ARRAY": "JSONB", "MAP": "JSONB", "STRUCT": "JSONB", "VARIANT": "JSONB",
}


def _error(message: str, code: str = "EXTERNAL_DB_QUERY_FAILED"):
    # Imported late: connections imports this module.
    from app.modules.external_db.connections import ExternalDbError

    return ExternalDbError(message, code)


def check_host(value: str) -> str:
    """The workspace host name, or a refusal.

    `https://` and a trailing slash are forgiven, because that is what gets
    pasted from a browser. A port, a path, a user or any other scheme is not.
    """
    text = str(value or "").strip().lower()
    if text.startswith("https://"):
        text = text[len("https://"):]
    text = text.rstrip("/")
    if not HOST.match(text):
        raise _error(
            "That is not a Databricks workspace host. Use the host name from the "
            "workspace URL, such as dbc-1234abcd-5678.cloud.databricks.com.",
            "VALIDATION_ERROR")
    return text


def check_name(value: str, what: str) -> str:
    text = str(value or "").strip()
    if not NAME.match(text):
        raise _error(f"'{text}' is not a valid {what} name.", "VALIDATION_ERROR")
    return text


def quote(*names: str) -> str:
    """A qualified name, backtick-quoted. Every part was checked first."""
    return ".".join(f"`{n.replace('`', '``')}`" for n in names)


def check(spec: Dict[str, Any]) -> Dict[str, Any]:
    """The connection as it will be used, or a refusal."""
    warehouse = str(spec.get("warehouse_id") or "").strip()
    if not WAREHOUSE.match(warehouse):
        raise _error("A SQL warehouse ID is required: letters and digits, as shown "
                     "in the warehouse's connection details.", "VALIDATION_ERROR")
    token = spec.get("token")
    token = token.get_secret_value() if hasattr(token, "get_secret_value") else str(token or "")
    if not token.strip():
        raise _error("An access token is required.", "VALIDATION_ERROR")
    return {"db_type": DATABRICKS, "host": check_host(spec.get("host")),
            "warehouse_id": warehouse,
            "catalog": check_name(spec.get("catalog"), "catalog"),
            "token": token.strip(), "name": str(spec.get("name") or "").strip()[:100]}


def describe(spec: Dict[str, Any]) -> str:
    """Safe to log and to store: never the token."""
    return f"databricks://{spec['host']}/{spec['catalog']}"


# --------------------------------------------------------------------------- #
# one statement
# --------------------------------------------------------------------------- #
def _client(spec: Dict[str, Any]) -> httpx.Client:
    return httpx.Client(
        base_url=f"https://{spec['host']}",
        headers={"Authorization": f"Bearer {spec['token']}"},
        timeout=httpx.Timeout(settings.external_db_query_timeout,
                              connect=settings.external_db_connect_timeout),
        follow_redirects=False,
        transport=transport,
    )


def _call(client: httpx.Client, method: str, path: str, **kwargs) -> Dict[str, Any]:
    """One HTTP call, its failures said in words that carry no secret.

    httpx's own messages name the URL; the token is in a header, not the URL,
    but none of it reaches the caller anyway — only the kind of failure does.
    """
    try:
        response = client.request(method, path, **kwargs)
    except httpx.HTTPError as exc:
        logger.warning("Databricks call failed: %s %s: %s", method, path, type(exc).__name__)
        raise _error("Unable to reach the Databricks workspace. Check the host "
                     "and network access.", "EXTERNAL_DB_CONNECTION_FAILED") from exc

    if response.status_code in (401, 403):
        raise _error("Databricks refused the access token, or it may not use "
                     "this warehouse.", "EXTERNAL_DB_CONNECTION_FAILED")
    if response.status_code == 404:
        raise _error("Databricks could not find that SQL warehouse.",
                     "EXTERNAL_DB_CONNECTION_FAILED")
    if response.status_code >= 300:
        logger.warning("Databricks answered %s to %s %s", response.status_code, method, path)
        raise _error(f"Databricks refused the request (HTTP {response.status_code}).")
    try:
        return response.json()
    except ValueError as exc:
        raise _error("Databricks sent an answer that could not be read.") from exc


def _failed(answer: Dict[str, Any]):
    """A statement that did not succeed, named by its error code only.

    Databricks' message can quote the statement; its error code
    (TABLE_OR_VIEW_NOT_FOUND, …) says what went wrong without it.
    """
    status = answer.get("status") or {}
    code = str((status.get("error") or {}).get("error_code") or status.get("state") or "")
    code = code if re.match(r"^[A-Z_]{1,64}$", code) else "UNKNOWN"
    if code in ("TABLE_OR_VIEW_NOT_FOUND", "SCHEMA_NOT_FOUND", "CATALOG_NOT_FOUND"):
        return _error(f"Databricks could not find that ({code}).", "RESOURCE_NOT_FOUND")
    return _error(f"Databricks could not run the query ({code}).")


def _run(client: httpx.Client, spec: Dict[str, Any], statement: str,
         **options) -> Dict[str, Any]:
    """Submit one statement and wait for it: the finished answer, or a refusal.

    Waits (polling) up to `external_db_databricks_wait_seconds` — a stopped
    warehouse takes a few minutes to start — then cancels the statement rather
    than leave it running on somebody's warehouse.
    """
    body = {"statement": statement, "warehouse_id": spec["warehouse_id"],
            "catalog": spec["catalog"], "wait_timeout": "10s",
            "on_wait_timeout": "CONTINUE", "format": "JSON_ARRAY",
            **{k: v for k, v in options.items() if v is not None}}
    answer = _call(client, "POST", "/api/2.0/sql/statements", json=body)
    statement_id = str(answer.get("statement_id") or "")
    deadline = time.monotonic() + settings.external_db_databricks_wait_seconds
    while (answer.get("status") or {}).get("state") in ("PENDING", "RUNNING"):
        if time.monotonic() > deadline:
            try:
                _call(client, "POST", f"/api/2.0/sql/statements/{statement_id}/cancel")
            except Exception:
                pass
            raise _error("Databricks did not finish the query within "
                         f"{settings.external_db_databricks_wait_seconds} seconds, so it was "
                         "cancelled. The warehouse may still be starting; try again in a minute.",
                         "IMPORT_LIMIT")
        time.sleep(POLL_SECONDS)
        answer = _call(client, "GET", f"/api/2.0/sql/statements/{statement_id}")
    if (answer.get("status") or {}).get("state") != DONE:
        raise _failed(answer)
    return answer


def execute(spec: Dict[str, Any], statement: str,
            parameters: Optional[List[Dict[str, str]]] = None,
            row_limit: Optional[int] = None
            ) -> Tuple[List[Dict[str, Any]], Iterator[List[list]], Optional[int]]:
    """Run one small statement inline: its columns, rows chunk by chunk, row count.

    For metadata and previews only. INLINE results are capped by Databricks at
    25 MiB, so an import never comes through here — see `rows`. A `row_limit`
    that cuts the result short (`truncated`) is what was asked for, not an error.
    """
    client = _client(spec)
    try:
        answer = _run(client, spec, statement, disposition="INLINE",
                      parameters=parameters or None,
                      row_limit=int(row_limit) if row_limit else None)
    except Exception:
        client.close()
        raise

    statement_id = str(answer.get("statement_id") or "")
    manifest = answer.get("manifest") or {}
    columns = (manifest.get("schema") or {}).get("columns") or []

    def rows() -> Iterator[List[list]]:
        try:
            result = answer.get("result") or {}
            while True:
                yield result.get("data_array") or []
                following = result.get("next_chunk_index")
                if following is None:
                    return
                result = _call(client, "GET",
                               f"/api/2.0/sql/statements/{statement_id}/result/chunks/{int(following)}")
        finally:
            client.close()

    described = [{"name": str(c.get("name")), "type": str(c.get("type_name") or "").upper()}
                 for c in columns]
    return described, rows(), manifest.get("total_row_count")


def _all(spec: Dict[str, Any], statement: str,
         parameters: Optional[List[Dict[str, str]]] = None,
         row_limit: Optional[int] = None) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """A small statement's columns and every row, as dicts by column name."""
    columns, chunks, _ = execute(spec, statement, parameters, row_limit)
    names = [c["name"] for c in columns]
    return columns, [dict(zip(names, row)) for chunk in chunks for row in chunk]


# --------------------------------------------------------------------------- #
# what is in there — the same questions connections.py answers
# --------------------------------------------------------------------------- #
def test(spec: Dict[str, Any]) -> Dict[str, Any]:
    checked = check(spec)
    _all(checked, "SELECT 1")
    logger.info("Databricks connection tested: %s", describe(checked))
    return {"success": True, "message": "Connection successful", "db_type": DATABRICKS}


def schemas(spec: Dict[str, Any]) -> List[str]:
    checked = check(spec)
    columns, rows = _all(checked, f"SHOW SCHEMAS IN {quote(checked['catalog'])}")
    # The column is `databaseName` or `namespace` depending on the runtime; it
    # is the only one either way.
    first = columns[0]["name"] if columns else None
    return sorted(str(r[first]) for r in rows if first and r.get(first)
                  and r[first] != "information_schema")


def tables(spec: Dict[str, Any], schema: str) -> List[Dict[str, str]]:
    """Discovered, never assumed: whatever the schema holds today."""
    checked = check(spec)
    wanted = check_name(schema, "schema")
    _, rows = _all(checked, f"SHOW TABLES IN {quote(checked['catalog'], wanted)}")
    return sorted(({"name": str(r["tableName"]), "kind": "TABLE"} for r in rows
                   if r.get("tableName") and str(r.get("isTemporary")).lower() != "true"),
                  key=lambda t: t["name"])


def columns(spec: Dict[str, Any], schema: str, table: str) -> List[Dict[str, Any]]:
    """The columns, read from the result of a query that returns no rows."""
    checked = check(spec)
    name = quote(checked["catalog"], check_name(schema, "schema"), check_name(table, "table"))
    described, chunks, _ = execute(checked, f"SELECT * FROM {name} LIMIT 0")
    for _ in chunks:
        pass
    return [{"name": c["name"], "source_type": c["type"].lower(),
             "declared": c["type"].lower(), "nullable": True} for c in described]


def preview(spec: Dict[str, Any], schema: str, table: str, limit: int = 20) -> Dict[str, Any]:
    checked = check(spec)
    wanted_schema = check_name(schema, "schema")
    wanted_table = check_name(table, "table")
    rows_wanted = max(1, min(int(limit or 20), settings.external_db_preview_max))
    described, rows = _all(
        checked, f"SELECT * FROM {quote(checked['catalog'], wanted_schema, wanted_table)}",
        row_limit=rows_wanted)
    return {"schema": wanted_schema, "table": wanted_table,
            "columns": [{"name": c["name"], "source_type": c["type"].lower()} for c in described],
            "rows": rows[:rows_wanted], "row_limit": rows_wanted}


# --------------------------------------------------------------------------- #
# the import: EXTERNAL_LINKS, one chunk at a time
# --------------------------------------------------------------------------- #
# Where Databricks puts result chunks: the cloud storage behind the workspace.
# A presigned link to anywhere else is refused — the link comes from a response,
# and this server must not be steered into fetching an arbitrary URL.
LINK_HOST = re.compile(
    r"^(?:[a-z0-9-]+\.)*(?:"
    r"s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com"                    # AWS S3
    r"|[a-z0-9]+\.(?:blob|dfs)\.core\.windows\.net"             # Azure storage
    r"|storage\.googleapis\.com"                                # GCS
    r")$")


def _limit(message: str):
    return _error(message, "IMPORT_LIMIT")


def check_link(url: str) -> httpx.URL:
    """A presigned chunk URL, or a refusal: https, a cloud-storage host, no tricks."""
    try:
        parsed = httpx.URL(str(url or ""))
    except Exception as exc:
        raise _error("Databricks sent a result link that could not be used.") from exc
    host = (parsed.host or "").lower()
    if (parsed.scheme != "https" or parsed.userinfo or parsed.port not in (None, 443)
            or not LINK_HOST.match(host)):
        # Never the URL itself in a message or log: it carries a signature.
        logger.warning("Databricks result link refused: host %s", host or "-")
        raise _error("Databricks sent a result link to an unexpected place, so it "
                     "was not followed. Nothing was imported.")
    return parsed


def _download(link: Dict[str, Any], budget: int) -> Tuple[List[list], int]:
    """One chunk's rows, and its size in bytes. Never more than `budget` bytes.

    No Authorization header — the link is presigned, and Databricks says not to
    send one. No redirects. Any headers Databricks lists for the link (e.g. an
    encryption key) are sent, except an Authorization header.
    """
    url = check_link(link.get("external_link"))
    headers = {str(k): str(v) for k, v in (link.get("http_headers") or {}).items()
               if str(k).lower() != "authorization"}
    body = bytearray()
    with httpx.Client(timeout=httpx.Timeout(settings.external_db_query_timeout,
                                            connect=settings.external_db_connect_timeout),
                      follow_redirects=False, transport=transport) as storage:
        try:
            with storage.stream("GET", url, headers=headers) as response:
                if response.status_code != 200:
                    raise _ChunkUnavailable(response.status_code)
                for piece in response.iter_bytes():
                    body.extend(piece)
                    if len(body) > budget:
                        raise _limit(_bytes_message())
        except httpx.HTTPError as exc:
            logger.warning("Databricks chunk download failed: %s", type(exc).__name__)
            raise _ChunkUnavailable(0) from exc
    try:
        data = json.loads(bytes(body))
    except ValueError as exc:
        raise _error("Databricks sent a result chunk that could not be read. "
                     "Nothing was imported.") from exc
    if not isinstance(data, list) or not all(isinstance(r, list) for r in data):
        raise _error("Databricks sent a result chunk in an unexpected shape. "
                     "Nothing was imported.")
    return data, len(body)


class _ChunkUnavailable(Exception):
    """A download that failed in a way a fresh link may fix (expired, network)."""

    def __init__(self, status: int):
        self.status = status


def _bytes_message() -> str:
    most = int(settings.external_db_databricks_max_bytes)
    return (f"That table is larger than {most / 1024 ** 2:,.0f} MB, the most this "
            "installation imports from Databricks in one import "
            "(EXTERNAL_DB_DATABRICKS_MAX_BYTES). Nothing was imported.")


def _rows_message() -> str:
    most = int(settings.external_db_databricks_max_rows)
    return (f"That table has more than {most:,} rows, the most this installation "
            "imports from Databricks in one import (EXTERNAL_DB_DATABRICKS_MAX_ROWS). "
            "Nothing was imported.")


def _whole(value: Any, what: str) -> int:
    """A count Databricks reported, or a refusal: never guessed at."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = -1
    if number < 0:
        raise _error(f"Databricks did not describe the result ({what}). Nothing was imported.")
    return number


def rows(spec: Dict[str, Any], schema: str, table: str, batch: int) -> Iterator[List[tuple]]:
    """Every row, in batches of `batch`, fetched one result chunk at a time.

        SELECT * … (EXTERNAL_LINKS, row_limit = max rows + 1, byte_limit = max bytes)
          └ for chunk 0 … total_chunk_count-1:
              GET …/result/chunks/{i}   → a presigned link for that chunk
              GET <link>                → its rows (no token), inserted, let go

    Only one chunk is held in memory. Each chunk is checked against the
    manifest — its index, its starting row, its row count — so a row missing or
    sent twice stops the import rather than landing in the table; the total is
    checked at the end. Any refusal is raised from inside the caller's
    transaction, which rolls the whole table back.
    """
    checked = check(spec)
    name = quote(checked["catalog"], check_name(schema, "schema"), check_name(table, "table"))
    most_rows = int(settings.external_db_databricks_max_rows)
    most_bytes = int(settings.external_db_databricks_max_bytes)
    deadline = time.monotonic() + settings.external_db_databricks_import_seconds

    client = _client(checked)
    try:
        # One row over the limit, so a table over it is known — and refused —
        # before anything is written, rather than silently cut short.
        answer = _run(client, checked, f"SELECT * FROM {name}",
                      disposition="EXTERNAL_LINKS",
                      row_limit=most_rows + 1, byte_limit=most_bytes)
        statement_id = str(answer.get("statement_id") or "")
        manifest = answer.get("manifest") or {}
        width = len((manifest.get("schema") or {}).get("columns") or [])
        total = _whole(manifest.get("total_row_count"), "row count")
        chunks = _whole(manifest.get("total_chunk_count", 0 if total == 0 else None),
                        "chunk count")
        if total > most_rows:
            raise _limit(_rows_message())
        if manifest.get("truncated"):
            # Not the rows (checked above), so the byte limit cut it short.
            raise _limit(_bytes_message())

        offset = size = 0
        for index in range(chunks):
            link = None
            for attempt in (1, 2):
                if time.monotonic() > deadline:
                    raise _limit(
                        "The import took longer than "
                        f"{settings.external_db_databricks_import_seconds} seconds "
                        "(EXTERNAL_DB_DATABRICKS_IMPORT_SECONDS) and was stopped. "
                        "Nothing was imported.")
                # A fresh link each attempt: they expire within 15 minutes.
                listed = _call(client, "GET",
                               f"/api/2.0/sql/statements/{statement_id}/result/chunks/{index}")
                link = next((l for l in listed.get("external_links") or []
                             if l.get("chunk_index") == index), None)
                if link is None or _whole(link.get("row_offset"), "chunk offset") != offset:
                    raise _error(f"Databricks described result chunk {index + 1} of {chunks} "
                                 "inconsistently. Nothing was imported.")
                try:
                    data, got = _download(link, most_bytes - size)
                    break
                except _ChunkUnavailable:
                    if attempt == 2:
                        raise _error(f"Result chunk {index + 1} of {chunks} could not be "
                                     "downloaded from Databricks. Nothing was imported.")
            if len(data) != _whole(link.get("row_count"), "chunk rows") or any(
                    len(r) != width for r in data):
                raise _error(f"Result chunk {index + 1} of {chunks} did not match its "
                             "description. Nothing was imported.")
            offset += len(data)
            size += got
            if offset > most_rows:
                raise _limit(_rows_message())
            for start in range(0, len(data), batch):
                yield [tuple(row) for row in data[start:start + batch]]
            del data

        if offset != total:
            raise _error(f"Databricks sent {offset:,} of the {total:,} rows it reported. "
                         "Nothing was imported.")
    finally:
        client.close()


def map_type(column: Dict[str, Any]) -> Optional[str]:
    return TYPES.get(str(column.get("source_type") or "").upper())
