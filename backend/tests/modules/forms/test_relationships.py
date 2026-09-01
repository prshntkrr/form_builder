"""One form's submissions hanging off another's.

    Farmer Registration   survey_id = F-000001
            └── Plot Registration   survey_id        = P-000001
                                    parent_survey_id = F-000001

The child keeps its own id and records which parent it belongs to. Nothing is
copied, and the relationship is never a way past anything: a parent has to be a
submission of the *configured* parent form, in the same project, that the
account could already read.

Every check below is on the backend. The frontend passes a survey id in a URL,
and that is a claim like any other.
"""
import uuid

import pytest

from app.core import auth_service
from app.core.database import ping, transaction
from app.modules.forms import form_service, relationships, submission_service
from app.modules.forms.form_schema import normalize_form, parent_form_id
from app.modules.forms.tabular_service import tabular_name
from app.modules.projects import project_service

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

PASSWORD = "correct horse battery"


# --------------------------------------------------------------------------- #
# scaffolding
# --------------------------------------------------------------------------- #
@pytest.fixture
def forms():
    made = []
    yield made
    from psycopg2 import sql
    with transaction() as cur:
        # Children first: a child table references its parent's.
        for form_id, table in reversed(made):
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
        token = auth_service.login(email, PASSWORD)["token"]
        made.append(user["user_id"])
        return {**user, "token": token}

    yield make

    with transaction() as cur:
        for user_id in made:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (user_id,))


def _role_id(name: str) -> str:
    with transaction() as cur:
        cur.execute("SELECT role_id FROM app_role WHERE name = %s", (name,))
        return cur.fetchone()["role_id"]


def client_for(person):
    from fastapi.testclient import TestClient

    from app.main import app
    return TestClient(app, headers={"Authorization": f"Bearer {person['token']}"})


def _make(forms, title, fields, relationship=None, project=None, status="Active"):
    definition = {
        "title": f"{title} {uuid.uuid4().hex[:5]}",
        "table_name": f"rel_{title[:6].lower()}_{uuid.uuid4().hex[:8]}",
        "fields": fields,
    }
    if relationship:
        definition["relationship"] = relationship

    created = form_service.create_form(normalize_form(definition),
                                       created_by="tests", status=status)
    forms.append((created["form_id"], created["table"]["table_name"]))
    if project:
        project_service.set_form_project(created["form_id"], project)
    return created["form_id"]


NAME = [{"name": "farmer_name", "label": "Farmer name", "type": "text"},
        {"name": "village", "label": "Village", "type": "text"}]
PLOT = [{"name": "plot_name", "label": "Plot name", "type": "text"},
        {"name": "area", "label": "Area", "type": "decimal"}]


@pytest.fixture
def pair(forms):
    """Farmer Registration, and Plot Registration hanging off it."""
    farmer = _make(forms, "Farmer", NAME)
    plot = _make(forms, "Plot", PLOT,
                 relationship={"type": "child", "parent_form_id": farmer})
    return {"farmer": farmer, "plot": plot}


def _submit(form_id, data, parent=None, by="tests"):
    return submission_service.submit(form_service.get_form(form_id), data,
                                     created_by=by, parent_survey_id=parent)


# --------------------------------------------------------------------------- #
# the definition, and the table under it
# --------------------------------------------------------------------------- #
def test_a_form_is_independent_unless_it_says_otherwise(forms):
    """Every form built before this existed, and every form nobody has said
    otherwise about."""
    plain = form_service.get_form(_make(forms, "Plain", NAME))

    assert "relationship" not in plain["form_json"]
    assert parent_form_id(plain["form_json"]) is None


def test_a_child_form_stores_its_parent(pair):
    definition = form_service.get_form(pair["plot"])["form_json"]

    assert definition["relationship"] == {"type": "child",
                                          "parent_form_id": pair["farmer"]}


def test_only_a_child_form_gets_the_parent_column(pair):
    """An independent form's table is exactly the shape it always was — which is
    what keeps every existing form and every existing row untouched."""
    child_table = form_service.get_form(pair["plot"])["form_json"]["table_name"]
    parent_table = form_service.get_form(pair["farmer"])["form_json"]["table_name"]

    with transaction() as cur:
        cur.execute(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_name = ANY(%s) AND column_name = 'parent_survey_id'",
            ([child_table, parent_table],),
        )
        carrying = {row["table_name"] for row in cur.fetchall()}

    assert carrying == {child_table}


