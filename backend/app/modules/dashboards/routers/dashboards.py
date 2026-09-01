"""HTTP surface for dashboards.

Every route declares the permission it needs. Never test a role name — roles are
the installation's to define, permissions are the application's.
"""
import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from app.modules.forms.llm import LLMError
from app.core.config import settings

from app.core.deps import needs
from app.modules.dashboards.permissions import DASHBOARDS_VIEW

from app.modules.dashboards.schemas import (
    DashboardDataRequest,
    DashboardGenerateRequest
)
from app.modules.dashboards.services.query_service import (
    execute_dashboard_query,
)

from app.modules.dashboards.services.dashboard_service import (
    create_dashboard,
    list_dashboards,
    get_dashboard,
    update_dashboard,
    delete_dashboard,
)

from app.modules.dashboards.services.data_source_service import (
    get_tabular_metadata,
    list_tabular_tables,
    list_table_columns,
)

from app.modules.dashboards.services.dashboard_llm import generate_dashboard

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/dashboards", tags=["dashboards"])


@router.get("")
def list_dashboards_route(
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_VIEW)),
):
    """Return all active dashboards."""

    return list_dashboards()


@router.post("")
def save_dashboard(
    payload: Dict[str, Any],
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_VIEW)),
):
    """Persist a generated dashboard specification."""

    dashboard = payload.get("dashboard") or {}

    title = dashboard.get("name") or "Untitled Dashboard"

    saved = create_dashboard(
        title=title,
        dashboard_json=payload,
        created_by=user.get("username"),
    )

    return saved

@router.get("/data-sources")
def list_data_sources(
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_VIEW)),
):
    """Return PostgreSQL _tabular tables available to dashboards."""
    return {
        "data_sources": list_tabular_tables(),
    }

@router.get("/data-sources/{table_name}")
def get_data_source(
    table_name: str,
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_VIEW)),
):
    """Return active field metadata for a selected _tabular table."""
    return get_tabular_metadata(table_name)

@router.get("/{dashboard_id}")
def get_dashboard_route(
    dashboard_id: str,
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_VIEW)),
):
    """Return a saved dashboard by ID."""

    dashboard = get_dashboard(dashboard_id)

    if dashboard is None:
        raise HTTPException(
            status_code=404,
            detail="Dashboard not found.",
        )

    return dashboard

@router.put("/{dashboard_id}")
def update_dashboard_route(
    dashboard_id: str,
    payload: Dict[str, Any],
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_VIEW)),
):
    """Update a saved dashboard."""

    dashboard = payload.get("dashboard") or {}

    title = dashboard.get("name") or "Untitled Dashboard"

    updated = update_dashboard(
        dashboard_id=dashboard_id,
        title=title,
        dashboard_json=payload,
    )

    if updated is None:
        raise HTTPException(
            status_code=404,
            detail="Dashboard not found.",
        )

    return updated

@router.delete("/{dashboard_id}")
def delete_dashboard_route(
    dashboard_id: str,
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_VIEW)),
):
    """Soft-delete a saved dashboard."""

    deleted = delete_dashboard(dashboard_id)

    if not deleted:
        raise HTTPException(
            status_code=404,
            detail="Dashboard not found.",
        )

    return {
        "message": "Dashboard deleted successfully.",
        "dashboard_id": dashboard_id,
    }


@router.post("/generate")
def generate_dashboard_route(
    req: DashboardGenerateRequest,
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_VIEW)),
):
    """
    Generate a validated dashboard specification from a user prompt.

    The AI receives table metadata only.
    It never receives database rows and never executes SQL.
    """

    table_name = req.table_name.strip()

    if not table_name:
        raise HTTPException(
            status_code=422,
            detail="A data source is required.",
        )

    if not table_name.endswith("_tabular"):
        raise HTTPException(
            status_code=400,
            detail="Only tabular dashboard data sources are supported.",
        )

    if not req.prompt.strip():
        raise HTTPException(
            status_code=422,
            detail="A dashboard prompt is required.",
        )

    # ---------------------------------------------------------
    # Resolve the real database schema
    # ---------------------------------------------------------

    fields = list_table_columns(
        table_name=table_name,
        schema_name=settings.db_schema,
    )

    if not fields:
        raise HTTPException(
            status_code=404,
            detail=f"Data source '{table_name}' was not found.",
        )

    try:
        dashboard = generate_dashboard(
            table_name=table_name,
            fields=fields,
            prompt=req.prompt,
            source_type="postgresql_tabular",
        )

    except LLMError as exc:
        logger.exception(
            "Dashboard AI generation failed for %s",
            table_name,
        )

        raise HTTPException(
            status_code=422,
            detail=str(exc),
        ) from exc

    return dashboard.model_dump()


@router.post("/data")
def get_dashboard_data(
    req: DashboardDataRequest,
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_VIEW)),
):
    """
    Execute a validated dashboard data binding.

    The frontend sends structured data-binding information,
    never raw SQL.
    """

    table_name = req.table_name.strip()

    if not table_name:
        raise HTTPException(
            status_code=422,
            detail="A data source is required.",
        )

    if not table_name.endswith("_tabular"):
        raise HTTPException(
            status_code=400,
            detail="Only tabular dashboard data sources are supported.",
        )

    fields = list_table_columns(
        table_name=table_name,
        schema_name=settings.db_schema,
    )

    if not fields:
        raise HTTPException(
            status_code=404,
            detail=f"Data source '{table_name}' was not found.",
        )

    available_fields = {
        field["name"]
        for field in fields
    }

    for dimension in req.binding.dimensions:
        if dimension.field not in available_fields:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown dimension field: {dimension.field}",
            )

    for measure in req.binding.measures:
        if measure.field not in available_fields:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown measure field: {measure.field}",
            )

    for filter_item in req.binding.filters:
        if filter_item.field not in available_fields:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown filter field: {filter_item.field}",
            )

    try:
        rows = execute_dashboard_query(
            table_name,
            req.binding,
        )

    except Exception as exc:
        logger.exception(
            "Dashboard data query failed for %s",
            table_name,
        )

        raise HTTPException(
            status_code=422,
            detail="Unable to execute dashboard data query.",
        ) from exc

    return {
        "table_name": table_name,
        "rows": rows,
    }