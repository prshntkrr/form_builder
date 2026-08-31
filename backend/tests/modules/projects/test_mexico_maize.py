"""The Mexico-Maize scenario, end to end.

One project, one published form, and three people who must each get a different
answer from the same endpoints:

    Administrator   a System Administrator, reaching in from outside
    Shrishti        Standard User, Surveyor in Mexico-Maize
    Piyush          Standard User, Reviewer in Mexico-Maize

The three concepts these are protecting are separate, and each has its own
helper in `projects/access.py`:

    visible_form_ids     what may be SEEN      — a reviewer sees every form
    fillable_form_ids    what may be FILLED    — and fills none of them
    submission_scope     whose answers may be READ, and whether they may be judged

Fixtures are local to this file rather than shared with test_projects.py: they
are a dozen lines of scaffolding, and a scenario test that reads top to bottom
is worth more here than the reuse.
"""
import uuid

import pytest
from psycopg2 import sql

from app.core import auth_service
from app.core.database import ping, transaction
from app.modules.forms import form_service
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.tabular_service import tabular_name
from app.modules.projects import access, project_service
from app.modules.projects.permissions import FORMS_FILL, SUBMISSIONS_REVIEW

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"


def _role_id(name: str) -> str:
    with transaction() as cur:
        cur.execute("SELECT role_id FROM app_role WHERE name = %s", (name,))
        row = cur.fetchone()
    assert row, f"the {name} role was not created"
    return row["role_id"]


@pytest.fixture
def people():
    """Throwaway accounts. Every one is a Standard User unless a test says
    otherwise — what they can do has to come from their project membership."""
    made = []

    def make(label, role="standard"):
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


def _project(projects, name):
    project = project_service.create_project(f"{name} {uuid.uuid4().hex[:6]}",
                                             created_by="tests")
    projects.append(project["project_id"])
    return project["project_id"]


def _form(forms, project_id, title, status="Active"):
    definition = normalize_form({
        "title": f"{title} {uuid.uuid4().hex[:6]}",
        "table_name": f"survey_{uuid.uuid4().hex[:8]}",
        "fields": [{"name": "answer", "label": "Answer", "type": "text"}],
    })
    created = form_service.create_form(definition, created_by="tests", status=status)
    forms.append((created["form_id"], created["table"]["table_name"]))

    if project_id:
        project_service.set_form_project(created["form_id"], project_id)
    return created["form_id"]


def client_for(person):
    from fastapi.testclient import TestClient

    from app.main import app
    return TestClient(app, headers={"Authorization": f"Bearer {person['token']}"})


@pytest.fixture
def scene(people, projects, forms):
    """Mexico-Maize as it is described: one Active form, assigned to everyone."""
    mexico = _project(projects, "Mexico-Maize")

    admin = people("Administrator", role="admin")
    shrishti = people("Shrishti")
    piyush = people("Piyush")

    project_service.add_member(mexico, shrishti["user_id"], _role_id("surveyor"))
    project_service.add_member(mexico, piyush["user_id"], _role_id("reviewer"))

    wellness = _form(forms, mexico, "Womens Wellness")
    project_service.assign_form(wellness, "everyone")

    return {"project": mexico, "form_id": wellness,
            "admin": admin, "shrishti": shrishti, "piyush": piyush}


def _fillable(person, project=None):
    where = f"?project={project}" if project else ""
    answer = client_for(person).get(f"/api/forms/live/list{where}")
    assert answer.status_code == 200, answer.text
    return [f["form_id"] for f in answer.json()]


def _submit(person, form_id, answer="x"):
    made = client_for(person).post(f"/api/forms/{form_id}/submissions",
                                   json={"data": {"answer": answer}})
    assert made.status_code == 201, made.text
    return made.json()["survey_id"]


# --------------------------------------------------------------------------- #
# Shrishti — the Surveyor
# --------------------------------------------------------------------------- #
def test_shrishti_sees_only_mexico_maize(scene, projects):
    elsewhere = _project(projects, "VACS")

    listed = client_for(scene["shrishti"]).get("/api/projects").json()["projects"]
    assert [p["project_id"] for p in listed] == [scene["project"]]
    assert elsewhere not in [p["project_id"] for p in listed]


def test_shrishti_sees_the_form_to_fill_in(scene):
    assert _fillable(scene["shrishti"]) == [scene["form_id"]]
    assert _fillable(scene["shrishti"], scene["project"]) == [scene["form_id"]]


