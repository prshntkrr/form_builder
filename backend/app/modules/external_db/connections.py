"""Reading somebody else's database, and nothing more.

One place holds every connection this feature opens, and it is deliberately
narrow: connect, list schemas, list tables, describe columns, read rows. There
is no method here that writes, and no method that takes SQL from a caller — the
statements are written here and the only thing a request contributes is a
schema name, a table name and a row limit, each checked before it is used.

    PostgreSQL   psycopg2, a named (server-side) cursor for the copy
    MySQL        PyMySQL, an unbuffered cursor for the copy

Both are opened with a connect timeout and a statement/read timeout, so a
request cannot hang on a host that accepts a socket and never answers.

The external side is read-only from this application's point of view. That is
not enforceable from here — a database grants what it grants — so the guarantee
this module makes is the one it can keep: it never composes an INSERT, UPDATE,
DELETE, ALTER, DROP or TRUNCATE against an external connection.
"""
import logging
import re
from contextlib import contextmanager
from typing import Any, Dict, Iterator, List, Optional, Tuple

from app.core.config import settings

logger = logging.getLogger(__name__)

POSTGRESQL, MYSQL = "postgresql", "mysql"
SUPPORTED = (POSTGRESQL, MYSQL)

# A schema or table name as the source database spells it. Deliberately strict:
# anything outside this never reaches a query, quoted or not.
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,62}$")

# Schemas that belong to the server rather than to anybody's data.
POSTGRES_INTERNAL = ("pg_catalog", "information_schema", "pg_toast")
MYSQL_INTERNAL = ("information_schema", "performance_schema", "mysql", "sys")


class ExternalDbError(Exception):
    """Something the caller can be told about, without driver internals."""

    code = "EXTERNAL_DB_QUERY_FAILED"

    def __init__(self, message: str, code: Optional[str] = None):
        self.code = code or self.code
        super().__init__(message)


class ConnectionFailed(ExternalDbError):
    code = "EXTERNAL_DB_CONNECTION_FAILED"


class UnsupportedDbType(ExternalDbError):
    code = "UNSUPPORTED_DB_TYPE"


def check_identifier(value: str, what: str) -> str:
    """A schema or table name, or a refusal. Never a fragment of SQL."""
    text = str(value or "").strip()
    if not IDENTIFIER.match(text):
        raise ExternalDbError(
            f"'{text}' is not a valid {what} name.", "VALIDATION_ERROR")
    return text


def check_connection(spec: Dict[str, Any]) -> Dict[str, Any]:
    """The connection as it will be used, or a refusal.

    Only what a driver needs: a type it knows, a host, a port in range, a
    database, a username and a password. Nothing here is interpolated into a
    connection string — every value is passed to the driver as a keyword.
    """
    db_type = str(spec.get("db_type") or "").strip().lower()
    if db_type not in SUPPORTED:
        raise UnsupportedDbType(
            f"'{db_type or 'none'}' is not a database this can read. "
            f"Supported: {', '.join(SUPPORTED)}.")

    host = str(spec.get("host") or "").strip()
    if not host or any(c in host for c in " \t\r\n;'\""):
        raise ExternalDbError("That host name cannot be used.", "VALIDATION_ERROR")

    # `or` would read 0 as "not given" and quietly substitute the default,
    # which is how an invalid port becomes a successful connection somewhere else.
    given = spec.get("port")
    if given is None or given == "":
        given = 5432 if db_type == POSTGRESQL else 3306
    try:
        port = int(given)
    except (TypeError, ValueError):
        raise ExternalDbError("The port must be a number.", "VALIDATION_ERROR")
    if not 1 <= port <= 65535:
        raise ExternalDbError("The port must be between 1 and 65535.",
                              "VALIDATION_ERROR")

    database = str(spec.get("database") or "").strip()
    if not database:
        raise ExternalDbError("A database name is required.", "VALIDATION_ERROR")

    return {"db_type": db_type, "host": host, "port": port, "database": database,
            "username": str(spec.get("username") or ""),
            "password": str(spec.get("password") or "")}


def describe(spec: Dict[str, Any]) -> str:
    """A connection in a form that is safe to log: never the password."""
    return (f"{spec['db_type']}://{spec['username'] or '-'}@{spec['host']}:"
            f"{spec['port']}/{spec['database']}")


