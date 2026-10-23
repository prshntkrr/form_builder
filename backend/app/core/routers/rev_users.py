"""Users from the REV platform who have e-agrology access.

Read-only: every user here comes from REV's database. The form_builder never
creates or modifies these records — REV is the single source of truth.
"""
import json
import logging

from fastapi import APIRouter, Depends

from app.core.deps import current_user
from app.core.database import rev_fetch_all

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/rev", tags=["rev"])


@router.get("/users")
def list_rev_users(_user=Depends(current_user)):
    """Users in REV who have e-agrology in their platform_access."""
    rows = rev_fetch_all(
        """
        SELECT u.id, u.email, u.full_name, u.organization, u.is_active,
               u.platform_access, u.last_login,
               r.name AS role_name, r.label AS role_label
        FROM users u
        JOIN roles r ON u.role_id = r.id
        WHERE u.is_active = true
        """
    )
    result = []
    for r in rows:
        access = r.get("platform_access") or "[]"
        if isinstance(access, str):
            try:
                access = json.loads(access)
            except (json.JSONDecodeError, TypeError):
                access = []
        if "e-agrology" in access:
            result.append({
                "id": r["id"],
                "email": r["email"],
                "full_name": r["full_name"],
                "organization": r.get("organization"),
                "role": r.get("role_name", "standard"),
                "role_label": r.get("role_label", "Standard User"),
                "last_login": r["last_login"].isoformat() if r.get("last_login") else None,
            })
    return {"users": result}