def test_shrishti_renders_and_submits(scene):
    api = client_for(scene["shrishti"])

    assert api.get(f"/api/forms/{scene['form_id']}/render").status_code == 200
    survey_id = _submit(scene["shrishti"], scene["form_id"])

    # And reads her own answer back.
    queue = api.get(f"/api/projects/{scene['project']}/submissions").json()
    assert [row["survey_id"] for row in queue["submissions"]] == [survey_id]
    assert queue["everything"] is False


def test_shrishti_cannot_edit_or_publish_the_form(scene):
    api = client_for(scene["shrishti"])
    definition = form_service.get_form(scene["form_id"])["form_json"]

    assert api.put(f"/api/forms/{scene['form_id']}",
                   json={"form_json": definition}).status_code == 403
    assert api.patch(f"/api/forms/{scene['form_id']}/status",
                     json={"form_status": "Inactive"}).status_code == 403
    # Nor decide who else gets it.
    assert api.post(f"/api/forms/{scene['form_id']}/assignments",
                    json={"kind": "everyone"}).status_code == 403


def test_shrishti_cannot_judge_a_submission(scene):
    api = client_for(scene["shrishti"])
    survey_id = _submit(scene["shrishti"], scene["form_id"])

    for action, body in (("start-review", None), ("approve", None),
                         ("reject", {"reason": "no"})):
        answer = api.post(
            f"/api/submissions/{scene['form_id']}/{survey_id}/{action}", json=body)
        assert answer.status_code == 409, action


def test_shrishti_cannot_read_a_colleagues_submission(scene, people):
    """Her own, and only her own — reading is `submission_scope`, and hers is
    `own`."""
    colleague = people("Rekha")
    project_service.add_member(scene["project"], colleague["user_id"],
                               _role_id("surveyor"))

    theirs = _submit(colleague, scene["form_id"], "theirs")

    api = client_for(scene["shrishti"])
    assert api.get(f"/api/submissions/{scene['form_id']}/{theirs}").status_code == 404
    assert api.post(
        f"/api/submissions/{scene['form_id']}/{theirs}/approve").status_code == 404

    queue = api.get(f"/api/projects/{scene['project']}/submissions").json()
    assert theirs not in [row["survey_id"] for row in queue["submissions"]]


def test_shrishti_cannot_reach_another_projects_form(scene, projects, forms):
    elsewhere = _project(projects, "VACS")
    theirs = _form(forms, elsewhere, "Soil Survey")
    project_service.assign_form(theirs, "everyone")

    api = client_for(scene["shrishti"])
    assert theirs not in _fillable(scene["shrishti"])
    assert api.get(f"/api/forms/{theirs}/render").status_code == 404
    assert api.post(f"/api/forms/{theirs}/submissions",
                    json={"data": {"answer": "x"}}).status_code == 404
    assert api.get(f"/api/projects/{elsewhere}/submissions").status_code == 404


def test_shrishti_resubmits_after_a_rejection(scene):
    survey_id = _submit(scene["shrishti"], scene["form_id"])
    reviewer = client_for(scene["piyush"])

    reviewer.post(f"/api/submissions/{scene['form_id']}/{survey_id}/reject",
                  json={"reason": "the date is wrong"})

    again = client_for(scene["shrishti"]).post(
        f"/api/submissions/{scene['form_id']}/{survey_id}/submit")
    assert again.status_code == 200
    assert again.json()["status"] == "submitted"
    # The reason belonged to the rejection and does not survive it.
    assert again.json()["rejection_reason"] == ""


# --------------------------------------------------------------------------- #
# Piyush — the Reviewer
# --------------------------------------------------------------------------- #
def test_piyush_sees_the_project_and_its_forms(scene):
    api = client_for(scene["piyush"])

    listed = api.get("/api/projects").json()["projects"]
    assert [p["project_id"] for p in listed] == [scene["project"]]

    found = api.get(f"/api/projects/{scene['project']}/forms").json()
    assert [f["form_id"] for f in found["forms"]] == [scene["form_id"]]
    assert found["everything"] is True


def test_piyush_sees_shrishtis_submission_in_the_queue(scene):
    """The queue must not be narrowed to the caller's own work — that is what
    would leave a reviewer with an empty screen."""
    survey_id = _submit(scene["shrishti"], scene["form_id"])

    queue = client_for(scene["piyush"]).get(
        f"/api/projects/{scene['project']}/submissions").json()

    assert queue["everything"] is True
    row = next(r for r in queue["submissions"] if r["survey_id"] == survey_id)
    assert row["created_by"] == auth_service.display_name(scene["shrishti"])
    assert row["status"] == "submitted"


