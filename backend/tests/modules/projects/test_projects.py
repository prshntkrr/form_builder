"""Projects, membership, groups, form assignment and the review workflow.

The thing all of it is protecting: an account's reach is decided by the projects
it is in, not by the role on the account. Somebody managing one project has no
standing at all in another, and the backend says so whether or not a screen
ever asked.
"""
import uuid

import pytest
from psycopg2 import sql

from app.core import auth_service
from app.core.database import ping, transaction
from app.modules.forms import form_service
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.tabular_service import tabular_name
from app.modules.projects import access, project_service, submission_workflow
from app.modules.projects.permissions import (
    FORMS_FILL,
    PROJECT_MEMBERS_MANAGE,
    SUBMISSIONS_REVIEW,
    SUBMISSIONS_VIEW_ALL,
)

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"


# --------------------------------------------------------------------------- #
# people, projects and forms to work with
# --------------------------------------------------------------------------- #
def _role_id(name: str) -> str:
    with transaction() as cur:
        cur.execute("SELECT role_id FROM app_role WHERE name = %s", (name,))
        row = cur.fetchone()
    assert row, f"the {name} role was not created"
    return row["role_id"]


@pytest.fixture
def people():
    """Throwaway accounts, all with the same account-wide role.

    Deliberately `field` for everyone: what they can do has to come from their
    project membership, so if a test passes because of the account role it is
    not testing what it says it is.
    """
    made = []

    def make(label, role="field"):
        email = f"{label}.{uuid.uuid4().hex[:8]}@example.test"
        user = auth_service.create_user(email, PASSWORD, role=role, full_name=label)
        token = auth_service.login(email, PASSWORD)["token"]
        made.append(user["user_id"])
        return {**user, "token": token, "email": email}

    yield make

    with transaction() as cur:
        for user_id in made:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))


@pytest.fixture
def projects():
    made = []
    yield made
    with transaction() as cur:
        for project_id in made:
            cur.execute("DELETE FROM project WHERE project_id = %s", (project_id,))


@pytest.fixture
def forms():
    made = []
    yield made
    with transaction() as cur:
        for form_id, table in made:
            for name in (tabular_name(table), table):
                cur.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(
                    sql.Identifier(name)))
            cur.execute(sql.SQL("DROP SEQUENCE IF EXISTS {}").format(
                sql.Identifier(f"{table[:43]}_survey_seq")))
            cur.execute("DELETE FROM form_version WHERE form_id = %s", (form_id,))
            cur.execute("DELETE FROM forms WHERE form_id = %s", (form_id,))


def _project(projects, name="Agriculture"):
    project = project_service.create_project(f"{name} {uuid.uuid4().hex[:6]}",
                                             created_by="tests")
    projects.append(project["project_id"])
    return project["project_id"]


def _form(forms, project_id=None, title="Survey"):
    definition = normalize_form({
        "title": f"{title} {uuid.uuid4().hex[:6]}",
        "table_name": f"survey_{uuid.uuid4().hex[:8]}",
        "fields": [{"name": "answer", "label": "Answer", "type": "text"}],
    })
    created = form_service.create_form(definition, created_by="tests")
    forms.append((created["form_id"], created["table"]["table_name"]))

    if project_id:
        project_service.set_form_project(created["form_id"], project_id)
    return created["form_id"]


def client_for(person):
    from fastapi.testclient import TestClient

    from app.main import app
    return TestClient(app, headers={"Authorization": f"Bearer {person['token']}"})


# --------------------------------------------------------------------------- #
# membership
# --------------------------------------------------------------------------- #
def test_a_user_can_belong_to_several_projects(people, projects):
    person = people("asha")
    agriculture, health = _project(projects, "Agriculture"), _project(projects, "Health")

    project_service.add_member(agriculture, person["user_id"], _role_id("project_manager"))
    project_service.add_member(health, person["user_id"], _role_id("surveyor"))

    assert set(access.projects_for(person)) == {agriculture, health}


def test_the_same_account_holds_different_roles_in_different_projects(people, projects):
    """The reason a role is not a property of the account."""
    person = people("asha")
    agriculture, health = _project(projects, "Agriculture"), _project(projects, "Health")

    project_service.add_member(agriculture, person["user_id"], _role_id("project_manager"))
    project_service.add_member(health, person["user_id"], _role_id("reviewer"))

    assert access.can(person, PROJECT_MEMBERS_MANAGE, agriculture) is True
    assert access.can(person, PROJECT_MEMBERS_MANAGE, health) is False
    assert access.can(person, SUBMISSIONS_REVIEW, health) is True


def test_a_duplicate_membership_is_refused(people, projects):
    person = people("asha")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("surveyor"))

    with pytest.raises(project_service.ProjectError):
        project_service.add_member(project, person["user_id"], _role_id("reviewer"))


def test_a_non_member_may_do_nothing_in_a_project(people, projects):
    person = people("stranger")
    project = _project(projects)

    assert access.permissions_in(person, project) == set()
    assert access.projects_for(person) == []


def test_a_suspended_membership_grants_nothing(people, projects):
    person = people("asha")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("project_manager"))

    members = project_service.list_members(project)
    project_service.update_member(project, members[0]["member_id"], {"status": "Suspended"})

    assert access.permissions_in(person, project) == set()


def test_the_role_a_member_holds_can_be_changed(people, projects):
    person = people("asha")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("surveyor"))

    assert access.can(person, SUBMISSIONS_REVIEW, project) is False

    member = project_service.list_members(project)[0]
    project_service.update_member(project, member["member_id"],
                                  {"role_id": _role_id("reviewer")})

    assert access.can(person, SUBMISSIONS_REVIEW, project) is True


# --------------------------------------------------------------------------- #
# project isolation
# --------------------------------------------------------------------------- #
def test_a_manager_of_one_project_cannot_reach_another(people, projects):
    person = people("manager")
    mine, theirs = _project(projects, "Mine"), _project(projects, "Theirs")
    project_service.add_member(mine, person["user_id"], _role_id("project_manager"))

    assert access.permissions_in(person, theirs) == set()

    api = client_for(person)
    assert api.get(f"/api/projects/{theirs}").status_code == 404
    assert api.get(f"/api/projects/{theirs}/members").status_code == 404
    assert api.get(f"/api/projects/{theirs}/forms").status_code == 404


