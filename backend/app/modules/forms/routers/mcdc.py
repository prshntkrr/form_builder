"""What the collection platform asks this application.

    GET  /api/mcdc/forms                     the forms this account may fill
    GET  /api/mcdc/whatsapp/routes?keyword=  which form a keyword means
    GET  /api/mcdc/ivr/routes?menu=          which form a menu option means
    CRUD /api/mcdc/routes                    which keyword means what
    POST /api/mcdc/identities                which account a phone number is

Resolution and authorization are two steps and stay two steps. A route says
where a keyword points; whether the caller may go there is `may_fill_form`,
the same call the form page makes. A route this caller may not use answers
exactly like a keyword nobody configured — `{"matched": false}` — because
"that form exists but you may not use it" turns a keyword into a way to
enumerate what an installation collects.

Nothing here returns a form definition. It returns the reference, and MCDC
fetches the canonical published configuration from `/api/forms/{id}/published`,
which is the one copy.
"""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core import auth_service
from app.core.deps import current_user, needs
from app.modules.forms import routing
from app.modules.forms.permissions import MCDC_INTEGRATE, MCDC_MANAGE, RECORDS_VIEW
from app.modules.forms.schemas import IdentityRequest, RouteRequest

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/mcdc", tags=["mcdc"])


def _caller(user: Dict[str, Any], channel: str,
            identity: Optional[str]) -> Dict[str, Any]:
    """Whose access is being asked about.

    The platform authenticates as itself and names the person on the other end.
    That name is a claim about a phone number, and it is only worth anything
    because `channel_identity` maps it to an account — an unmapped number is
    nobody, and nobody may fill anything in.

    Without an identity the caller is asking about itself, which is what the
    integration's own account can reach. That is deliberately very little.
    """
    if not identity:
        return user

    found = routing.user_for_identity(channel, identity)
    if found is None:
        # An unrecognised number is told the same as an unknown keyword.
        return None
    return found


# --------------------------------------------------------------------------- #
# resolution
# --------------------------------------------------------------------------- #
def _resolve(channel: str, key: str, user: Dict[str, Any],
             identity: Optional[str]) -> Dict[str, Any]:
    caller = _caller(user, channel, identity)
    if caller is None:
        return {"matched": False}

    try:
        return routing.resolve(channel, key, caller)
    except routing.Ambiguous as exc:
        # A configuration to fix, not a coin to toss.
        logger.warning("Ambiguous %s route: %s", channel, exc)
        raise HTTPException(status_code=409, detail=str(exc))
    except routing.RoutingError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/whatsapp/routes")
def whatsapp_route(
    keyword: str = Query(..., description="What the person sent"),
    identity: Optional[str] = Query(None, description="Their WhatsApp number"),
    user: Dict[str, Any] = Depends(needs(MCDC_INTEGRATE)),
):
    """Which form a keyword means, for the person who sent it.

    Case and surrounding space are forgiven — "REGISTER FARMER", "register
    farmer" and " Register Farmer " are one keyword. Nothing fuzzier: a keyword
    that nearly matches starts the wrong form, and nobody downstream can tell.
    """
    return _resolve("whatsapp", keyword, user, identity)


@router.get("/ivr/routes")
def ivr_route(
    menu: str = Query(..., description="What the caller pressed"),
    identity: Optional[str] = Query(None, description="Their phone number"),
    user: Dict[str, Any] = Depends(needs(MCDC_INTEGRATE)),
):
    """Which form a menu option means, for the caller who pressed it."""
    return _resolve("ivr", menu, user, identity)


@router.get("/forms")
def mobile_forms(
    project: Optional[str] = Query(None),
    identity: Optional[str] = Query(None),
    user: Dict[str, Any] = Depends(needs(RECORDS_VIEW)),
):
    """The forms an account may fill in — mobile's whole routing story.

    The same list the application's own form picker shows, from the same
    function, so there is one answer to "what may this person fill in" and no
    chance of a second one drifting. Fillable, not visible: being able to read
    a project's forms, which reviewing needs, is not being able to answer them.

    `identity` is for the platform asking on somebody's behalf; it takes
    `mcdc.integrate`, and without it an account only ever asks about itself.
    """
    from app.modules.forms.routers.submissions import live_forms

    caller = user
    if identity:
        if not auth_service.may(user, MCDC_INTEGRATE):
            raise HTTPException(status_code=403,
                                detail="Asking on somebody else's behalf needs "
                                       "the collection platform's permission")
        caller = routing.user_for_identity("mobile", identity)
        if caller is None:
            return []

    return live_forms(project=project, user=caller)


# --------------------------------------------------------------------------- #
# management
# --------------------------------------------------------------------------- #
@router.get("/routes")
def list_routes(
    project: Optional[str] = Query(None),
    channel: Optional[str] = Query(None),
    user: Dict[str, Any] = Depends(needs(MCDC_MANAGE)),
):
    return {"routes": routing.list_routes(project_id=project, channel=channel),
            "channels": list(routing.CHANNELS)}


def _project_reachable(user: Dict[str, Any], project_id: Optional[str]) -> None:
    """A route may only be made in a project this account can manage forms in.

    Same isolation as everywhere: a project this account is not in reads as one
    that is not there.
    """
    if not project_id:
        return
    try:
        from app.modules.projects import access
    except Exception:
        return
    access.require(user, "project.forms.manage", project_id)


@router.post("/routes", status_code=201)
def create_route(req: RouteRequest, user: Dict[str, Any] = Depends(needs(MCDC_MANAGE))):
    _project_reachable(user, req.project_id)
    try:
        return routing.create_route(
            req.channel, req.route_key, req.form_id, project_id=req.project_id,
            enabled=True if req.enabled is None else req.enabled,
            metadata=req.metadata, created_by=auth_service.display_name(user))
    except routing.RoutingError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/routes/{route_id}")
def update_route(route_id: int, req: RouteRequest,
                 user: Dict[str, Any] = Depends(needs(MCDC_MANAGE))):
    was = routing.get_route(route_id)
    if was is None:
        raise HTTPException(status_code=404, detail=f"No route {route_id}")

    _project_reachable(user, was["project_id"])
    _project_reachable(user, req.project_id)

    try:
        return routing.update_route(
            route_id, channel=req.channel, route_key=req.route_key,
            form_id=req.form_id, project_id=req.project_id, enabled=req.enabled,
            metadata=req.metadata)
    except routing.RoutingError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/routes/{route_id}")
def delete_route(route_id: int, user: Dict[str, Any] = Depends(needs(MCDC_MANAGE))):
    """Remove a signpost. The form it pointed at is untouched."""
    was = routing.get_route(route_id)
    if was is None:
        raise HTTPException(status_code=404, detail=f"No route {route_id}")

    _project_reachable(user, was["project_id"])
    routing.delete_route(route_id)
    return {"route_id": route_id, "deleted": True}


@router.post("/identities", status_code=201)
def link_identity(req: IdentityRequest,
                  user: Dict[str, Any] = Depends(needs(MCDC_MANAGE))):
    """Say which account a phone number or channel id belongs to."""
    if auth_service.get_user(req.user_id) is None:
        raise HTTPException(status_code=404, detail="No such account")

    linked = routing.link_identity(req.channel, req.identity, req.user_id,
                                   created_by=auth_service.display_name(user))
    return {"channel": linked["channel"], "identity": linked["identity"],
            "user_id": linked["user_id"]}