def test_piyush_starts_review_and_approves(scene):
    survey_id = _submit(scene["shrishti"], scene["form_id"])
    api = client_for(scene["piyush"])

    started = api.post(f"/api/submissions/{scene['form_id']}/{survey_id}/start-review")
    assert started.json()["status"] == "under_review"

    approved = api.post(f"/api/submissions/{scene['form_id']}/{survey_id}/approve")
    assert approved.json()["status"] == "approved"
    assert approved.json()["reviewed_by"] == auth_service.display_name(scene["piyush"])


def test_piyush_rejects_and_the_reason_is_required(scene):
    survey_id = _submit(scene["shrishti"], scene["form_id"])
    api = client_for(scene["piyush"])

    assert api.post(f"/api/submissions/{scene['form_id']}/{survey_id}/reject",
                    json={}).status_code == 422
    assert api.post(f"/api/submissions/{scene['form_id']}/{survey_id}/reject",
                    json={"reason": "   "}).status_code == 409

    rejected = api.post(f"/api/submissions/{scene['form_id']}/{survey_id}/reject",
                        json={"reason": "the plot id is missing"})
    assert rejected.json()["status"] == "rejected"
    assert rejected.json()["rejection_reason"] == "the plot id is missing"

    # And the history reads back, so the surveyor is told why.
    seen = client_for(scene["shrishti"]).get(
        f"/api/submissions/{scene['form_id']}/{survey_id}").json()
    assert seen["rejection_reason"] == "the plot id is missing"


def test_piyush_is_not_offered_the_form_to_fill_in(scene):
    """The reported regression. He may read every form in the project — that is
    what reviewing needs — and that must not put one in his own list."""
    assert _fillable(scene["piyush"]) == []
    assert _fillable(scene["piyush"], scene["project"]) == []

    assert access.may_see_form(scene["piyush"], scene["form_id"]) is True
    assert access.may_fill_form(scene["piyush"], scene["form_id"]) is False


def test_piyush_cannot_submit_by_going_straight_to_the_api(scene):
    api = client_for(scene["piyush"])

    assert api.get(f"/api/forms/{scene['form_id']}/render").status_code == 404
    assert api.post(f"/api/forms/{scene['form_id']}/submissions",
                    json={"data": {"answer": "x"}}).status_code == 404


def test_piyush_cannot_reach_another_project(scene, projects, forms):
    elsewhere = _project(projects, "VACS")
    theirs = _form(forms, elsewhere, "Soil Survey")

    api = client_for(scene["piyush"])
    assert api.get(f"/api/projects/{elsewhere}").status_code == 404
    assert api.get(f"/api/projects/{elsewhere}/submissions").status_code == 404
    assert api.get(f"/api/forms/{theirs}").status_code == 404


def test_piyush_cannot_manage_users(scene):
    api = client_for(scene["piyush"])
    assert api.get("/api/users").status_code == 403


# --------------------------------------------------------------------------- #
# the Administrator
# --------------------------------------------------------------------------- #
def test_the_administrator_reaches_projects_by_permission(scene, projects):
    """Not by being a member, and not by being called an administrator: through
    `projects.view_all`, which the role happens to hold."""
    other = _project(projects, "VACS")
    admin = scene["admin"]

    assert auth_service.may(admin, "projects.view_all") is True
    reachable = [p["project_id"]
                 for p in client_for(admin).get("/api/projects").json()["projects"]]
    assert scene["project"] in reachable and other in reachable

    # And with no membership row anywhere.
    assert access.membership(admin, scene["project"]) is None


def test_a_standard_user_sees_no_project_they_are_not_in(scene, people, projects):
    outsider = people("Nobody")
    assert client_for(outsider).get("/api/projects").json()["projects"] == []
    assert client_for(outsider).get(
        f"/api/projects/{scene['project']}").status_code == 404


# --------------------------------------------------------------------------- #
# the security rules, stated one at a time
# --------------------------------------------------------------------------- #
def test_view_all_does_not_imply_fill(scene):
    from app.modules.projects.permissions import FORMS_VIEW_ALL

    held = access.permissions_in(scene["piyush"], scene["project"])
    assert FORMS_VIEW_ALL in held
    assert FORMS_FILL not in held
    assert access.visible_form_ids(scene["piyush"], scene["project"]) is None
    assert access.fillable_form_ids(scene["piyush"], scene["project"]) == []


