"""Endpoints for live Databricks dashboard data sources.

A live source queries Databricks on every request — no data is copied into
PostgreSQL. The connection is an existing saved external_connection of type
'databricks', and the credential is unsealed for the duration of each call.
"""
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.deps import current_user
from app.modules.dashboards import dash_access
from app.modules.dashboards.permissions import (
    DASHBOARDS_CREATE,
    DASHBOARDS_VIEW,
)
from app.modules.dashboards.schemas import DashboardDataBinding
from app.modules.dashboards.services.query_builder import DEFAULT_TABLE_PAGE_SIZE

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/dashboards/live", tags=["dashboards-live"])


# ── Request schemas ────────────────────────────────────────────────

class LiveDataRequest(BaseModel):
    connection_id: int
    schema_name: str = Field(alias="schema")
    table: str
    binding: DashboardDataBinding
    page: Optional[int] = Field(default=None, ge=1)
    page_size: Optional[int] = Field(default=None, ge=1, le=200)

    class Config:
        populate_by_name = True


class LiveFilterRequest(BaseModel):
    connection_id: int
    schema_name: str = Field(alias="schema")
    table: str
    field: str

    class Config:
        populate_by_name = True


class LiveDependentFilterRequest(BaseModel):
    connection_id: int
    schema_name: str = Field(alias="schema")
    table: str
    field: str
    parent_filters: List[Dict[str, Any]] = Field(default_factory=list)

    class Config:
        populate_by_name = True


class LiveGenerateRequest(BaseModel):
    connection_id: int
    schema_name: str = Field(alias="schema")
    table: str
    prompt: str

    class Config:
        populate_by_name = True


# ── Discovery ─────────────────────────────────────────────────────

@router.get("/connections")
def list_live_connections(
    project_id: Optional[str] = Query(None),
    user: Dict[str, Any] = Depends(current_user),
):
    """Saved Databricks connections this user may use for live dashboards."""
    from app.modules.external_db.connection_store import listed

    all_connections = listed(user)
    databricks_connections = [
        c for c in all_connections
        if c.get("db_type") == "databricks"
        and c.get("enabled")
        and c.get("credential_configured")
    ]
    if project_id:
        databricks_connections = [
            c for c in databricks_connections
            if c.get("project_id") is None or c.get("project_id") == project_id
        ]
    return {"connections": databricks_connections}


@router.get("/connections/{connection_id}/schemas")
def list_schemas(
    connection_id: int,
    user: Dict[str, Any] = Depends(current_user),
):
    """Schemas available in a Databricks connection's catalog."""
    from app.modules.external_db.connection_store import spec_for
    from app.modules.external_db import databricks

    try:
        spec = spec_for(user, connection_id)
        schema_list = databricks.schemas(spec)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {"schemas": schema_list}


@router.get("/connections/{connection_id}/tables")
def list_tables(
    connection_id: int,
    schema: str = Query(...),
    user: Dict[str, Any] = Depends(current_user),
):
    """Tables in one schema of a Databricks connection."""
    from app.modules.external_db.connection_store import spec_for
    from app.modules.external_db import databricks

    try:
        spec = spec_for(user, connection_id)
        table_list = databricks.tables(spec, schema)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {"tables": table_list}


@router.get("/connections/{connection_id}/columns")
def list_columns(
    connection_id: int,
    schema: str = Query(...),
    table: str = Query(...),
    dashboard: bool = Query(False),
    user: Dict[str, Any] = Depends(current_user),
):
    """Columns of a table in a Databricks connection, cached for a few minutes."""
    from app.modules.dashboards.services.live_query_service import (
        live_columns,
        live_columns_for_dashboard,
    )

    try:
        cols = (live_columns_for_dashboard(connection_id, schema, table)
                if dashboard
                else live_columns(user, connection_id, schema, table))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {"fields": cols}


# ── AI generation from live source ────────────────────────────────

