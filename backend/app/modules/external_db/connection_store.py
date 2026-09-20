"""Saved connections: everything but the credential, plus the credential sealed.

    save     test it first, then seal the credential and write the row
    list     metadata, never a credential
    use      the server unseals it for the length of one request

What a browser holds afterwards is a number. The password or access token is
sealed by `app/core/secrets.py` with a key from the environment, is decrypted
only here, only to hand to a driver or to Databricks, and is never returned by
any route, written to a log line or put in an error message.

Who may use one: everybody has to hold `external_db.import`. A connection with
a `project_id` is additionally limited to that project's members — somebody
else's project connection answers exactly as one that does not exist.
"""
import logging
from typing import Any, Dict, List, Optional

from app.core import secrets
from app.core.database import transaction
from app.modules.external_db import connections
from app.modules.external_db.connections import ExternalDbError

logger = logging.getLogger(__name__)

# What a saved row holds, and what a caller may set. `secret` is not here on
# purpose: it is written only by `_seal_into`, never by a field update.
FIELDS = ("name", "db_type", "host", "port", "database", "username",
          "warehouse_id", "catalog", "db_schema", "enabled", "project_id")

# What is safe to send back. Deliberately written out rather than "everything
# except secret": a column added later is not published by accident.
PUBLIC = ("connection_id", "name", "db_type", "host", "port", "database",
          "username", "warehouse_id", "catalog", "db_schema", "enabled",
          "project_id", "created_by", "created_on", "updated_on")


class NoSuchConnection(ExternalDbError):
    code = "RESOURCE_NOT_FOUND"


def _projects_of(user: Dict[str, Any]) -> List[str]:
    """The projects this account belongs to, or [] where there are none."""
    try:
        from app.modules.projects import access
    except ImportError:                       # the projects module is switched off
        return []
    return access.projects_for(user) or []


def _may_use(user: Dict[str, Any], row: Dict[str, Any]) -> bool:
    return not row.get("project_id") or row["project_id"] in _projects_of(user)


def public(row: Dict[str, Any]) -> Dict[str, Any]:
    """One row as a route may answer with it: metadata, and whether it is set up."""
    shown = {key: row.get(key) for key in PUBLIC}
    for key in ("created_on", "updated_on"):
        if shown.get(key) is not None:
            shown[key] = shown[key].isoformat()
    # Whether a credential is stored — never anything about what it is.
    shown["credential_configured"] = bool(row.get("secret"))
    return shown


# --------------------------------------------------------------------------- #
# what a caller may send
# --------------------------------------------------------------------------- #
def _credential(given: Dict[str, Any]) -> str:
    """The password or token out of a request, whichever this type uses."""
    token = given.get("token")
    token = token.get_secret_value() if hasattr(token, "get_secret_value") else token
    if str(given.get("db_type") or "").strip().lower() == connections.DATABRICKS:
        return str(token or "")
    return str(given.get("password") or "")


def _checked(given: Dict[str, Any]) -> Dict[str, Any]:
    """The fields of a connection, checked by the same code that opens one."""
    spec = connections.check_connection({**given, "password": _credential(given),
                                         "token": _credential(given)})
    name = str(given.get("name") or "").strip()
    if not name:
        raise ExternalDbError("A name is required for a saved connection.",
                              "VALIDATION_ERROR")

    row = {"name": name[:100], "db_type": spec["db_type"], "host": spec["host"],
           "port": None, "database": "", "username": "",
           "warehouse_id": "", "catalog": "", "db_schema": ""}
    if spec["db_type"] == connections.DATABRICKS:
        row["warehouse_id"] = spec["warehouse_id"]
        row["catalog"] = spec["catalog"]
        # Only a starting point for the browser; it is checked again when used.
        schema = str(given.get("db_schema") or given.get("schema") or "").strip()
        if schema:
            from app.modules.external_db import databricks
            row["db_schema"] = databricks.check_name(schema, "schema")
    else:
        row.update(port=spec["port"], database=spec["database"],
                   username=spec["username"])
    return row


