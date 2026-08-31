"""Walking the standards instead of searching them.

One endpoint, one shape, three vocabularies of different depths — and the depth
comes from the data rather than from anything written down here. These tests say
what the shape is, and that a level appears only where there is something to
choose.
"""
import pytest

from app.core import registry
from app.core.database import ping
from app.modules.standards.icasa import variable_service as icasa
from app.modules.standards.seont import concept_service as seont

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

BROWSE = "/api/standards/browse"

needs_icasa = pytest.mark.skipif(
    "standards" in registry.disabled() or not icasa.categories("ICASA"),
    reason="ICASA has not been imported - run: python import_icasa.py",
)
needs_seont = pytest.mark.skipif(
    "ontology" in registry.disabled() or not seont.roots("SEOnt"),
    reason="SEOnt has not been imported - run: python import_ontology.py",
)


def _walk(client, *path):
    answer = client.get(BROWSE, params={"p": list(path)})
    assert answer.status_code == 200, answer.text
    return answer.json()


def _labels(node):
    return [option["label"] for option in node["level"]["options"]]


# --- the shape, whatever the path ------------------------------------------- #
def test_the_root_offers_the_standards_that_are_installed(editor_client):
    client = editor_client
    node = _walk(client)

    assert node["path"] == []
    assert node["items"] is None
    assert node["level"]["label"] == "Standard"
    # Every option says whether going into it leads anywhere.
    for option in node["level"]["options"]:
        assert set(option) == {"value", "label", "hint", "has_children"}


def test_every_answer_has_the_same_three_keys(editor_client):
    """A screen renders any depth of any vocabulary without knowing which."""
    client = editor_client

    for path in ([], ["icasa:ICASA"], ["crop"]):
        node = _walk(client, *path)
        assert set(node) >= {"path", "level", "items"}


def test_a_standard_nobody_has_heard_of_is_not_there(editor_client):
    client = editor_client
    assert client.get(BROWSE, params={"p": ["nonsense"]}).status_code == 404


# --- ICASA: standard -> category -> subcategory -> variables ---------------- #
@needs_icasa
def test_icasa_offers_its_categories(editor_client):
    client = editor_client
    node = _walk(client, "icasa:ICASA")

    assert node["level"]["label"] == "Category"
    assert len(node["level"]["options"]) > 5
    # Read, not shouted: ICASA files things under IRRIGATIONS.
    assert "Irrigations" in _labels(node)
    assert "IRRIGATIONS" not in _labels(node)


@needs_icasa
def test_a_category_with_subcategories_offers_them_and_its_own_variables(editor_client):
    client = editor_client
    node = _walk(client, "icasa:ICASA", "IRRIGATIONS")

    assert node["level"]["label"] == "Subcategory"
    assert "Automatic irrig" in _labels(node)
    # A parent category has variables of its own as well as children.
    assert node["items"]["kind"] == "icasa"
    assert len(node["items"]["rows"]) > 0


@needs_icasa
def test_a_category_with_nothing_under_it_is_the_end_of_the_road(editor_client):
    """Depth is per branch, not per vocabulary — DOCUMENTS stops one level
    earlier than IRRIGATIONS, and the answer says so."""
    client = editor_client
    node = _walk(client, "icasa:ICASA", "DOCUMENTS")

    assert node["level"] is None
    assert len(node["items"]["rows"]) > 0


@needs_icasa
def test_the_deepest_icasa_path_lists_that_subcategory(editor_client):
    client = editor_client
    node = _walk(client, "icasa:ICASA", "IRRIGATIONS", "AUTOMATIC_IRRIG")

    assert node["level"] is None
    assert [c["label"] for c in node["path"]] == [
        "ICASA", "Irrigations", "Automatic irrig"]
    for row in node["items"]["rows"]:
        assert row["category"] == "IRRIGATIONS / AUTOMATIC_IRRIG"


@needs_icasa
def test_a_browsed_variable_is_shaped_like_a_searched_one(editor_client):
    """So the same row can be rendered, and attached to a field, either way."""
    client = editor_client
    browsed = _walk(client, "icasa:ICASA", "DOCUMENTS")["items"]["rows"][0]
    searched = icasa.search(browsed["name"], limit=1)

    assert searched, browsed["name"]
    assert set(browsed) == set(searched[0])


# --- SEOnt: as deep as the ontology goes ------------------------------------ #
@needs_seont
def test_an_ontology_starts_at_the_concepts_nothing_is_above(editor_client):
    client = editor_client
    node = _walk(client, "seont:SEOnt")

    assert node["level"]["label"] == "Concept"
    assert "entity" in _labels(node)


@needs_seont
def test_a_concept_can_be_descended_into_indefinitely(editor_client):
    """No fixed number of levels: the path grows one concept id at a time for as
    long as the ontology has children to offer."""
    client = editor_client

    path = ["seont:SEOnt"]
    node = _walk(client, *path)
    depth = 0

    while node["level"] and node["level"]["options"] and depth < 6:
        deeper = next((o for o in node["level"]["options"] if o["has_children"]),
                      node["level"]["options"][0])
        path.append(deeper["value"])
        node = _walk(client, *path)
        depth += 1

    assert depth >= 3, "the ontology should go deeper than a fixed two levels"
    assert len(node["path"]) == len(path)


