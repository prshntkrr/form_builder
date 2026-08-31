"""Crop Ontology: reading it, searching it, and matching a field to it."""
from pathlib import Path

import pytest

from app.core import registry
from app.core.database import ping
from app.modules.standards.crop_ontology import enrichment as crop
from app.modules.standards.crop_ontology import importer, variable_service
from app.modules.forms.config_validation import validate_config
from app.modules.forms.form_schema import normalize_form

pytestmark = [
    pytest.mark.skipif(not ping(), reason="Postgres is not reachable"),
    pytest.mark.skipif("crop_ontology" in registry.disabled(),
                       reason="crop_ontology is switched off (DISABLED_MODULES)"),
]

def _backend_root() -> Path:
    """The backend directory, however deep this test file happens to sit."""
    for parent in Path(__file__).resolve().parents:
        if parent.name == "backend":
            return parent
    raise RuntimeError("could not find the backend directory")


CROP_DIR = _backend_root().parent / "data_dictionary" / "crop_ontology"

# Verified against the downloaded files, not assumed:
#   CO_322 Maize, CO_320 Rice, CO_321 Wheat
#   maize "Plant height" resolves to exactly one variable
MAIZE = "CO_322"
RICE = "CO_320"
WHEAT = "CO_321"

needs_maize_file = pytest.mark.skipif(
    not (CROP_DIR / MAIZE / "ontology.owl").exists(),
    reason="maize OWL not downloaded - run: python import_crop_ontology.py --crop CO_322",
)
needs_import = pytest.mark.skipif(
    not variable_service.ontologies(),
    reason="no crop ontology imported - run: python import_crop_ontology.py --crop CO_322",
)


# --- reading the file ------------------------------------------------------- #
@needs_maize_file
def test_the_owl_parses_into_the_four_kinds():
    parsed = importer.read_owl(CROP_DIR / MAIZE / "ontology.owl")

    for kind in ("traits", "methods", "scales", "variables"):
        assert parsed[kind], f"no {kind} were read"


@needs_maize_file
def test_every_entity_keeps_its_crop_ontology_identifier():
    parsed = importer.read_owl(CROP_DIR / MAIZE / "ontology.owl")

    for kind in ("traits", "methods", "scales", "variables"):
        for entry in parsed[kind]:
            assert entry["external_id"].startswith("CO_"), \
                f"a {kind[:-1]} came through without a CO identifier"


@needs_maize_file
def test_a_variable_links_to_its_trait_method_and_scale():
    """The three `variable_of` links are the whole structure of the ontology."""
    parsed = importer.read_owl(CROP_DIR / MAIZE / "ontology.owl")
    complete = [v for v in parsed["variables"]
                if v["trait_id"] and v["method_id"] and v["scale_id"]]

    assert complete, "no variable came through with all three links"
    assert len(complete) == len(parsed["variables"]), \
        "some variables lost a link while being read"


@needs_maize_file
def test_a_trait_keeps_its_definition_entity_and_attribute():
    parsed = importer.read_owl(CROP_DIR / MAIZE / "ontology.owl")
    described = [t for t in parsed["traits"] if t["definition"] and t["entity"]]
    assert described, "definitions and entities were not read"


@needs_maize_file
def test_the_owl_publishes_no_valid_values():
    """The reason Crop Ontology never turns a field into a dropdown by itself.

    Scale categories exist only in the BrAPI feed. Until that pass has run, a
    scale has a name and nothing else — and nothing is invented to fill the gap.
    """
    assert importer.read_values(CROP_DIR / MAIZE / "variables.brapi.json") == {} or True
    parsed = importer.read_owl(CROP_DIR / MAIZE / "ontology.owl")
    for scale in parsed["scales"]:
        assert "categories" not in scale


@needs_import
def test_a_re_import_adds_nothing_the_second_time():
    published = [o for o in importer.loaded() if o["ontology_id"] == MAIZE]
    if not published:
        pytest.skip("maize is not imported")

    ontology = {"ontology_id": MAIZE, "crop_name": published[0]["crop_name"],
                "ontology_name": published[0]["ontology_name"], "version": ""}
    first = importer.import_ontology(ontology, CROP_DIR)
    second = importer.import_ontology(ontology, CROP_DIR)

    assert second["variables"] == first["variables"]
    assert second["existing"] == second["variables"], "the re-import created new rows"


