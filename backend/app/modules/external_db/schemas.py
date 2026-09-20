"""What a request to this module may contain.

A connection is either **typed in** — the fields below, used for the length of
one request and forgotten — or **saved**, in which case the whole of it is
`connection_id` and the server unseals the credential itself. A browser never
holds a stored credential, so it never sends one back.

Structured values only. There is no field here that carries SQL, a statement, a
clause or a connection string: the queries are written in `connections.py`, and
what a caller contributes is a host, a schema name, a table name and a limit.
"""
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field, SecretStr


class ConnectionRequest(BaseModel):
    """How to reach the external database. Used, then forgotten.

    Typed in, nothing here is stored: the password lives for the length of the
    request that carried it. Saved, it is sealed by `app/core/secrets.py`.
    Either way it is never written to a log line or to a response.
    """
    # Defaults rather than required: a missing required field makes FastAPI's
    # 422 echo the whole object back as "input" — token and password included.
    # Empty values are refused by `check_connection` in words of our own.
    db_type: str = Field(default="", description="postgresql, mysql or databricks")
    host: str = ""
    port: Optional[int] = None
    database: str = ""
    username: str = ""
    password: str = ""
    # Databricks only. The token is a SecretStr so that no repr, validation
    # error or log line built from this model can show it.
    warehouse_id: str = ""
    catalog: str = ""
    token: Optional[SecretStr] = None
    # A label somebody chose for this source; shown in the import history and
    # the name a saved connection is listed under.
    name: str = Field(default="", max_length=100)
    # Databricks: the schema to open first. Remembered by a saved connection;
    # checked again every time it is used.
    db_schema: str = ""

    # Instead of all of the above: a connection saved earlier. The credential
    # for it never leaves the server.
    connection_id: Optional[int] = None
    # Saved connections only: which project owns it, and whether it may be used.
    project_id: Optional[str] = None
    enabled: Optional[bool] = None


class SchemaRequest(BaseModel):
    connection: ConnectionRequest


class TableRequest(BaseModel):
    connection: ConnectionRequest
    # `schema` shadows a BaseModel attribute in pydantic, so the field is named
    # for what it is and accepts the shorter spelling from the browser.
    source_schema: str = Field(alias="schema")

    model_config = {"populate_by_name": True}


class PreviewRequest(TableRequest):
    table: str
    limit: int = 20


class LoadRequest(BaseModel):
    connection: ConnectionRequest
    source_schema: str = Field(alias="schema")
    source_table: str = Field(alias="table")
    destination_table: str

    model_config = {"populate_by_name": True}


def as_spec(connection: ConnectionRequest,
            user: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The connection to use: what was sent, or what was saved under that id.

    Resolving a saved one needs the caller, because whose it is decides whether
    they may use it at all.
    """
    if connection.connection_id:
        from app.modules.external_db import connection_store

        return connection_store.spec_for(user or {}, connection.connection_id)
    return connection.model_dump()
