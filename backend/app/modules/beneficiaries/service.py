"""Beneficiary types and master registry operations."""
import logging
from typing import Any, Dict, List, Optional

from psycopg2 import sql

from app.core.config import settings
from app.core.database import transaction

logger = logging.getLogger(__name__)

VOICE_THRESHOLD = 0.80


def _q(table: str) -> sql.Composed:
    return sql.SQL("{}.{}").format(
        sql.Identifier(settings.db_schema), sql.Identifier(table)
    )


# ── beneficiary types ──────────────────────────────────────────────────────

class DuplicateType(Exception):
    pass


class UnknownType(Exception):
    pass


def list_types(*, active_only: bool = True, with_stats: bool = False) -> List[Dict[str, Any]]:
    with transaction() as cur:
        where = sql.SQL(" WHERE is_active = TRUE") if active_only else sql.SQL("")
        cur.execute(sql.SQL("SELECT * FROM {} {} ORDER BY name").format(
            _q("beneficiary_types"), where))
        types = [dict(r) for r in cur.fetchall()]
        for t in types:
            if t.get("form_id") and not t.get("master_fields"):
                resolved = _resolve_master_fields(cur, t["form_id"], [])
                if resolved:
                    cur.execute(sql.SQL("UPDATE {} SET master_fields = %s::jsonb WHERE type_id = %s").format(
                        _q("beneficiary_types")),
                        (__import__("json").dumps(resolved), t["type_id"]))
                    t["master_fields"] = resolved
        if with_stats and types:
            cur.execute(sql.SQL(
                "SELECT type_id, COUNT(*) AS total, "
                "COUNT(*) FILTER (WHERE status = 'pending') AS pending "
                "FROM {} GROUP BY type_id"
            ).format(_q("master_registry")))
            stats = {r["type_id"]: r for r in cur.fetchall()}
            for t in types:
                s = stats.get(t["type_id"])
                t["record_count"] = s["total"] if s else 0
                t["pending_count"] = s["pending"] if s else 0
        return types


def get_type(type_id: str) -> Dict[str, Any]:
    with transaction() as cur:
        cur.execute(sql.SQL("SELECT * FROM {} WHERE type_id = %s").format(
            _q("beneficiary_types")), (type_id,))
        row = cur.fetchone()
        if not row:
            raise UnknownType(f"Beneficiary type '{type_id}' not found")
        return dict(row)


def _resolve_master_fields(cur, form_id: Optional[str], master_fields: List[str]) -> List[str]:
    """If master_fields is empty and form_id is a standard form, derive fields from it."""
    if master_fields or not form_id:
        return master_fields
    cur.execute(
        sql.SQL("SELECT form_json FROM {} WHERE standard_id = %s").format(
            _q("standard_form_library")),
        (form_id,),
    )
    row = cur.fetchone()
    if not row:
        return master_fields
    fj = row["form_json"] or {}
    return [
        f["name"] for f in fj.get("fields", [])
        if f.get("name") and f.get("type") not in ("label", "banner")
    ]


def create_type(
    type_id: str,
    name: str,
    prefix: str,
    form_id: Optional[str],
    master_fields: List[str],
    id_pattern: str = "{prefix}-{seq}",
    created_by: Optional[str] = None,
) -> Dict[str, Any]:
    with transaction() as cur:
        master_fields = _resolve_master_fields(cur, form_id, master_fields)
        try:
            cur.execute(
                sql.SQL(
                    "INSERT INTO {} (type_id, name, prefix, form_id, master_fields, id_pattern, created_by) "
                    "VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s) RETURNING *"
                ).format(_q("beneficiary_types")),
                (type_id, name, prefix, form_id,
                 __import__("json").dumps(master_fields), id_pattern, created_by),
            )
        except Exception as exc:
            if "duplicate key" in str(exc).lower():
                raise DuplicateType(f"Type '{type_id}' already exists")
            raise
        row = dict(cur.fetchone())
        cur.execute(
            sql.SQL("INSERT INTO {} (type_id, last_seq) VALUES (%s, 0) ON CONFLICT DO NOTHING").format(
                _q("master_sequences")),
            (type_id,),
        )
        return row


class FormAlreadyLinked(Exception):
    pass


