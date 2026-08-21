"""Creating roles and choosing what each one may do."""
import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from app.core import auth_service
from app.core import permissions
from app.core import role_service
from app.core.deps import needs
from app.core.permissions import ROLES_MANAGE
from app.core.schemas import CreateRoleRequest, DeleteRoleRequest, UpdateRoleRequest

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/roles", tags=["roles"])


@router.get("/permissions")
def catalogue(user: Dict[str, Any] = Depends(needs(ROLES_MANAGE))):
    """Everything a role can be given, grouped for the screen that assigns them.

    Fixed in code: a permission only means something because an endpoint checks
    it, so this list is not editable.
    """
    return permissions.as_catalogue()


@router.get("")
def index(user: Dict[str, Any] = Depends(needs(ROLES_MANAGE))):
    return role_service.list_roles()


@router.post("", status_code=201)
def create(req: CreateRoleRequest, user: Dict[str, Any] = Depends(needs(ROLES_MANAGE))):
    """Create a role and give it permissions."""
    try:
        return role_service.create_role(
            req.label,
            name=req.name,
            description=req.description,
            permission_keys=req.permissions,
            created_by=auth_service.display_name(user),
        )
    except role_service.RoleError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/{role_id}")
def detail(role_id: str, user: Dict[str, Any] = Depends(needs(ROLES_MANAGE))):
    try:
        return role_service.get_role(role_id)
    except role_service.RoleNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.patch("/{role_id}")
def update(role_id: str, req: UpdateRoleRequest,
           user: Dict[str, Any] = Depends(needs(ROLES_MANAGE))):
    """Rename a role or change what it may do.

    Everyone holding it is signed out, so a permission taken away stops applying
    at once rather than at their next sign-in.
    """
    try:
        return role_service.update_role(
            role_id, label=req.label, description=req.description,
            permission_keys=req.permissions,
        )
    except role_service.RoleNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except role_service.RoleError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/{role_id}")
def remove(role_id: str, req: DeleteRoleRequest = DeleteRoleRequest(),
           user: Dict[str, Any] = Depends(needs(ROLES_MANAGE))):
    """Delete a role. Anyone still holding it must be moved to another one."""
    try:
        return role_service.delete_role(role_id, reassign_to=req.reassign_to)
    except role_service.RoleNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except role_service.RoleError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
