"""External data API — authenticated by project API key, not a session.

Three endpoints for tools like Databricks to pull form data:

    GET /api/data/v1/tables          — forms (tables) in the project
    GET /api/data/v1/tables/{t}/schema — column definitions
    GET /api/data/v1/tables/{t}/rows   — paginated submission data
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from psycopg2 import sql

from app.core.config import settings
from app.core.database import table_exists, transaction
from app.modules.projects import api_key_service

router = APIRouter(prefix="/api/data/v1", tags=["data-api"])


def _require_api_key(
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    if not x_api_key:
        raise HTTPException(status_code=401, detail="Missing X-API-Key header")

    resolved = api_key_service.resolve_key(x_api_key)
    if not resolved:
        raise HTTPException(status_code=401, detail="Invalid or revoked API key")

    return resolved


def _project_forms(project_id: str, cur) -> List[Dict[str, Any]]:
    cur.execute(
        """
        SELECT form_id, form_title, form_status,
               form_json -> 'table_name' AS table_name
        FROM forms
        WHERE project_id = %s AND form_status <> 'Deleted'
        ORDER BY updated_on DESC NULLS LAST
        """,
        (project_id,),
    )
    rows = []
    for r in cur.fetchall():
        tn = r["table_name"]
        if tn and isinstance(tn, str):
            tn = tn.strip('"')
        if tn:
            rows.append({
                "form_id": r["form_id"],
                "title": r["form_title"],
                "status": r["form_status"],
                "table_name": tn,
            })
    return rows


@router.get("/tables")
def list_tables(api_key: Dict[str, Any] = Depends(_require_api_key)):
    with transaction() as cur:
        tables = _project_forms(api_key["project_id"], cur)
    return {"project_id": api_key["project_id"], "tables": tables}


@router.get("/tables/{table_name}/schema")
def table_schema(table_name: str, api_key: Dict[str, Any] = Depends(_require_api_key)):
    with transaction() as cur:
        forms = _project_forms(api_key["project_id"], cur)
        match = next((f for f in forms if f["table_name"] == table_name), None)
        if not match:
            raise HTTPException(status_code=404, detail="Table not found in this project")

        cur.execute(
            """
            SELECT form_json -> 'fields' AS fields
            FROM forms WHERE form_id = %s
            """,
            (match["form_id"],),
        )
        row = cur.fetchone()
        fields = row["fields"] if row else []

    columns = []
    for f in (fields or []):
        name = f.get("name") or f.get("key") or f.get("id")
        if not name:
            continue
        columns.append({
            "name": name,
            "label": f.get("label") or name,
            "type": f.get("type") or "text",
            "required": bool(f.get("required")),
        })

    return {
        "form_id": match["form_id"],
        "title": match["title"],
        "table_name": table_name,
        "columns": columns,
    }


@router.get("/tables/{table_name}/rows")
def table_rows(
    table_name: str,
    limit: int = Query(default=100, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
    since: Optional[str] = Query(default=None),
    until: Optional[str] = Query(default=None),
    api_key: Dict[str, Any] = Depends(_require_api_key),
):
    with transaction() as cur:
        forms = _project_forms(api_key["project_id"], cur)
        match = next((f for f in forms if f["table_name"] == table_name), None)
        if not match:
            raise HTTPException(status_code=404, detail="Table not found in this project")

        if not table_exists(cur, table_name):
            return {"total": 0, "limit": limit, "offset": offset, "rows": []}

        qualified = sql.SQL("{}.{}").format(
            sql.Identifier(settings.db_schema), sql.Identifier(table_name)
        )

        where_parts = [sql.SQL("form_id = %s")]
        params: list = [match["form_id"]]

        if since:
            where_parts.append(sql.SQL("created_on >= %s"))
            params.append(since)
        if until:
            where_parts.append(sql.SQL("created_on <= %s"))
            params.append(until)

        where = sql.SQL(" AND ").join(where_parts)

        cur.execute(
            sql.SQL("SELECT COUNT(*) AS n FROM {} WHERE {}").format(qualified, where),
            tuple(params),
        )
        total = int(cur.fetchone()["n"])

        cur.execute(
            sql.SQL(
                "SELECT survey_id, form_data, created_on, form_version, created_by "
                "FROM {} WHERE {} ORDER BY created_on DESC LIMIT %s OFFSET %s"
            ).format(qualified, where),
            tuple(params + [limit, offset]),
        )
        rows = [dict(r) for r in cur.fetchall()]

    return {"total": total, "limit": limit, "offset": offset, "rows": rows}