def test_fill_without_an_assignment_is_nothing(scene, forms):
    """The permission alone is not a form. This is the state the installation
    was actually in: a published form nobody had been given."""
    unassigned = _form(forms, scene["project"], "Household Roster")

    assert FORMS_FILL in access.permissions_in(scene["shrishti"], scene["project"])
    assert unassigned not in _fillable(scene["shrishti"])
    assert client_for(scene["shrishti"]).get(
        f"/api/forms/{unassigned}/render").status_code == 404


def test_the_three_ways_a_form_is_given_out_all_work(scene, people, forms):
    everyone_form = scene["form_id"]
    by_name = _form(forms, scene["project"], "By Name")
    by_group = _form(forms, scene["project"], "By Group")

    project_service.assign_form(by_name, "user",
                                user_id=scene["shrishti"]["user_id"])
    group = project_service.create_group(scene["project"], "Field Team North")
    project_service.add_to_group(scene["project"], group["group_id"],
                                 scene["shrishti"]["user_id"])
    project_service.assign_form(by_group, "group", group_id=group["group_id"])

    hers = set(_fillable(scene["shrishti"]))
    assert hers == {everyone_form, by_name, by_group}

    # Somebody in the project but in neither the group nor the name gets only
    # the one that went to everyone.
    other = people("Rekha")
    project_service.add_member(scene["project"], other["user_id"], _role_id("surveyor"))
    assert set(_fillable(other)) == {everyone_form}


def test_a_draft_form_is_never_fillable(scene, forms):
    draft = _form(forms, scene["project"], "Not Published Yet", status="Draft")
    project_service.assign_form(draft, "everyone")

    assert draft not in _fillable(scene["shrishti"])
    # It is hers by assignment, so the refusal explains itself rather than
    # pretending the form is not there.
    assert client_for(scene["shrishti"]).get(
        f"/api/forms/{draft}/render").status_code == 403


def test_a_paused_form_is_not_fillable_either(scene):
    form_service.set_status(scene["form_id"], "Inactive")
    assert _fillable(scene["shrishti"]) == []


def test_a_suspended_membership_takes_everything_away(scene):
    member = next(m for m in project_service.list_members(scene["project"])
                  if m["user_id"] == scene["shrishti"]["user_id"])
    project_service.update_member(scene["project"], member["member_id"],
                                  {"status": "Suspended"})

    api = client_for(scene["shrishti"])
    assert access.permissions_in(scene["shrishti"], scene["project"]) == set()
    assert _fillable(scene["shrishti"]) == []
    assert api.get(f"/api/forms/{scene['form_id']}/render").status_code == 404
    assert api.get(f"/api/projects/{scene['project']}").status_code == 404
    # The row is kept, so the history still reads back.
    assert access.membership(scene["shrishti"], scene["project"])["status"] == "Suspended"


def test_review_needs_the_review_permission_not_a_role(scene, people):
    """A second reviewer, with the permission removed from a copy of the role.

    Nothing anywhere asks what the role is called: take the permission away and
    the same account stops being able to review, under the same name.
    """
    from app.core import role_service

    stripped = role_service.create_role(
        f"Reader {uuid.uuid4().hex[:6]}",
        description="Reads submissions and judges none.",
        permission_keys=["project.view", "project.submissions.view_all"])
    reader = people("Anita")
    project_service.add_member(scene["project"], reader["user_id"],
                               stripped["role_id"])

    survey_id = _submit(scene["shrishti"], scene["form_id"])
    api = client_for(reader)

    # Reads the queue...
    queue = api.get(f"/api/projects/{scene['project']}/submissions").json()
    assert survey_id in [r["survey_id"] for r in queue["submissions"]]
    # ...and can move nothing.
    assert access.may_review_submissions(reader, scene["project"]) is False
    assert api.post(
        f"/api/submissions/{scene['form_id']}/{survey_id}/approve").status_code == 409

    with transaction() as cur:
        # The membership holds the role down, and the project's own teardown has
        # not run yet.
        cur.execute("DELETE FROM project_member WHERE role_id = %s", (stripped["role_id"],))
        cur.execute("DELETE FROM app_role WHERE role_id = %s", (stripped["role_id"],))