# --------------------------------------------------------------------------- #
# opening one
# --------------------------------------------------------------------------- #
@contextmanager
def connect(spec: Dict[str, Any], streaming: bool = False):
    """An open connection to the external database, always closed again.

    `streaming` asks for a cursor that does not load the whole result into
    memory — a server-side cursor in PostgreSQL, an unbuffered one in MySQL —
    which is what makes copying a large table possible at all.
    """
    checked = check_connection(spec)
    connection = None

    try:
        if checked["db_type"] == POSTGRESQL:
            import psycopg2
            import psycopg2.extras

            connection = psycopg2.connect(
                host=checked["host"], port=checked["port"],
                dbname=checked["database"], user=checked["username"],
                password=checked["password"],
                connect_timeout=settings.external_db_connect_timeout,
                # Nothing this feature runs should take minutes; a source that
                # hangs is a failed request, not a stuck worker.
                options=f"-c statement_timeout={settings.external_db_query_timeout * 1000}",
            )
            # Read-only always. Autocommit for the small metadata reads, but
            # *not* while streaming: a named (server-side) cursor only exists
            # inside a transaction, and psycopg2 opens none under autocommit.
            connection.set_session(readonly=True, autocommit=not streaming)
        else:
            import pymysql
            import pymysql.cursors

            connection = pymysql.connect(
                host=checked["host"], port=checked["port"],
                database=checked["database"], user=checked["username"],
                password=checked["password"],
                connect_timeout=settings.external_db_connect_timeout,
                read_timeout=settings.external_db_query_timeout,
                write_timeout=settings.external_db_query_timeout,
                cursorclass=(pymysql.cursors.SSDictCursor if streaming
                             else pymysql.cursors.DictCursor),
                autocommit=True,
            )
    except ImportError as exc:
        raise UnsupportedDbType(
            f"This installation has no driver for {checked['db_type']}.") from exc
    except Exception as exc:
        # The driver's message can carry the host, the user and sometimes the
        # password it tried. None of that goes back to the browser.
        logger.warning("External connection failed for %s: %s",
                       describe(checked), type(exc).__name__)
        raise ConnectionFailed(
            "Unable to connect to the external database. Verify the host, port, "
            "database, username, password, and network access.") from exc

    try:
        yield connection
    finally:
        try:
            connection.close()
        except Exception:
            pass


@contextmanager
def _cursor(connection, db_type: str, streaming: bool = False):
    if db_type == POSTGRESQL:
        import psycopg2.extras

        # A named cursor is the server-side one; it must not be used for the
        # small metadata reads, which are simpler unnamed.
        cursor = (connection.cursor(name="external_read",
                                    cursor_factory=psycopg2.extras.RealDictCursor)
                  if streaming
                  else connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor))
        cursor.itersize = settings.external_db_batch_size
    else:
        cursor = connection.cursor()

    try:
        yield cursor
    finally:
        try:
            cursor.close()
        except Exception:
            pass


def _query(connection, db_type: str, sql: str, params: tuple = ()) -> List[Dict[str, Any]]:
    try:
        with _cursor(connection, db_type) as cursor:
            cursor.execute(sql, params)
            return [dict(row) for row in cursor.fetchall()]
    except Exception as exc:
        logger.warning("External query failed (%s): %s", db_type, type(exc).__name__)
        raise ExternalDbError(
            "The external database refused that request. It may be unavailable, "
            "or the account may not be allowed to read this.") from exc


# --------------------------------------------------------------------------- #
# what is in there
# --------------------------------------------------------------------------- #
def test(spec: Dict[str, Any]) -> Dict[str, Any]:
    """Open a connection, ask it the cheapest possible question, close it."""
    checked = check_connection(spec)
    with connect(checked) as connection:
        _query(connection, checked["db_type"], "SELECT 1")
    logger.info("External connection tested: %s", describe(checked))
    return {"success": True, "message": "Connection successful",
            "db_type": checked["db_type"]}


def schemas(spec: Dict[str, Any]) -> List[str]:
    checked = check_connection(spec)
    with connect(checked) as connection:
        if checked["db_type"] == POSTGRESQL:
            rows = _query(connection, POSTGRESQL,
                          "SELECT schema_name AS name FROM information_schema.schemata "
                          "WHERE schema_name <> ALL(%s) ORDER BY schema_name",
                          (list(POSTGRES_INTERNAL),))
        else:
            rows = _query(connection, MYSQL,
                          "SELECT schema_name AS name FROM information_schema.schemata "
                          "ORDER BY schema_name")
            rows = [r for r in rows if r["name"] not in MYSQL_INTERNAL]

    return [r["name"] for r in rows]