def test_another_projects_form_is_not_readable(people, projects, forms):
    """An editor — somebody whose account may read forms at all — still cannot
    read one belonging to a project they are not in.

    The two checks are in that order on purpose: the account-wide permission
    answers 403 ("your role cannot do this"), and project isolation answers 404
    ("there is no such form"). Using an editor here means this is testing the
    second and not accidentally passing on the first.
    """
    person = people("manager", role="editor")
    mine, theirs = _project(projects, "Mine"), _project(projects, "Theirs")
    project_service.add_member(mine, person["user_id"], _role_id("project_manager"))

    hidden = _form(forms, theirs)

    assert access.may_see_form(person, hidden) is False
    assert client_for(person).get(f"/api/forms/{hidden}").status_code == 404


def test_another_projects_form_cannot_be_filled_in(people, projects, forms):
    """Direct API access, with no screen involved."""
    person = people("surveyor", role="editor")
    mine, theirs = _project(projects, "Mine"), _project(projects, "Theirs")
    project_service.add_member(mine, person["user_id"], _role_id("surveyor"))

    hidden = _form(forms, theirs)
    form_service.set_status(hidden, "Active")

    api = client_for(person)
    assert api.get(f"/api/forms/{hidden}/render").status_code == 404
    assert api.post(f"/api/forms/{hidden}/submissions",
                    json={"data": {"answer": "x"}}).status_code == 404


def test_a_missing_project_and_an_unreachable_one_read_the_same(people, projects):
    """A project somebody is not in should be indistinguishable from one that
    does not exist — answering 403 would confirm the id is real."""
    person = people("stranger")
    theirs = _project(projects, "Theirs")

    api = client_for(person)
    assert api.get(f"/api/projects/{theirs}").status_code == 404
    assert api.get("/api/projects/PRJ99999").status_code == 404


def test_a_form_outside_every_project_takes_the_system_permission(people, projects, forms):
    """A system form belongs to no project, so no membership opens it.

    Being in a project — as a manager, even — says nothing about the forms that
    are outside every project. That takes `forms.system.view`, held on the
    account.
    """
    loose = _form(forms, None)

    standard = people("asha")
    assert access.may_see_form(standard, loose) is False

    # An account that may use system forms still can, exactly as before.
    builder = people("builder", role="editor")
    assert access.may_see_form(builder, loose) is True


def test_a_project_role_does_not_open_a_system_form(people, projects, forms):
    """The reported bug, stated directly."""
    person = people("manager")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("project_manager"))

    loose = _form(forms, None)
    form_service.set_status(loose, "Active")

    assert access.may_see_form(person, loose) is False

    api = client_for(person)
    assert api.get(f"/api/forms/{loose}").status_code in (403, 404)
    assert api.get(f"/api/forms/{loose}/render").status_code in (403, 404)
    assert api.post(f"/api/forms/{loose}/submissions",
                    json={"data": {"answer": "x"}}).status_code in (403, 404)

    # And it is not in the list of forms they may fill in.
    fillable = api.get("/api/forms/live/list").json()
    assert loose not in [f["form_id"] for f in fillable]


# --------------------------------------------------------------------------- #
# form assignment
# --------------------------------------------------------------------------- #
def test_a_form_assigned_to_everyone_is_visible_to_every_member(people, projects, forms):
    person = people("surveyor")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("surveyor"))

    form_id = _form(forms, project)
    project_service.assign_form(form_id, "everyone")

    assert access.visible_form_ids(person, project) == [form_id]
    assert access.may_see_form(person, form_id) is True


def test_a_form_assigned_by_name_reaches_that_person_only(people, projects, forms):
    asha, ravi = people("asha"), people("ravi")
    project = _project(projects)
    for person in (asha, ravi):
        project_service.add_member(project, person["user_id"], _role_id("surveyor"))

    form_id = _form(forms, project)
    project_service.assign_form(form_id, "user", user_id=asha["user_id"])

    assert access.may_see_form(asha, form_id) is True
    assert access.may_see_form(ravi, form_id) is False


def test_a_form_assigned_to_a_group_reaches_its_members(people, projects, forms):
    asha, ravi = people("asha"), people("ravi")
    project = _project(projects)
    for person in (asha, ravi):
        project_service.add_member(project, person["user_id"], _role_id("surveyor"))

    group = project_service.create_group(project, "Field Team North")
    project_service.add_to_group(project, group["group_id"], asha["user_id"])

    form_id = _form(forms, project)
    project_service.assign_form(form_id, "group", group_id=group["group_id"])

    assert access.may_see_form(asha, form_id) is True
    assert access.may_see_form(ravi, form_id) is False


def test_an_unassigned_form_is_hidden_from_a_project_member(people, projects, forms):
    """A form nobody was given is not a form everybody gets."""
    person = people("surveyor")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("surveyor"))

    form_id = _form(forms, project)

    assert access.visible_form_ids(person, project) == []
    assert access.may_see_form(person, form_id) is False


def test_a_manager_sees_the_projects_forms_without_being_assigned(people, projects, forms):
    person = people("manager")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("project_manager"))

    form_id = _form(forms, project)

    assert access.visible_form_ids(person, project) is None
    assert access.may_see_form(person, form_id) is True


def test_a_form_cannot_be_given_to_somebody_outside_its_project(people, projects, forms):
    outsider = people("outsider")
    project = _project(projects)
    form_id = _form(forms, project)

    with pytest.raises(project_service.ProjectError):
        project_service.assign_form(form_id, "user", user_id=outsider["user_id"])


def test_assigning_the_same_person_twice_makes_one_assignment(people, projects, forms):
    person = people("asha")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("surveyor"))
    form_id = _form(forms, project)

    project_service.assign_form(form_id, "user", user_id=person["user_id"])
    project_service.assign_form(form_id, "user", user_id=person["user_id"])

    assert len(project_service.list_assignments(form_id)) == 1