def update_type(type_id: str, **fields) -> Dict[str, Any]:
    allowed = {"name", "prefix", "form_id", "master_fields", "id_pattern", "is_active", "card_config"}
    updates = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if not updates:
        return get_type(type_id)
    if "master_fields" in updates:
        updates["master_fields"] = __import__("json").dumps(updates["master_fields"])
    if "card_config" in updates:
        updates["card_config"] = __import__("json").dumps(updates["card_config"])
    with transaction() as cur:
        if "form_id" in updates:
            cur.execute(sql.SQL("SELECT form_id FROM {} WHERE type_id = %s").format(
                _q("beneficiary_types")), (type_id,))
            existing = cur.fetchone()
            if existing and existing["form_id"] and existing["form_id"] != updates["form_id"]:
                raise FormAlreadyLinked(
                    f"Cannot change the linked form. '{type_id}' is permanently linked to '{existing['form_id']}'. "
                    f"You can only add fields to the existing form."
                )
        if "form_id" in updates and "master_fields" not in updates:
            resolved = _resolve_master_fields(cur, updates["form_id"], [])
            if resolved:
                updates["master_fields"] = __import__("json").dumps(resolved)
        sets = sql.SQL(", ").join(
            sql.SQL("{} = %s").format(sql.Identifier(k)) for k in updates
        )
        cur.execute(
            sql.SQL("UPDATE {} SET {} WHERE type_id = %s RETURNING *").format(
                _q("beneficiary_types"), sets),
            list(updates.values()) + [type_id],
        )
        row = cur.fetchone()
        if not row:
            raise UnknownType(f"Type '{type_id}' not found")
        return dict(row)


def sync_master_fields_from_standard(standard_id: str, fields: List[str]) -> None:
    """Called when a standard form is updated — grow master_fields to match."""
    if not standard_id or not fields:
        return
    with transaction() as cur:
        cur.execute(sql.SQL(
            "SELECT type_id, master_fields FROM {} WHERE form_id = %s AND is_active = TRUE"
        ).format(_q("beneficiary_types")), (standard_id,))
        for row in cur.fetchall():
            existing = row.get("master_fields") or []
            new_fields = [f for f in fields if f not in existing]
            if new_fields:
                updated = existing + new_fields
                cur.execute(sql.SQL(
                    "UPDATE {} SET master_fields = %s::jsonb WHERE type_id = %s"
                ).format(_q("beneficiary_types")),
                    (__import__("json").dumps(updated), row["type_id"]))
                logger.info("Synced master_fields for %s from standard %s: +%s",
                            row["type_id"], standard_id, new_fields)


# ── master registry ────────────────────────────────────────────────────────

import re as _re

_FIELD_RE = _re.compile(r"\{(\w+)(?::(\d+))?\}")


def _next_id(cur, type_id: str, prefix: str, pattern: str,
             data: Optional[Dict[str, Any]] = None) -> str:
    cur.execute(
        sql.SQL(
            "UPDATE {} SET last_seq = last_seq + 1 WHERE type_id = %s RETURNING last_seq"
        ).format(_q("master_sequences")),
        (type_id,),
    )
    row = cur.fetchone()
    if not row:
        cur.execute(
            sql.SQL("INSERT INTO {} (type_id, last_seq) VALUES (%s, 1) RETURNING last_seq").format(
                _q("master_sequences")),
            (type_id,),
        )
        row = cur.fetchone()
    seq = row["last_seq"]
    data = data or {}

    def _replace(m):
        key, limit = m.group(1), m.group(2)
        if key == "prefix":
            return prefix
        if key == "seq":
            return str(seq).zfill(5)
        val = str(data.get(key, "")).strip().upper().replace(" ", "")
        if limit:
            val = val[:int(limit)]
        return val or "X"

    return _FIELD_RE.sub(_replace, pattern)


def register_beneficiary(
    type_id: str,
    data: Dict[str, Any],
    voice_bytes: Optional[bytes] = None,
    project_id: Optional[str] = None,
    source_survey_id: Optional[str] = None,
    created_by: Optional[str] = None,
) -> Dict[str, Any]:
    """Register a new beneficiary, checking for voice duplicates."""
    btype = get_type(type_id)

    voice_embedding = None
    voice_model = None
    voice_score = None
    duplicate_of = None
    status = "pending"

    if voice_bytes is not None:
        try:
            from app.core import voiceprint
            import numpy as np
            samples = np.frombuffer(voice_bytes, dtype="<i2").astype(np.float32) / 32768.0
            vec = voiceprint.embed(samples)
            voice_embedding = voiceprint.pack(vec)
            voice_model = voiceprint.MODEL
            duplicate_of, voice_score = _find_voice_duplicate(type_id, voice_embedding)
            if duplicate_of:
                status = "duplicate"
        except Exception:
            logger.exception("Voice duplicate check failed")

    with transaction() as cur:
        bid = _next_id(cur, type_id, btype["prefix"], btype["id_pattern"], data)
        cur.execute(
            sql.SQL(
                "INSERT INTO {} "
                "(beneficiary_id, type_id, data, status, voice_embedding, voice_model, "
                " voice_score, duplicate_of, project_id, source_survey_id, created_by) "
                "VALUES (%s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING *"
            ).format(_q("master_registry")),
            (bid, type_id, __import__("json").dumps(data), status,
             voice_embedding, voice_model, voice_score, duplicate_of,
             project_id, source_survey_id, created_by),
        )
        return dict(cur.fetchone())


