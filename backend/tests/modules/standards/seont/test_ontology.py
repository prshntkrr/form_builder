"""Reading an ontology, and using it to shape a form."""
from pathlib import Path

import pytest

from app.core import registry
from app.core.database import ping
from app.modules.forms.config_validation import validate_config
from app.modules.forms.form_schema import normalize_form
from app.modules.standards.seont import concept_service, importer

pytestmark = [
    pytest.mark.skipif(not ping(), reason="Postgres is not reachable"),
    pytest.mark.skipif("ontology" in registry.disabled(),
                       reason="ontology is switched off (DISABLED_MODULES)"),
]

def _backend_root() -> Path:
    """The backend directory, however deep this test file happens to sit."""
    for parent in Path(__file__).resolve().parents:
        if parent.name == "backend":
            return parent
    raise RuntimeError("could not find the backend directory")


SEONT = _backend_root().parent / "data_dictionary" / "seont.owl"

# The two concepts the whole design turns on: one that can back a dropdown, and
# one that carries meaning but no values.
IRRIGATION_SOURCE = "http://purl.obolibrary.org/obo/AGRO_00000009"
IRRIGATION_METHOD = "http://purl.obolibrary.org/obo/AGRO_00000054"
LAKE = "http://purl.obolibrary.org/obo/ENVO_00000020"
DEPRESSION = "http://purl.obolibrary.org/obo/ENVO_00000309"

needs_file = pytest.mark.skipif(not SEONT.exists(), reason="seont.owl is not present")
needs_import = pytest.mark.skipif(
    not concept_service.get_by_uri(IRRIGATION_SOURCE),
    reason="SEOnt has not been imported - run: python import_ontology.py",
)


# --- reading the file ------------------------------------------------------- #
@needs_file
def test_the_file_parses():
    concepts, relations, triples = importer.read_file(SEONT)
    assert triples > 0, "no triples were read"
    assert len(concepts) > 0
    assert len(relations) > 0


@needs_file
def test_named_concepts_are_read_with_their_label_and_definition():
    concepts, _, _ = importer.read_file(SEONT)
    by_uri = {c["concept_uri"]: c for c in concepts}

    assert by_uri[IRRIGATION_SOURCE]["label"] == "irrigation source"
    assert by_uri[IRRIGATION_SOURCE]["definition"], "the definition was not picked up"


@needs_file
def test_blank_nodes_are_never_concepts():
    """An anonymous class is an OWL restriction. It has no URI, so it can be
    neither referenced by a form nor shown to anyone."""
    concepts, relations, _ = importer.read_file(SEONT)

    assert all(c["concept_uri"].startswith("http") for c in concepts)
    for parent, child in relations:
        assert parent.startswith("http") and child.startswith("http")


@needs_file
def test_subclass_links_are_read():
    _, relations, _ = importer.read_file(SEONT)
    assert (IRRIGATION_SOURCE, LAKE) in relations
    assert (IRRIGATION_SOURCE, DEPRESSION) in relations


# --- storing it ------------------------------------------------------------- #
@needs_file
def test_importing_twice_adds_nothing_the_second_time():
    first = importer.import_file(SEONT)
    second = importer.import_file(SEONT)

    assert second["concepts_in_file"] == first["concepts_in_file"]
    assert second["concepts_added"] == 0, "the second import duplicated concepts"
    assert second["relations_added"] == 0, "the second import duplicated relations"


@needs_import
def test_a_concept_is_searchable_whatever_the_case():
    lower = concept_service.search("irrigation source")
    upper = concept_service.search("IRRIGATION SOURCE")

    assert [c["concept_uri"] for c in lower] == [c["concept_uri"] for c in upper]
    assert lower[0]["concept_uri"] == IRRIGATION_SOURCE, "an exact match should come first"


@needs_import
def test_searching_for_nothing_returns_nothing():
    assert concept_service.search("") == []
    assert concept_service.search("   ") == []