# --------------------------------------------------------------------------- #
# what /api/auth/me says, and where it gets it
# --------------------------------------------------------------------------- #
def test_the_navigation_flags_come_from_membership_not_the_account(scene):
    """The bug behind "the reviewer cannot find the review queue".

    `use_projects` was read off the account role, where a Standard User holds
    nothing — so it was false for every real project member, and the landing
    page sent them to an empty list of forms to fill in.
    """
    hers = client_for(scene["shrishti"]).get("/api/auth/me").json()
    his = client_for(scene["piyush"]).get("/api/auth/me").json()

    assert hers["can"]["use_projects"] is True
    assert his["can"]["use_projects"] is True

    # And they are still Standard Users: not one project permission has landed
    # on the account.
    for me in (hers, his):
        assert me["can"].get("use_system_forms", False) is False
        assert me["can"].get("build_forms", False) is False
        assert me["can"].get("manage_users", False) is False
        assert not [p for p in me["permissions"] if p.startswith("project")]


def test_the_flags_tell_filling_and_reviewing_apart(scene):
    hers = client_for(scene["shrishti"]).get("/api/auth/me").json()["can"]
    his = client_for(scene["piyush"]).get("/api/auth/me").json()["can"]

    assert hers["fill_forms"] is True and hers["review_submissions"] is False
    assert his["review_submissions"] is True and his["fill_forms"] is False


def test_somebody_in_no_project_gets_no_project_flags(scene, people):
    me = client_for(people("Nobody")).get("/api/auth/me").json()["can"]

    assert me.get("use_projects", False) is False
    assert me.get("fill_forms", False) is False
    assert me.get("review_submissions", False) is False


def test_projects_where_answers_per_project(scene, projects, people):
    """Holding a permission somewhere is not holding it everywhere."""
    elsewhere = _project(projects, "VACS")
    project_service.add_member(elsewhere, scene["shrishti"]["user_id"],
                               _role_id("reviewer"))

    assert access.projects_where(scene["shrishti"], FORMS_FILL) == [scene["project"]]
    assert access.projects_where(
        scene["shrishti"], SUBMISSIONS_REVIEW) == [elsewhere]


# --------------------------------------------------------------------------- #
# nothing decides by the name of a role
# --------------------------------------------------------------------------- #
def test_no_authorization_code_names_a_role():
    """Every file that decides access, read for role names.

    A check against a name is the thing this architecture exists to avoid: a
    role can be renamed or invented in the database, and the check would quietly
    stop being true.
    """
    from pathlib import Path

    root = Path(access.__file__).resolve().parents[2]      # .../app
    watched = [
        root / "modules" / "projects" / "access.py",
        root / "modules" / "projects" / "routers" / "review.py",
        root / "modules" / "projects" / "routers" / "projects.py",
        root / "modules" / "forms" / "routers" / "submissions.py",
        root / "core" / "routers" / "auth.py",
    ]

    for path in watched:
        assert path.exists(), path
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            code = line.split("#")[0]
            for name in ("surveyor", "reviewer", "project_manager"):
                assert f'== "{name}"' not in code, f"{path.name}:{number}"
                assert f"== '{name}'" not in code, f"{path.name}:{number}"


# --------------------------------------------------------------------------- #
# reading one submission before deciding about it
#
# A decision made without seeing the answers is not a review. The detail
# endpoint is authorized by `_reachable`, exactly as the moves are, so it opens
# nothing the queue would not already have shown.
# --------------------------------------------------------------------------- #
def _rich_form(forms, project_id):
    """A form with sections, a conditional question and several answer types."""
    definition = normalize_form({
        "title": f"Womens Wellness {uuid.uuid4().hex[:6]}",
        "table_name": f"survey_{uuid.uuid4().hex[:8]}",
        "sections": [
            {"key": "consent", "title": "Consent"},
            {"key": "health", "title": "General Health"},
        ],
        "fields": [
            {"name": "consent", "label": "Do you consent?", "type": "select",
             "section": "consent", "options": ["yes", "no"], "required": True},
            {"name": "age", "label": "Age", "type": "number", "section": "health"},
            {"name": "health_rating", "label": "How would you rate your health?",
             "type": "rating", "section": "health"},
            {"name": "pregnant", "label": "Are you currently pregnant?",
             "type": "boolean", "section": "health"},
            {"name": "pregnancy_month", "label": "Which month?", "type": "number",
             "section": "health",
             "rules": [{"when": [{"field": "pregnant", "op": "is_true"}], "show": True}]},
        ],
    })
    created = form_service.create_form(definition, created_by="tests", status="Active")
    forms.append((created["form_id"], created["table"]["table_name"]))
    project_service.set_form_project(created["form_id"], project_id)
    project_service.assign_form(created["form_id"], "everyone")
    return created["form_id"]


