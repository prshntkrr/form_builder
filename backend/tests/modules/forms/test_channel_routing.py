"""How a channel reaches a form, and what that does not buy it.

    "REGISTER FARMER" ─> route ─> FRM000xx ─> published version
                                     │
                                may_fill_form
                                     │
                              start, or nothing

The claim these tests exist to hold: **a route grants nothing**. Resolution and
authorization are separate steps, and a keyword reaches exactly the forms its
caller could have opened from the application itself. Everything else here —
normalization, scope, versions, lifecycle — is in service of that.
"""
import uuid

import pytest
from psycopg2 import sql

from app.core import auth_service
from app.core.database import ping, transaction
from app.modules.forms import form_service, routing
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.permissions import (
    MCDC_INTEGRATE, MCDC_MANAGE, RECORDS_CREATE, RECORDS_VIEW,
)
from app.modules.forms.tabular_service import tabular_name
from app.modules.projects import project_service

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"
KEYWORD = "REGISTER FARMER"

FIELDS = [
    {"name": "farmer_name", "label": "Farmer name", "type": "text", "required": True},
    {"name": "main_crop", "label": "Main crop", "type": "select",
     "options": ["MAIZE", "WHEAT", "RICE"]},
]


# --------------------------------------------------------------------------- #
# scaffolding
# --------------------------------------------------------------------------- #
@pytest.fixture
def forms():
    made = []
    yield made
    with transaction() as cur:
        for form_id, table in made:
            for name in ("channel_form_route", "form_export", "submission_channel",
                         "form_survey_progress"):
                cur.execute(f"DELETE FROM {name} WHERE form_id = %s", (form_id,))
            for name in (tabular_name(table), table):
                cur.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(
                    sql.Identifier(name)))
            cur.execute(sql.SQL("DROP SEQUENCE IF EXISTS {}").format(
                sql.Identifier(f"{table[:43]}_survey_seq")))
            cur.execute("DELETE FROM form_version WHERE form_id = %s", (form_id,))
            cur.execute("DELETE FROM forms WHERE form_id = %s", (form_id,))


@pytest.fixture
def projects():
    made = []
    yield made
    with transaction() as cur:
        for project_id in made:
            cur.execute("DELETE FROM project WHERE project_id = %s", (project_id,))


@pytest.fixture
def people():
    made = []

    def make(label, role="standard"):
        email = f"{label}.{uuid.uuid4().hex[:8]}@example.test"
        user = auth_service.create_user(email, PASSWORD, role=role, full_name=label)
        made.append(user["user_id"])
        return {**user, "token": auth_service.login(email, PASSWORD)["token"]}

    yield make

    with transaction() as cur:
        for user_id in made:
            cur.execute("DELETE FROM channel_identity WHERE user_id = %s", (user_id,))
            cur.execute("DELETE FROM project_member WHERE user_id = %s", (user_id,))
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))


@pytest.fixture
def roles():
    """Roles made for one test, with exactly the permissions it names."""
    made = []

    def make(label, permissions):
        from app.core import role_service

        role = role_service.create_role(
            f"{label} {uuid.uuid4().hex[:6]}", permission_keys=list(permissions),
            created_by="tests")
        made.append(role["role_id"])
        return role["name"]

    yield make

    with transaction() as cur:
        for role_id in made:
            # Accounts first: an account outlives the role it was given here.
            cur.execute(
                "DELETE FROM channel_identity WHERE user_id IN "
                "(SELECT user_id FROM app_user WHERE role_id = %s)", (role_id,))
            cur.execute(
                "DELETE FROM project_member WHERE user_id IN "
                "(SELECT user_id FROM app_user WHERE role_id = %s)", (role_id,))
            cur.execute("DELETE FROM app_user WHERE role_id = %s", (role_id,))
            cur.execute("DELETE FROM project_member WHERE role_id = %s", (role_id,))
            cur.execute("DELETE FROM role_permission WHERE role_id = %s", (role_id,))
            cur.execute("DELETE FROM app_role WHERE role_id = %s", (role_id,))


def client_for(person):
    from fastapi.testclient import TestClient

    from app.main import app
    return TestClient(app, headers={"Authorization": f"Bearer {person['token']}"})


