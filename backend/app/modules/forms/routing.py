"""How a channel reaches a form.

    "REGISTER FARMER"  ─whatsapp─┐
    "1"                ─ivr─────>├─> route ─> FRM00030 ─> published version
    (an app account)   ─mobile──┘

Two questions that must never be confused:

    resolution      which form does this keyword or menu option mean?
    authorization   may this identity use that form?

A route is a signpost. It says where something points; it grants nothing. A
keyword that resolves to a form is still refused unless the person behind it
could have filled that form in from the application itself — same project
membership, same assignment, same `project.forms.fill`. If a route could grant
access, publishing a keyword would be publishing the data.

The mapping is configuration, in `channel_form_route`, so adding a keyword is a
row rather than a deployment. Nothing about a channel goes into the form
definition: the form says what it asks, and routing says how somebody gets to
it.

The route names the *form*, never a version. Which version is live is the
published-form service's business, so republishing does not mean editing every
keyword that points at the form.
"""
import logging
import re
from typing import Any, Dict, List, Optional

from psycopg2.extras import Json

from app.core.database import transaction

logger = logging.getLogger(__name__)

# Mobile needs no routing — an application account asks for the forms it may
# fill, which is a list, not a keyword.
CHANNELS = ("whatsapp", "ivr")

# What an IVR menu option may be: what a keypad can send. Letters are not on a
# phone keypad in any way a caller would reach reliably.
IVR_KEY = re.compile(r"^[0-9*#]{1,8}$")


class RoutingError(ValueError):
    """The route cannot be stored as asked. The message is safe to show."""


class Ambiguous(RoutingError):
    """Two routes could answer, and guessing between them is not an option."""


def normalize_key(channel: str, key: str) -> str:
    """The form a route key is compared in.

    A keyword is matched with its case and its edges forgiven, because a person
    typing into a chat is not typing a database key: "REGISTER FARMER",
    "register farmer" and " Register Farmer " are one keyword. Runs of
    whitespace collapse for the same reason.

    Deliberately nothing cleverer. No stemming, no fuzzy distance, no "did you
    mean" — a keyword that nearly matches something starts the wrong form, and
    the person filling it in has no way to tell.
    """
    text = re.sub(r"\s+", " ", str(key or "")).strip()
    if channel == "ivr":
        return text
    return text.casefold()


def check_key(channel: str, key: str) -> str:
    if channel not in CHANNELS:
        raise RoutingError(
            f"There is no '{channel}' channel to route. Known: {', '.join(CHANNELS)}.")

    text = re.sub(r"\s+", " ", str(key or "")).strip()
    if not text:
        raise RoutingError("A route needs a keyword or menu option.")
    if channel == "ivr" and not IVR_KEY.match(text):
        raise RoutingError(
            f"'{text}' is not a menu option a caller could press. Use digits, "
            "* or #.")
    return text


# --------------------------------------------------------------------------- #
# what a route may point at
# --------------------------------------------------------------------------- #
def _usable_form(form_id: str, project_id: Optional[str]) -> Dict[str, Any]:
    """The form a route may point at, or why it may not.

    Checked when the route is stored, so a keyword pointing at a draft is
    refused at the point somebody can still do something about it rather than
    at the point a caller is waiting on the line.
    """
    from app.modules.forms import form_service, publishing

    try:
        form = form_service.get_form(form_id)
    except form_service.FormNotFound:
        raise RoutingError(f"There is no form '{form_id}'.")

    try:
        from app.modules.projects import project_service
    except Exception:
        belongs_to = None
    else:
        belongs_to = project_service.project_of_form(form_id)

    if (belongs_to or None) != (project_id or None):
        raise RoutingError(
            "That form does not belong to the project this route is scoped to.")

    try:
        publishing.published(form)
    except publishing.NotPublished as exc:
        raise RoutingError(str(exc))

    return form


# --------------------------------------------------------------------------- #
# the rows
# --------------------------------------------------------------------------- #
def _shown(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "route_id": row["route_id"],
        "channel": row["channel"],
        "route_key": row["route_key"],
        "form_id": row["form_id"],
        "project_id": row["project_id"],
        "enabled": row["enabled"],
        "metadata": row["metadata"] or {},
        "created_by": row["created_by"],
        "created_on": row["created_on"],
        "updated_on": row["updated_on"],
    }