# --- children --------------------------------------------------------------- #
@needs_import
def test_a_concept_with_children_offers_them():
    source = concept_service.get_by_uri(IRRIGATION_SOURCE)
    labels = {c["label"] for c in concept_service.children(source["concept_id"])}
    assert labels == {"lake", "depression"}


@needs_import
def test_a_concept_without_children_returns_an_empty_list():
    """Not a failure. Plenty of concepts mean something without listing values."""
    method = concept_service.get_by_uri(IRRIGATION_METHOD)
    assert concept_service.children(method["concept_id"]) == []


@needs_import
def test_children_come_back_shaped_as_options():
    source = concept_service.get_by_uri(IRRIGATION_SOURCE)
    options = concept_service.as_options(source["concept_id"])

    assert {o["label"] for o in options} == {"lake", "depression"}
    assert all(o["ontology_uri"].startswith("http") for o in options)
    lake = next(o for o in options if o["label"] == "lake")
    assert lake["value"] == "lake", "the stored value is readable, not a URI"
    assert lake["ontology_uri"] == LAKE


@needs_import
def test_an_unknown_concept_is_reported():
    with pytest.raises(concept_service.ConceptNotFound):
        concept_service.children(9_999_999)


# --- what a form does with it ----------------------------------------------- #
def test_a_field_can_carry_a_concept():
    form = normalize_form({
        "title": "Plot Survey",
        "fields": [{
            "label": "Irrigation Source",
            "type": "select",
            "option_source": "ontology",
            "semantic_concept": {"standard": "SEOnt", "uri": IRRIGATION_SOURCE,
                                 "label": "irrigation source"},
            "options": [
                {"label": "lake", "value": "lake", "ontology_uri": LAKE},
                {"label": "depression", "value": "depression", "ontology_uri": DEPRESSION},
            ],
        }],
    })
    field = form["fields"][0]

    assert field["semantic_concept"]["uri"] == IRRIGATION_SOURCE
    assert field["semantic_concept"]["standard"] == "SEOnt"
    assert field["option_source"] == "ontology"
    assert field["options"][0]["ontology_uri"] == LAKE, \
        "an answer must be traceable to the concept it came from"
    validate_config(form)


def test_a_manual_dropdown_is_untouched():
    form = normalize_form({
        "title": "Plot Survey",
        "fields": [{"label": "Crop", "type": "select", "options": ["Wheat", "Rice", "Maize"]}],
    })
    field = form["fields"][0]

    assert [o["label"] for o in field["options"]] == ["Wheat", "Rice", "Maize"]
    assert "ontology_uri" not in field["options"][0]
    assert "option_source" not in field, "a manual field carries no ontology keys at all"
    validate_config(form)


def test_a_form_with_no_ontology_anywhere_is_unchanged():
    """The keys are optional. Every form built before this feature still works."""
    form = normalize_form({
        "title": "Farmer Registration",
        "fields": [
            {"label": "Farmer Name", "type": "text", "required": True},
            {"label": "Age", "type": "number", "validation": {"min": 0, "max": 120}},
        ],
    })

    for field in form["fields"]:
        assert "semantic_concept" not in field
        assert "option_source" not in field
    assert form["fields"][1]["validation"] == {"min": 0, "max": 120}, \
        "the rules stay with the data dictionary, not the ontology"
    validate_config(form)


def test_a_concept_without_values_leaves_the_choices_manual():
    """Picking "irrigation method" means something, but supplies nothing to pick
    from - so the field keeps whatever choices were typed in."""
    form = normalize_form({
        "title": "Plot Survey",
        "fields": [{
            "label": "Irrigation Method",
            "type": "select",
            "semantic_concept": {"standard": "SEOnt", "uri": IRRIGATION_METHOD},
            "options": ["Drip", "Sprinkler"],
        }],
    })
    field = form["fields"][0]

    assert field["semantic_concept"]["uri"] == IRRIGATION_METHOD
    assert "option_source" not in field, "nothing came from the ontology"
    assert [o["label"] for o in field["options"]] == ["Drip", "Sprinkler"]