def test_a_child_submission_keeps_its_own_survey_id(pair):
    farmer = _submit(pair["farmer"], {"farmer_name": "Prashant Kumar", "village": "ABC"})
    plot = _submit(pair["plot"], {"plot_name": "Plot A", "area": 2}, parent=farmer["survey_id"])

    assert plot["survey_id"] != farmer["survey_id"]
    assert plot["survey_id"].startswith(pair["plot"])
    assert plot["parent_survey_id"] == farmer["survey_id"]


def test_the_parent_is_referenced_not_copied(pair):
    """The farmer's name lives in the farmer's row and nowhere else."""
    farmer = _submit(pair["farmer"], {"farmer_name": "Prashant Kumar", "village": "ABC"})
    plot = _submit(pair["plot"], {"plot_name": "Plot A", "area": 2}, parent=farmer["survey_id"])

    stored = submission_service.one_submission(
        form_service.get_form(pair["plot"]), plot["survey_id"])

    assert stored["form_data"] == {"plot_name": "Plot A", "area": 2}
    assert "Prashant Kumar" not in str(stored["form_data"])
    assert stored["parent_survey_id"] == farmer["survey_id"]


def test_an_independent_form_still_submits_exactly_as_before(forms):
    plain = _make(forms, "Plain", NAME)
    result = _submit(plain, {"farmer_name": "A", "village": "B"})

    assert result["survey_id"]
    assert result["parent_survey_id"] is None
    stored = submission_service.one_submission(form_service.get_form(plain),
                                               result["survey_id"])
    assert "parent_survey_id" not in stored


# --------------------------------------------------------------------------- #
# what the backend refuses
# --------------------------------------------------------------------------- #
def test_a_child_submission_needs_a_parent(pair):
    user = {"user_id": "x", "permissions": ["forms.system.view"]}
    with pytest.raises(relationships.RelationshipError):
        relationships.validate_parent(user, form_service.get_form(pair["plot"]), None)


def test_a_parent_that_does_not_exist_is_refused(pair):
    user = {"user_id": "x", "permissions": ["forms.system.view"]}
    with pytest.raises(relationships.RelationshipError):
        relationships.validate_parent(user, form_service.get_form(pair["plot"]),
                                      f"{pair['farmer']}-999999")


def test_a_survey_id_from_the_wrong_form_is_refused(pair, forms):
    """The attack that looks plausible: a real survey id, from another form."""
    other = _make(forms, "Crop", NAME)
    elsewhere = _submit(other, {"farmer_name": "A", "village": "B"})

    user = {"user_id": "x", "permissions": ["forms.system.view"]}
    with pytest.raises(relationships.RelationshipError):
        relationships.validate_parent(user, form_service.get_form(pair["plot"]),
                                      elsewhere["survey_id"])


def test_an_independent_form_refuses_a_parent(pair):
    user = {"user_id": "x", "permissions": ["forms.system.view"]}
    farmer = _submit(pair["farmer"], {"farmer_name": "A", "village": "B"})

    with pytest.raises(relationships.RelationshipError):
        relationships.validate_parent(user, form_service.get_form(pair["farmer"]),
                                      farmer["survey_id"])


def test_self_parenting_is_refused(forms):
    farmer = _make(forms, "Farmer", NAME)
    definition = form_service.get_form(farmer)["form_json"]

    with pytest.raises(relationships.RelationshipError):
        relationships.check_configuration(
            farmer, {**definition, "relationship": {"type": "child",
                                                    "parent_form_id": farmer}})


def test_a_cycle_is_refused(forms):
    """A -> B -> C, and C cannot then become the parent of A."""
    a = _make(forms, "A", NAME)
    b = _make(forms, "B", NAME, relationship={"type": "child", "parent_form_id": a})
    c = _make(forms, "C", NAME, relationship={"type": "child", "parent_form_id": b})

    definition = form_service.get_form(a)["form_json"]
    with pytest.raises(relationships.RelationshipError):
        relationships.check_configuration(
            a, {**definition, "relationship": {"type": "child", "parent_form_id": c}})