def test_an_assignment_can_be_taken_back(people, projects, forms):
    person = people("asha")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("surveyor"))
    form_id = _form(forms, project)

    made = project_service.assign_form(form_id, "user", user_id=person["user_id"])
    assert access.may_see_form(person, form_id) is True

    project_service.unassign_form(form_id, made["assignment_id"])
    assert access.may_see_form(person, form_id) is False


# --------------------------------------------------------------------------- #
# groups
# --------------------------------------------------------------------------- #
def test_a_group_belongs_to_one_project(projects):
    agriculture, health = _project(projects, "Agriculture"), _project(projects, "Health")
    project_service.create_group(agriculture, "Field Team North")

    assert [g["name"] for g in project_service.list_groups(agriculture)] == \
        ["Field Team North"]
    assert project_service.list_groups(health) == []


def test_only_project_members_can_join_a_group(people, projects):
    outsider = people("outsider")
    project = _project(projects)
    group = project_service.create_group(project, "Field Team North")

    with pytest.raises(project_service.ProjectError):
        project_service.add_to_group(project, group["group_id"], outsider["user_id"])


def test_a_duplicate_group_membership_is_one_membership(people, projects):
    person = people("asha")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("surveyor"))
    group = project_service.create_group(project, "Field Team North")

    project_service.add_to_group(project, group["group_id"], person["user_id"])
    project_service.add_to_group(project, group["group_id"], person["user_id"])

    assert len(project_service.group_members(project, group["group_id"])) == 1


def test_two_projects_may_have_a_group_of_the_same_name(projects):
    agriculture, health = _project(projects, "Agriculture"), _project(projects, "Health")

    project_service.create_group(agriculture, "Enumerators")
    project_service.create_group(health, "Enumerators")   # not a clash


def test_one_project_may_not(projects):
    project = _project(projects)
    project_service.create_group(project, "Enumerators")

    with pytest.raises(project_service.ProjectError):
        project_service.create_group(project, "enumerators")


# --------------------------------------------------------------------------- #
# the submission workflow
# --------------------------------------------------------------------------- #
def _submitted(forms, projects, people):
    """A project, a surveyor, a reviewer, and one submitted response."""
    from app.modules.forms import submission_service

    surveyor, reviewer = people("surveyor"), people("reviewer")
    project = _project(projects)
    project_service.add_member(project, surveyor["user_id"], _role_id("surveyor"))
    project_service.add_member(project, reviewer["user_id"], _role_id("reviewer"))

    form_id = _form(forms, project)
    project_service.assign_form(form_id, "everyone")
    form_service.set_status(form_id, "Active")

    form = form_service.get_form(form_id)
    result = submission_service.submit(
        form, {"answer": "x"}, created_by=auth_service.display_name(surveyor))

    return {"project": project, "form_id": form_id, "survey_id": result["survey_id"],
            "surveyor": surveyor, "reviewer": reviewer}


def test_a_submission_starts_as_submitted(people, projects, forms):
    made = _submitted(forms, projects, people)

    state = submission_workflow.status_of(made["form_id"], made["survey_id"])
    assert state["status"] == submission_workflow.SUBMITTED
    assert state["submitted_by"] == auth_service.display_name(made["surveyor"])


def test_a_reviewer_approves(people, projects, forms):
    made = _submitted(forms, projects, people)
    api = client_for(made["reviewer"])

    response = api.post(f"/api/submissions/{made['form_id']}/{made['survey_id']}/approve")

    assert response.status_code == 200
    assert response.json()["status"] == "approved"
    assert response.json()["reviewed_by"] == auth_service.display_name(made["reviewer"])


def test_a_reviewer_rejects_with_a_reason(people, projects, forms):
    made = _submitted(forms, projects, people)
    api = client_for(made["reviewer"])

    response = api.post(f"/api/submissions/{made['form_id']}/{made['survey_id']}/reject",
                        json={"reason": "The plot number does not match the register."})

    assert response.status_code == 200
    assert response.json()["status"] == "rejected"
    assert "plot number" in response.json()["rejection_reason"]


def test_a_rejection_has_to_say_why(people, projects, forms):
    made = _submitted(forms, projects, people)
    api = client_for(made["reviewer"])

    response = api.post(f"/api/submissions/{made['form_id']}/{made['survey_id']}/reject",
                        json={"reason": "   "})

    assert response.status_code == 409


def test_a_surveyor_cannot_approve_their_own_work(people, projects, forms):
    """The obvious attack, and the reason status is never a field a caller sets."""
    made = _submitted(forms, projects, people)
    api = client_for(made["surveyor"])

    response = api.post(f"/api/submissions/{made['form_id']}/{made['survey_id']}/approve")

    assert response.status_code == 409
    assert submission_workflow.status_of(
        made["form_id"], made["survey_id"])["status"] == "submitted"


def test_there_is_no_endpoint_that_sets_a_status(people, projects, forms):
    made = _submitted(forms, projects, people)
    api = client_for(made["surveyor"])

    for path in (f"/api/submissions/{made['form_id']}/{made['survey_id']}",
                 f"/api/submissions/{made['form_id']}/{made['survey_id']}/status"):
        assert api.patch(path, json={"status": "approved"}).status_code in (404, 405)


def test_an_approved_submission_cannot_be_approved_again(people, projects, forms):
    made = _submitted(forms, projects, people)
    api = client_for(made["reviewer"])

    api.post(f"/api/submissions/{made['form_id']}/{made['survey_id']}/approve")
    again = api.post(f"/api/submissions/{made['form_id']}/{made['survey_id']}/approve")

    assert again.status_code == 409


def test_a_rejected_submission_can_be_sent_back(people, projects, forms):
    """The loop that makes rejection useful: fix it, submit it again."""
    made = _submitted(forms, projects, people)

    client_for(made["reviewer"]).post(
        f"/api/submissions/{made['form_id']}/{made['survey_id']}/reject",
        json={"reason": "Needs the plot number."})

    again = client_for(made["surveyor"]).post(
        f"/api/submissions/{made['form_id']}/{made['survey_id']}/submit")

    assert again.status_code == 200
    assert again.json()["status"] == "submitted"
    assert again.json()["rejection_reason"] == "", "a stale reason was left behind"


