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

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.core import auth_service
from app.core.deps import current_user, needs
from app.modules.forms import channel_settings, routing, webhook_service
from app.modules.forms.permissions import MCDC_INTEGRATE, MCDC_MANAGE, RECORDS_VIEW
from app.modules.forms.schemas import (
    IdentityRequest, RouteRequest, WebhookRequest,
    WhatsAppRouteRequest, WhatsAppSettingsRequest,
)

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
             identity: Optional[str], receiver: Optional[str] = None) -> Dict[str, Any]:
    caller = _caller(user, channel, identity)
    if caller is None:
        return {"matched": False}

    try:
        return routing.resolve(channel, key, caller, receiver=receiver)
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
    receiver: Optional[str] = Query(None, description="The number they sent it to"),
    user: Dict[str, Any] = Depends(needs(MCDC_INTEGRATE)),
):
    """Which form a keyword means, for the person who sent it.

    Case and surrounding space are forgiven — "REGISTER FARMER", "register
    farmer" and " Register Farmer " are one keyword. Nothing fuzzier: a keyword
    that nearly matches starts the wrong form, and nobody downstream can tell.

    `receiver` is the WhatsApp number it arrived on. A route configured for a
    number answers only there, so two projects can use the same keyword on
    their own lines. Left out, every route is considered — which is what a
    caller written before numbers existed sends.
    """
    return _resolve("whatsapp", keyword, user, identity, receiver)


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
    from app.modules.forms.routers.submissions import fillable_forms

    caller = user
    if identity:
        if not auth_service.may(user, MCDC_INTEGRATE):
            raise HTTPException(status_code=403,
                                detail="Asking on somebody else's behalf needs "
                                       "the collection platform's permission")
        caller = routing.user_for_identity("mobile", identity)
        if caller is None:
            return []

    # Only forms open on mobile: never a WhatsApp or IVR form, and never a form
    # whose profile keeps mobile off.
    return fillable_forms(project, caller, channel="mobile")


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
            metadata=req.metadata, receiver_number=req.receiver_number or "",
            created_by=auth_service.display_name(user))
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

    changes: Dict[str, Any] = {
        "channel": req.channel, "route_key": req.route_key,
        "form_id": req.form_id, "project_id": req.project_id,
        "enabled": req.enabled, "metadata": req.metadata,
    }
    # Left out means "unchanged", so a caller that does not know about numbers
    # cannot blank one by omission.
    if req.receiver_number is not None:
        changes["receiver_number"] = req.receiver_number

    try:
        return routing.update_route(route_id, **changes)
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


# --------------------------------------------------------------------------- #
# the Form Builder's view of the same rows
# --------------------------------------------------------------------------- #
# The builder knows a form, a number and a keyword; the routing screen knows a
# route id. Both edit `channel_form_route`, and these two endpoints are only a
# second way in to it. There is no second store, and nothing here writes a
# route the routing screen cannot then see and change.
#
# The welcome and consent messages are not here. They go with the form, in
# `form_json.channel_config.whatsapp`, because they refer to the questions and
# have to be versioned and rolled back with them.
@router.get("/forms/{form_id}/whatsapp-route")
def form_whatsapp_route(form_id: str,
                        user: Dict[str, Any] = Depends(needs(MCDC_MANAGE))):
    """How this form is reached on WhatsApp, or nothing if it is not."""
    route = routing.route_for_form(form_id, "whatsapp")
    if route is None:
        return {"route": None}

    _project_reachable(user, route["project_id"])
    return {"route": route}


@router.put("/forms/{form_id}/whatsapp-route")
def save_form_whatsapp_route(form_id: str, req: WhatsAppRouteRequest,
                             user: Dict[str, Any] = Depends(needs(MCDC_MANAGE))):
    """Give this form its WhatsApp number and keyword, or change them.

    Upserts rather than always creating, so saving the builder twice does not
    leave two keywords pointing at one form.

    A route for a form that is not published yet is stored **switched off**. The
    configuration is real and the routing screen shows it; it starts answering
    when the form is published (`form_service.set_status`), which is also what
    brings it back after an unpublish. Configuring routing while still drafting
    is the ordinary way round, and refusing it would mean publishing first and
    configuring afterwards.

    **The project is the form's own**, read here rather than taken from the
    caller. A route may only be scoped where its form is, so there is exactly
    one right answer and the server is the side that knows it. Asking the
    builder for it was a mistake: while editing a saved form it had no project
    to hand and sent none, which scoped the route to the system and made it
    vanish from the project's routing page.
    """
    project_id = _project_of(form_id)
    _project_reachable(user, project_id)

    published = _is_published(form_id)
    enabled = published if req.enabled is None else (req.enabled and published)

    existing = routing.route_for_form(form_id, "whatsapp")
    try:
        if existing is None:
            return routing.create_route(
                "whatsapp", req.keyword, form_id, project_id=project_id,
                enabled=enabled, receiver_number=req.receiver_number or "",
                created_by=auth_service.display_name(user))

        _project_reachable(user, existing["project_id"])
        return routing.update_route(
            existing["route_id"], channel="whatsapp", route_key=req.keyword,
            form_id=form_id, project_id=project_id, enabled=enabled,
            receiver_number=req.receiver_number or "")
    except routing.RoutingError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _project_of(form_id: str) -> Optional[str]:
    """Which project owns this form, or None for a system form.

    Defensive about the projects module being switched off, like everything
    else that reaches for it: without it every form is a system form, which is
    what this application was before projects existed.
    """
    try:
        from app.modules.projects import project_service
    except Exception:
        return None
    return project_service.project_of_form(form_id)