def tables(spec: Dict[str, Any], schema: str) -> List[Dict[str, str]]:
    checked = check_connection(spec)
    wanted = check_identifier(schema, "schema")

    with connect(checked) as connection:
        rows = _query(
            connection, checked["db_type"],
            "SELECT table_name AS name, table_type AS kind "
            "FROM information_schema.tables WHERE table_schema = %s "
            "ORDER BY table_name",
            (wanted,))

    return [{"name": r["name"], "kind": r["kind"]} for r in rows]


def columns(spec: Dict[str, Any], schema: str, table: str) -> List[Dict[str, Any]]:
    """The source columns, in their declared order."""
    checked = check_connection(spec)
    wanted_schema = check_identifier(schema, "schema")
    wanted_table = check_identifier(table, "table")

    # MySQL needs `column_type` to tell tinyint(1) — a boolean — from tinyint;
    # PostgreSQL has no such column, so each gets the statement it can answer.
    if checked["db_type"] == POSTGRESQL:
        statement = ("SELECT column_name AS name, data_type AS source_type, "
                     "is_nullable FROM information_schema.columns "
                     "WHERE table_schema = %s AND table_name = %s "
                     "ORDER BY ordinal_position")
    else:
        statement = ("SELECT column_name AS name, data_type AS source_type, "
                     "column_type AS declared, is_nullable "
                     "FROM information_schema.columns "
                     "WHERE table_schema = %s AND table_name = %s "
                     "ORDER BY ordinal_position")

    with connect(checked) as connection:
        rows = _query(connection, checked["db_type"], statement,
                      (wanted_schema, wanted_table))

    if not rows:
        raise ExternalDbError(
            f"There is no table '{wanted_schema}.{wanted_table}' in that database.",
            "RESOURCE_NOT_FOUND")

    return [{"name": r["name"],
             "source_type": str(r["source_type"]).lower(),
             "declared": str(r.get("declared") or r["source_type"]).lower(),
             "nullable": str(r.get("is_nullable", "YES")).upper() == "YES"}
            for r in rows]


def _quoted(db_type: str, schema: str, table: str) -> str:
    """A qualified name, quoted the way that database quotes one.

    Both halves have already been through `check_identifier`, so there is
    nothing here that could close a quote; the quoting is the second lock.
    """
    if db_type == POSTGRESQL:
        return f'"{schema}"."{table}"'
    return f"`{schema}`.`{table}`"


def preview(spec: Dict[str, Any], schema: str, table: str,
            limit: int = 20) -> Dict[str, Any]:
    """A few rows, for somebody deciding whether this is the right table."""
    checked = check_connection(spec)
    wanted_schema = check_identifier(schema, "schema")
    wanted_table = check_identifier(table, "table")
    rows_wanted = max(1, min(int(limit or 20), settings.external_db_preview_max))

    described = columns(checked, wanted_schema, wanted_table)

    with connect(checked) as connection:
        rows = _query(
            connection, checked["db_type"],
            f"SELECT * FROM {_quoted(checked['db_type'], wanted_schema, wanted_table)} "
            f"LIMIT {rows_wanted}")

    return {"schema": wanted_schema, "table": wanted_table,
            "columns": [{"name": c["name"], "source_type": c["source_type"]}
                        for c in described],
            "rows": [{k: _plain(v) for k, v in row.items()} for row in rows],
            "row_limit": rows_wanted}


def _plain(value: Any) -> Any:
    """A value JSON can carry. Dates, decimals and bytes become strings."""
    import datetime
    import decimal

    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (datetime.date, datetime.datetime, datetime.time)):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"<{len(bytes(value))} bytes>"
    return str(value)


def rows(spec: Dict[str, Any], schema: str, table: str,
         batch: int) -> Iterator[List[Tuple]]:
    """Every row of the source table, in batches, in column order.

    A generator on purpose: the caller writes each batch and lets it go, so the
    memory this uses is one batch whatever the size of the table.
    """
    checked = check_connection(spec)
    wanted_schema = check_identifier(schema, "schema")
    wanted_table = check_identifier(table, "table")
    names = [c["name"] for c in columns(checked, wanted_schema, wanted_table)]

    selected = ", ".join(
        f'"{n}"' if checked["db_type"] == POSTGRESQL else f"`{n}`" for n in names)
    statement = (f"SELECT {selected} FROM "
                 f"{_quoted(checked['db_type'], wanted_schema, wanted_table)}")

    with connect(checked, streaming=True) as connection:
        with _cursor(connection, checked["db_type"], streaming=True) as cursor:
            cursor.execute(statement)
            while True:
                found = cursor.fetchmany(batch)
                if not found:
                    break
                yield [tuple(row[name] for name in names) for row in found]