def test_review_can_be_started_before_a_decision(people, projects, forms):
    made = _submitted(forms, projects, people)
    api = client_for(made["reviewer"])

    started = api.post(f"/api/submissions/{made['form_id']}/{made['survey_id']}/start-review")
    assert started.json()["status"] == "under_review"

    approved = api.post(f"/api/submissions/{made['form_id']}/{made['survey_id']}/approve")
    assert approved.json()["status"] == "approved"


def test_a_reviewer_from_another_project_cannot_reach_it(people, projects, forms):
    made = _submitted(forms, projects, people)

    outsider = people("outsider")
    elsewhere = _project(projects, "Elsewhere")
    project_service.add_member(elsewhere, outsider["user_id"], _role_id("reviewer"))

    api = client_for(outsider)
    assert api.get(f"/api/submissions/{made['form_id']}/{made['survey_id']}").status_code == 404
    assert api.post(
        f"/api/submissions/{made['form_id']}/{made['survey_id']}/approve").status_code == 404


def test_a_surveyor_sees_their_own_submission_and_not_a_colleagues(people, projects, forms):
    made = _submitted(forms, projects, people)

    colleague = people("colleague")
    project_service.add_member(made["project"], colleague["user_id"], _role_id("surveyor"))

    assert client_for(made["surveyor"]).get(
        f"/api/submissions/{made['form_id']}/{made['survey_id']}").status_code == 200
    assert client_for(colleague).get(
        f"/api/submissions/{made['form_id']}/{made['survey_id']}").status_code == 404


def test_the_review_queue_is_the_projects_own(people, projects, forms):
    made = _submitted(forms, projects, people)

    queue = client_for(made["reviewer"]).get(
        f"/api/projects/{made['project']}/submissions").json()

    assert queue["everything"] is True
    assert [s["survey_id"] for s in queue["submissions"]] == [made["survey_id"]]
    assert queue["submissions"][0]["status"] == "submitted"


def test_a_surveyors_queue_holds_only_their_own(people, projects, forms):
    made = _submitted(forms, projects, people)

    queue = client_for(made["surveyor"]).get(
        f"/api/projects/{made['project']}/submissions").json()

    assert queue["everything"] is False
    assert [s["survey_id"] for s in queue["submissions"]] == [made["survey_id"]]


@pytest.mark.parametrize("action,frm", [
    ("approve", submission_workflow.APPROVED),
    ("start_review", submission_workflow.APPROVED),
    ("submit", submission_workflow.APPROVED),
])
def test_the_transitions_are_a_table_not_a_suggestion(action, frm):
    """Every move is checked against where the submission actually is."""
    move = submission_workflow.TRANSITIONS[action]
    assert frm not in move["from"]


# --------------------------------------------------------------------------- #
# authorization is central
# --------------------------------------------------------------------------- #
def test_no_route_decides_by_role_name():
    """Roles are data. A route that tested a name would stop being true the
    moment somebody renamed a role or made one of their own."""
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[3] / "app"
    offenders = []

    for path in root.rglob("routers/*.py"):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r'role\s*==\s*["\']|["\']manager["\']\s*==|role\s+in\s+\(["\']', line):
                offenders.append(f"{path.name}:{number}: {line.strip()}")

    assert not offenders, "a route decided by role name:\n" + "\n".join(offenders)


def test_every_project_permission_is_reachable_through_a_role():
    """A permission nothing grants would be a permission nothing can do."""
    from app.modules.projects.permissions import CATALOGUE, PROJECT_ROLES

    granted = {p for spec in PROJECT_ROLES.values() for p in spec["permissions"]}
    system_wide = {"projects.view_all", "projects.manage"}

    for permission in CATALOGUE:
        assert permission.key in granted or permission.key in system_wide, \
            f"{permission.key} is held by no role"


def test_an_administrator_can_reach_a_project_without_joining_it(people, projects):
    """The one deliberate bypass, and it is a permission like any other."""
    admin = people("admin")
    with transaction() as cur:
        cur.execute("UPDATE app_user SET role_id = (SELECT role_id FROM app_role "
                    "WHERE name = 'admin') WHERE user_id = %s", (admin["user_id"],))

    project = _project(projects)
    fresh = auth_service.resolve_session(admin["token"])

    assert access.can(fresh, SUBMISSIONS_VIEW_ALL, project) is True
    assert project in access.projects_for(fresh)


# --------------------------------------------------------------------------- #
# creating a form inside a project
# --------------------------------------------------------------------------- #
def _definition(title="Farmer Survey"):
    return {
        "title": f"{title} {uuid.uuid4().hex[:6]}",
        "table_name": f"survey_{uuid.uuid4().hex[:8]}",
        "fields": [{"name": "answer", "label": "Answer", "type": "text"}],
    }


def _created(response, forms):
    """Register whatever a create call made, so the fixture can clean it up."""
    if response.status_code == 201:
        body = response.json()
        forms.append((body["form_id"], body["table"]["table_name"]))
    return response


def test_a_project_manager_creates_a_form_in_their_project(people, projects, forms):
    person = people("manager", role="editor")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("project_manager"))

    response = _created(client_for(person).post(
        "/api/forms", json={"form_json": _definition(), "project_id": project}), forms)

    assert response.status_code == 201
    assert response.json()["project_id"] == project
    assert project_service.project_of_form(response.json()["form_id"]) == project


def test_a_surveyor_cannot_build_a_form_even_in_their_own_project(people, projects, forms):
    """Being in a project is not the same as being allowed to build in it —
    a surveyor's project role does not carry `project.forms.manage`."""
    person = people("surveyor", role="editor")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("surveyor"))

    response = _created(client_for(person).post(
        "/api/forms", json={"form_json": _definition(), "project_id": project}), forms)

    assert response.status_code == 403


def test_a_non_member_cannot_build_in_a_project(people, projects, forms):
    """The obvious way in: send somebody else's project_id."""
    person = people("outsider", role="editor")
    theirs = _project(projects, "Theirs")

    response = _created(client_for(person).post(
        "/api/forms", json={"form_json": _definition(), "project_id": theirs}), forms)

    assert response.status_code == 404, "a project id was accepted from a non-member"