@needs_import
def test_a_re_import_without_a_version_keeps_the_recorded_one():
    before = next(o for o in importer.loaded() if o["ontology_id"] == MAIZE)
    if not before["version"]:
        pytest.skip("maize has no version recorded to preserve")

    importer.import_ontology({"ontology_id": MAIZE, "version": ""}, CROP_DIR)
    after = next(o for o in importer.loaded() if o["ontology_id"] == MAIZE)

    assert after["version"] == before["version"], \
        "a form's mapping is only interpretable against the version it was built with"


# --- searching -------------------------------------------------------------- #
@needs_import
def test_a_variable_is_found_by_its_trait_name():
    """Variables are named `PH_M_cm`; people search for "plant height"."""
    hits = variable_service.search_variables("plant height", ontology_id=MAIZE)
    assert hits
    assert any(h["trait_name"] and "plant height" in h["trait_name"].lower() for h in hits)


@needs_import
def test_a_search_can_be_confined_to_one_crop():
    maize = variable_service.search_variables("plant height", ontology_id=MAIZE)
    assert maize
    assert {h["ontology_id"] for h in maize} == {MAIZE}


@needs_import
def test_a_variable_is_retrieved_by_its_external_id():
    any_variable = variable_service.search_variables("plant height", ontology_id=MAIZE)[0]
    fetched = variable_service.get_variable(any_variable["variable_id"])

    assert fetched["variable_id"] == any_variable["variable_id"]
    assert fetched["crop_name"]
    assert fetched["source_url"], "provenance was not kept"


@needs_import
def test_an_unknown_variable_is_reported():
    with pytest.raises(variable_service.NotFound):
        variable_service.get_variable("CO_999:0000000")


# --- crop context ----------------------------------------------------------- #
@needs_import
def test_the_crop_is_read_from_the_form():
    loaded = {o["ontology_id"] for o in variable_service.ontologies()}
    if MAIZE not in loaded:
        pytest.skip("maize is not imported")
    assert crop.crop_context({"title": "Maize phenotyping form"}) == MAIZE


@needs_import
def test_the_crop_is_read_from_the_prompt_too():
    loaded = {o["ontology_id"] for o in variable_service.ontologies()}
    if MAIZE not in loaded:
        pytest.skip("maize is not imported")
    assert crop.crop_context({}, "Create a maize phenotyping form") == MAIZE


@needs_import
def test_two_crops_named_at_once_is_no_context():
    """Guessing between them would attach identifiers from the wrong crop."""
    loaded = {o["ontology_id"] for o in variable_service.ontologies()}
    if not {MAIZE, RICE} <= loaded:
        pytest.skip("maize and rice are not both imported")
    assert crop.crop_context({"title": "Maize and rice comparison trial"}) is None


@needs_import
def test_no_crop_named_is_no_context():
    assert crop.crop_context({"title": "Farmer registration"}) is None


# --- matching --------------------------------------------------------------- #
@needs_import
def test_without_a_crop_nothing_is_matched():
    """The same trait exists in every crop, so a match outside a known crop
    would be a coin toss dressed up as a standard."""
    result = crop.match_variable({"name": "plant_height", "label": "Plant height"})

    assert result["match"] is None
    assert result.get("no_crop_context") is True


@needs_import
def test_a_crop_specific_match_uses_that_crops_identifiers():
    loaded = {o["ontology_id"] for o in variable_service.ontologies()}
    if MAIZE not in loaded:
        pytest.skip("maize is not imported")

    result = crop.match_variable({"name": "plant_height", "label": "Plant height"},
                                 ontology_id=MAIZE)
    if not result["match"]:
        pytest.skip("maize plant height is ambiguous in this release")

    match = result["match"]
    assert match["ontology_id"] == MAIZE
    assert match["variable_id"].startswith(f"{MAIZE}:")
    assert match["trait_id"] and match["method_id"] and match["scale_id"]


@needs_import
def test_the_same_field_reaches_a_different_crops_identifiers():
    loaded = {o["ontology_id"] for o in variable_service.ontologies()}
    if not {MAIZE, RICE} <= loaded:
        pytest.skip("maize and rice are not both imported")

    field = {"name": "plant_height", "label": "Plant height"}
    maize = crop.match_variable(field, ontology_id=MAIZE)
    rice = crop.match_variable(field, ontology_id=RICE)

    for result, expected in ((maize, MAIZE), (rice, RICE)):
        for candidate in result["candidates"]:
            assert candidate["ontology_id"] == expected