def _find_voice_duplicate(
    type_id: str,
    voice_bytes: bytes,
) -> tuple:
    """Compare against all existing voiceprints for this type. Returns (duplicate_id, score) or (None, None)."""
    from app.core import voiceprint
    new_vec = voiceprint.unpack(voice_bytes)
    if new_vec is None:
        return None, None

    with transaction() as cur:
        cur.execute(
            sql.SQL(
                "SELECT beneficiary_id, voice_embedding FROM {} "
                "WHERE type_id = %s AND voice_embedding IS NOT NULL AND status = 'approved'"
            ).format(_q("master_registry")),
            (type_id,),
        )
        best_id, best_score = None, 0.0
        for row in cur:
            existing = voiceprint.unpack(row["voice_embedding"])
            if existing is None:
                continue
            score = voiceprint.similarity(new_vec, existing)
            if score >= VOICE_THRESHOLD and score > best_score:
                best_id = row["beneficiary_id"]
                best_score = score
        if best_id:
            return best_id, best_score
    return None, None


def list_registry(
    type_id: Optional[str] = None,
    status: Optional[str] = None,
    project_id: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> Dict[str, Any]:
    conditions = []
    params: list = []
    if type_id:
        conditions.append("type_id = %s")
        params.append(type_id)
    if status:
        conditions.append("status = %s")
        params.append(status)
    if project_id:
        conditions.append("project_id = %s")
        params.append(project_id)
    where = sql.SQL(" WHERE " + " AND ".join(conditions)) if conditions else sql.SQL("")

    with transaction() as cur:
        cur.execute(
            sql.SQL("SELECT COUNT(*) AS total FROM {} {}").format(
                _q("master_registry"), where),
            params,
        )
        total = cur.fetchone()["total"]
        cur.execute(
            sql.SQL(
                "SELECT beneficiary_id, type_id, data, status, voice_score, "
                "duplicate_of, project_id, source_survey_id, created_on, created_by, "
                "reviewed_by, reviewed_on "
                "FROM {} {} ORDER BY created_on DESC LIMIT %s OFFSET %s"
            ).format(_q("master_registry"), where),
            params + [limit, offset],
        )
        rows = [dict(r) for r in cur.fetchall()]
    return {"items": rows, "total": total}


def get_beneficiary(beneficiary_id: str) -> Dict[str, Any]:
    with transaction() as cur:
        cur.execute(
            sql.SQL(
                "SELECT beneficiary_id, type_id, data, status, voice_score, "
                "duplicate_of, project_id, source_survey_id, created_on, created_by, "
                "reviewed_by, reviewed_on FROM {} WHERE beneficiary_id = %s"
            ).format(_q("master_registry")),
            (beneficiary_id,),
        )
        row = cur.fetchone()
        if not row:
            raise ValueError(f"Beneficiary '{beneficiary_id}' not found")
        return dict(row)


def search_registry(
    query: str,
    type_id: Optional[str] = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """Full-text search across beneficiary_id and JSONB data values."""
    pattern = f"%{query}%"
    conditions = [
        "(beneficiary_id ILIKE %s OR data::text ILIKE %s)"
    ]
    params: list = [pattern, pattern]
    if type_id:
        conditions.append("type_id = %s")
        params.append(type_id)
    where = " AND ".join(conditions)
    with transaction() as cur:
        cur.execute(
            sql.SQL(
                "SELECT beneficiary_id, type_id, data, status, voice_score, "
                "duplicate_of, project_id, created_on, created_by "
                "FROM {} WHERE {} ORDER BY created_on DESC LIMIT %s"
            ).format(_q("master_registry"), sql.SQL(where)),
            params + [limit],
        )
        return [dict(r) for r in cur.fetchall()]


def review_beneficiary(
    beneficiary_id: str,
    action: str,
    reviewed_by: str,
) -> Dict[str, Any]:
    if action not in ("approve", "reject"):
        raise ValueError("Action must be 'approve' or 'reject'")
    new_status = "approved" if action == "approve" else "rejected"
    with transaction() as cur:
        cur.execute(
            sql.SQL(
                "UPDATE {} SET status = %s, reviewed_by = %s, reviewed_on = NOW() "
                "WHERE beneficiary_id = %s RETURNING *"
            ).format(_q("master_registry")),
            (new_status, reviewed_by, beneficiary_id),
        )
        row = cur.fetchone()
        if not row:
            raise ValueError(f"Beneficiary '{beneficiary_id}' not found")
        return dict(row)


def bulk_review(
    ids: List[str],
    action: str,
    reviewed_by: str,
) -> Dict[str, int]:
    if action not in ("approve", "reject"):
        raise ValueError("Action must be 'approve' or 'reject'")
    new_status = "approved" if action == "approve" else "rejected"
    updated = 0
    with transaction() as cur:
        for bid in ids:
            cur.execute(
                sql.SQL(
                    "UPDATE {} SET status = %s, reviewed_by = %s, reviewed_on = NOW() "
                    "WHERE beneficiary_id = %s AND status IN ('pending', 'duplicate')"
                ).format(_q("master_registry")),
                (new_status, reviewed_by, bid),
            )
            updated += cur.rowcount
    return {"updated": updated, "action": action}


def merge_beneficiaries(
    keep_id: str,
    merge_ids: List[str],
    reviewed_by: str,
) -> Dict[str, Any]:
    """Merge duplicate records: keep one, mark others as duplicates pointing to it."""
    kept = get_beneficiary(keep_id)
    merged = 0
    with transaction() as cur:
        for mid in merge_ids:
            if mid == keep_id:
                continue
            cur.execute(
                sql.SQL(
                    "UPDATE {} SET status = 'duplicate', duplicate_of = %s, "
                    "reviewed_by = %s, reviewed_on = NOW() "
                    "WHERE beneficiary_id = %s"
                ).format(_q("master_registry")),
                (keep_id, reviewed_by, mid),
            )
            merged += cur.rowcount
    return {"kept": keep_id, "merged": merged}


def find_duplicates(
    type_id: Optional[str] = None,
    pending_ids: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """Compare pending records' voiceprints against all other records.

    Voice-only: records without a voice_embedding are skipped.
    Returns {pending, matches: [{record, score}]} where score >= VOICE_THRESHOLD.
    """
    from app.core import voiceprint

    with transaction() as cur:
        # Fetch pending records to check
        p_conds = ["status = 'pending'", "voice_embedding IS NOT NULL"]
        p_params: list = []
        if type_id:
            p_conds.append("type_id = %s")
            p_params.append(type_id)
        if pending_ids:
            p_conds.append("beneficiary_id = ANY(%s)")
            p_params.append(pending_ids)

        cur.execute(
            sql.SQL(
                "SELECT beneficiary_id, type_id, data, status, voice_score, "
                "duplicate_of, project_id, created_on, created_by, voice_embedding "
                "FROM {} WHERE {}"
            ).format(_q("master_registry"), sql.SQL(" AND ".join(p_conds))),
            p_params,
        )
        pendings = [dict(r) for r in cur.fetchall()]
        if not pendings:
            return []

        # Fetch all other records with voice embeddings for comparison
        a_conds = ["voice_embedding IS NOT NULL"]
        a_params: list = []
        if type_id:
            a_conds.append("type_id = %s")
            a_params.append(type_id)

        cur.execute(
            sql.SQL(
                "SELECT beneficiary_id, type_id, data, status, voice_score, "
                "duplicate_of, project_id, created_on, created_by, voice_embedding "
                "FROM {} WHERE {}"
            ).format(_q("master_registry"), sql.SQL(" AND ".join(a_conds))),
            a_params,
        )
        all_records = [dict(r) for r in cur.fetchall()]

    seen = set()
    results = []

    for p in pendings:
        p_vec = voiceprint.unpack(p.pop("voice_embedding", None))
        if p_vec is None:
            continue

        matches = []
        for other in all_records:
            if other["beneficiary_id"] == p["beneficiary_id"]:
                continue
            if other["beneficiary_id"] in seen:
                continue
            o_vec = voiceprint.unpack(other.get("voice_embedding"))
            if o_vec is None:
                continue
            score = voiceprint.similarity(p_vec, o_vec)
            if score >= VOICE_THRESHOLD:
                rec = {k: v for k, v in other.items() if k != "voice_embedding"}
                matches.append({"record": rec, "score": round(float(score), 4)})

        matches.sort(key=lambda m: m["score"], reverse=True)
        if matches:
            # ponytail: top-5 per pending, O(n*m) — precompute matrix if registry > 10k
            results.append({"pending": p, "matches": matches[:5]})
            seen.add(p["beneficiary_id"])

    return results


def export_registry(
    type_id: Optional[str] = None,
    status: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """All records for export (no voice embedding, no limit)."""
    conditions = []
    params: list = []
    if type_id:
        conditions.append("type_id = %s")
        params.append(type_id)
    if status:
        conditions.append("status = %s")
        params.append(status)
    where = sql.SQL(" WHERE " + " AND ".join(conditions)) if conditions else sql.SQL("")
    with transaction() as cur:
        cur.execute(
            sql.SQL(
                "SELECT beneficiary_id, type_id, data, status, voice_score, "
                "duplicate_of, project_id, source_survey_id, created_on, created_by, "
                "reviewed_by, reviewed_on FROM {} {} ORDER BY created_on"
            ).format(_q("master_registry"), where),
            params,
        )
        return [dict(r) for r in cur.fetchall()]
