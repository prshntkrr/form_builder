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

from app.core import auth_service
from app.core import permissions

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


def _label(permission: str) -> str:
    """The human name for a permission, looked up when a request is refused.

    At request time, never at import time: a module declares its permissions
    while it is still being imported, so reading the catalogue from the body of
    `needs()` would ask for a catalogue that is still being assembled.
    """
    entry = permissions.BY_KEY.get(permission)
    return entry.label if entry else permission


def needs(permission: str):
    """A dependency requiring one permission."""

    def dependency(user: Dict[str, Any] = Depends(current_user)) -> Dict[str, Any]:
        label = _label(permission)
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
            wanted = ", ".join(_label(k) for k in permission_keys)
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
