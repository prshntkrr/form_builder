"""Who is asking, and are they allowed.

FastAPI dependencies over `auth_service`, so a route declares the permission it
needs rather than the roles that happen to have it today:

    @router.post("")
    def create(req: CreateFormRequest, user = Depends(needs(FORMS_CREATE))):
        ...

That is what lets an admin invent a role and decide what it may do: the check
never mentions a role name.
"""
from typing import Any, Dict, Optional

from fastapi import Depends, Header, HTTPException, Request

from . import auth_service, permissions

UNAUTHENTICATED = HTTPException(
    status_code=401,
    detail="Sign in to continue",
    headers={"WWW-Authenticate": "Bearer"},
)


def _token(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return None
    return token.strip() or None


def optional_user(
    authorization: Optional[str] = Header(default=None),
) -> Optional[Dict[str, Any]]:
    """The signed-in user, or None. Never raises."""
    return auth_service.resolve_session(_token(authorization))


def current_user(
    user: Optional[Dict[str, Any]] = Depends(optional_user),
) -> Dict[str, Any]:
    """Anyone signed in, whatever their role."""
    if user is None:
        raise UNAUTHENTICATED
    return user


def needs(permission: str):
    """A dependency requiring one permission."""
    label = permissions.BY_KEY[permission].label if permission in permissions.BY_KEY \
        else permission

    def dependency(user: Dict[str, Any] = Depends(current_user)) -> Dict[str, Any]:
        if not auth_service.may(user, permission):
            raise HTTPException(
                status_code=403,
                detail=(
                    f"Your role ({user.get('role_label') or user.get('role')}) cannot do "
                    f"this — it needs the '{label}' permission"
                ),
            )
        return user
    return dependency


def needs_any(*permission_keys: str):
    """A dependency satisfied by any one of several permissions."""
    def dependency(user: Dict[str, Any] = Depends(current_user)) -> Dict[str, Any]:
        if not any(auth_service.may(user, key) for key in permission_keys):
            wanted = ", ".join(
                permissions.BY_KEY[k].label for k in permission_keys if k in permissions.BY_KEY
            )
            raise HTTPException(
                status_code=403,
                detail=(
                    f"Your role ({user.get('role_label') or user.get('role')}) cannot do "
                    f"this — it needs one of: {wanted}"
                ),
            )
        return user
    return dependency


def request_token(request: Request) -> Optional[str]:
    """The raw token on this request — for logging out."""
    return _token(request.headers.get("authorization"))


# Anyone signed in.
viewer = current_user

__all__ = [
    "current_user", "needs", "needs_any", "optional_user", "request_token", "viewer",
]
