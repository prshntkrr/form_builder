"""Reading another database, and copying one of its tables into this one.

    POST /api/external-db/test-connection    can this be reached?
    POST /api/external-db/schemas            what is in it
    POST /api/external-db/tables             what is in one schema
    POST /api/external-db/preview            columns, and a few rows
    POST /api/external-db/load               copy one table into this database
    GET  /api/external-db/imports            what has been imported, and how it went

    GET    /api/external-db/connections            the saved ones
    POST   /api/external-db/connections            save one (tested first)
    GET    /api/external-db/connections/{id}       one, as metadata
    PATCH  /api/external-db/connections/{id}       change it, credential or not
    DELETE /api/external-db/connections/{id}       forget it, credential and all
    POST   /api/external-db/connections/{id}/test  does it still work?

Any of the five above take `{"connection": {"connection_id": 7}}` in place of
a typed-in connection: the browser sends a number, the server unseals the
credential for that one request. No stored credential is ever sent back.

POST throughout, including for the reads: the connection details — including a
password — are the body of every request, and a password does not belong in a
URL, a query string, a browser history or an access log.

One permission guards every route here: `external_db.import`. A typed-in
connection lives for the length of the request that carried it. A saved one
keeps its credential sealed server-side (`connection_store`), and no route
returns it: a saved connection is answered as metadata plus
`credential_configured`.
"""
import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from app.core import auth_service
from app.core.deps import needs
from app.modules.external_db import connection_store, connections, import_service
from app.modules.external_db.connections import ExternalDbError
from app.modules.external_db.permissions import EXTERNAL_DB_IMPORT
from app.modules.external_db.schemas import (
    ConnectionRequest, LoadRequest, PreviewRequest, SchemaRequest, TableRequest,
    as_spec,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/external-db", tags=["external database"])

# Which HTTP status each refusal is. The message is written for somebody who
# has to act on it; the driver's own wording never reaches the browser.
STATUS = {
    "VALIDATION_ERROR": 422,
    "UNSUPPORTED_DB_TYPE": 422,
    "UNSUPPORTED_COLUMN_TYPE": 422,
    # A configured import limit — rows, bytes or time — was reached.
    "IMPORT_LIMIT": 422,
    "RESOURCE_NOT_FOUND": 404,
    "CONFLICT": 409,
    "EXTERNAL_DB_CONNECTION_FAILED": 502,
    "EXTERNAL_DB_QUERY_FAILED": 502,
    "IMPORT_FAILED": 500,
}


# --------------------------------------------------------------------------- #
# saved connections — metadata out, credentials never
# --------------------------------------------------------------------------- #
@router.get("/connections")
def list_connections(user: Dict[str, Any] = Depends(needs(EXTERNAL_DB_IMPORT))):
    """The saved connections this account may use. No credential, ever."""
    return {"connections": connection_store.listed(user)}


@router.post("/connections", status_code=201)
def create_connection(req: ConnectionRequest,
                      user: Dict[str, Any] = Depends(needs(EXTERNAL_DB_IMPORT))):
    """Save a connection. The credential is tested, then sealed — never echoed."""
    try:
        return connection_store.create(user, req.model_dump(),
                                       created_by=auth_service.display_name(user))
    except ExternalDbError as exc:
        raise _refuse(exc)


@router.get("/connections/{connection_id}")
def get_connection(connection_id: int,
                   user: Dict[str, Any] = Depends(needs(EXTERNAL_DB_IMPORT))):
    """One saved connection: what it points at, and `credential_configured`."""
    try:
        return connection_store.one(user, connection_id)
    except ExternalDbError as exc:
        raise _refuse(exc)


@router.patch("/connections/{connection_id}")
def update_connection(connection_id: int, req: ConnectionRequest,
                      user: Dict[str, Any] = Depends(needs(EXTERNAL_DB_IMPORT))):
    """Change a saved connection.

    A body with no password or token leaves the stored credential exactly as it
    was. One with a credential replaces it only after that credential has
    opened the connection.
    """
    try:
        return connection_store.update(user, connection_id, req.model_dump())
    except ExternalDbError as exc:
        raise _refuse(exc)


@router.delete("/connections/{connection_id}")
def delete_connection(connection_id: int,
                      user: Dict[str, Any] = Depends(needs(EXTERNAL_DB_IMPORT))):
    """Forget the connection and its sealed credential. Imported tables stay."""
    try:
        return connection_store.delete(user, connection_id)
    except ExternalDbError as exc:
        raise _refuse(exc)


@router.post("/connections/{connection_id}/test")
def test_connection_by_id(connection_id: int,
                          user: Dict[str, Any] = Depends(needs(EXTERNAL_DB_IMPORT))):
    """Open a saved connection now, with the credential it already holds."""
    try:
        return connection_store.test(user, connection_id)
    except ExternalDbError as exc:
        raise _refuse(exc)


@router.get("/imports")
def list_imports(user: Dict[str, Any] = Depends(needs(EXTERNAL_DB_IMPORT))):
    """Every import attempt, newest first: metadata only, never a credential."""
    return {"imports": import_service.history()}


def _refuse(exc: ExternalDbError) -> HTTPException:
    return HTTPException(status_code=STATUS.get(exc.code, 400),
                         detail={"code": exc.code, "message": str(exc)})


@router.post("/test-connection")
def test_connection(req: ConnectionRequest,
                    user: Dict[str, Any] = Depends(needs(EXTERNAL_DB_IMPORT))):
    """Whether the external database can be reached with these details.

    Answers with nothing but success and the kind of database it reached. The
    password that was sent is not echoed, stored or logged.
    """
    try:
        return connections.test(as_spec(req, user))
    except ExternalDbError as exc:
        raise _refuse(exc)


@router.post("/schemas")
def list_schemas(req: SchemaRequest,
                 user: Dict[str, Any] = Depends(needs(EXTERNAL_DB_IMPORT))):
    """The schemas in that database, without the server's own."""
    try:
        return {"schemas": connections.schemas(as_spec(req.connection, user))}
    except ExternalDbError as exc:
        raise _refuse(exc)


@router.post("/tables")
def list_tables(req: TableRequest,
                user: Dict[str, Any] = Depends(needs(EXTERNAL_DB_IMPORT))):
    """The tables in one schema. Metadata only — no data is read here."""
    try:
        return {"schema": req.source_schema,
                "tables": connections.tables(as_spec(req.connection, user),
                                             req.source_schema)}
    except ExternalDbError as exc:
        raise _refuse(exc)


@router.post("/preview")
def preview(req: PreviewRequest,
            user: Dict[str, Any] = Depends(needs(EXTERNAL_DB_IMPORT))):
    """The columns, and the first few rows, so somebody can be sure.

    `limit` is clamped to `EXTERNAL_DB_PREVIEW_MAX`: a preview is for looking
    at, and a request for a million rows is not a preview.
    """
    try:
        return connections.preview(as_spec(req.connection, user), req.source_schema,
                                   req.table, req.limit)
    except ExternalDbError as exc:
        raise _refuse(exc)


@router.post("/load")
def load(req: LoadRequest, user: Dict[str, Any] = Depends(needs(EXTERNAL_DB_IMPORT))):
    """Copy one external table into this application's database.

    A one-time, whole-table load. The destination must not already exist —
    nothing here overwrites or drops a table — and the whole copy is one
    transaction, so a failure leaves the database exactly as it was.
    """
    try:
        return import_service.load(
            as_spec(req.connection, user), req.source_schema, req.source_table,
            req.destination_table, loaded_by=auth_service.display_name(user),
            connection_id=req.connection.connection_id)
    except ExternalDbError as exc:
        raise _refuse(exc)