def test_more_than_one_level_is_allowed(forms):
    """Farmer -> Plot -> Crop season is a real shape, and nothing forbids it."""
    farmer = _make(forms, "Farmer", NAME)
    plot = _make(forms, "Plot", PLOT,
                 relationship={"type": "child", "parent_form_id": farmer})
    season = _make(forms, "Season", PLOT,
                   relationship={"type": "child", "parent_form_id": plot})

    assert relationships.ancestry(season) == [season, plot, farmer]

    one = _submit(farmer, {"farmer_name": "A", "village": "B"})
    two = _submit(plot, {"plot_name": "Plot A", "area": 2}, parent=one["survey_id"])
    three = _submit(season, {"plot_name": "Kharif", "area": 1}, parent=two["survey_id"])

    assert three["parent_survey_id"] == two["survey_id"]


def test_a_parent_that_is_not_there_is_refused_at_configuration(forms):
    definition = form_service.get_form(_make(forms, "Orphan", NAME))["form_json"]

    with pytest.raises(relationships.RelationshipError):
        relationships.check_configuration(
            None, {**definition, "relationship": {"type": "child",
                                                  "parent_form_id": "FRM99999"}})


# --------------------------------------------------------------------------- #
# changing or removing a relationship
# --------------------------------------------------------------------------- #
def test_re_pointing_a_child_that_has_submissions_is_refused(pair, forms):
    farmer = _submit(pair["farmer"], {"farmer_name": "A", "village": "B"})
    _submit(pair["plot"], {"plot_name": "Plot A", "area": 2}, parent=farmer["survey_id"])

    other = _make(forms, "Other", NAME)
    definition = form_service.get_form(pair["plot"])["form_json"]

    with pytest.raises(relationships.RelationshipError) as refused:
        relationships.check_change_is_safe(
            pair["plot"], {**definition,
                           "relationship": {"type": "child", "parent_form_id": other}})

    assert "1 submission" in str(refused.value)


def test_making_a_child_independent_with_submissions_is_refused(pair):
    farmer = _submit(pair["farmer"], {"farmer_name": "A", "village": "B"})
    _submit(pair["plot"], {"plot_name": "Plot A", "area": 2}, parent=farmer["survey_id"])

    definition = dict(form_service.get_form(pair["plot"])["form_json"])
    definition.pop("relationship")

    with pytest.raises(relationships.RelationshipError):
        relationships.check_change_is_safe(pair["plot"], definition)


def test_becoming_a_child_is_always_safe(forms, pair):
    """Nothing to strand: the form has no linked submissions yet."""
    plain = _make(forms, "Plain", NAME)
    _submit(plain, {"farmer_name": "A", "village": "B"})

    definition = form_service.get_form(plain)["form_json"]
    relationships.check_change_is_safe(
        plain, {**definition,
                "relationship": {"type": "child", "parent_form_id": pair["farmer"]}})


def test_nothing_silently_rewrites_a_stored_parent(pair):
    farmer = _submit(pair["farmer"], {"farmer_name": "A", "village": "B"})
    plot = _submit(pair["plot"], {"plot_name": "Plot A", "area": 2},
                   parent=farmer["survey_id"])

    # Whatever else happens, the value stored stays the value stored.
    stored = submission_service.one_submission(
        form_service.get_form(pair["plot"]), plot["survey_id"])
    assert stored["parent_survey_id"] == farmer["survey_id"]


# --------------------------------------------------------------------------- #
# reading in both directions
# --------------------------------------------------------------------------- #
def test_a_parent_submission_lists_its_children(pair):
    admin = {"user_id": "a", "permissions": ["forms.system.view"]}
    farmer = _submit(pair["farmer"], {"farmer_name": "Prashant Kumar", "village": "ABC"})
    _submit(pair["plot"], {"plot_name": "Plot A", "area": 2}, parent=farmer["survey_id"])
    _submit(pair["plot"], {"plot_name": "Plot B", "area": 1.5}, parent=farmer["survey_id"])

    found = relationships.children_of(admin, pair["farmer"], farmer["survey_id"])

    assert len(found) == 1
    assert {s["form_data"]["plot_name"] for s in found[0]["submissions"]} == {"Plot A", "Plot B"}