def test_membership_of_one_project_does_not_reach_another(people, projects, forms):
    person = people("manager", role="editor")
    mine, theirs = _project(projects, "Mine"), _project(projects, "Theirs")
    project_service.add_member(mine, person["user_id"], _role_id("project_manager"))

    response = _created(client_for(person).post(
        "/api/forms", json={"form_json": _definition(), "project_id": theirs}), forms)

    assert response.status_code == 404


def test_a_project_that_does_not_exist_reads_the_same_as_one_you_cannot_reach(
        people, projects, forms):
    person = people("manager", role="editor")

    response = _created(client_for(person).post(
        "/api/forms", json={"form_json": _definition(), "project_id": "PRJ99999"}), forms)

    assert response.status_code == 404


def test_a_form_created_with_no_project_still_works(people, forms):
    """Every form built before projects existed, and every system-level form
    built now. Unchanged."""
    person = people("builder", role="editor")

    response = _created(client_for(person).post(
        "/api/forms", json={"form_json": _definition()}), forms)

    assert response.status_code == 201
    assert project_service.project_of_form(response.json()["form_id"]) is None


def test_a_form_created_in_a_project_is_isolated_from_the_start(people, projects, forms):
    """It is in the project the moment it exists — not once somebody remembers
    to move it."""
    manager = people("manager", role="editor")
    outsider = people("outsider", role="editor")
    project = _project(projects)
    project_service.add_member(project, manager["user_id"], _role_id("project_manager"))

    made = _created(client_for(manager).post(
        "/api/forms", json={"form_json": _definition(), "project_id": project}), forms)
    form_id = made.json()["form_id"]

    assert client_for(outsider).get(f"/api/forms/{form_id}").status_code == 404
    assert client_for(manager).get(f"/api/forms/{form_id}").status_code == 200


def test_a_form_created_in_a_project_appears_in_its_form_list(people, projects, forms):
    person = people("manager", role="editor")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("project_manager"))

    api = client_for(person)
    made = _created(api.post("/api/forms",
                             json={"form_json": _definition(), "project_id": project}), forms)

    listed = api.get(f"/api/projects/{project}/forms").json()

    assert [f["form_id"] for f in listed["forms"]] == [made.json()["form_id"]]


def test_a_project_role_is_enough_to_build_inside_that_project(people, projects, forms):
    """The point of the split. A Standard User account holds no form permission
    at all; being Project Manager *in this project* is what lets them build
    here — and it lets them build nowhere else."""
    person = people("standard")       # no forms.create on the account
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("project_manager"))

    made = _created(client_for(person).post(
        "/api/forms", json={"form_json": _definition(), "project_id": project}), forms)

    assert made.status_code == 201
    assert made.json()["project_id"] == project

    # And nowhere else: no project named means the account permission, which
    # this account does not have.
    outside = _created(client_for(person).post(
        "/api/forms", json={"form_json": _definition()}), forms)
    assert outside.status_code == 403


# --------------------------------------------------------------------------- #
# forms that belong to no project
# --------------------------------------------------------------------------- #
def test_a_project_less_form_still_needs_the_account_permission(people, forms):
    """`project_id = NULL` means "no project restriction", never "anybody".

    The account-wide permission is a dependency and runs first; the project
    guard runs inside the handler and only decides whether a *project's* rules
    also apply. A form outside every project is therefore exactly as reachable
    as it was before projects existed — and no more.
    """
    loose = _form(forms, None)

    # An account that may use system forms: allowed, as it always was.
    editor = people("editor", role="editor")
    assert client_for(editor).get(f"/api/forms/{loose}").status_code == 200

    # An account that may not: refused.
    field = people("field")
    assert client_for(field).get(f"/api/forms/{loose}").status_code == 403


def test_a_project_less_form_is_not_offered_through_any_project(people, projects, forms):
    """It belongs to no project, so it is in no project's list — including the
    list of somebody who may see every form in theirs."""
    person = people("manager", role="editor")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("project_manager"))

    loose = _form(forms, None)

    listed = client_for(person).get(f"/api/projects/{project}/forms").json()
    assert loose not in [f["form_id"] for f in listed["forms"]]


def test_a_project_less_form_cannot_be_assigned(people, forms):
    """Assignment is a project idea. There is nobody to assign it to."""
    person = people("editor", role="editor")
    loose = _form(forms, None)

    response = client_for(person).post(f"/api/forms/{loose}/assignments",
                                       json={"kind": "everyone"})
    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# the two endpoints the project screens need
# --------------------------------------------------------------------------- #
def test_the_project_roles_are_derived_not_listed(people):
    """A role qualifies by holding a project permission, so an installation that
    invents one gets it without a code change."""
    person = people("asha")

    roles = client_for(person).get("/api/projects/roles").json()["roles"]
    named = {r["name"] for r in roles}

    assert {"project_manager", "surveyor", "reviewer"} <= named
    # Account-wide roles hold no project permission, so they are not offered.
    assert "field" not in named
    assert all(r["permissions"] for r in roles)


def test_candidates_are_accounts_not_already_in_the_project(people, projects):
    manager, joiner = people("manager"), people("joiner")
    project = _project(projects)
    project_service.add_member(project, manager["user_id"], _role_id("project_manager"))

    found = client_for(manager).get(f"/api/projects/{project}/candidates").json()["candidates"]
    ids = {c["user_id"] for c in found}

    assert joiner["user_id"] in ids
    assert manager["user_id"] not in ids, "somebody already in the project was offered"


def test_candidates_needs_the_member_permission(people, projects):
    person = people("surveyor")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("surveyor"))

    assert client_for(person).get(
        f"/api/projects/{project}/candidates").status_code == 403


def test_candidates_of_another_project_are_not_reachable(people, projects):
    person = people("manager")
    mine, theirs = _project(projects, "Mine"), _project(projects, "Theirs")
    project_service.add_member(mine, person["user_id"], _role_id("project_manager"))

    assert client_for(person).get(
        f"/api/projects/{theirs}/candidates").status_code == 404