@router.post("/generate")
def generate_live_dashboard(
    req: LiveGenerateRequest,
    user: Dict[str, Any] = Depends(current_user),
):
    """Generate a dashboard spec from a Databricks table's fields."""
    from app.modules.dashboards.services.live_query_service import live_columns
    from app.modules.dashboards.services.dashboard_llm import generate_dashboard
    from app.modules.forms.llm import LLMError
    from app.modules.dashboards.services.dashboard_validator import (
        DashboardValidationError,
    )
    from app.modules.external_db.connection_store import spec_for

    try:
        spec = spec_for(user, req.connection_id)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        cols = live_columns(user, req.connection_id, req.schema_name, req.table)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if not cols:
        raise HTTPException(status_code=404, detail="No columns found in that table.")

    fields = [{"name": c["name"], "type": c.get("source_type", "text")} for c in cols]

    source_name = f"live:{req.connection_id}:{req.schema_name}:{req.table}"

    try:
        dashboard = generate_dashboard(
            table_name=source_name,
            fields=fields,
            prompt=req.prompt,
            source_type="databricks",
        )
    except (LLMError, DashboardValidationError) as exc:
        logger.exception("Live dashboard AI generation failed")
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    result = dashboard.model_dump()
    result["_live_source"] = {
        "connection_id": req.connection_id,
        "catalog": spec["catalog"],
        "schema": req.schema_name,
        "table": req.table,
        "connection_name": spec.get("name", ""),
    }
    return result


# ── Live data queries ─────────────────────────────────────────────

@router.post("/data")
def get_live_data(
    req: LiveDataRequest,
    user: Dict[str, Any] = Depends(current_user),
):
    """Execute a dashboard data binding against a live Databricks table."""
    from app.modules.dashboards.services.live_query_service import (
        execute_live_query,
        count_live_rows,
    )
    from app.modules.external_db.connection_store import spec_for_dashboard

    try:
        spec = spec_for_dashboard(req.connection_id)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    catalog = spec["catalog"]
    paging = req.page is not None and req.page_size is not None

    try:
        rows = execute_live_query(
            user, req.connection_id, catalog, req.schema_name, req.table,
            req.binding, page=req.page, page_size=req.page_size,
        )

        total_rows = (
            count_live_rows(
                user, req.connection_id, catalog, req.schema_name, req.table,
                req.binding,
            )
            if paging else None
        )
    except Exception as exc:
        logger.exception("Live dashboard query failed")
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    answer: Dict[str, Any] = {"rows": rows}
    if paging:
        answer["page"] = req.page
        answer["page_size"] = req.page_size
        answer["total_rows"] = total_rows
        answer["total_pages"] = max(1, -(-total_rows // req.page_size))

    return answer


@router.post("/filter-options")
def live_filter_options(
    req: LiveFilterRequest,
    user: Dict[str, Any] = Depends(current_user),
):
    """Distinct values for a filter field from a live Databricks table."""
    from app.modules.dashboards.services.live_query_service import live_distinct_values
    from app.modules.external_db.connection_store import spec_for_dashboard

    try:
        spec = spec_for_dashboard(req.connection_id)
        values = live_distinct_values(
            user, req.connection_id, spec["catalog"],
            req.schema_name, req.table, req.field,
        )
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {"field": req.field, "values": values}


@router.post("/dependent-filter-options")
def live_dependent_filter_options(
    req: LiveDependentFilterRequest,
    user: Dict[str, Any] = Depends(current_user),
):
    """Dependent filter values from a live Databricks table."""
    from app.modules.dashboards.services.live_query_service import live_dependent_values
    from app.modules.external_db.connection_store import spec_for_dashboard

    try:
        spec = spec_for_dashboard(req.connection_id)
        values = live_dependent_values(
            user, req.connection_id, spec["catalog"],
            req.schema_name, req.table, req.field, req.parent_filters,
        )
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {"field": req.field, "values": values}