@pytest.fixture
def answered(scene, forms):
    """Shrishti's answers to a form with a question she was never asked."""
    form_id = _rich_form(forms, scene["project"])
    survey_id = client_for(scene["shrishti"]).post(
        f"/api/forms/{form_id}/submissions",
        json={"data": {"consent": "yes", "age": 25, "health_rating": 4,
                       "pregnant": False}},
    ).json()["survey_id"]
    return {**scene, "form_id": form_id, "survey_id": survey_id}


def _detail(person, made):
    return client_for(person).get(
        f"/api/submissions/{made['form_id']}/{made['survey_id']}/detail")


def test_a_reviewer_opens_a_submission_from_their_project(answered):
    found = _detail(answered["piyush"], answered)
    assert found.status_code == 200

    body = found.json()
    assert body["submission_id"] == answered["survey_id"]
    assert body["project_id"] == answered["project"]
    assert body["form_name"].startswith("Womens Wellness")


def test_the_reviewer_sees_every_answer_that_was_given(answered):
    body = _detail(answered["piyush"], answered).json()
    given = {a["name"]: a for a in body["answers"] if a["answered"]}

    assert given["consent"]["value"] == "yes"
    assert given["consent"]["label"] == "Do you consent?"
    assert given["age"]["value"] == 25
    assert given["health_rating"]["value"] == 4
    assert given["health_rating"]["type"] == "rating"
    assert given["pregnant"]["value"] is False


def test_a_question_that_was_never_asked_reads_as_unanswered(answered):
    """A conditional question is stored as a null. Left to itself it reads
    exactly like a question answered with nothing, which is a different thing
    for somebody deciding whether the answer set is complete."""
    body = _detail(answered["piyush"], answered).json()
    month = next(a for a in body["answers"] if a["name"] == "pregnancy_month")

    assert month["answered"] is False
    assert month["label"] == "Which month?"


def test_the_answers_come_back_in_the_order_they_were_asked(answered):
    body = _detail(answered["piyush"], answered).json()

    assert [a["name"] for a in body["answers"]] == [
        "consent", "age", "health_rating", "pregnant", "pregnancy_month"]
    assert [a["section"] for a in body["answers"][:2]] == ["Consent", "General Health"]


def test_the_metadata_and_status_come_with_it(answered):
    body = _detail(answered["piyush"], answered).json()

    assert body["submitted_by"] == auth_service.display_name(answered["shrishti"])
    assert body["submitted_at"]
    assert body["status"] == "submitted"
    assert body["may_review"] is True
    assert body["is_author"] is False
    assert [event["event"] for event in body["review_history"]] == ["submitted"]


def test_the_detail_carries_no_form_definition(answered):
    """Enough to display an answer, and nothing more — no table name, no
    validation rules, no option lists."""
    body = _detail(answered["piyush"], answered).json()

    assert "form_json" not in body and "table_name" not in body
    for answer in body["answers"]:
        assert set(answer) <= {"name", "label", "type", "section", "value",
                               "answered", "retired"}


def test_a_rejection_reason_and_its_history_read_back(answered):
    reviewer = client_for(answered["piyush"])
    reviewer.post(f"/api/submissions/{answered['form_id']}/{answered['survey_id']}"
                  f"/start-review")
    reviewer.post(f"/api/submissions/{answered['form_id']}/{answered['survey_id']}/reject",
                  json={"reason": "the age looks wrong"})

    body = _detail(answered["piyush"], answered).json()
    assert body["status"] == "rejected"
    assert body["rejection_reason"] == "the age looks wrong"
    assert [e["event"] for e in body["review_history"]] == ["submitted", "rejected"]
    assert body["review_history"][-1]["by"] == auth_service.display_name(
        answered["piyush"])

    # And the person who filled it in is told why.
    hers = _detail(answered["shrishti"], answered).json()
    assert hers["rejection_reason"] == "the age looks wrong"


def test_the_answers_can_be_read_in_every_state(answered):
    """Reading is not part of the workflow: whatever state it is in, somebody
    who may see the submission may see what it says."""
    reviewer = client_for(answered["piyush"])
    base = f"/api/submissions/{answered['form_id']}/{answered['survey_id']}"

    for move, expected in (("start-review", "under_review"), ("approve", "approved")):
        reviewer.post(f"{base}/{move}")
        body = _detail(answered["piyush"], answered).json()
        assert body["status"] == expected
        assert len(body["answers"]) == 5