def test_another_parents_children_are_not_listed(pair):
    admin = {"user_id": "a", "permissions": ["forms.system.view"]}
    one = _submit(pair["farmer"], {"farmer_name": "One", "village": "A"})
    two = _submit(pair["farmer"], {"farmer_name": "Two", "village": "B"})
    _submit(pair["plot"], {"plot_name": "Plot A", "area": 2}, parent=one["survey_id"])

    found = relationships.children_of(admin, pair["farmer"], two["survey_id"])
    assert found[0]["submissions"] == []


def test_a_child_submission_names_its_parent(pair):
    farmer = _submit(pair["farmer"], {"farmer_name": "Prashant Kumar", "village": "ABC"})
    plot = _submit(pair["plot"], {"plot_name": "Plot A", "area": 2},
                   parent=farmer["survey_id"])

    found = relationships.parent_of(pair["plot"], plot["survey_id"])

    assert found["survey_id"] == farmer["survey_id"]
    assert found["form_id"] == pair["farmer"]
    assert "Prashant Kumar" in found["summary"]


def test_an_independent_submission_has_no_parent(forms):
    plain = _make(forms, "Plain", NAME)
    made = _submit(plain, {"farmer_name": "A", "village": "B"})

    assert relationships.parent_of(plain, made["survey_id"]) is None


def test_child_forms_are_found_from_the_parent(pair):
    children = relationships.child_forms(pair["farmer"])

    assert [c["form_id"] for c in children] == [pair["plot"]]
    assert relationships.child_forms(pair["plot"]) == []


# --------------------------------------------------------------------------- #
# project isolation, and the permissions that were already there
# --------------------------------------------------------------------------- #
def test_a_relationship_cannot_cross_projects(forms, projects):
    mine = project_service.create_project(f"Mine {uuid.uuid4().hex[:5]}")["project_id"]
    theirs = project_service.create_project(f"Theirs {uuid.uuid4().hex[:5]}")["project_id"]
    projects.extend([mine, theirs])

    farmer = _make(forms, "Farmer", NAME, project=theirs)
    plot_json = form_service.get_form(_make(forms, "Plot", PLOT, project=mine))["form_json"]

    with pytest.raises(relationships.RelationshipError) as refused:
        relationships.check_configuration(
            None, {**plot_json, "relationship": {"type": "child",
                                                 "parent_form_id": farmer}},
            project_id=mine)

    assert "same place" in str(refused.value)


def test_a_project_form_cannot_hang_off_a_system_form(forms, projects):
    """The two are not each other's business, in either direction."""
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)

    system_form = _make(forms, "System", NAME)
    inside = form_service.get_form(_make(forms, "Inside", PLOT, project=project))["form_json"]

    with pytest.raises(relationships.RelationshipError):
        relationships.check_configuration(
            None, {**inside, "relationship": {"type": "child",
                                              "parent_form_id": system_form}},
            project_id=project)


def test_a_surveyor_is_offered_only_the_parents_they_may_read(forms, projects, people):
    """Their scope decides, not the relationship."""
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)

    shrishti, rekha = people("Shrishti"), people("Rekha")
    for person in (shrishti, rekha):
        project_service.add_member(project, person["user_id"], _role_id("surveyor"))

    farmer = _make(forms, "Farmer", NAME, project=project)
    plot = _make(forms, "Plot", PLOT, project=project,
                 relationship={"type": "child", "parent_form_id": farmer})

    hers = _submit(farmer, {"farmer_name": "Hers", "village": "A"},
                   by=auth_service.display_name(shrishti))
    theirs = _submit(farmer, {"farmer_name": "Theirs", "village": "B"},
                     by=auth_service.display_name(rekha))

    offered = relationships.parents_for(shrishti, plot)["submissions"]
    ids = [s["survey_id"] for s in offered]

    assert hers["survey_id"] in ids
    assert theirs["survey_id"] not in ids

    # And the one she was not offered is refused if she sends it anyway.
    with pytest.raises(relationships.RelationshipError):
        relationships.validate_parent(shrishti, form_service.get_form(plot),
                                      theirs["survey_id"])


