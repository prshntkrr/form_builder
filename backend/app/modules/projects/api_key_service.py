"""Project API keys for external data access.

The raw key is returned exactly once — at creation. Only the SHA-256 hash is
stored, so a leaked table cannot authenticate anything.
"""
import secrets

from typing import Any, Dict, List, Optional

from app.core.database import transaction
from app.core.security import hash_token

KEY_ID_PREFIX = "pak"
KEY_BYTES = 32


class KeyError_(Exception):
    pass


def _next_key_id(cur) -> str:
    cur.execute(
        """
        SELECT COALESCE(MAX(CAST(SUBSTRING(key_id, %s) AS INTEGER)), 0) + 1 AS n
        FROM project_api_key
        """,
        (len(KEY_ID_PREFIX) + 1,),
    )
    return f"{KEY_ID_PREFIX}{cur.fetchone()['n']}"


def create_key(project_id: str, label: str, created_by: str) -> Dict[str, Any]:
    raw = secrets.token_urlsafe(KEY_BYTES)
    hashed = hash_token(raw)
    prefix = raw[:8]

    with transaction() as cur:
        key_id = _next_key_id(cur)
        cur.execute(
            """
            INSERT INTO project_api_key (key_id, project_id, key_hash, key_prefix, label, created_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (key_id, project_id, hashed, prefix, label or "", created_by),
        )

    return {"key_id": key_id, "key": raw, "prefix": prefix, "label": label}


def list_keys(project_id: str) -> List[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute(
            """
            SELECT key_id, key_prefix, label, created_on, created_by, revoked_on
            FROM project_api_key
            WHERE project_id = %s
            ORDER BY created_on DESC
            """,
            (project_id,),
        )
        return [dict(r) for r in cur.fetchall()]


def revoke_key(key_id: str, project_id: str) -> bool:
    with transaction() as cur:
        cur.execute(
            """
            UPDATE project_api_key SET revoked_on = CURRENT_TIMESTAMP
            WHERE key_id = %s AND project_id = %s AND revoked_on IS NULL
            """,
            (key_id, project_id),
        )
        return cur.rowcount > 0


def rotate_key(key_id: str, project_id: str, created_by: str) -> Dict[str, Any]:
    with transaction() as cur:
        cur.execute(
            "SELECT label FROM project_api_key WHERE key_id = %s AND project_id = %s",
            (key_id, project_id),
        )
        row = cur.fetchone()
        if not row:
            raise KeyError_("Key not found")
        label = row["label"]

        cur.execute(
            """
            UPDATE project_api_key SET revoked_on = CURRENT_TIMESTAMP
            WHERE key_id = %s AND revoked_on IS NULL
            """,
            (key_id,),
        )

    return create_key(project_id, label, created_by)


def delete_key(key_id: str, project_id: str) -> bool:
    with transaction() as cur:
        cur.execute(
            "DELETE FROM project_api_key WHERE key_id = %s AND project_id = %s",
            (key_id, project_id),
        )
        return cur.rowcount > 0


def resolve_key(raw_key: str) -> Optional[Dict[str, Any]]:
    """Look up an API key by its hash. Returns the project_id or None."""
    if not raw_key:
        return None

    hashed = hash_token(raw_key)

    with transaction() as cur:
        cur.execute(
            """
            SELECT k.key_id, k.project_id, k.label, k.revoked_on
            FROM project_api_key k
            WHERE k.key_hash = %s
            """,
            (hashed,),
        )
        row = cur.fetchone()
        if not row or row["revoked_on"] is not None:
            return None

        return {"key_id": row["key_id"], "project_id": row["project_id"], "label": row["label"]}