def test_a_surveyor_reads_their_own_submission(answered):
    body = _detail(answered["shrishti"], answered).json()

    assert body["submission_id"] == answered["survey_id"]
    assert body["may_review"] is False
    assert body["is_author"] is True


def test_a_surveyor_cannot_read_a_colleagues_submission(answered, people):
    colleague = people("Rekha")
    project_service.add_member(answered["project"], colleague["user_id"],
                               _role_id("surveyor"))

    assert _detail(colleague, answered).status_code == 404


def test_another_projects_submission_is_not_reachable(answered, people, projects):
    outsider = people("Nobody")
    elsewhere = _project(projects, "VACS")
    project_service.add_member(elsewhere, outsider["user_id"], _role_id("reviewer"))

    # A reviewer — of a different project. 404, so the id is not confirmed.
    assert _detail(outsider, answered).status_code == 404


def test_somebody_outside_every_project_is_refused(answered, people):
    assert _detail(people("Nobody"), answered).status_code == 404


def test_a_suspended_member_can_no_longer_read_it(answered):
    member = next(m for m in project_service.list_members(answered["project"])
                  if m["user_id"] == answered["piyush"]["user_id"])
    project_service.update_member(answered["project"], member["member_id"],
                                  {"status": "Suspended"})

    assert _detail(answered["piyush"], answered).status_code == 404


def test_guessing_a_survey_id_finds_nothing(answered):
    api = client_for(answered["piyush"])

    assert api.get(f"/api/submissions/{answered['form_id']}/NOPE-000001/detail"
                   ).status_code == 404
    assert api.get(f"/api/submissions/FRM99999/{answered['survey_id']}/detail"
                   ).status_code == 404


def test_there_is_no_way_to_write_an_answer_back(answered):
    """The review side is read-only: nothing here accepts an answer set."""
    api = client_for(answered["piyush"])
    base = f"/api/submissions/{answered['form_id']}/{answered['survey_id']}"

    for method in (api.put, api.patch, api.post):
        answer = method(f"{base}/detail", json={"answers": {"age": 99}})
        assert answer.status_code == 405

    # And the stored answer is exactly what was submitted.
    body = _detail(answered["piyush"], answered).json()
    assert next(a for a in body["answers"] if a["name"] == "age")["value"] == 25


def test_the_workflow_still_works_after_reading_it(answered):
    """Reading changes nothing, and the moves are unchanged."""
    reviewer = client_for(answered["piyush"])
    base = f"/api/submissions/{answered['form_id']}/{answered['survey_id']}"

    assert _detail(answered["piyush"], answered).json()["status"] == "submitted"

    assert reviewer.post(f"{base}/start-review").json()["status"] == "under_review"
    assert reviewer.post(f"{base}/approve").json()["status"] == "approved"

    # And a surveyor reading it still cannot move it.
    assert client_for(answered["shrishti"]).post(f"{base}/approve").status_code == 409


# --------------------------------------------------------------------------- #
# the builder's own tabs, on a project's form
#
# `/versions` was judged by the project and `/diff` by the account, so the
# History tab listed the versions and then refused to compare two of them. The
# same split left the View tab's `/submissions` refused while `/records` — which
# a Standard User's own role happens to allow — worked. Every one of these is
# one form being read, so every one is judged by the context that form is in.
# --------------------------------------------------------------------------- #
def _manager_in(scene, people):
    person = people("Prashant")
    project_service.add_member(scene["project"], person["user_id"],
                               _role_id("project_manager"))
    return person


def test_a_project_manager_reads_every_tab_of_their_forms(scene, people):
    """The reported log, line by line."""
    manager = client_for(_manager_in(scene, people))
    form_id = scene["form_id"]

    assert manager.get(f"/api/forms/{form_id}/versions").status_code == 200
    assert manager.get(f"/api/forms/{form_id}/diff?from=1&to=1").status_code == 200
    assert manager.get(
        f"/api/forms/{form_id}/submissions?limit=25&offset=0").status_code == 200
    assert manager.get(
        f"/api/forms/{form_id}/records?limit=25&offset=0").status_code == 200
    assert manager.get(f"/api/forms/{form_id}/render").status_code == 200
    assert manager.get(f"/api/forms/{form_id}/submissions/export").status_code == 200
    assert manager.get(f"/api/forms/{form_id}/view-config").status_code == 200