def test_a_reviewer_may_read_every_parent_in_their_project(forms, projects, people):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)

    piyush = people("Piyush")
    project_service.add_member(project, piyush["user_id"], _role_id("reviewer"))

    farmer = _make(forms, "Farmer", NAME, project=project)
    plot = _make(forms, "Plot", PLOT, project=project,
                 relationship={"type": "child", "parent_form_id": farmer})
    made = _submit(farmer, {"farmer_name": "Somebody", "village": "A"}, by="Anybody")

    offered = relationships.parents_for(piyush, plot)["submissions"]
    assert made["survey_id"] in [s["survey_id"] for s in offered]


def test_a_reviewer_still_cannot_fill_the_child_form(forms, projects, people):
    """Being able to read a parent is not being able to add a child.

    The fill permission is unchanged and unrelated: this feature adds no way in.
    """
    from app.modules.projects import access

    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)

    piyush = people("Piyush")
    project_service.add_member(project, piyush["user_id"], _role_id("reviewer"))

    farmer = _make(forms, "Farmer", NAME, project=project)
    plot = _make(forms, "Plot", PLOT, project=project,
                 relationship={"type": "child", "parent_form_id": farmer})
    project_service.assign_form(plot, "everyone")

    assert access.may_fill_form(piyush, plot) is False
    api = client_for(piyush)
    made = _submit(farmer, {"farmer_name": "A", "village": "B"}, by="Anybody")
    assert api.post(f"/api/forms/{plot}/submissions",
                    json={"data": {"plot_name": "X", "area": 1},
                          "parent_survey_id": made["survey_id"]}).status_code == 404


def test_an_outsider_cannot_reach_a_parent_through_a_child(forms, projects, people):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)

    farmer = _make(forms, "Farmer", NAME, project=project)
    plot = _make(forms, "Plot", PLOT, project=project,
                 relationship={"type": "child", "parent_form_id": farmer})
    made = _submit(farmer, {"farmer_name": "A", "village": "B"})

    outsider = people("Nobody")
    api = client_for(outsider)

    assert api.get(f"/api/forms/{plot}/parent-options").status_code == 404
    assert api.get(
        f"/api/forms/{farmer}/records/{made['survey_id']}/children").status_code == 404
    with pytest.raises(relationships.RelationshipError):
        relationships.validate_parent(outsider, form_service.get_form(plot),
                                      made["survey_id"])


def test_a_project_manager_configures_relationships_in_their_own_project(
        forms, projects, people):
    project = project_service.create_project(f"P {uuid.uuid4().hex[:5]}")["project_id"]
    projects.append(project)

    prashant = people("Prashant")
    project_service.add_member(project, prashant["user_id"], _role_id("project_manager"))

    farmer = _make(forms, "Farmer", NAME, project=project)
    plot = _make(forms, "Plot", PLOT, project=project)

    api = client_for(prashant)
    definition = form_service.get_form(plot)["form_json"]
    saved = api.put(f"/api/forms/{plot}", json={"form_json": {
        **definition, "relationship": {"type": "child", "parent_form_id": farmer}}})

    assert saved.status_code == 200
    assert form_service.get_form(plot)["form_json"]["relationship"]["parent_form_id"] == farmer


def test_a_project_manager_cannot_configure_another_projects_form(
        forms, projects, people):
    mine = project_service.create_project(f"Mine {uuid.uuid4().hex[:5]}")["project_id"]
    theirs = project_service.create_project(f"Theirs {uuid.uuid4().hex[:5]}")["project_id"]
    projects.extend([mine, theirs])

    prashant = people("Prashant")
    project_service.add_member(mine, prashant["user_id"], _role_id("project_manager"))

    farmer = _make(forms, "Farmer", NAME, project=theirs)
    plot = _make(forms, "Plot", PLOT, project=theirs)

    definition = form_service.get_form(plot)["form_json"]
    answer = client_for(prashant).put(f"/api/forms/{plot}", json={"form_json": {
        **definition, "relationship": {"type": "child", "parent_form_id": farmer}}})

    assert answer.status_code == 404