# --------------------------------------------------------------------------- #
# the two contexts, from the backend's side
# --------------------------------------------------------------------------- #
def test_the_system_context_lists_only_project_less_forms(people, projects, forms):
    """`?project=none` is what the System forms screen asks for. The narrowing
    is the backend's, so a project's forms and the system's are never one list
    that somebody has to filter."""
    person = people("builder", role="editor")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("project_manager"))

    loose = _form(forms, None)
    inside = _form(forms, project)

    listed = client_for(person).get("/api/forms?project=none&limit=500").json()
    ids = {f["form_id"] for f in listed}

    assert loose in ids
    assert inside not in ids, "a project's form appeared among the system forms"


def test_the_unnarrowed_list_is_unchanged(people, projects, forms):
    """Without the filter the endpoint answers exactly as it always did."""
    person = people("builder", role="editor")
    project = _project(projects)
    project_service.add_member(project, person["user_id"], _role_id("project_manager"))

    loose = _form(forms, None)
    inside = _form(forms, project)

    ids = {f["form_id"] for f in client_for(person).get("/api/forms?limit=500").json()}

    assert loose in ids and inside in ids


def test_one_projects_forms_can_be_asked_for_by_id(people, projects, forms):
    person = people("builder", role="editor")
    mine, theirs = _project(projects, "Mine"), _project(projects, "Theirs")
    project_service.add_member(mine, person["user_id"], _role_id("project_manager"))

    ours = _form(forms, mine)
    hidden = _form(forms, theirs)

    ids = {f["form_id"] for f in
           client_for(person).get(f"/api/forms?project={mine}&limit=500").json()}

    assert ours in ids
    assert hidden not in ids


# --------------------------------------------------------------------------- #
# editing a project form somebody else made
# --------------------------------------------------------------------------- #
def _draft_in(project, forms, made_by="An administrator"):
    """A Draft form inside a project, created by somebody else."""
    definition = normalize_form({
        "title": f"Farmer Survey {uuid.uuid4().hex[:6]}",
        "table_name": f"survey_{uuid.uuid4().hex[:8]}",
        "fields": [{"name": "answer", "label": "Answer", "type": "text"}],
    })
    created = form_service.create_form(definition, created_by=made_by, status="Draft")
    forms.append((created["form_id"], created["table"]["table_name"]))
    project_service.set_form_project(created["form_id"], project)
    return created["form_id"]


def _manager_of(people, projects, name="Mexico-Maize"):
    """Prashant: Standard User on the account, Project Manager in one project."""
    person = people("prashant", role="standard")
    project = _project(projects, name)
    project_service.add_member(project, person["user_id"], _role_id("project_manager"))
    return person, project


def test_a_project_manager_opens_a_form_an_administrator_made(people, projects, forms):
    """A project form belongs to its project, not to whoever created it.

    `created_by` is never consulted — the question is what this account may do
    in *this project*.
    """
    person, project = _manager_of(people, projects)
    draft = _draft_in(project, forms)

    opened = client_for(person).get(f"/api/forms/{draft}")

    assert opened.status_code == 200
    assert opened.json()["created_by"] == "An administrator"
    assert opened.json()["form_json"]["fields"][0]["name"] == "answer"


def test_a_project_manager_saves_edits_to_it(people, projects, forms):
    person, project = _manager_of(people, projects)
    draft = _draft_in(project, forms)
    api = client_for(person)

    definition = api.get(f"/api/forms/{draft}").json()["form_json"]
    definition["fields"].append({"name": "village", "label": "Village", "type": "text"})

    saved = api.put(f"/api/forms/{draft}", json={"form_json": definition})

    assert saved.status_code == 200
    reopened = api.get(f"/api/forms/{draft}").json()["form_json"]
    assert [f["name"] for f in reopened["fields"]] == ["answer", "village"]


def test_a_project_manager_reads_the_things_the_builder_needs(people, projects, forms):
    """Everything the builder asks for while it is open."""
    person, project = _manager_of(people, projects)
    draft = _draft_in(project, forms)
    api = client_for(person)

    assert api.get(f"/api/forms/{draft}/versions").status_code == 200
    assert api.get("/api/forms/languages").status_code == 200
    assert api.post("/api/forms/validate", json={
        "form_json": {"title": "T", "fields": [{"name": "a", "label": "A", "type": "text"}]},
    }).status_code == 200


def test_a_project_manager_publishes_it(people, projects, forms):
    person, project = _manager_of(people, projects)
    draft = _draft_in(project, forms)

    published = client_for(person).patch(f"/api/forms/{draft}/status",
                                         json={"form_status": "Active"})

    assert published.status_code == 200


def test_the_builder_is_reachable_by_somebody_with_no_account_form_permission(
        people, projects, forms):
    """The bug behind the report: the builder was gated on an account
    permission, so a Project Manager was turned away and sent home — and home
    for them is the fill page."""
    person, project = _manager_of(people, projects)
    _draft_in(project, forms)

    me = client_for(person).get("/api/auth/me").json()

    assert me["can"]["build_forms"] is False, "this account holds no system form permission"
    assert me["can"]["build_any_forms"] is True, "yet the builder must open for them"


def test_a_project_manager_cannot_edit_another_projects_form(people, projects, forms):
    person, mine = _manager_of(people, projects, "Mine")
    theirs = _project(projects, "Theirs")
    elsewhere = _draft_in(theirs, forms)

    api = client_for(person)
    definition = {"title": "X", "fields": [{"name": "a", "label": "A", "type": "text"}]}

    assert api.get(f"/api/forms/{elsewhere}").status_code == 404
    assert api.put(f"/api/forms/{elsewhere}", json={"form_json": definition}).status_code == 404
    assert api.patch(f"/api/forms/{elsewhere}/status",
                     json={"form_status": "Active"}).status_code == 404