def _role_id(name):
    with transaction() as cur:
        cur.execute("SELECT role_id FROM app_role WHERE name = %s", (name,))
        row = cur.fetchone()
        return row["role_id"] if row else None


def _form(forms, project=None, status="Active", fields=None, title=None):
    created = form_service.create_form(normalize_form({
        "title": title or f"Route {uuid.uuid4().hex[:6]}",
        "table_name": f"rt_{uuid.uuid4().hex[:8]}",
        "fields": fields or FIELDS,
    }), created_by="tests", status=status)
    forms.append((created["form_id"], created["table"]["table_name"]))
    if project:
        project_service.set_form_project(created["form_id"], project)
    return created["form_id"]


@pytest.fixture
def platform(people, roles):
    """The collection platform's own account: `mcdc.integrate` and nothing more.

    Not an administrator, and not an employee's login. What it can do is ask on
    behalf of callers it can name, and send in what they answered.
    """
    name = roles("MCDC service", [MCDC_INTEGRATE, RECORDS_VIEW, RECORDS_CREATE])
    return people("mcdc-service", role=name)


@pytest.fixture
def routed(forms, projects, people, platform):
    """A project, a surveyor who may fill its form, and a keyword for it."""
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project, title="Farmer Registration")
    project_service.assign_form(form_id, "everyone")

    surveyor = people("Shrishti")
    project_service.add_member(project, surveyor["user_id"], _role_id("surveyor"))
    routing.link_identity("whatsapp", "+521555000111", surveyor["user_id"])
    routing.link_identity("ivr", "+521555000111", surveyor["user_id"])
    routing.link_identity("mobile", "+521555000111", surveyor["user_id"])

    routing.create_route("whatsapp", KEYWORD, form_id, project_id=project)
    routing.create_route("ivr", "1", form_id, project_id=project)

    return {"project": project, "form_id": form_id, "surveyor": surveyor,
            "identity": "+521555000111"}


def ask(client, channel, key, identity=None):
    """Ask the routing API what a keyword or keypress means.

    Parameters go through the client rather than into a formatted string: a
    phone number starts with '+', which in a raw query string is a space.
    """
    path, name = {"whatsapp": ("whatsapp", "keyword"), "ivr": ("ivr", "menu")}[channel]
    params = {name: key}
    if identity:
        params["identity"] = identity
    return client.get(f"/api/mcdc/{path}/routes", params=params)


# --------------------------------------------------------------------------- #
# WhatsApp
# --------------------------------------------------------------------------- #
def test_a_keyword_resolves_to_its_form(routed, platform):
    answer = ask(client_for(platform), "whatsapp", KEYWORD, routed["identity"])

    assert answer.status_code == 200
    body = answer.json()
    assert body["matched"] is True
    assert body["form_id"] == routed["form_id"]
    assert body["version"] == 1
    assert body["status"] == "published"


def test_case_and_spacing_are_forgiven(routed, platform):
    client = client_for(platform)

    for typed in ("register farmer", "  Register Farmer  ", "REGISTER  FARMER"):
        answer = ask(client, "whatsapp", typed, routed["identity"])
        assert answer.json()["matched"] is True, typed
        assert answer.json()["form_id"] == routed["form_id"]


def test_a_keyword_nobody_configured_matches_nothing(routed, platform):
    answer = ask(client_for(platform), "whatsapp", "REGISTER GOAT",
                 routed["identity"])

    assert answer.json() == {"matched": False}


def test_one_keyword_cannot_mean_two_things_at_once(routed, forms):
    """Rejected when it is configured, not guessed at when somebody is waiting."""
    another = _form(forms, project=routed["project"])

    with pytest.raises(routing.RoutingError) as refused:
        routing.create_route("whatsapp", "register farmer", another,
                             project_id=routed["project"])

    assert "already points somewhere" in str(refused.value)

    # Retiring the first frees the keyword — the ordinary way these change hands.
    live = [r for r in routing.list_routes(project_id=routed["project"])
            if r["channel"] == "whatsapp"][0]
    routing.update_route(live["route_id"], enabled=False)
    assert routing.create_route("whatsapp", "REGISTER FARMER", another,
                                project_id=routed["project"])["enabled"] is True


