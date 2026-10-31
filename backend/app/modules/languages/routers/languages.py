import json
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, HTTPException

from app.core.database import transaction
from app.core.deps import needs
from app.modules.languages.permissions import MANAGE_LANGUAGES

router = APIRouter(prefix="/api/languages", tags=["languages"])


@router.get("")
def list_languages():
    with transaction() as cur:
        cur.execute("SELECT language, label FROM language_pack ORDER BY label")
        return [dict(r) for r in cur.fetchall()]


@router.get("/{language}")
def get_language(language: str):
    with transaction() as cur:
        cur.execute(
            "SELECT language, label, pack FROM language_pack WHERE language = %s",
            (language,),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Language pack not found")
    return dict(row)


@router.put("/{language}")
def upsert_language(
    language: str,
    body: Dict[str, Any] = Body(...),
    user: Dict[str, Any] = Depends(needs(MANAGE_LANGUAGES)),
):
    label = str(body.get("label") or language)
    pack = body.get("pack", {})
    if not isinstance(pack, dict):
        raise HTTPException(422, "pack must be a JSON object")

    with transaction() as cur:
        cur.execute(
            "INSERT INTO language_pack (language, label, pack, updated_on)"
            " VALUES (%s, %s, %s, NOW())"
            " ON CONFLICT (language) DO UPDATE"
            " SET label = EXCLUDED.label, pack = EXCLUDED.pack, updated_on = NOW()",
            (language, label, json.dumps(pack)),
        )
    return {"ok": True}


@router.delete("/{language}")
def delete_language(
    language: str,
    user: Dict[str, Any] = Depends(needs(MANAGE_LANGUAGES)),
):
    with transaction() as cur:
        cur.execute("DELETE FROM language_pack WHERE language = %s", (language,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Language pack not found")
    return {"ok": True}