# --------------------------------------------------------------------------- #
# through the API, as the browser drives it
# --------------------------------------------------------------------------- #
def test_the_endpoints_answer_the_whole_flow(pair, editor_client):
    api = editor_client

    farmer = api.post(f"/api/forms/{pair['farmer']}/submissions",
                      json={"data": {"farmer_name": "Prashant Kumar", "village": "ABC"}})
    assert farmer.status_code == 201
    parent_id = farmer.json()["survey_id"]

    # What the fill page offers instead of a box to type an id into.
    options = api.get(f"/api/forms/{pair['plot']}/parent-options").json()
    assert parent_id in [s["survey_id"] for s in options["submissions"]]
    assert "Prashant Kumar" in options["submissions"][0]["summary"]

    made = api.post(f"/api/forms/{pair['plot']}/submissions",
                    json={"data": {"plot_name": "Plot A", "area": 2},
                          "parent_survey_id": parent_id})
    assert made.status_code == 201
    assert made.json()["parent_survey_id"] == parent_id

    children = api.get(
        f"/api/forms/{pair['farmer']}/records/{parent_id}/children").json()
    assert children["children"][0]["submissions"][0]["form_data"]["plot_name"] == "Plot A"

    child_id = made.json()["survey_id"]
    parent = api.get(
        f"/api/forms/{pair['plot']}/records/{child_id}/parent").json()["parent"]
    assert parent["survey_id"] == parent_id
    assert parent["may_open"] is True

    shape = api.get(f"/api/forms/{pair['plot']}/relationship").json()
    assert shape["is_child"] is True
    assert shape["parent_form"]["form_id"] == pair["farmer"]
    assert api.get(f"/api/forms/{pair['farmer']}/relationship"
                   ).json()["child_forms"][0]["form_id"] == pair["plot"]


def test_the_api_refuses_a_bad_parent_with_a_clear_message(pair, editor_client):
    answer = editor_client.post(f"/api/forms/{pair['plot']}/submissions",
                                json={"data": {"plot_name": "X", "area": 1},
                                      "parent_survey_id": "nonsense"})

    assert answer.status_code == 422
    assert "parent_survey_id" in answer.json()["detail"]["errors"]


def test_nothing_here_deletes_a_child(pair):
    """There is no route that removes a submission, and the column is declared
    RESTRICT where the database can hold it — so a parent can never take its
    children with it."""
    from app.main import app

    paths = {route.path for route in app.routes}
    assert not [p for p in paths if p.endswith("/records/{survey_id}")
                and "delete" in p.lower()]

    farmer = _submit(pair["farmer"], {"farmer_name": "A", "village": "B"})
    _submit(pair["plot"], {"plot_name": "Plot A", "area": 2}, parent=farmer["survey_id"])
    assert relationships.count_children_stored(pair["plot"]) == 1


def test_no_relationship_code_decides_by_a_role_name():
    from pathlib import Path

    source = Path(relationships.__file__).read_text(encoding="utf-8")
    for name in ("surveyor", "reviewer", "project_manager", "admin"):
        assert f'== "{name}"' not in source
        assert f"== '{name}'" not in source


# --------------------------------------------------------------------------- #
# the forms row's own view of the relationship
#
# `form_type` and `parent_id` have been on this table since the beginning, and
# `config_validation` already refuses a child form that names no parent. They
# were never written, so the row said `parent` with a NULL parent while the
# definition said otherwise — and that rule never fired.
# --------------------------------------------------------------------------- #
def _row(form_id):
    with transaction() as cur:
        cur.execute(
            "SELECT form_type, parent_id, "
            "       form_json -> 'relationship' ->> 'parent_form_id' AS in_json "
            "FROM forms WHERE form_id = %s",
            (form_id,),
        )
        return dict(cur.fetchone())


def test_an_independent_form_says_so_on_its_row(forms):
    row = _row(_make(forms, "Plain", NAME))

    assert row["form_type"] == "parent"
    assert row["parent_id"] is None
    assert row["in_json"] is None


def test_a_form_created_as_a_child_says_so_on_its_row(pair):
    row = _row(pair["plot"])

    assert row["form_type"] == "child"
    assert row["parent_id"] == pair["farmer"]
    assert row["in_json"] == pair["farmer"]


def test_changing_a_form_to_a_child_updates_its_row(forms, pair):
    """The path through the builder: an existing independent form is edited."""
    plot = _make(forms, "Later", PLOT)
    assert _row(plot)["form_type"] == "parent"

    definition = form_service.get_form(plot)["form_json"]
    form_service.update_form(plot, {**definition, "relationship": {
        "type": "child", "parent_form_id": pair["farmer"]}})

    row = _row(plot)
    assert row["form_type"] == "child"
    assert row["parent_id"] == pair["farmer"]