def test_a_disabled_route_resolves_to_nothing(routed, platform):
    route = [r for r in routing.list_routes(project_id=routed["project"])
             if r["channel"] == "whatsapp"][0]
    routing.update_route(route["route_id"], enabled=False)

    assert ask(client_for(platform), "whatsapp", KEYWORD,
               routed["identity"]).json() == {"matched": False}
    # And the form itself is untouched by that.
    assert form_service.get_form(routed["form_id"])["form_status"] == "Active"


def test_a_route_cannot_be_made_to_a_draft(forms, projects):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    draft = _form(forms, project=project, status="Draft")

    with pytest.raises(routing.RoutingError) as refused:
        routing.create_route("whatsapp", "DRAFT THING", draft, project_id=project)

    assert "draft" in str(refused.value).lower()


def test_a_form_taken_out_of_circulation_stops_resolving(routed, platform):
    form_service.set_status(routed["form_id"], "Inactive")

    assert ask(client_for(platform), "whatsapp", KEYWORD,
               routed["identity"]).json() == {"matched": False}


def test_deleting_a_route_leaves_the_form_alone(routed):
    route = [r for r in routing.list_routes(project_id=routed["project"])
             if r["channel"] == "whatsapp"][0]

    assert routing.delete_route(route["route_id"]) is True
    assert form_service.get_form(routed["form_id"])["form_status"] == "Active"


# --------------------------------------------------------------------------- #
# IVR
# --------------------------------------------------------------------------- #
def test_a_menu_option_resolves_to_its_form(routed, platform):
    answer = ask(client_for(platform), "ivr", "1", routed["identity"])

    assert answer.json()["matched"] is True
    assert answer.json()["form_id"] == routed["form_id"]


def test_an_option_nobody_configured_matches_nothing(routed, platform):
    assert ask(client_for(platform), "ivr", "9",
               routed["identity"]).json() == {"matched": False}


def test_a_menu_option_has_to_be_something_a_keypad_can_send(routed, forms):
    with pytest.raises(routing.RoutingError) as refused:
        routing.create_route("ivr", "REGISTER", _form(forms, project=routed["project"]),
                             project_id=routed["project"])

    assert "keypad" in str(refused.value) or "digits" in str(refused.value)
    # What a keypad can send is fine.
    for key in ("2", "*", "#", "12"):
        route = routing.create_route("ivr", key,
                                     _form(forms, project=routed["project"]),
                                     project_id=routed["project"])
        assert route["route_key"] == key


def test_a_disabled_ivr_route_resolves_to_nothing(routed, platform):
    route = [r for r in routing.list_routes(project_id=routed["project"])
             if r["channel"] == "ivr"][0]
    routing.update_route(route["route_id"], enabled=False)

    assert ask(client_for(platform), "ivr", "1",
               routed["identity"]).json() == {"matched": False}


# --------------------------------------------------------------------------- #
# scope
# --------------------------------------------------------------------------- #
def test_one_keyword_can_mean_different_forms_in_different_projects(
        forms, projects, people, platform):
    """Two projects, one keyword, two farmer registrations."""
    made = []
    for label in ("Mexico", "Kenya"):
        project = project_service.create_project(
            f"{label} {uuid.uuid4().hex[:5]}")["project_id"]
        projects.append(project)
        form_id = _form(forms, project=project, title=f"{label} Farmer Registration")
        project_service.assign_form(form_id, "everyone")
        routing.create_route("whatsapp", KEYWORD, form_id, project_id=project)

        surveyor = people(label)
        project_service.add_member(project, surveyor["user_id"], _role_id("surveyor"))
        identity = f"+52155500{len(made)}999"
        routing.link_identity("whatsapp", identity, surveyor["user_id"])
        made.append((form_id, identity))

    client = client_for(platform)
    for form_id, identity in made:
        assert ask(client, "whatsapp", KEYWORD, identity).json()["form_id"] == form_id


def test_a_projects_own_route_wins_over_a_global_one(routed, forms, platform):
    """Precedence, stated rather than guessed."""
    system_form = _form(forms, title="Global Farmer Registration")
    routing.create_route("whatsapp", KEYWORD, system_form)     # global

    answer = ask(client_for(platform), "whatsapp", KEYWORD, routed["identity"])

    assert answer.json()["form_id"] == routed["form_id"]


