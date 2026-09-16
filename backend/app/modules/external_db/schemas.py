"""What a request to this module may contain.

Structured values only. There is no field here that carries SQL, a statement, a
clause or a connection string: the queries are written in `connections.py`, and
what a caller contributes is a host, a schema name, a table name and a limit.
"""
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


class ConnectionRequest(BaseModel):
    """How to reach the external database. Used, then forgotten.

    Nothing is stored. The password lives for the length of the request that
    carried it and is never written to a table, a log line or a response.
    """
    db_type: str = Field(description="postgresql or mysql")
    host: str
    port: Optional[int] = None
    database: str
    username: str = ""
    password: str = ""


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


def as_spec(connection: ConnectionRequest) -> Dict[str, Any]:
    return connection.model_dump()
