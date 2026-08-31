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


def _project_flags(user: Dict[str, Any], flags: Dict[str, Any]) -> Dict[str, bool]:
    """What this account can do *somewhere*, from its project memberships.

    The account's own role cannot answer any of this. A Standard User holds no
    project permission at all — they hold them through the projects they are a
    member of — so a flag read off the account role is false for every real
    project member, which is what sent them to an empty "forms to fill in" page
    instead of into their project.

    These are navigation flags, nothing more. Which project each one is true in
    is a separate question, asked per project by `your_permissions`, and every
    endpoint checks the permission again for the project it is acting on. None
    of this widens what the account itself may do: a flag being true here never
    makes a project permission into a system one.
    """
    try:
        from app.modules.projects import access
        from app.modules.projects import permissions as project_permissions
    except Exception:
        # The projects module is switched off; the account's own flags stand.
        return {}

    try:
        joined = access.projects_for(user)
        found = {
            # Offer the project side of the application at all.
            "use_projects": bool(flags.get("use_projects")) or bool(joined),
            # Somebody has forms to fill in somewhere.
            "fill_forms": bool(access.projects_where(
                user, project_permissions.FORMS_FILL)),
            # Somebody has submissions to judge somewhere.
            "review_submissions": bool(access.projects_where(
                user, project_permissions.SUBMISSIONS_REVIEW)),
        }
    except Exception:
        logger.exception("Could not work out this account's project navigation")
        return {}

    return found


@router.get("/me")
def me(user: Dict[str, Any] = Depends(current_user)):
    """Who the caller is, and what their role lets them do."""
    # The permission list is the contract; the flags are conveniences the
    # frontend uses to decide which whole sections to show.
    # Only what this deployment can act on: a module switched off in .env has no
    # routes, so reporting its permissions would promise something that 404s.
    held = permissions.clean(user.get("permissions") or [])
    flags = permissions.capabilities(held)

    # Whether the builder is reachable at all. `build_forms` is an account
    # permission; this one is also true for somebody who may build forms in a
    # project they belong to, which the account alone cannot say. Without it the
    # builder route would turn a Project Manager away and send them home.
    try:
        from app.modules.forms.routers.forms import may_build_somewhere
        flags["build_any_forms"] = bool(flags.get("build_forms")) or may_build_somewhere(user)
    except Exception:
        logger.exception("Could not work out whether the builder is reachable")
        flags["build_any_forms"] = bool(flags.get("build_forms"))

    flags.update(_project_flags(user, flags))

    return {
        "user": user,
        "permissions": held,
        "can": flags,
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