def test_a_project_manager_cannot_edit_a_system_form(people, projects, forms):
    """A project permission never reaches a form outside every project."""
    person, project = _manager_of(people, projects)
    loose = _form(forms, None)

    api = client_for(person)
    definition = {"title": "X", "fields": [{"name": "a", "label": "A", "type": "text"}]}

    assert api.get(f"/api/forms/{loose}").status_code == 403
    assert api.put(f"/api/forms/{loose}", json={"form_json": definition}).status_code == 403
    assert api.patch(f"/api/forms/{loose}/status",
                     json={"form_status": "Active"}).status_code == 403


def test_an_account_form_permission_does_not_reach_into_a_project(people, projects, forms):
    """The mirror of the rule above, in the other direction."""
    builder = people("builder", role="editor")     # holds forms.edit on the account
    project = _project(projects, "Theirs")
    inside = _draft_in(project, forms)

    api = client_for(builder)
    definition = {"title": "X", "fields": [{"name": "a", "label": "A", "type": "text"}]}

    assert api.put(f"/api/forms/{inside}", json={"form_json": definition}).status_code == 404


def test_a_draft_is_manageable_but_not_fillable(people, projects, forms):
    person, project = _manager_of(people, projects)
    draft = _draft_in(project, forms)
    project_service.assign_form(draft, "everyone")
    api = client_for(person)

    # It is in the project's forms, to be managed.
    listed = api.get(f"/api/projects/{project}/forms").json()["forms"]
    assert draft in [f["form_id"] for f in listed]

    # It is not among the forms to fill in, and cannot be answered.
    fillable = api.get("/api/forms/live/list").json()
    assert draft not in [f["form_id"] for f in fillable]
    assert api.post(f"/api/forms/{draft}/submissions",
                    json={"data": {"answer": "x"}}).status_code == 422


def test_a_published_assigned_form_is_fillable(people, projects, forms):
    """The other half: once it is live and assigned, it appears."""
    person, project = _manager_of(people, projects)
    draft = _draft_in(project, forms)
    project_service.assign_form(draft, "everyone")
    form_service.set_status(draft, "Active")

    fillable = client_for(person).get("/api/forms/live/list").json()

    assert draft in [f["form_id"] for f in fillable]


def test_a_project_manager_manages_assignments_on_it(people, projects, forms):
    person, project = _manager_of(people, projects)
    draft = _draft_in(project, forms)
    api = client_for(person)

    assert api.post(f"/api/forms/{draft}/assignments",
                    json={"kind": "everyone"}).status_code == 201
    assert len(api.get(f"/api/forms/{draft}/assignments").json()["assignments"]) == 1


# --------------------------------------------------------------------------- #
# filling is not seeing: the surveyor / reviewer workflow
#
# The bug these were written for: a Reviewer could see and fill in a form nobody
# had given them, while the Surveyor the form was for saw "nothing to fill in".
# The reviewer's role carries `project.forms.view_all`, because reviewing the
# project's work means reading its forms — and the fillable list was built from
# what could be *seen*. `project.forms.fill` existed and was never checked.
# --------------------------------------------------------------------------- #
def _wellness(people, projects, forms, assign="user"):
    """Mexico-Maize: Piyush reviews, Shrishti fills, one published form.

    The reported scenario, as close to it as a test can be. `assign` chooses how
    the form is given out, because who may fill it has to come out the same
    whichever way that is.
    """
    project = _project(projects, "Mexico-Maize")
    piyush = people("Piyush")
    shrishti = people("Shrishti")

    project_service.add_member(project, piyush["user_id"], _role_id("reviewer"))
    project_service.add_member(project, shrishti["user_id"], _role_id("surveyor"))

    form_id = _form(forms, project, title="Womens Wellness")
    form_service.set_status(form_id, "Active")

    if assign == "user":
        project_service.assign_form(form_id, "user", user_id=shrishti["user_id"])
    elif assign == "everyone":
        project_service.assign_form(form_id, "everyone")
    elif assign == "group":
        group = project_service.create_group(project, "Field Team North")
        project_service.add_to_group(project, group["group_id"], shrishti["user_id"])
        project_service.assign_form(form_id, "group", group_id=group["group_id"])

    return {"project": project, "form_id": form_id,
            "piyush": piyush, "shrishti": shrishti}


def _fillable_ids(person):
    return [f["form_id"] for f in client_for(person).get("/api/forms/live/list").json()]


def test_a_directly_assigned_surveyor_can_see_and_submit_the_form(people, projects, forms):
    made = _wellness(people, projects, forms)
    api = client_for(made["shrishti"])

    assert made["form_id"] in _fillable_ids(made["shrishti"])
    assert api.get(f"/api/forms/{made['form_id']}/render").status_code == 200
    assert api.post(f"/api/forms/{made['form_id']}/submissions",
                    json={"data": {"answer": "x"}}).status_code == 201


def test_an_unassigned_surveyor_can_neither_see_nor_submit(people, projects, forms):
    made = _wellness(people, projects, forms, assign=None)
    api = client_for(made["shrishti"])

    assert _fillable_ids(made["shrishti"]) == []
    # 404, not 403: a form that is not theirs to answer reads as one that is
    # not there.
    assert api.get(f"/api/forms/{made['form_id']}/render").status_code == 404
    assert api.post(f"/api/forms/{made['form_id']}/submissions",
                    json={"data": {"answer": "x"}}).status_code == 404


def test_a_surveyor_in_an_assigned_group_can_see_and_submit(people, projects, forms):
    made = _wellness(people, projects, forms, assign="group")
    api = client_for(made["shrishti"])

    assert made["form_id"] in _fillable_ids(made["shrishti"])
    assert api.post(f"/api/forms/{made['form_id']}/submissions",
                    json={"data": {"answer": "x"}}).status_code == 201


def test_an_everyone_assignment_reaches_every_member_who_may_fill(people, projects, forms):
    """`everyone` keeps meaning everyone in the project — for filling, everyone
    whose role there is one that fills."""
    made = _wellness(people, projects, forms, assign="everyone")

    assert made["form_id"] in _fillable_ids(made["shrishti"])
    # Still visible to the reviewer, who reads the project's forms...
    assert access.may_see_form(made["piyush"], made["form_id"]) is True
    # ...and still not theirs to answer.
    assert access.may_fill_form(made["piyush"], made["form_id"]) is False
    assert made["form_id"] not in _fillable_ids(made["piyush"])