def list_routes(project_id: Optional[str] = None,
                channel: Optional[str] = None) -> List[Dict[str, Any]]:
    where = ["TRUE"]
    values: List[Any] = []

    if project_id == "none":
        where.append("project_id IS NULL")
    elif project_id:
        where.append("project_id = %s")
        values.append(project_id)
    if channel:
        where.append("channel = %s")
        values.append(channel)

    with transaction() as cur:
        cur.execute(
            f"SELECT * FROM channel_form_route WHERE {' AND '.join(where)} "
            "ORDER BY channel, route_key",
            values,
        )
        return [_shown(dict(r)) for r in cur.fetchall()]


def get_route(route_id: int) -> Optional[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute("SELECT * FROM channel_form_route WHERE route_id = %s", (route_id,))
        row = cur.fetchone()
    return _shown(dict(row)) if row else None


def _clashes(channel: str, key_norm: str, project_id: Optional[str],
             enabled: bool, ignoring: Optional[int] = None) -> bool:
    """Whether an enabled route already answers to this, in this scope.

    Only enabled routes clash: a keyword can be retired and the same keyword
    given to another form, which is the ordinary way these change hands.
    """
    if not enabled:
        return False

    with transaction() as cur:
        cur.execute(
            """
            SELECT route_id FROM channel_form_route
            WHERE channel = %s AND route_key_norm = %s AND enabled
              AND project_id IS NOT DISTINCT FROM %s
              AND (%s::int IS NULL OR route_id <> %s)
            """,
            (channel, key_norm, project_id, ignoring, ignoring),
        )
        return cur.fetchone() is not None


def create_route(channel: str, route_key: str, form_id: str,
                 project_id: Optional[str] = None, enabled: bool = True,
                 metadata: Optional[Dict[str, Any]] = None,
                 created_by: str = "") -> Dict[str, Any]:
    channel = (channel or "").strip().lower()
    key = check_key(channel, route_key)
    key_norm = normalize_key(channel, key)

    _usable_form(form_id, project_id)

    if _clashes(channel, key_norm, project_id, enabled):
        raise RoutingError(
            f"'{key}' already points somewhere on {channel} here. Change that "
            "route, or disable it first — two live routes for one keyword is "
            "not something this can guess between.")

    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO channel_form_route
                (channel, route_key, route_key_norm, form_id, project_id,
                 enabled, metadata, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
            """,
            (channel, key, key_norm, form_id, project_id, enabled,
             Json(metadata or {}), created_by),
        )
        row = dict(cur.fetchone())

    logger.info("Routed %s '%s' to %s", channel, key, form_id)
    return _shown(row)


def update_route(route_id: int, **changes: Any) -> Dict[str, Any]:
    was = get_route(route_id)
    if was is None:
        raise RoutingError(f"There is no route {route_id}.")

    channel = (changes.get("channel") or was["channel"]).strip().lower()
    route_key = changes.get("route_key", was["route_key"])
    form_id = changes.get("form_id") or was["form_id"]
    project_id = changes["project_id"] if "project_id" in changes else was["project_id"]
    enabled = was["enabled"] if changes.get("enabled") is None else bool(changes["enabled"])
    metadata = changes.get("metadata")

    key = check_key(channel, route_key)
    key_norm = normalize_key(channel, key)

    # A route being turned off, or deleted, never touches the form: they are
    # different lifecycles and one is not the other's switch.
    if enabled:
        _usable_form(form_id, project_id)

    if _clashes(channel, key_norm, project_id, enabled, ignoring=route_id):
        raise RoutingError(
            f"'{key}' already points somewhere on {channel} here.")

    with transaction() as cur:
        cur.execute(
            """
            UPDATE channel_form_route
               SET channel = %s, route_key = %s, route_key_norm = %s,
                   form_id = %s, project_id = %s, enabled = %s,
                   metadata = COALESCE(%s, metadata),
                   updated_on = CURRENT_TIMESTAMP
             WHERE route_id = %s
             RETURNING *
            """,
            (channel, key, key_norm, form_id, project_id, enabled,
             Json(metadata) if metadata is not None else None, route_id),
        )
        row = dict(cur.fetchone())

    return _shown(row)


def delete_route(route_id: int) -> bool:
    """Remove a signpost. The form it pointed at is untouched."""
    with transaction() as cur:
        cur.execute("DELETE FROM channel_form_route WHERE route_id = %s", (route_id,))
        return cur.rowcount > 0


# --------------------------------------------------------------------------- #
# who is on the other end
# --------------------------------------------------------------------------- #
def link_identity(channel: str, identity: str, user_id: str,
                  created_by: str = "") -> Dict[str, Any]:
    """Say which application account a phone number or channel id belongs to.

    A phone number is not an account. Somebody who knows a keyword and can send
    a message has said nothing about who they are; this table is where that
    claim becomes an identity, and everything downstream authorizes the account
    it names — its projects, its role there, its assignments.
    """
    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO channel_identity (channel, identity, user_id, created_by)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (channel, identity)
            DO UPDATE SET user_id = EXCLUDED.user_id
            RETURNING *
            """,
            ((channel or "").strip().lower(), str(identity or "").strip(),
             user_id, created_by),
        )
        return dict(cur.fetchone())


def user_for_identity(channel: str, identity: str) -> Optional[Dict[str, Any]]:
    """The account behind a channel identity, with its permissions loaded."""
    from app.core import auth_service

    with transaction() as cur:
        cur.execute(
            "SELECT user_id FROM channel_identity WHERE channel = %s AND identity = %s",
            ((channel or "").strip().lower(), str(identity or "").strip()),
        )
        row = cur.fetchone()

    if row is None:
        return None
    return auth_service.get_user(row["user_id"])


# --------------------------------------------------------------------------- #
# resolution
# --------------------------------------------------------------------------- #
def _matching(channel: str, key_norm: str,
              projects: List[str]) -> List[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute(
            """
            SELECT * FROM channel_form_route
            WHERE channel = %s AND route_key_norm = %s AND enabled
              AND (project_id IS NULL OR project_id = ANY(%s))
            """,
            (channel, key_norm, list(projects) or [""]),
        )
        return [dict(r) for r in cur.fetchall()]


def resolve(channel: str, route_key: str, user: Dict[str, Any]) -> Dict[str, Any]:
    """Which form this keyword or menu option means, for this identity.

    Two steps, in this order and never merged:

        resolution      a route, in a scope this identity can be in
        authorization   `may_fill_form`, exactly as the form page asks it

    A route this identity may not use answers the same as a keyword nobody has
    configured — `{"matched": false}`. Saying "that form exists but you may not
    use it" would turn the keyword list into a directory of everything an
    installation collects.

    Precedence is a project's own route over a global one, because a project
    that has said what a keyword means there has said it. Two projects claiming
    the same keyword for one identity is not something to guess between: that
    is `Ambiguous`, and it is a configuration to fix rather than a coin to toss.
    """
    channel = (channel or "").strip().lower()
    if channel not in CHANNELS:
        raise RoutingError(
            f"There is no '{channel}' channel to route. Known: {', '.join(CHANNELS)}.")

    try:
        from app.modules.projects import access
    except Exception:
        projects: List[str] = []
    else:
        projects = access.projects_for(user)

    found = _matching(channel, normalize_key(channel, route_key), projects)
    if not found:
        return {"matched": False}

    scoped = [r for r in found if r["project_id"]]
    if len({r["project_id"] for r in scoped}) > 1:
        raise Ambiguous(
            f"'{route_key}' means different things in more than one of this "
            "caller's projects. Narrow the routes so it means one thing.")

    # A project's own route wins over a global one.
    route = (scoped or found)[0]

    return authorized(route, user)


def authorized(route: Dict[str, Any], user: Dict[str, Any]) -> Dict[str, Any]:
    """What a resolved route becomes once the identity has been checked.

    The route is not consulted about permission. `may_fill_form` is the same
    call the form page makes, so a keyword reaches exactly the forms that
    identity could have opened and filled in from the application, and nothing
    else.
    """
    from app.modules.forms import form_service, publishing

    try:
        from app.modules.projects import access
    except Exception:
        allowed = True
    else:
        allowed = access.may_fill_form(user, route["form_id"])

    if not allowed:
        logger.info("Route %s refused for %s", route["route_id"], user.get("user_id"))
        return {"matched": False}

    try:
        form = form_service.get_form(route["form_id"])
        config = publishing.published(form)
    except (form_service.FormNotFound, publishing.NotPublished):
        # Published when the route was made, not any more. Unusable is
        # unmatched — the caller has nothing to start.
        return {"matched": False}

    # The reference, not the definition. MCDC fetches the configuration itself
    # from the published-form endpoint, which is the one canonical copy.
    return {
        "matched": True,
        "route_id": route["route_id"],
        "channel": route["channel"],
        "route_key": route["route_key"],
        "form_id": config["form_id"],
        "form_title": config["form_title"],
        "version": config["version"],
        "status": config["status"],
        "project_id": route["project_id"],
        "metadata": route.get("metadata") or {},
    }
