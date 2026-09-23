"""HTTP surface for dashboards.

Every route declares the permission it needs. Never test a role name — roles are
the installation's to define, permissions are the application's.
"""
import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from app.modules.forms.llm import LLMError
from app.modules.dashboards.services.dashboard_validator import (
    DashboardValidationError,
)
from app.core.config import settings

from app.core.deps import needs
from app.modules.dashboards.permissions import (
    DASHBOARDS_IMPORT,
    DASHBOARDS_VIEW,
    DASHBOARDS_EDIT,
    DASHBOARDS_DELETE,
    DASHBOARDS_SHARE,
)

from app.modules.dashboards.schemas import (
    DashboardDataBinding,
    DashboardDataRequest,
    DashboardGenerateRequest,
    SharedDataRequest,
)
from app.modules.dashboards.services.query_service import (
    count_dashboard_rows,
    execute_dashboard_query,
)

from app.modules.dashboards.services.dashboard_service import (
    NotPublished,
    create_dashboard,
    list_dashboards,
    get_dashboard,
    get_shared,
    share_dashboard,
    unshare_dashboard,
    update_dashboard,
    delete_dashboard,
    list_versions,
    get_version,
    publish_version,
    restore_version,
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

@router.post("/data-sources/excel")
async def import_excel_data_source(
    file: UploadFile = File(...),
    table_name: str = Form(...),
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_IMPORT)),
):
    """Create a data source from a spreadsheet.

    The table is named `<table_name>_tabular`, which is how `list_data_sources`
    finds it — the import is only useful if the result appears in the picker.
    Nothing is overwritten: a name already in use is refused.
    """
    from app.modules.dashboards.services.excel_source_service import (
        ExcelSourceError,
        MAX_WORKBOOK_BYTES,
        import_workbook,
    )

    name = file.filename or "workbook.xlsx"

    if not name.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(
            status_code=400,
            detail="That is not an .xlsx file. Save the spreadsheet as Excel and try again.",
        )

    data = await file.read()

    if not data:
        raise HTTPException(status_code=400, detail="That file is empty.")

    if len(data) > MAX_WORKBOOK_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"That file is larger than {MAX_WORKBOOK_BYTES // (1024 * 1024)} MB.",
        )

    try:
        return import_workbook(
            data,
            table_name,
            imported_by=user.get("username", ""),
        )
    except ExcelSourceError as exc:
        # Every one of these names what is wrong with the file or the name, and
        # none of them is the server failing.
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/data-sources/{table_name}")
def get_data_source(
    table_name: str,
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_VIEW)),
):
    """Return active field metadata for a selected _tabular table."""
    try:
        return get_tabular_metadata(table_name)
    except ValueError as exc:
        # A table the dashboard cannot describe is the caller asking for the
        # wrong thing, not the server failing. Left unhandled it surfaced in
        # the builder as "Internal Server Error", which named neither the
        # table nor the reason.
        raise HTTPException(status_code=404, detail=str(exc))

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
        created_by=user.get("username"),
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
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_DELETE)),
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



# ── Version endpoints ────────────────────────────────────────────


@router.get("/{dashboard_id}/versions")
def list_versions_route(
    dashboard_id: str,
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_VIEW)),
):
    """Return all versions for a saved dashboard."""

    return list_versions(dashboard_id)


@router.get("/{dashboard_id}/versions/{version_no}")
def get_version_route(
    dashboard_id: str,
    version_no: int,
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_VIEW)),
):
    """Return a specific version with full configuration."""

    version = get_version(dashboard_id, version_no)

    if version is None:
        raise HTTPException(
            status_code=404,
            detail="Version not found.",
        )

    return version


@router.post("/{dashboard_id}/versions/{version_no}/publish")
def publish_version_route(
    dashboard_id: str,
    version_no: int,
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_EDIT)),
):
    """Publish a version."""

    result = publish_version(dashboard_id, version_no)

    if result is None:
        raise HTTPException(
            status_code=404,
            detail="Version not found.",
        )

    return result


