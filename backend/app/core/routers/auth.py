"""Signing in, signing out, and getting back in when you forget."""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request

from app.core import auth_service
from app.core import permissions
from app.core import registry
from app.core.deps import current_user, request_token
from app.core.config import settings
from app.core.security import WeakPassword
from app.core.schemas import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    ResetPasswordRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
def login(req: LoginRequest, user_agent: Optional[str] = Header(default=None)):
    """Exchange an email and password for a session token."""
    try:
        return auth_service.login(req.email, req.password, user_agent)
    except auth_service.AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc))


@router.post("/logout")
def logout(request: Request, user: Dict[str, Any] = Depends(current_user)):
    """End this session. Other devices stay signed in."""
    auth_service.logout(request_token(request) or "")
    return {"signed_out": True}


@router.get("/me")
def me(user: Dict[str, Any] = Depends(current_user)):
    """Who the caller is, and what their role lets them do."""
    # The permission list is the contract; the flags are conveniences the
    # frontend uses to decide which whole sections to show.
    # Only what this deployment can act on: a module switched off in .env has no
    # routes, so reporting its permissions would promise something that 404s.
    held = permissions.clean(user.get("permissions") or [])
    return {
        "user": user,
        "permissions": held,
        "can": permissions.capabilities(held),
        # Which modules this deployment is running. A module switched off in
        # .env is absent here, so the frontend hides its screens without needing
        # a rebuild or a second setting to keep in step.
        "modules": [m.name for m in registry.modules()],
    }


@router.post("/change-password")
def change_password(
    req: ChangePasswordRequest, user: Dict[str, Any] = Depends(current_user)
):
    """Change your own password. Every session ends, including this one."""
    try:
        auth_service.change_password(user["user_id"], req.current_password, req.new_password)
    except WeakPassword as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except auth_service.AuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"changed": True, "sign_in_again": True}


@router.post("/forgot-password")
def forgot_password(req: ForgotPasswordRequest):
    """Send a reset link.

    The reply is the same whether or not the address is registered — otherwise
    this endpoint tells anyone who asks which addresses have accounts.
    """
    issued = auth_service.begin_password_reset(req.email)
    answer: Dict[str, Any] = {
        "sent": True,
        "message": "If that email has an account, a reset link is on its way.",
    }

    if issued:
        token, _ = issued
        auth_service.deliver_reset(req.email, token)
        if settings.auth_expose_reset_link:
            # Local development only — see AUTH_EXPOSE_RESET_LINK.
            answer["reset_link"] = auth_service.reset_link(token)

    return answer


@router.post("/reset-password")
def reset_password(req: ResetPasswordRequest):
    """Set a new password from a reset link. The link works once."""
    try:
        user = auth_service.complete_password_reset(req.token, req.password)
    except WeakPassword as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except auth_service.AuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"reset": True, "email": user["email"]}