def test_a_reviewer_does_not_get_fill_access_from_reviewing(people, projects, forms):
    """The exact reported regression.

    Piyush reviews in Mexico-Maize and was given nothing to fill. Shrishti was
    given the form. Before the fix the list came out the other way round.
    """
    made = _wellness(people, projects, forms)
    piyush, shrishti = made["piyush"], made["shrishti"]

    assert _fillable_ids(piyush) == []
    assert _fillable_ids(shrishti) == [made["form_id"]]

    api = client_for(piyush)
    assert api.get(f"/api/forms/{made['form_id']}/render").status_code == 404
    assert api.post(f"/api/forms/{made['form_id']}/submissions",
                    json={"data": {"answer": "x"}}).status_code == 404

    # Reviewing is untouched: the form itself is still readable to them.
    assert access.may_see_form(piyush, made["form_id"]) is True


def test_a_reviewer_reviews_what_the_surveyor_submitted(people, projects, forms):
    """The other half of the workflow, from the same fixture."""
    made = _wellness(people, projects, forms)
    surveyor, reviewer = client_for(made["shrishti"]), client_for(made["piyush"])

    survey_id = surveyor.post(f"/api/forms/{made['form_id']}/submissions",
                              json={"data": {"answer": "x"}}).json()["survey_id"]

    queue = reviewer.get(f"/api/projects/{made['project']}/submissions").json()
    assert survey_id in [row["survey_id"] for row in queue["submissions"]]

    assert reviewer.post(
        f"/api/submissions/{made['form_id']}/{survey_id}/start-review"
    ).json()["status"] == submission_workflow.UNDER_REVIEW
    assert reviewer.post(
        f"/api/submissions/{made['form_id']}/{survey_id}/approve"
    ).json()["status"] == submission_workflow.APPROVED


def test_a_surveyor_cannot_start_review_approve_or_reject(people, projects, forms):
    made = _wellness(people, projects, forms)
    surveyor = client_for(made["shrishti"])

    survey_id = surveyor.post(f"/api/forms/{made['form_id']}/submissions",
                              json={"data": {"answer": "x"}}).json()["survey_id"]

    for action, body in (("start-review", None), ("approve", None),
                         ("reject", {"reason": "not good enough"})):
        answer = surveyor.post(
            f"/api/submissions/{made['form_id']}/{survey_id}/{action}", json=body)
        assert answer.status_code == 409, action

    # And it did not move.
    assert submission_workflow.status_of(
        made["form_id"], survey_id)["status"] == submission_workflow.SUBMITTED


def test_a_rejected_submission_can_be_filled_in_again(people, projects, forms):
    """The end of the loop: rejected goes back to the surveyor, who resubmits."""
    made = _wellness(people, projects, forms)
    surveyor, reviewer = client_for(made["shrishti"]), client_for(made["piyush"])

    survey_id = surveyor.post(f"/api/forms/{made['form_id']}/submissions",
                              json={"data": {"answer": "x"}}).json()["survey_id"]

    rejected = reviewer.post(f"/api/submissions/{made['form_id']}/{survey_id}/reject",
                             json={"reason": "the date is wrong"}).json()
    assert rejected["status"] == submission_workflow.REJECTED

    again = surveyor.post(f"/api/submissions/{made['form_id']}/{survey_id}/submit")
    assert again.json()["status"] == submission_workflow.SUBMITTED
    # The form is still theirs to fill, so a corrected answer can be sent too.
    assert surveyor.post(f"/api/forms/{made['form_id']}/submissions",
                         json={"data": {"answer": "y"}}).status_code == 201


def test_a_draft_or_paused_form_is_not_in_the_fillable_list(people, projects, forms):
    made = _wellness(people, projects, forms)

    for status in ("Draft", "Inactive"):
        form_service.set_status(made["form_id"], status)
        assert _fillable_ids(made["shrishti"]) == [], status
        # Assigned, so still reachable — it is the status that stops it, and the
        # answer says so rather than pretending the form is gone.
        assert client_for(made["shrishti"]).get(
            f"/api/forms/{made['form_id']}/render").status_code == 403, status


def test_a_surveyor_cannot_reach_another_projects_form(people, projects, forms):
    made = _wellness(people, projects, forms)

    elsewhere = _project(projects, "Kenya-Beans")
    theirs = _form(forms, elsewhere, title="Soil Survey")
    form_service.set_status(theirs, "Active")
    project_service.assign_form(theirs, "everyone")

    api = client_for(made["shrishti"])
    assert theirs not in _fillable_ids(made["shrishti"])
    assert api.get(f"/api/forms/{theirs}/render").status_code == 404
    assert api.post(f"/api/forms/{theirs}/submissions",
                    json={"data": {"answer": "x"}}).status_code == 404
    # And the project itself is not there as far as they are concerned.
    assert api.get(f"/api/forms/live/list?project={elsewhere}").status_code == 404


def test_the_fillable_list_can_be_asked_for_one_context(people, projects, forms):
    """The sidebar asks about the context it is in; the backend still narrows."""
    made = _wellness(people, projects, forms)
    api = client_for(made["shrishti"])

    scoped = api.get(f"/api/forms/live/list?project={made['project']}").json()
    assert [f["form_id"] for f in scoped] == [made["form_id"]]

    # The system context is the forms belonging to no project, and a project
    # role is no way into it.
    loose = _form(forms, None, title="Legacy")
    form_service.set_status(loose, "Active")
    assert api.get("/api/forms/live/list?project=none").json() == []


def test_a_manager_fills_their_own_projects_forms(people, projects, forms):
    """Unchanged: a manager holds both permissions, so an unassigned form in
    their own project is still theirs to fill."""
    made = _wellness(people, projects, forms, assign=None)
    manager = people("manager")
    project_service.add_member(made["project"], manager["user_id"],
                               _role_id("project_manager"))

    assert access.may_fill_form(manager, made["form_id"]) is True
    assert made["form_id"] in _fillable_ids(manager)