def test_a_keyword_meaning_two_things_to_one_caller_is_refused(
        routed, forms, projects, platform):
    """Not a coin to toss: a configuration to fix."""
    other = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(other)
    other_form = _form(forms, project=other)
    project_service.assign_form(other_form, "everyone")
    routing.create_route("whatsapp", KEYWORD, other_form, project_id=other)
    project_service.add_member(other, routed["surveyor"]["user_id"],
                               _role_id("surveyor"))

    answer = ask(client_for(platform), "whatsapp", KEYWORD, routed["identity"])

    assert answer.status_code == 409
    assert "more than one" in answer.json()["detail"]


# --------------------------------------------------------------------------- #
# the point of the whole thing
# --------------------------------------------------------------------------- #
def test_knowing_a_keyword_is_not_being_allowed_to_use_it(routed, people, platform):
    """A route is a signpost. It grants nothing.

    Somebody outside the project, with the right keyword and a mapped number,
    is told exactly what somebody with a wrong keyword is told.
    """
    outsider = people("Nobody")
    routing.link_identity("whatsapp", "+5215559999999", outsider["user_id"])

    answer = ask(client_for(platform), "whatsapp", KEYWORD, "+5215559999999")

    assert answer.json() == {"matched": False}
    # Not "that form exists but you may not use it".
    assert routed["form_id"] not in answer.text


def test_a_number_nobody_has_mapped_is_nobody(routed, platform):
    assert ask(client_for(platform), "whatsapp", KEYWORD,
               "+5215550000000").json() == {"matched": False}


def test_a_reviewer_who_may_read_but_not_fill_is_not_routed_to_it(
        routed, people, platform):
    """The distinction the fillable list keeps, kept here too."""
    reviewer = people("Piyush")
    project_service.add_member(routed["project"], reviewer["user_id"],
                               _role_id("reviewer"))
    routing.link_identity("whatsapp", "+5215558888888", reviewer["user_id"])

    answer = ask(client_for(platform), "whatsapp", KEYWORD, "+5215558888888")

    assert answer.json() == {"matched": False}


def test_the_platform_cannot_resolve_for_a_caller_it_has_not_named(routed, platform):
    """Asking with no identity asks about the platform's own access, which is
    nothing: a service account is not a member of anybody's project."""
    assert ask(client_for(platform), "whatsapp", KEYWORD).json() == {"matched": False}


def test_an_ordinary_account_cannot_act_as_the_platform(routed, people):
    """`mcdc.integrate` is the platform's, and only the platform's."""
    somebody = people("Standard")

    assert ask(client_for(somebody), "whatsapp", KEYWORD,
               routed["identity"]).status_code == 403
    assert client_for(somebody).get("/api/mcdc/routes").status_code == 403


def test_the_platform_cannot_manage_routing(routed, platform, forms):
    """Its permission is narrow on purpose: it reads routes, it does not write
    them, and it is not an administrator."""
    client = client_for(platform)

    assert client.get("/api/mcdc/routes").status_code == 403
    assert client.post("/api/mcdc/routes", json={
        "channel": "whatsapp", "route_key": "ANYTHING",
        "form_id": routed["form_id"]}).status_code == 403
    assert client.post("/api/mcdc/identities", json={
        "channel": "whatsapp", "identity": "+1", "user_id": "USR00001"
    }).status_code == 403


def test_no_secret_is_in_any_routing_response(routed, editor_client, platform):
    from app.core.config import settings

    shown = editor_client.get("/api/mcdc/routes").text
    resolved = ask(client_for(platform), "whatsapp", KEYWORD, routed["identity"]).text

    for secret in (settings.mcdc_api_key, settings.aws_secret_access_key,
                   settings.db_password, PASSWORD):
        if secret:
            assert secret not in shown and secret not in resolved
    assert "password" not in shown and "api_key" not in shown