def test_changing_a_form_back_clears_its_row(forms, pair):
    plot = _make(forms, "Later", PLOT,
                 relationship={"type": "child", "parent_form_id": pair["farmer"]})
    assert _row(plot)["form_type"] == "child"

    definition = dict(form_service.get_form(plot)["form_json"])
    definition.pop("relationship")
    form_service.update_form(plot, definition)

    row = _row(plot)
    assert row["form_type"] == "parent"
    assert row["parent_id"] is None


def test_the_row_and_the_definition_never_disagree(forms, pair):
    """The state this exists to prevent: the screen says child, the row says
    parent."""
    plot = _make(forms, "Later", PLOT)
    definition = form_service.get_form(plot)["form_json"]

    for relationship in ({"type": "child", "parent_form_id": pair["farmer"]},
                         {"type": "independent"},
                         {"type": "child", "parent_form_id": pair["plot"]}):
        form_service.update_form(plot, {**definition, "relationship": relationship})
        row = _row(plot)
        assert row["parent_id"] == row["in_json"]
        assert (row["form_type"] == "child") == bool(row["in_json"])


def test_becoming_a_child_gives_the_table_its_column(forms, pair):
    """The other half of the same edit: `sync_table` runs on update, so a form
    changed in the builder gets the column it now needs."""
    plot = _make(forms, "Later", PLOT)
    table = form_service.get_form(plot)["form_json"]["table_name"]

    with transaction() as cur:
        assert "parent_survey_id" not in _table_columns(cur, table)

    definition = form_service.get_form(plot)["form_json"]
    form_service.update_form(plot, {**definition, "relationship": {
        "type": "child", "parent_form_id": pair["farmer"]}})

    with transaction() as cur:
        assert "parent_survey_id" in _table_columns(cur, table)

    # And it works end to end straight away.
    parent = _submit(pair["farmer"], {"farmer_name": "A", "village": "B"})
    made = _submit(plot, {"plot_name": "Plot A", "area": 2}, parent=parent["survey_id"])
    assert made["parent_survey_id"] == parent["survey_id"]


def _table_columns(cur, table):
    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = %s",
        (table,),
    )
    return {row["column_name"] for row in cur.fetchall()}


def test_the_backfill_corrects_a_row_written_before_this(forms, pair):
    """A form configured while only the definition was written."""
    from app.modules.forms import bootstrap

    plot = _make(forms, "Legacy", PLOT,
                 relationship={"type": "child", "parent_form_id": pair["farmer"]})

    # Put the row back the way it used to be left.
    with transaction() as cur:
        cur.execute("UPDATE forms SET form_type = 'parent', parent_id = NULL "
                    "WHERE form_id = %s", (plot,))
    assert _row(plot)["form_type"] == "parent"

    assert bootstrap.ensure_relationship_columns() >= 1

    row = _row(plot)
    assert row["form_type"] == "child"
    assert row["parent_id"] == pair["farmer"]

    # And running it again changes nothing.
    assert bootstrap.ensure_relationship_columns() == 0


def test_a_parent_can_have_several_child_forms(forms, pair):
    """Found by configuration, never by name."""
    crops = _make(forms, "Crops", PLOT,
                  relationship={"type": "child", "parent_form_id": pair["farmer"]})
    kit = _make(forms, "Equipment", PLOT,
                relationship={"type": "child", "parent_form_id": pair["farmer"]})

    assert {c["form_id"] for c in relationships.child_forms(pair["farmer"])} == {
        pair["plot"], crops, kit}

    admin = {"user_id": "a", "permissions": ["forms.system.view"]}
    parent = _submit(pair["farmer"], {"farmer_name": "A", "village": "B"})
    _submit(crops, {"plot_name": "Maize", "area": 1}, parent=parent["survey_id"])

    sections = relationships.children_of(admin, pair["farmer"], parent["survey_id"])
    by_form = {s["form_id"]: s["submissions"] for s in sections}

    assert len(by_form) == 3
    assert [s["form_data"]["plot_name"] for s in by_form[crops]] == ["Maize"]
    assert by_form[pair["plot"]] == [] and by_form[kit] == []
