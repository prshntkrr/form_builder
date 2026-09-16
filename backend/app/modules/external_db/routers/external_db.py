"""Reading another database, and copying one of its tables into this one.

    POST /api/external-db/test-connection    can this be reached?
    POST /api/external-db/schemas            what is in it
    POST /api/external-db/tables             what is in one schema
    POST /api/external-db/preview            columns, and a few rows
    POST /api/external-db/load               copy one table into this database

POST throughout, including for the reads: the connection details — including a
password — are the body of every request, and a password does not belong in a
URL, a query string, a browser history or an access log.

One permission guards all five: `external_db.import`. Nothing is stored, so
there is nothing here to list afterwards; a connection lives for the length of
the request that carried it.
"""
import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from app.core import auth_service
from app.core.deps import needs
from app.modules.external_db import connections, import_service
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
    "RESOURCE_NOT_FOUND": 404,
    "CONFLICT": 409,
    "EXTERNAL_DB_CONNECTION_FAILED": 502,
    "EXTERNAL_DB_QUERY_FAILED": 502,
    "IMPORT_FAILED": 500,
}


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
        return connections.test(as_spec(req))
    except ExternalDbError as exc:
        raise _refuse(exc)


@router.post("/schemas")
def list_schemas(req: SchemaRequest,
                 user: Dict[str, Any] = Depends(needs(EXTERNAL_DB_IMPORT))):
    """The schemas in that database, without the server's own."""
    try:
        return {"schemas": connections.schemas(as_spec(req.connection))}
    except ExternalDbError as exc:
        raise _refuse(exc)


@router.post("/tables")
def list_tables(req: TableRequest,
                user: Dict[str, Any] = Depends(needs(EXTERNAL_DB_IMPORT))):
    """The tables in one schema. Metadata only — no data is read here."""
    try:
        return {"schema": req.source_schema,
                "tables": connections.tables(as_spec(req.connection), req.source_schema)}
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
        return connections.preview(as_spec(req.connection), req.source_schema,
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
            as_spec(req.connection), req.source_schema, req.source_table,
            req.destination_table, loaded_by=auth_service.display_name(user))
    except ExternalDbError as exc:
        raise _refuse(exc)