@needs_seont
def test_a_concept_that_is_not_there_is_a_404(editor_client):
    client = editor_client
    assert client.get(BROWSE, params={"p": ["seont:SEOnt", "99999999"]}).status_code == 404


# --- Crop Ontology: crop -> trait -> variables ------------------------------ #
def test_crop_ontology_asks_for_the_crop_first(editor_client):
    client = editor_client
    root = _walk(client)
    if "Crop Ontology" not in _labels(root):
        pytest.skip("no crop ontology imported")

    node = _walk(client, "crop")
    assert node["level"]["label"] == "Crop"
    assert node["items"] is None


def test_a_crop_leads_to_traits_and_a_trait_to_variables(editor_client):
    client = editor_client
    root = _walk(client)
    if "Crop Ontology" not in _labels(root):
        pytest.skip("no crop ontology imported")

    crops = _walk(client, "crop")["level"]["options"]
    traits = _walk(client, "crop", crops[0]["value"])
    assert traits["level"]["label"] == "Trait"

    trait = traits["level"]["options"][0]
    node = _walk(client, "crop", crops[0]["value"], trait["value"])
    assert node["level"] is None
    assert node["items"]["kind"] == "crop"
    assert all(row["trait_id"] == trait["value"] for row in node["items"]["rows"])


# --- finding a mapping a field already carries ------------------------------ #
@needs_icasa
def test_a_saved_icasa_mapping_is_found_in_the_tree(editor_client):
    """A field stores the identifier and never the path, so the path is worked
    out — which is what lets a reimport file it somewhere else safely."""
    client = editor_client
    variable = _walk(client, "icasa:ICASA", "IRRIGATIONS", "AUTOMATIC_IRRIG"
                     )["items"]["rows"][0]

    found = client.get(f"{BROWSE}/locate", params={
        "kind": "icasa", "id": variable["external_id"], "standard": "ICASA"})
    assert found.status_code == 200
    assert found.json()["path"] == ["icasa:ICASA", "IRRIGATIONS", "AUTOMATIC_IRRIG"]

    # And walking that path lands back on the same variable.
    node = _walk(client, *found.json()["path"])
    assert variable["external_id"] in [r["external_id"] for r in node["items"]["rows"]]


@needs_seont
def test_a_saved_concept_is_found_with_its_ancestors(editor_client):
    client = editor_client
    roots = seont.roots("SEOnt")
    parent = next(c for c in roots if c["child_count"])
    child = seont.children(parent["concept_id"])[0]

    found = client.get(f"{BROWSE}/locate",
                       params={"kind": "seont", "uri": child["concept_uri"]})
    assert found.status_code == 200

    path = found.json()["path"]
    assert path[0] == "seont:SEOnt"
    assert path[-1] == str(child["concept_id"])
    # The whole branch, so every dropdown above it can be drawn.
    assert str(parent["concept_id"]) in path


def test_a_mapping_that_is_no_longer_imported_is_a_404_not_a_crash(editor_client):
    """The mapping on the field stays true; only its position is unknown."""
    client = editor_client
    assert client.get(f"{BROWSE}/locate", params={
        "kind": "icasa", "id": "no-such-variable", "standard": "ICASA"}).status_code == 404


def test_a_crop_mapping_needs_no_lookup_at_all(editor_client):
    """Both halves of the path are already on the field."""
    client = editor_client
    found = client.get(f"{BROWSE}/locate", params={
        "kind": "crop", "ontology": "CO_370", "id": "CO_370:0000989"})

    if found.status_code == 403:
        pytest.skip("the crop ontology is not readable by this account")
    assert found.json()["path"] == ["crop", "CO_370", "CO_370:0000989"]


# --- who may see what ------------------------------------------------------- #
def test_browsing_needs_a_session(editor_client):
    from fastapi.testclient import TestClient

    from app.main import app
    assert TestClient(app).get(BROWSE).status_code == 401


def test_a_vocabulary_an_account_cannot_read_is_not_offered(people_free_client):
    """The permissions are each vocabulary's own — this module has none, and
    grants nothing."""
    client = people_free_client
    node = client.get(BROWSE).json()

    assert node["level"]["options"] == []
    # And is not reachable by typing its path either.
    assert client.get(BROWSE, params={"p": ["icasa:ICASA"]}).status_code == 403


@pytest.fixture
def people_free_client():
    """An account holding no standards permission at all."""
    import uuid

    from fastapi.testclient import TestClient

    from app.core import auth_service
    from app.core.database import transaction
    from app.main import app

    email = f"plain.{uuid.uuid4().hex[:8]}@example.test"
    user = auth_service.create_user(email, "correct horse battery",
                                    role="standard", full_name="Plain")
    token = auth_service.login(email, "correct horse battery")["token"]

    yield TestClient(app, headers={"Authorization": f"Bearer {token}"})

    with transaction() as cur:
        cur.execute("DELETE FROM app_user WHERE user_id = %s", (user["user_id"],))
