import json
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.database import transaction
from app.core.deps import needs
from ..permissions import MANAGE_FIELD_MASTER

router = APIRouter(prefix="/api/field-master", tags=["field-master"])


class FieldMasterIn(BaseModel):
    name: str
    data_type: str = "text"
    category: str = "native"
    ref_ontology: Optional[str] = None
    field_json: Dict[str, Any] = {}


@router.get("")
def list_fields(
    search: str = Query("", description="Filter by name"),
    category: str = Query("", description="Filter by category"),
    user: Dict[str, Any] = Depends(needs(MANAGE_FIELD_MASTER)),
):
    with transaction() as cur:
        sql = "SELECT * FROM field_master WHERE 1=1"
        params: list = []
        if search:
            sql += " AND LOWER(name) LIKE %s"
            params.append(f"%{search.lower()}%")
        if category:
            sql += " AND category = %s"
            params.append(category)
        sql += " ORDER BY field_id"
        cur.execute(sql, params)
        return cur.fetchall()


@router.get("/search")
def search_fields(q: str = Query("", min_length=2)):
    """Public search — used by the form builder to suggest standard fields."""
    with transaction() as cur:
        slug = q.lower().replace(" ", "_")
        cur.execute(
            """SELECT * FROM field_master
               WHERE LOWER(name) LIKE %s
                  OR LOWER(REPLACE(name, ' ', '_')) LIKE %s
               ORDER BY name LIMIT 8""",
            (f"%{q.lower()}%", f"%{slug}%"),
        )
        return cur.fetchall()


@router.get("/{field_id}")
def get_field(
    field_id: int,
    user: Dict[str, Any] = Depends(needs(MANAGE_FIELD_MASTER)),
):
    with transaction() as cur:
        cur.execute("SELECT * FROM field_master WHERE field_id = %s", (field_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Field not found")
        return row


@router.post("", status_code=201)
def create_field(
    body: FieldMasterIn,
    user: Dict[str, Any] = Depends(needs(MANAGE_FIELD_MASTER)),
):
    with transaction() as cur:
        cur.execute(
            "INSERT INTO field_master (name, data_type, category, ref_ontology, field_json)"
            " VALUES (%s, %s, %s, %s, %s) RETURNING *",
            (body.name, body.data_type, body.category,
             body.ref_ontology, json.dumps(body.field_json)),
        )
        return cur.fetchone()


@router.put("/{field_id}")
def update_field(
    field_id: int,
    body: FieldMasterIn,
    user: Dict[str, Any] = Depends(needs(MANAGE_FIELD_MASTER)),
):
    with transaction() as cur:
        cur.execute(
            "UPDATE field_master SET name=%s, data_type=%s, category=%s,"
            " ref_ontology=%s, field_json=%s, updated_on=NOW()"
            " WHERE field_id=%s RETURNING *",
            (body.name, body.data_type, body.category,
             body.ref_ontology, json.dumps(body.field_json), field_id),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Field not found")
        return row


@router.delete("/{field_id}", status_code=204)
def delete_field(
    field_id: int,
    user: Dict[str, Any] = Depends(needs(MANAGE_FIELD_MASTER)),
):
    with transaction() as cur:
        cur.execute("DELETE FROM field_master WHERE field_id = %s", (field_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Field not found")