def _is_published(form_id: str) -> bool:
    from app.modules.forms import form_service, publishing

    try:
        publishing.published(form_service.get_form(form_id))
    except (form_service.FormNotFound, publishing.NotPublished):
        return False
    return True


# --------------------------------------------------------------------------- #
# how the channel is operated
# --------------------------------------------------------------------------- #
@router.get("/whatsapp/settings")
def whatsapp_settings(project: Optional[str] = Query(None),
                      user: Dict[str, Any] = Depends(needs(MCDC_MANAGE))):
    """The timeout, and whether a token is set. Never the token.

    `token_hint` is its last four characters, which is enough to recognise the
    one you pasted and no use to anybody else. The sealed value never leaves
    `channel_settings`.
    """
    project_id = None if project in (None, "", "none") else project
    _project_reachable(user, project_id)
    return channel_settings.shown("whatsapp", project_id)


@router.put("/whatsapp/settings")
def save_whatsapp_settings(req: WhatsAppSettingsRequest,
                           project: Optional[str] = Query(None),
                           user: Dict[str, Any] = Depends(needs(MCDC_MANAGE))):
    """Change the timeout, the token, or both.

    Sending no `api_token` leaves the stored one alone, so a screen that never
    received it cannot blank it by saving something else. Rotation is sending a
    new one: the row is replaced in a single statement, so the old credential
    is in use right up to the commit and the new one from it.

    The response is `shown()` — the same thing the GET returns, and no token.
    """
    project_id = None if project in (None, "", "none") else project
    _project_reachable(user, project_id)

    try:
        return channel_settings.save(
            "whatsapp", project_id,
            session_timeout_seconds=req.session_timeout_seconds,
            api_token=req.api_token,
            updated_by=auth_service.display_name(user))
    except channel_settings.SettingsError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# --------------------------------------------------------------------------- #
# IVR settings
# --------------------------------------------------------------------------- #
@router.get("/ivr/settings")
def ivr_settings(project: Optional[str] = Query(None),
                 user: Dict[str, Any] = Depends(needs(MCDC_MANAGE))):
    project_id = None if project in (None, "", "none") else project
    _project_reachable(user, project_id)
    return channel_settings.shown("ivr", project_id)


@router.put("/ivr/settings")
def save_ivr_settings(req: WhatsAppSettingsRequest,
                      project: Optional[str] = Query(None),
                      user: Dict[str, Any] = Depends(needs(MCDC_MANAGE))):
    project_id = None if project in (None, "", "none") else project
    _project_reachable(user, project_id)
    try:
        return channel_settings.save(
            "ivr", project_id,
            session_timeout_seconds=req.session_timeout_seconds,
            api_token=req.api_token,
            updated_by=auth_service.display_name(user))
    except channel_settings.SettingsError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# --------------------------------------------------------------------------- #
# Sarvam AI settings (speech-to-text key, stored as a pseudo-channel)
# --------------------------------------------------------------------------- #
@router.get("/sarvam/settings")
def sarvam_settings(project: Optional[str] = Query(None),
                    user: Dict[str, Any] = Depends(needs(MCDC_MANAGE))):
    project_id = None if project in (None, "", "none") else project
    _project_reachable(user, project_id)
    return channel_settings.shown("sarvam", project_id)


@router.put("/sarvam/settings")
def save_sarvam_settings(req: WhatsAppSettingsRequest,
                         project: Optional[str] = Query(None),
                         user: Dict[str, Any] = Depends(needs(MCDC_MANAGE))):
    project_id = None if project in (None, "", "none") else project
    _project_reachable(user, project_id)
    try:
        return channel_settings.save(
            "sarvam", project_id,
            session_timeout_seconds=req.session_timeout_seconds,
            api_token=req.api_token,
            updated_by=auth_service.display_name(user))
    except channel_settings.SettingsError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# --------------------------------------------------------------------------- #
# webhook management
# --------------------------------------------------------------------------- #
def _base_url(request) -> str:
    return str(request.base_url).rstrip("/")


@router.get("/whatsapp/webhooks")
def list_webhooks(
    request: Request,
    project: Optional[str] = Query(None),
    user: Dict[str, Any] = Depends(needs(MCDC_MANAGE)),
):
    project_id = None if project in (None, "", "none") else project
    return {"webhooks": webhook_service.list_webhooks(project_id, _base_url(request))}


@router.post("/whatsapp/webhooks", status_code=201)
def create_webhook(
    req: WebhookRequest,
    request: Request,
    user: Dict[str, Any] = Depends(needs(MCDC_MANAGE)),
):
    project_id = None if req.project_id in (None, "", "none") else req.project_id
    _project_reachable(user, project_id)
    try:
        return webhook_service.create_webhook(
            label=req.label, channel="whatsapp",
            project_id=project_id,
            api_token=req.api_token or "",
            created_by=auth_service.display_name(user),
            base_url=_base_url(request))
    except webhook_service.WebhookError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/whatsapp/webhooks/{webhook_id}")
def update_webhook(
    webhook_id: str,
    req: WebhookRequest,
    request: Request,
    user: Dict[str, Any] = Depends(needs(MCDC_MANAGE)),
):
    try:
        return webhook_service.update_webhook(
            webhook_id,
            label=req.label,
            enabled=req.enabled,
            api_token=req.api_token,
            base_url=_base_url(request))
    except webhook_service.WebhookError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/whatsapp/webhooks/{webhook_id}")
def delete_webhook(
    webhook_id: str,
    user: Dict[str, Any] = Depends(needs(MCDC_MANAGE)),
):
    if not webhook_service.delete_webhook(webhook_id):
        raise HTTPException(status_code=404, detail="That webhook does not exist.")
    return {"webhook_id": webhook_id, "deleted": True}


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