# --------------------------------------------------------------------------- #
# versions
# --------------------------------------------------------------------------- #
def test_republishing_moves_the_route_with_it(routed, platform):
    """The route names the form. Which version is live is not its business."""
    client = client_for(platform)
    assert ask(client, "whatsapp", KEYWORD, routed["identity"]).json()["version"] == 1

    definition = form_service.get_form(routed["form_id"])["form_json"]
    for _ in range(2):
        definition = form_service.update_form(
            routed["form_id"], normalize_form({**definition, "title": "Renamed"}),
            updated_by="tests")["form_json"]

    answer = ask(client, "whatsapp", KEYWORD, routed["identity"])

    assert answer.json()["version"] == 3
    # And nobody had to edit the keyword.
    route = [r for r in routing.list_routes(project_id=routed["project"])
             if r["channel"] == "whatsapp"][0]
    assert route["form_id"] == routed["form_id"]


def test_a_route_never_carries_the_form_definition(routed, platform):
    """It carries the reference. The configuration comes from one place."""
    body = ask(client_for(platform), "whatsapp", KEYWORD, routed["identity"]).json()

    assert set(body) >= {"form_id", "version", "status"}
    assert "fields" not in body and "config" not in body and "rules" not in body


# --------------------------------------------------------------------------- #
# mobile
# --------------------------------------------------------------------------- #
def test_mobile_is_offered_what_it_may_fill_in(routed, forms):
    """No keyword, no menu: an account asks for its own list."""
    surveyor = client_for(routed["surveyor"])

    offered = surveyor.get("/api/mcdc/forms").json()

    assert [f["form_id"] for f in offered] == [routed["form_id"]]
    # The reference and enough to show a list — not the definition.
    assert "fields" not in offered[0]


def test_a_form_nobody_assigned_is_not_offered(routed, forms):
    _form(forms, project=routed["project"])       # in the project, not assigned

    offered = client_for(routed["surveyor"]).get("/api/mcdc/forms").json()

    assert [f["form_id"] for f in offered] == [routed["form_id"]]


def test_a_reviewer_is_offered_nothing_to_fill(routed, people):
    reviewer = people("Piyush")
    project_service.add_member(routed["project"], reviewer["user_id"],
                               _role_id("reviewer"))

    assert client_for(reviewer).get("/api/mcdc/forms").json() == []


def test_another_projects_forms_are_not_offered(routed, forms, projects, people):
    other = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(other)
    theirs = _form(forms, project=other)
    project_service.assign_form(theirs, "everyone")

    offered = client_for(routed["surveyor"]).get("/api/mcdc/forms").json()

    assert theirs not in [f["form_id"] for f in offered]


def test_a_draft_is_not_offered_to_mobile(routed, forms):
    draft = _form(forms, project=routed["project"], status="Draft")
    project_service.assign_form(draft, "everyone")

    offered = client_for(routed["surveyor"]).get("/api/mcdc/forms").json()

    assert draft not in [f["form_id"] for f in offered]


def test_the_platform_may_ask_on_a_callers_behalf_and_gets_their_list(routed,
                                                                      platform):
    client = client_for(platform)

    theirs = client.get("/api/mcdc/forms",
                        params={"identity": routed["identity"]}).json()
    its_own = client.get("/api/mcdc/forms").json()

    assert [f["form_id"] for f in theirs] == [routed["form_id"]]
    # The platform itself is a member of nothing.
    assert its_own == []


def test_an_ordinary_account_cannot_ask_for_somebody_elses_list(routed, people):
    somebody = people("Standard")

    answer = client_for(somebody).get("/api/mcdc/forms",
                                      params={"identity": routed["identity"]})

    assert answer.status_code == 403


# --------------------------------------------------------------------------- #
# managing the mappings
# --------------------------------------------------------------------------- #
def test_routes_are_managed_through_the_api(forms, editor_client):
    form_id = _form(forms, title="System Farmer Registration")

    made = editor_client.post("/api/mcdc/routes", json={
        "channel": "whatsapp", "route_key": " Register Farmer ",
        "form_id": form_id})
    assert made.status_code == 201
    route_id = made.json()["route_id"]
    # Stored as typed; compared normalized.
    assert made.json()["route_key"] == "Register Farmer"

    listed = editor_client.get("/api/mcdc/routes").json()
    assert any(r["route_id"] == route_id for r in listed["routes"])

    changed = editor_client.put(f"/api/mcdc/routes/{route_id}", json={
        "channel": "whatsapp", "route_key": "REGISTER FARMER",
        "form_id": form_id, "enabled": False})
    assert changed.json()["enabled"] is False

    assert editor_client.delete(f"/api/mcdc/routes/{route_id}").status_code == 200
    assert editor_client.get(f"/api/mcdc/routes").json()["routes"] == [
        r for r in editor_client.get("/api/mcdc/routes").json()["routes"]
        if r["route_id"] != route_id]