def test_comparing_a_version_with_itself_is_a_valid_question(scene, people):
    """What the History tab asks of a form saved once: version 1 against version
    1. An empty answer, not an error and certainly not a refusal."""
    manager = client_for(_manager_in(scene, people))

    body = manager.get(f"/api/forms/{scene['form_id']}/diff?from=1&to=1").json()
    assert body["form_id"] == scene["form_id"]
    assert body["available_versions"] == [1]


def test_the_project_manager_sees_the_answers_in_full(scene, people):
    manager = client_for(_manager_in(scene, people))
    survey_id = _submit(scene["shrishti"], scene["form_id"])

    body = manager.get(f"/api/forms/{scene['form_id']}/submissions").json()
    assert survey_id in [row["survey_id"] for row in body["rows"]]


def test_a_surveyor_reads_none_of_those_tabs(scene):
    """Unchanged, and now refused for the right reason: her role in the project
    does not read other people's answers or the form's history."""
    api = client_for(scene["shrishti"])
    form_id = scene["form_id"]

    for path in (f"/api/forms/{form_id}/versions",
                 f"/api/forms/{form_id}/diff",
                 f"/api/forms/{form_id}/submissions",
                 f"/api/forms/{form_id}/submissions/export",
                 f"/api/forms/{form_id}/view-config"):
        assert api.get(path).status_code == 403, path

    # What she does have is unchanged.
    assert api.get(f"/api/forms/{form_id}/records").status_code == 200
    assert api.get(f"/api/forms/{form_id}/render").status_code == 200


def test_a_reviewer_reads_the_answers_and_the_history(scene):
    """`project.submissions.view_all` is exactly "read submissions from
    anybody", and reviewing the work means reading the form it came from."""
    api = client_for(scene["piyush"])
    form_id = scene["form_id"]

    assert api.get(f"/api/forms/{form_id}/submissions").status_code == 200
    assert api.get(f"/api/forms/{form_id}/versions").status_code == 200
    assert api.get(f"/api/forms/{form_id}/diff").status_code == 200
    # Still not the form's design, and still nothing to fill in.
    assert api.get(f"/api/forms/{form_id}/view-config").status_code == 403
    assert api.get(f"/api/forms/{form_id}/render").status_code == 404


def test_a_manager_of_one_project_reads_nothing_of_another(scene, people, projects, forms):
    manager = client_for(_manager_in(scene, people))
    elsewhere = _project(projects, "VACS")
    theirs = _form(forms, elsewhere, "Soil Survey")

    for path in (f"/api/forms/{theirs}/diff",
                 f"/api/forms/{theirs}/submissions",
                 f"/api/forms/{theirs}/versions",
                 f"/api/forms/{theirs}/submissions/export",
                 f"/api/forms/{theirs}/view-config"):
        # 404: a project they are not in is indistinguishable from one that is
        # not there.
        assert manager.get(path).status_code == 404, path


def test_a_project_role_still_opens_no_system_form(scene, people, forms):
    """The line these dependencies exist to hold. Running a project is not an
    account permission, and a form outside every project takes one."""
    manager = client_for(_manager_in(scene, people))
    loose = _form(forms, None, "Legacy Registration")

    for path in (f"/api/forms/{loose}/diff",
                 f"/api/forms/{loose}/submissions",
                 f"/api/forms/{loose}/versions",
                 f"/api/forms/{loose}/submissions/export",
                 f"/api/forms/{loose}/view-config"):
        assert manager.get(path).status_code == 403, path


def test_an_account_permission_still_reads_a_system_form(people, forms):
    """The other half: nothing was taken away from the accounts that had it."""
    builder = people("Builder", role="editor")
    loose = _form(forms, None, "Legacy Registration")

    api = client_for(builder)
    assert api.get(f"/api/forms/{loose}/versions").status_code == 200
    assert api.get(f"/api/forms/{loose}/diff").status_code == 200
    assert api.get(f"/api/forms/{loose}/submissions").status_code == 200
    assert api.get(f"/api/forms/{loose}/view-config").status_code == 200


def test_an_account_permission_does_not_reach_into_a_project(scene, people):
    """An editor holds `responses.view` and `forms.view` on the account. Neither
    is a way into a project they are not a member of."""
    builder = client_for(people("Builder", role="editor"))
    form_id = scene["form_id"]

    for path in (f"/api/forms/{form_id}/diff",
                 f"/api/forms/{form_id}/submissions",
                 f"/api/forms/{form_id}/versions"):
        assert builder.get(path).status_code == 404, path
