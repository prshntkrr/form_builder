"""Managing people and their roles. Admin only, throughout."""
import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from app.core import auth_service
from app.core.deps import needs
from app.core.permissions import USERS_DELETE, USERS_MANAGE
from app.core.role_migration import NOT_OFFERED
from app.core.config import settings
from app.core.security import WeakPassword
from app.core.schemas import CreateUserRequest, UpdateUserRequest

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("/roles")
def assignable_roles(user: Dict[str, Any] = Depends(needs(USERS_MANAGE))):
    """The roles that can be written on an **account**.

    System roles only. A role that carries project permissions is something
    somebody is *inside one project*, held through membership — writing it on an
    account meant nothing, and reading it as though it did is what made
    "Project manager" look like a kind of administrator. Those are offered by
    `GET /api/projects/roles` instead, where they belong.

    Derived rather than listed, so a role an administrator invents with only
    system permissions is offered here without a code change.
    """
    from app.core import role_service

    return [
        {
            "role_id": r["role_id"],
            "role": r["name"],
            "label": r["label"],
            "description": r["description"],
            "permission_count": len(r["permissions"]),
        }
        for r in role_service.list_roles()
        if not _is_project_role(r["permissions"]) and r["name"] not in NOT_OFFERED
    ]


def _is_project_role(held) -> bool:
    """Whether a role belongs to the project catalogue instead of this one.

    The same predicate `GET /api/projects/roles` uses, so a role is offered on
    exactly one of the two and never on both.
    """
    try:
        from app.modules.projects import permissions as projects
    except Exception:
        # The projects module is switched off, so every role is a system role.
        return False
    return projects.is_project_role(held)


@router.get("")
def index(user: Dict[str, Any] = Depends(needs(USERS_MANAGE))):
    return auth_service.list_users()


@router.post("", status_code=201)
def create(req: CreateUserRequest, user: Dict[str, Any] = Depends(needs(USERS_MANAGE))):
    """Add someone and give them a role."""
    try:
        return auth_service.create_user(
            req.email, req.password,
            full_name=req.full_name, role=req.role,
            created_by=auth_service.display_name(user),
        )
    except auth_service.UserExists as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except WeakPassword as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except auth_service.AuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.patch("/{user_id}")
def update(user_id: str, req: UpdateUserRequest, user: Dict[str, Any] = Depends(needs(USERS_MANAGE))):
    """Change a role, a name, or whether the account works at all.

    Changing either ends that person's sessions, so a revoked role takes effect
    immediately rather than at their next sign-in.
    """
    if user_id == user["user_id"] and req.is_active is False:
        raise HTTPException(status_code=400, detail="You cannot deactivate your own account")
    if user_id == user["user_id"] and req.role and req.role != user["role"]:
        raise HTTPException(status_code=400, detail="You cannot change your own role")

    try:
        return auth_service.update_user(
            user_id, role=req.role, full_name=req.full_name,
            is_active=req.is_active, unlock=req.unlock,
        )
    except auth_service.UserNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except auth_service.AuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/{user_id}/deactivate")
def deactivate(user_id: str, user: Dict[str, Any] = Depends(needs(USERS_MANAGE))):
    """Switch an account off without removing it.

    Usually the right answer: the account stops working immediately and
    everything about it is still there to turn back on.
    """
    if user_id == user["user_id"]:
        raise HTTPException(status_code=400, detail="You cannot deactivate your own account")
    try:
        return auth_service.update_user(user_id, is_active=False)
    except auth_service.UserNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except auth_service.AuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/{user_id}")
def delete(user_id: str, user: Dict[str, Any] = Depends(needs(USERS_DELETE))):
    """Remove an account, its sessions and its project memberships.

    What it collected stays. See `auth_service.delete_user` for why that is safe
    and what it means for the records they left behind.
    """
    if user_id == user["user_id"]:
        raise HTTPException(
            status_code=400,
            detail="You cannot delete your own account. Ask another administrator.",
        )
    try:
        return auth_service.delete_user(user_id)
    except auth_service.UserNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except auth_service.AuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/{user_id}/reset-link")
def reset_link(user_id: str, user: Dict[str, Any] = Depends(needs(USERS_MANAGE))):
    """Issue a reset link for someone who cannot get in.

    The link is emailed if mail is configured, and always written to the server
    log. It is returned here only when AUTH_EXPOSE_RESET_LINK is on.
    """
    try:
        target = auth_service.get_user(user_id)
    except auth_service.UserNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    issued = auth_service.begin_password_reset(target["email"])
    if not issued:
        raise HTTPException(status_code=400, detail="That account is not active")

    token, _ = issued
    auth_service.deliver_reset(target["email"], token)
    logger.info("%s issued a reset link for %s", user["email"], target["email"])

    answer = {"email": target["email"], "sent": True}
    if settings.auth_expose_reset_link:
        answer["reset_link"] = auth_service.reset_link(token)
    return answer
