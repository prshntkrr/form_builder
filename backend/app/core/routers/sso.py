"""SSO endpoint for REV platform integration.

Validates an HMAC-signed token from the platform, finds or creates the user,
issues a session, and redirects to the frontend with the bearer token so the
SPA can pick it up and proceed as if the user had signed in normally.
"""
import base64
import hashlib
import hmac
import json
import logging
import time
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import RedirectResponse

from app.core import auth_service
from app.core.config import settings
from app.core.database import transaction
from app.core.security import hash_password, hash_token, new_token

logger = logging.getLogger(__name__)
router = APIRouter(tags=["sso"])


def _validate_sso_token(token: str, secret: str) -> dict:
    parts = token.split(".")
    if len(parts) != 2:
        raise ValueError("Invalid token format")
    raw, sig = parts

    expected = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), raw.encode(), hashlib.sha256).digest()
    ).decode().rstrip("=")
    if not hmac.compare_digest(sig, expected):
        raise ValueError("Invalid signature")

    padded = raw + "=" * (-len(raw) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded))

    if payload.get("exp", 0) < time.time():
        raise ValueError("Token expired")

    return payload


def _find_or_create_user(payload: dict) -> dict:
    """Look up the user by email; create a standard account if new.

    Syncs the role from REV on every SSO login so that admin status
    stays current without manual intervention.
    """
    email = payload["email"]
    name = payload.get("name", "")
    is_admin = payload.get("is_admin", False)
    target_role = auth_service.ROLE_ADMIN if is_admin else auth_service.ROLE_STANDARD

    with transaction() as cur:
        cur.execute("SELECT * FROM app_user WHERE email = %s", (email,))
        row = cur.fetchone()
        if row:
            user = dict(row)
            # Sync role from REV on each SSO login
            cur.execute("SELECT role_id FROM app_role WHERE name = %s", (target_role,))
            role_row = cur.fetchone()
            if role_row and user.get("role_id") != role_row["role_id"]:
                cur.execute(
                    "UPDATE app_user SET role_id = %s WHERE user_id = %s",
                    (role_row["role_id"], user["user_id"]),
                )
                logger.info("SSO synced role to %s for %s", target_role, email)
            return user

    # No existing account — create one with a random password (they sign in
    # via SSO, never by typing a password).
    import secrets
    random_pw = secrets.token_urlsafe(32) + "A1!"  # meets strength check
    user = auth_service.create_user(
        email=email,
        password=random_pw,
        full_name=name or None,
        role=target_role,
        created_by="sso",
    )
    logger.info("SSO created account %s for %s as %s", user["user_id"], email, target_role)
    return user


def _issue_session(user_id: str, user_agent: Optional[str] = None) -> dict:
    """Mint a session token for the given user, bypassing password check."""
    with transaction() as cur:
        token, token_hash = new_token()
        expires = datetime.utcnow() + timedelta(hours=settings.session_hours)
        cur.execute(
            """
            INSERT INTO user_session (token_hash, user_id, expires_on, user_agent)
            VALUES (%s, %s, %s, %s)
            """,
            (token_hash, user_id, expires, (user_agent or "")[:200] or None),
        )
        cur.execute(
            "UPDATE app_user SET failed_logins = 0, locked_until = NULL, "
            "last_login_on = CURRENT_TIMESTAMP WHERE user_id = %s",
            (user_id,),
        )
    return {"token": token, "expires_on": expires}


def _ensure_project(project_payload: dict, user_id: str) -> str:
    """Create the project in form_builder if it doesn't exist, add user as member."""
    rev_project_id = project_payload["id"]
    project_name = project_payload.get("name", rev_project_id)

    with transaction() as cur:
        cur.execute(
            "SELECT project_id FROM project WHERE project_id = %s",
            (rev_project_id,),
        )
        if not cur.fetchone():
            cur.execute(
                """
                INSERT INTO project (project_id, name, description, created_by)
                VALUES (%s, %s, %s, %s)
                """,
                (rev_project_id, project_name, "", "sso"),
            )
            logger.info("SSO created project %s (%s)", rev_project_id, project_name)

        # Ensure user is a member — use project_manager role as default.
        cur.execute(
            "SELECT member_id FROM project_member WHERE project_id = %s AND user_id = %s",
            (rev_project_id, user_id),
        )
        if not cur.fetchone():
            cur.execute(
                "SELECT role_id FROM app_role WHERE name = 'project_manager' LIMIT 1"
            )
            role_row = cur.fetchone()
            if role_row:
                cur.execute(
                    """
                    INSERT INTO project_member (project_id, user_id, role_id, added_by)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (project_id, user_id) DO NOTHING
                    """,
                    (rev_project_id, user_id, role_row["role_id"], "sso"),
                )

    return rev_project_id


@router.get("/sso/")
def sso_login(request: Request, token: str = Query(...)):
    """Validate an SSO token from the REV platform and redirect into the app."""
    secret = settings.sso_secret
    if not secret:
        raise HTTPException(status_code=503, detail="SSO is not configured")

    try:
        payload = _validate_sso_token(token, secret)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc))

    user = _find_or_create_user(payload)

    project = payload.get("project", {})
    fb_project_id = None
    if project.get("id"):
        fb_project_id = _ensure_project(project, user["user_id"])

    session = _issue_session(
        user["user_id"],
        request.headers.get("user-agent"),
    )

    fragment = f"sso_token={session['token']}"
    if fb_project_id:
        fragment += f"&sso_project_id={fb_project_id}&sso_project_name={project.get('name', '')}"
    redirect_url = f"{settings.app_url}/#{fragment}"
    return RedirectResponse(url=redirect_url, status_code=302)