def _spec_of(row: Dict[str, Any], credential: str) -> Dict[str, Any]:
    """A saved row as the spec every reader in this module already takes."""
    if row["db_type"] == connections.DATABRICKS:
        return {"db_type": row["db_type"], "host": row["host"],
                "warehouse_id": row["warehouse_id"], "catalog": row["catalog"],
                "token": credential, "name": row["name"]}
    return {"db_type": row["db_type"], "host": row["host"], "port": row["port"],
            "database": row["database"], "username": row["username"],
            "password": credential, "name": row["name"]}


def _verify(row: Dict[str, Any], credential: str) -> None:
    """Open the connection once. A credential is never stored untested."""
    connections.test(_spec_of(row, credential))


def _seal(credential: str, connection_id: Any) -> str:
    # The row's own id is the additional data, so a sealed credential lifted
    # into another row does not open there.
    return secrets.seal(credential, aad=f"external_connection:{connection_id}")


# --------------------------------------------------------------------------- #
# reading
# --------------------------------------------------------------------------- #
def _row(connection_id: int) -> Optional[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute("SELECT * FROM external_connection WHERE connection_id = %s",
                    (connection_id,))
        found = cur.fetchone()
    return dict(found) if found else None


def listed(user: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every saved connection this account may use. No credentials."""
    mine = _projects_of(user)
    with transaction() as cur:
        cur.execute(
            """SELECT * FROM external_connection
                WHERE project_id IS NULL OR project_id = ANY(%s)
                ORDER BY name""", (mine,))
        rows = [dict(r) for r in cur.fetchall()]
    return [public(r) for r in rows]


def one(user: Dict[str, Any], connection_id: int) -> Dict[str, Any]:
    return public(_usable(user, connection_id, in_use=False))


def _usable(user: Dict[str, Any], connection_id: int, in_use: bool = True) -> Dict[str, Any]:
    """The row, or a refusal. Somebody else's is answered as no such thing."""
    row = _row(connection_id)
    if row is None or not _may_use(user, row):
        raise NoSuchConnection("There is no saved connection with that id.")
    if in_use and not row["enabled"]:
        raise ExternalDbError(
            f"The saved connection '{row['name']}' is turned off. Turn it back "
            "on to use it.", "CONFLICT")
    return row


def spec_for(user: Dict[str, Any], connection_id: int) -> Dict[str, Any]:
    """A saved connection ready to use — credential unsealed for this request."""
    row = _usable(user, connection_id)
    if not row["secret"]:
        raise ExternalDbError(
            f"The saved connection '{row['name']}' has no stored credential. "
            "Edit it and enter one.", "VALIDATION_ERROR")
    try:
        credential = secrets.unseal(row["secret"], aad=f"external_connection:{connection_id}")
    except secrets.SecretUnavailable as exc:
        raise ExternalDbError(str(exc), "VALIDATION_ERROR") from exc
    except secrets.SecretTampered as exc:
        logger.warning("Stored credential for connection %s could not be opened",
                       connection_id)
        raise ExternalDbError(str(exc), "VALIDATION_ERROR") from exc
    return _spec_of(row, credential)


# --------------------------------------------------------------------------- #
# writing
# --------------------------------------------------------------------------- #
def create(user: Dict[str, Any], given: Dict[str, Any], created_by: str = "") -> Dict[str, Any]:
    """Save a connection — after opening it once with the credential given."""
    if not secrets.available():
        raise ExternalDbError(
            "This installation cannot store credentials: it has no SECRET_KEY. "
            "Ask an administrator to set one, or connect without saving.",
            "VALIDATION_ERROR")

    row = _checked(given)
    credential = _credential(given)
    if not credential:
        raise ExternalDbError(
            "A password or access token is required to save a connection.",
            "VALIDATION_ERROR")

    project_id = str(given.get("project_id") or "").strip() or None
    if project_id and project_id not in _projects_of(user):
        raise ExternalDbError("You are not a member of that project.", "VALIDATION_ERROR")

    _verify(row, credential)

    with transaction() as cur:
        cur.execute(
            """INSERT INTO external_connection
                   (name, db_type, host, port, database, username, warehouse_id,
                    catalog, db_schema, secret, project_id, created_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, '', %s, %s)
               RETURNING connection_id""",
            (row["name"], row["db_type"], row["host"], row["port"], row["database"],
             row["username"], row["warehouse_id"], row["catalog"], row["db_schema"],
             project_id, (created_by or "")[:200]))
        connection_id = cur.fetchone()["connection_id"]
        # Sealed against the id, so it is written once the row has one.
        cur.execute("UPDATE external_connection SET secret = %s WHERE connection_id = %s",
                    (_seal(credential, connection_id), connection_id))

    logger.info("External connection saved: %s (%s) by %s", connection_id,
                connections.describe(_spec_of(row, "")), created_by or "-")
    return one(user, connection_id)


def update(user: Dict[str, Any], connection_id: int, given: Dict[str, Any]) -> Dict[str, Any]:
    """Change what a connection points at, and optionally its credential.

    A request with no credential keeps the stored one untouched — that is what
    a browser sends back, because it was never given the credential to send.
    A new one replaces the old **only after** it has opened the connection.
    """
    row = _usable(user, connection_id, in_use=False)
    # What a PATCH leaves out — or sends empty, as a browser form does for a
    # field this type does not use — stays as it was. The type of a saved
    # connection is never one of the things a change may move.
    told = {k: v for k, v in given.items()
            if v is not None and (v != "" or k == "db_schema")}
    merged = {**{k: row[k] for k in FIELDS if k in row}, **told, "db_type": row["db_type"]}
    wanted = _checked({**merged, "password": "x", "token": "x"})

    # Which field carries a credential is decided by the saved connection's own
    # type, not by what a PATCH says: a body that leaves `db_type` out must not
    # make a new token look like no credential at all.
    credential = _credential({**given, "db_type": row["db_type"]})
    if credential:
        if not secrets.available():
            raise ExternalDbError(
                "This installation cannot store credentials: it has no SECRET_KEY.",
                "VALIDATION_ERROR")
        _verify(wanted, credential)

    enabled = row["enabled"] if given.get("enabled") is None else bool(given["enabled"])
    with transaction() as cur:
        cur.execute(
            """UPDATE external_connection
                  SET name = %s, host = %s, port = %s, database = %s, username = %s,
                      warehouse_id = %s, catalog = %s, db_schema = %s, enabled = %s,
                      updated_on = CURRENT_TIMESTAMP
                WHERE connection_id = %s""",
            (wanted["name"], wanted["host"], wanted["port"], wanted["database"],
             wanted["username"], wanted["warehouse_id"], wanted["catalog"],
             wanted["db_schema"], enabled, connection_id))
        if credential:
            cur.execute("UPDATE external_connection SET secret = %s WHERE connection_id = %s",
                        (_seal(credential, connection_id), connection_id))

    logger.info("External connection %s updated (credential %s)", connection_id,
                "replaced" if credential else "unchanged")
    return one(user, connection_id)


def delete(user: Dict[str, Any], connection_id: int) -> Dict[str, Any]:
    """Forget the connection and its sealed credential. Imported tables stay."""
    row = _usable(user, connection_id, in_use=False)
    with transaction() as cur:
        cur.execute("DELETE FROM external_connection WHERE connection_id = %s",
                    (connection_id,))
    logger.info("External connection %s deleted", connection_id)
    return {"deleted": True, "connection_id": connection_id, "name": row["name"]}


def test(user: Dict[str, Any], connection_id: int) -> Dict[str, Any]:
    """Open a saved connection now, to see whether it still works."""
    return connections.test(spec_for(user, connection_id))