def test_a_duplicate_is_refused_by_the_api_too(forms, editor_client):
    form_id = _form(forms)
    body = {"channel": "whatsapp", "route_key": "SAME WORD", "form_id": form_id}

    assert editor_client.post("/api/mcdc/routes", json=body).status_code == 201
    second = editor_client.post("/api/mcdc/routes",
                                json={**body, "route_key": "same word"})

    assert second.status_code == 400
    assert "already points" in second.json()["detail"]

    for route in routing.list_routes(channel="whatsapp"):
        if route["form_id"] == form_id:
            routing.delete_route(route["route_id"])


def test_a_route_cannot_be_made_into_a_project_this_account_cannot_reach(
        forms, projects, people, roles):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)
    form_id = _form(forms, project=project)

    manager = people("Manager", role=roles("Router", [MCDC_MANAGE]))

    answer = client_for(manager).post("/api/mcdc/routes", json={
        "channel": "whatsapp", "route_key": "THEIRS", "form_id": form_id,
        "project_id": project})

    assert answer.status_code == 404


def test_a_route_cannot_point_across_a_project_boundary(routed, forms):
    """A project's route names one of that project's forms."""
    system_form = _form(forms)

    with pytest.raises(routing.RoutingError) as refused:
        routing.create_route("whatsapp", "CROSSING", system_form,
                             project_id=routed["project"])

    assert "does not belong" in str(refused.value)


def test_a_route_to_a_form_that_does_not_exist_is_refused(routed):
    with pytest.raises(routing.RoutingError):
        routing.create_route("whatsapp", "GHOST", "FRM99999",
                             project_id=routed["project"])


def test_an_empty_or_unknown_channel_is_refused(routed, forms):
    form_id = _form(forms, project=routed["project"])

    for channel, key in (("telegram", "HELLO"), ("whatsapp", "   ")):
        with pytest.raises(routing.RoutingError):
            routing.create_route(channel, key, form_id, project_id=routed["project"])


# --------------------------------------------------------------------------- #
# end to end, one channel at a time
# --------------------------------------------------------------------------- #
def _rows(form_id):
    table = form_service.get_form(form_id)["form_json"]["table_name"]
    with transaction() as cur:
        cur.execute(sql.SQL(
            "SELECT survey_id, form_data, created_by FROM {} ORDER BY survey_id"
        ).format(sql.Identifier(table)))
        return [dict(r) for r in cur.fetchall()]


def test_a_whole_whatsapp_conversation(routed, platform):
    """keyword → route → published config → authorized → answers → stored."""
    client = client_for(platform)
    surveyor = client_for(routed["surveyor"])

    resolved = ask(client, "whatsapp", KEYWORD, routed["identity"]).json()
    assert resolved["matched"] is True

    # MCDC fetches the canonical configuration from the one place it lives.
    config = surveyor.get(f"/api/forms/{resolved['form_id']}/published").json()
    assert config["version"] == resolved["version"]

    stored = client.post(f"/api/forms/{resolved['form_id']}/submissions/ingest", json={
        "channel": "whatsapp",
        "channel_identity": routed["identity"],
        "form_version": resolved["version"],
        "payload": {"messages": ["Ramesh", "1"]}})

    assert stored.status_code == 201
    assert stored.json()["channel"] == "whatsapp"
    row = _rows(routed["form_id"])[0]
    assert row["form_data"] == {"farmer_name": "Ramesh", "main_crop": "MAIZE"}
    # Attributed to the person, not to the platform.
    assert row["created_by"] == routed["surveyor"]["full_name"]