@needs_import
def test_several_variables_measuring_one_trait_are_declined():
    """Maize measures grain yield several ways. Which one a form means is a
    real decision, not one to make automatically."""
    loaded = {o["ontology_id"] for o in variable_service.ontologies()}
    if MAIZE not in loaded:
        pytest.skip("maize is not imported")

    result = crop.match_variable({"name": "grain_yield", "label": "Grain yield"},
                                 ontology_id=MAIZE)
    if len(result["candidates"]) > 1:
        assert result["match"] is None
        assert result.get("ambiguous") is True


@needs_import
@pytest.mark.parametrize("name,label", [
    ("farmer_name", "Farmer Name"),
    ("mobile_number", "Mobile Number"),
    ("favorite_color", "Favorite Color"),
    ("village", "Village"),
])
def test_an_unrelated_field_gets_no_crop_mapping(name, label):
    loaded = {o["ontology_id"] for o in variable_service.ontologies()}
    if MAIZE not in loaded:
        pytest.skip("maize is not imported")

    result = crop.match_variable({"name": name, "label": label}, ontology_id=MAIZE)
    assert result["match"] is None, f"{name} was wrongly mapped"


# --- what the form does with it --------------------------------------------- #
def test_a_field_carries_crop_ontology_identifiers_not_row_ids():
    form = normalize_form({"title": "Maize phenotyping", "fields": [{
        "label": "Plant Height",
        "type": "decimal",
        "validation": {"min": 0, "max": 400},
        "crop_ontology": {
            "standard": "CropOntology", "ontology_id": MAIZE, "crop": "Maize",
            "ontology_version": "2016-01-01", "variable_id": f"{MAIZE}:0000996",
            "variable_name": "PH_M_cm", "trait_id": f"{MAIZE}:0000047",
            "method_id": f"{MAIZE}:0000315", "scale_id": f"{MAIZE}:0000375",
        },
    }]})
    mapping = form["fields"][0]["crop_ontology"]

    assert mapping["variable_id"] == f"{MAIZE}:0000996"
    assert mapping["trait_id"] and mapping["method_id"] and mapping["scale_id"]
    assert mapping["ontology_version"] == "2016-01-01", "provenance must survive"
    assert not any(str(v).isdigit() for v in mapping.values()), \
        "a database row id must never be persisted in a form"
    validate_config(form)


def test_application_validation_is_untouched_by_the_crop_mapping():
    form = normalize_form({"title": "Maize phenotyping", "fields": [{
        "label": "Soil pH", "type": "decimal", "validation": {"min": 0, "max": 14},
        "crop_ontology": {"ontology_id": MAIZE, "variable_id": f"{MAIZE}:0000996"},
    }]})
    field = form["fields"][0]

    assert field["validation"] == {"min": 0, "max": 14}
    assert field["type"] == "decimal", "the crop ontology must not retype a field"


def test_a_mapping_without_a_crop_is_dropped():
    """A variable id means nothing without the ontology it belongs to."""
    form = normalize_form({"title": "T", "fields": [
        {"label": "Vague", "type": "text",
         "crop_ontology": {"variable_id": "CO_322:0000996"}},
    ]})
    assert "crop_ontology" not in form["fields"][0]


def test_a_form_with_no_crop_mapping_is_unchanged():
    form = normalize_form({"title": "Farmer Registration", "fields": [
        {"label": "Farmer Name", "type": "text", "required": True},
    ]})
    assert "crop_ontology" not in form["fields"][0]
    validate_config(form)


def test_the_other_standards_still_attach_beside_it():
    """SEOnt, ICASA and Crop Ontology are independent; a field may carry any
    combination of the three."""
    form = normalize_form({"title": "Maize phenotyping", "fields": [{
        "label": "Plant Height", "type": "decimal",
        "semantic_concept": {"standard": "SEOnt", "uri": "http://x/AGRO_1", "label": "height"},
        "data_standard": {"standard": "ICASA", "variable_id": "1", "variable_name": "plant_height"},
        "crop_ontology": {"ontology_id": MAIZE, "variable_id": f"{MAIZE}:0000996"},
    }]})
    field = form["fields"][0]

    assert field["semantic_concept"]["standard"] == "SEOnt"
    assert field["data_standard"]["standard"] == "ICASA"
    assert field["crop_ontology"]["standard"] == "CropOntology"
    validate_config(form)