@router.post("/{dashboard_id}/versions/{version_no}/restore")
def restore_version_route(
    dashboard_id: str,
    version_no: int,
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_EDIT)),
):
    """Create a new draft version from an existing version."""

    result = restore_version(
        dashboard_id,
        version_no,
        created_by=user.get("username"),
    )

    if result is None:
        raise HTTPException(
            status_code=404,
            detail="Version not found.",
        )

    return result


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

    # A spec the validator refuses is the generator producing something
    # unusable, exactly like LLMError — not the server breaking. Uncaught it
    # reached the builder as "Internal Server Error", which told nobody which
    # widget was wrong even though the message names it.
    except (LLMError, DashboardValidationError) as exc:
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

    paging = req.page is not None and req.page_size is not None

    try:
        rows = execute_dashboard_query(
            table_name,
            req.binding,
            page=req.page,
            page_size=req.page_size,
        )

        # Counted only when somebody is paging. Every other widget reads its
        # whole result and would pay for a count it has no use for.
        total_rows = (
            count_dashboard_rows(table_name, req.binding) if paging else None
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

    answer = {
        "table_name": table_name,
        "rows": rows,
    }

    if paging:
        # Added to the reply rather than replacing it: a caller that does not
        # page sees the same two keys it always saw.
        answer["page"] = req.page
        answer["page_size"] = req.page_size
        answer["total_rows"] = total_rows
        answer["total_pages"] = max(1, -(-total_rows // req.page_size))

    return answer


# ── Public links ────────────────────────────────────────────────
#
# The two routes below take no session. They are the only ones in this
# application that do not, so they are written to give away as little as
# possible: an unguessable token names one published dashboard, and nothing
# reachable through it lets the caller ask about anything else.


@router.post("/{dashboard_id}/share")
def share_dashboard_route(
    dashboard_id: str,
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_SHARE)),
):
    """Issue a public link for a published dashboard.

    Its own permission: being allowed to look at a dashboard says nothing about
    being allowed to put its contents in front of anyone with a URL.
    """

    try:
        result = share_dashboard(dashboard_id, user.get("username"))
    except NotPublished as exc:
        raise HTTPException(status_code=409, detail=str(exc))

    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"No dashboard '{dashboard_id}'",
        )

    return result


@router.delete("/{dashboard_id}/share", status_code=204)
def unshare_dashboard_route(
    dashboard_id: str,
    user: Dict[str, Any] = Depends(needs(DASHBOARDS_SHARE)),
):
    """Withdraw the public link, breaking every copy of it."""

    if not unshare_dashboard(dashboard_id):
        raise HTTPException(
            status_code=404,
            detail=f"No dashboard '{dashboard_id}'",
        )

    return None


@router.get("/shared/{token}")
def shared_dashboard(token: str):
    """A published dashboard, to whoever holds the link. No session.

    A token that names nothing — withdrawn, mistyped, or never issued — is a
    404, the same answer as a token that never existed, so the reply says
    nothing about which of those it was.
    """

    shared = get_shared(token)

    if shared is None:
        raise HTTPException(status_code=404, detail="That link is not valid.")

    return shared


@router.post("/shared/{token}/data")
def shared_dashboard_data(token: str, req: SharedDataRequest):
    """The data behind one widget of a shared dashboard. No session.

    The signed-in endpoint above takes a binding — a table, fields,
    aggregations, filters — because whoever sends it has been authorised to
    query that table. Nobody here has been authorised for anything, so this
    takes a widget id and reads the binding out of the published specification
    itself. The caller cannot name a table, a column or a filter, which means
    this endpoint can only ever run a query that the dashboard's author already
    put on the dashboard.
    """

    shared = get_shared(token)

    if shared is None:
        raise HTTPException(status_code=404, detail="That link is not valid.")

    specification = shared.get("dashboard_json") or {}

    widget = next(
        (
            item
            for item in specification.get("widgets", [])
            if item.get("id") == req.widget_id
        ),
        None,
    )

    if widget is None:
        raise HTTPException(
            status_code=404,
            detail="That widget is not on this dashboard.",
        )

    # The table comes from the specification, never from the request.
    source = next(
        (
            item
            for item in specification.get("data_sources", [])
            if item.get("id") == widget.get("data_source_id")
        ),
        None,
    )

    table_name = ((source or {}).get("name") or "").strip()

    if not table_name.endswith("_tabular"):
        raise HTTPException(
            status_code=400,
            detail="Only tabular dashboard data sources are supported.",
        )

    try:
        binding = DashboardDataBinding(**(widget.get("data_binding") or {}))
        rows = execute_dashboard_query(table_name, binding)

    except Exception as exc:
        logger.exception(
            "Shared dashboard data query failed for %s",
            table_name,
        )

        raise HTTPException(
            status_code=422,
            detail="Unable to execute dashboard data query.",
        ) from exc

    return {"rows": rows}