def test_a_whole_ivr_call(routed, platform):
    client = client_for(platform)

    resolved = ask(client, "ivr", "1", routed["identity"]).json()
    assert resolved["matched"] is True

    stored = client.post(f"/api/forms/{resolved['form_id']}/submissions/ingest", json={
        "channel": "ivr",
        "channel_identity": routed["identity"],
        "form_version": resolved["version"],
        "payload": {"digits": {"farmer_name": "Ramesh", "main_crop": "1"}}})

    assert stored.status_code == 201
    assert _rows(routed["form_id"])[0]["form_data"] == {
        "farmer_name": "Ramesh", "main_crop": "MAIZE"}


def test_a_whole_mobile_session(routed):
    """No routing layer at all: the account asks for its list and fills one in."""
    surveyor = client_for(routed["surveyor"])

    offered = surveyor.get("/api/mcdc/forms").json()
    form_id = offered[0]["form_id"]
    config = surveyor.get(f"/api/forms/{form_id}/published").json()

    stored = surveyor.post(f"/api/forms/{form_id}/submissions/ingest", json={
        "channel": "mobile", "form_version": config["version"],
        "payload": {"farmer_name": "Ramesh", "main_crop": "MAIZE"}})

    assert stored.status_code == 201
    assert _rows(form_id)[0]["form_data"] == {"farmer_name": "Ramesh",
                                              "main_crop": "MAIZE"}


def test_all_three_channels_meet_in_the_same_place(routed, platform):
    """The architectural claim, once more, from the routing side.

    Three ways in — a keyword, a keypress, a list — and one form, one
    configuration, one submission service, one survey id sequence.
    """
    platform_client = client_for(platform)
    surveyor = client_for(routed["surveyor"])
    form_id = routed["form_id"]

    by_keyword = ask(platform_client, "whatsapp", KEYWORD, routed["identity"]).json()
    by_keypress = ask(platform_client, "ivr", "1", routed["identity"]).json()
    by_list = surveyor.get("/api/mcdc/forms").json()[0]

    # Three routes in, one form.
    assert by_keyword["form_id"] == by_keypress["form_id"] == by_list["form_id"]
    assert by_keyword["version"] == by_keypress["version"]

    platform_client.post(f"/api/forms/{form_id}/submissions/ingest", json={
        "channel": "whatsapp", "channel_identity": routed["identity"],
        "payload": {"messages": ["Ramesh", "1"]}})
    platform_client.post(f"/api/forms/{form_id}/submissions/ingest", json={
        "channel": "ivr", "channel_identity": routed["identity"],
        "payload": {"digits": ["Ramesh", "1"]}})
    surveyor.post(f"/api/forms/{form_id}/submissions/ingest", json={
        "channel": "mobile",
        "payload": {"farmer_name": "Ramesh", "main_crop": "MAIZE"}})

    rows = _rows(form_id)
    assert [r["survey_id"] for r in rows] == ["000001", "000002", "000003"]
    assert all(r["form_data"] == {"farmer_name": "Ramesh", "main_crop": "MAIZE"}
               for r in rows)


def test_the_platform_cannot_send_for_somebody_who_may_not_fill_it(
        routed, people, platform):
    """The last line of the whole design: knowing the keyword, and being named
    by the platform, is still not permission."""
    outsider = people("Nobody")
    routing.link_identity("whatsapp", "+5215557777777", outsider["user_id"])

    answer = client_for(platform).post(
        f"/api/forms/{routed['form_id']}/submissions/ingest", json={
            "channel": "whatsapp", "channel_identity": "+5215557777777",
            "payload": {"messages": ["Ramesh", "1"]}})

    assert answer.status_code == 404
    assert _rows(routed["form_id"]) == []


def test_the_platform_cannot_send_as_a_caller_it_has_not_named(routed, platform):
    answer = client_for(platform).post(
        f"/api/forms/{routed['form_id']}/submissions/ingest", json={
            "channel": "whatsapp", "channel_identity": "+5215550000000",
            "payload": {"messages": ["Ramesh", "1"]}})

    assert answer.status_code == 404
    assert _rows(routed["form_id"]) == []


def test_an_ordinary_account_cannot_send_for_somebody_else(routed, people):
    somebody = people("Standard")

    answer = client_for(somebody).post(
        f"/api/forms/{routed['form_id']}/submissions/ingest", json={
            "channel": "whatsapp", "channel_identity": routed["identity"],
            "payload": {"messages": ["Ramesh", "1"]}})

    assert answer.status_code == 403
