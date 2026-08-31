"""Crop and feature choices, read from the local database rather than invented."""
import socket

import pytest

from app.core import registry
from app.core.database import ping
from app.modules.standards.crop_ontology import dynamic_options
from app.modules.standards.crop_ontology import enrichment as crop
from app.modules.standards.crop_ontology import variable_service
from app.modules.forms.config_validation import validate_config
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.submission_service import ValidationFailed, validate_payload

pytestmark = [
    pytest.mark.skipif(not ping(), reason="Postgres is not reachable"),
    pytest.mark.skipif("crop_ontology" in registry.disabled(),
                       reason="crop_ontology is switched off (DISABLED_MODULES)"),
]

MAIZE = "CO_322"
RICE = "CO_320"

needs_import = pytest.mark.skipif(
    not variable_service.ontologies(),
    reason="no crop ontology imported - run: python import_crop_ontology.py --crop CO_322",
)


@pytest.fixture
def no_network():
    """Fail loudly on any outbound connection, allowing local Postgres."""
    real = socket.socket.connect
    reached = []

    def guard(self, address):
        host = address[0] if isinstance(address, tuple) else str(address)
        if host not in ("127.0.0.1", "::1", "localhost"):
            reached.append(host)
            raise AssertionError(f"an external request was made to {host}")
        return real(self, address)

    socket.socket.connect = guard
    try:
        yield reached
    finally:
        socket.socket.connect = real


# --- where the choices come from -------------------------------------------- #
@needs_import
def test_crop_choices_are_the_imported_ontologies(no_network):
    options = dynamic_options.crop_options()
    imported = {o["ontology_id"] for o in variable_service.ontologies()}

    assert options, "no crops were offered"
    assert {o["value"] for o in options} <= imported, \
        "a crop was offered that is not imported"
    assert all(o["value"].startswith("CO_") for o in options), \
        "the value must be the ontology's own identifier"


@needs_import
def test_choosing_maize_reads_maize_traits(no_network):
    loaded = {o["ontology_id"] for o in variable_service.ontologies()}
    if MAIZE not in loaded:
        pytest.skip("maize is not imported")

    options = dynamic_options.trait_options(MAIZE)
    assert options
    assert all(o["value"].startswith(f"{MAIZE}:") for o in options), \
        "maize features must carry maize identifiers"


@needs_import
def test_choosing_rice_reads_rice_traits(no_network):
    loaded = {o["ontology_id"] for o in variable_service.ontologies()}
    if RICE not in loaded:
        pytest.skip("rice is not imported")

    options = dynamic_options.trait_options(RICE)
    assert options
    assert all(o["value"].startswith(f"{RICE}:") for o in options)


@needs_import
def test_the_two_crops_offer_different_features():
    loaded = {o["ontology_id"] for o in variable_service.ontologies()}
    if not {MAIZE, RICE} <= loaded:
        pytest.skip("maize and rice are not both imported")

    maize = {o["value"] for o in dynamic_options.trait_options(MAIZE)}
    rice = {o["value"] for o in dynamic_options.trait_options(RICE)}
    assert not (maize & rice), "an identifier cannot belong to two crops"


def test_no_crop_chosen_offers_no_features():
    """A trait list is meaningless without a crop, so none is offered."""
    assert dynamic_options.trait_options(None) == []
    assert dynamic_options.trait_options("") == []


@needs_import
def test_nothing_reaches_cropontology_org(no_network):
    """Every choice comes from PostgreSQL. The importer is the only thing that
    ever talks to the source, and it is run by hand."""
    dynamic_options.crop_options()
    dynamic_options.trait_options(MAIZE)
    dynamic_options.options_for("crop")
    assert no_network == []


# --- rewiring what the model produced --------------------------------------- #
def test_invented_crop_choices_are_replaced():
    """The model writes whatever crops it knows. This installation's crops are
    whichever ontologies were imported, which is not the same list."""
    draft = {"fields": [
        {"name": "selected_crop", "label": "Selected Crop", "type": "select",
         "options": [{"label": "Wheat", "value": "wheat"},
                     {"label": "Corn", "value": "corn"}]},
    ]}
    field = crop.apply_dynamic_options(draft)["form_json"]["fields"][0]

    assert field["options"] == [], "the invented crops survived"
    assert field["options_from"] == {"source": "crop_ontology", "kind": "crop"}


def test_placeholder_features_are_never_kept():
    """The reported bug: Feature 1, Feature 2, Feature 3. A choice nobody can
    act on is worse than no choice."""
    draft = {"fields": [
        {"name": "crop", "label": "Crop", "type": "select", "options": []},
        {"name": "crop_feature", "label": "Crop Feature", "type": "select",
         "options": [{"label": "Feature 1", "value": "feature_1"},
                     {"label": "Feature 2", "value": "feature_2"},
                     {"label": "Feature 3", "value": "feature_3"}]},
    ]}
    result = crop.apply_dynamic_options(draft)
    feature = result["form_json"]["fields"][1]

    labels = [o["label"] for o in feature["options"]]
    assert labels == [], "a placeholder choice survived"
    assert feature["options_from"]["kind"] == "trait"
    assert feature["options_from"]["depends_on"] == "crop"


def test_the_feature_field_depends_on_the_crop_field():
    draft = {"fields": [
        {"name": "which_crop", "label": "Crop", "type": "select", "options": []},
        {"name": "traits", "label": "Traits", "type": "select", "options": []},
    ]}
    feature = crop.apply_dynamic_options(draft)["form_json"]["fields"][1]
    assert feature["options_from"]["depends_on"] == "which_crop"


def test_a_feature_field_with_no_crop_field_is_left_alone():
    """A trait list without a crop would be the same mistake in another place."""
    draft = {"fields": [
        {"name": "crop_feature", "label": "Crop Feature", "type": "select",
         "options": [{"label": "Something", "value": "something"}]},
    ]}
    field = crop.apply_dynamic_options(draft)["form_json"]["fields"][0]

    assert "options_from" not in field
    assert [o["label"] for o in field["options"]] == ["Something"]


def test_ordinary_fields_that_mention_crops_are_untouched():
    """`crop_area` and `crop_variety` are not crop selectors."""
    draft = {"fields": [
        {"name": "crop", "label": "Crop", "type": "select", "options": []},
        {"name": "crop_area", "label": "Crop Area", "type": "decimal", "options": []},
        {"name": "crop_variety", "label": "Crop Variety", "type": "text", "options": []},
        {"name": "crop_damage_notes", "label": "Crop Damage", "type": "textarea", "options": []},
    ]}
    fields = crop.apply_dynamic_options(draft)["form_json"]["fields"]

    assert fields[0]["options_from"]["kind"] == "crop"
    for field in fields[1:]:
        assert "options_from" not in field, f"{field['name']} was wrongly rewired"
        assert field["type"] in ("decimal", "text", "textarea")


# --- the form definition ----------------------------------------------------- #
def test_a_dynamic_dropdown_is_not_demoted_to_text():
    """An option-less dropdown is normally degraded to free text. One that names
    a source is the exception — its choices arrive when the form is drawn."""
    form = normalize_form({"title": "Crop features", "fields": [
        {"label": "Crop", "type": "select", "options": [],
         "options_from": {"source": "crop_ontology", "kind": "crop"}},
        {"label": "Crop feature", "type": "select", "options": [],
         "options_from": {"source": "crop_ontology", "kind": "trait", "depends_on": "Crop"}},
    ]})

    assert [f["type"] for f in form["fields"]] == ["select", "select"]
    assert form["fields"][1]["options_from"]["depends_on"] == "crop", \
        "the dependency must point at the stored key, not the label"
    validate_config(form)


def test_an_option_less_dropdown_with_no_source_is_still_demoted():
    form = normalize_form({"title": "T", "fields": [
        {"label": "Broken", "type": "select", "options": []},
    ]})
    assert form["fields"][0]["type"] == "text"


def test_an_unknown_source_is_ignored():
    """Only sources the application actually has are honoured."""
    form = normalize_form({"title": "T", "fields": [
        {"label": "Made up", "type": "select", "options": [],
         "options_from": {"source": "wikipedia", "kind": "crop"}},
    ]})
    assert "options_from" not in form["fields"][0]
    assert form["fields"][0]["type"] == "text"


# --- answering it ------------------------------------------------------------ #
@needs_import
def test_a_real_identifier_is_accepted():
    loaded = {o["ontology_id"] for o in variable_service.ontologies()}
    if MAIZE not in loaded:
        pytest.skip("maize is not imported")

    trait = dynamic_options.trait_options(MAIZE)[0]["value"]
    form = normalize_form({"title": "Crop features", "fields": [
        {"label": "Crop", "type": "select", "options": [],
         "options_from": {"source": "crop_ontology", "kind": "crop"}},
        {"label": "Crop feature", "type": "select", "options": [],
         "options_from": {"source": "crop_ontology", "kind": "trait", "depends_on": "crop"}},
    ]})

    clean = validate_payload(form, {"crop": MAIZE, "crop_feature": trait})
    assert clean["crop"] == MAIZE
    assert clean["crop_feature"] == trait, "the Crop Ontology identifier is what gets stored"


@needs_import
def test_a_feature_from_the_wrong_crop_is_refused():
    """A maize trait is not an answer to a rice form."""
    loaded = {o["ontology_id"] for o in variable_service.ontologies()}
    if not {MAIZE, RICE} <= loaded:
        pytest.skip("maize and rice are not both imported")

    maize_trait = dynamic_options.trait_options(MAIZE)[0]["value"]
    form = normalize_form({"title": "Crop features", "fields": [
        {"label": "Crop", "type": "select", "options": [],
         "options_from": {"source": "crop_ontology", "kind": "crop"}},
        {"label": "Crop feature", "type": "select", "options": [],
         "options_from": {"source": "crop_ontology", "kind": "trait", "depends_on": "crop"}},
    ]})

    with pytest.raises(ValidationFailed) as caught:
        validate_payload(form, {"crop": RICE, "crop_feature": maize_trait})
    assert "crop_feature" in caught.value.errors


@needs_import
def test_an_invented_answer_is_refused():
    form = normalize_form({"title": "Crop features", "fields": [
        {"label": "Crop", "type": "select", "options": [],
         "options_from": {"source": "crop_ontology", "kind": "crop"}},
    ]})
    with pytest.raises(ValidationFailed):
        validate_payload(form, {"crop": "CO_999"})


@needs_import
def test_a_stored_answer_can_be_read_back():
    loaded = {o["ontology_id"] for o in variable_service.ontologies()}
    if MAIZE not in loaded:
        pytest.skip("maize is not imported")

    trait_id = dynamic_options.trait_options(MAIZE)[0]["value"]
    described = dynamic_options.describe("trait", trait_id)

    assert described["trait_id"] == trait_id
    assert described["ontology_id"] == MAIZE
    assert described["crop_name"], "provenance was lost"


# --- the other standards are untouched --------------------------------------- #
def test_an_ordinary_dropdown_still_carries_its_own_choices():
    form = normalize_form({"title": "T", "fields": [
        {"label": "Irrigation", "type": "select", "options": ["Drip", "Flood"]},
    ]})
    field = form["fields"][0]

    assert [o["label"] for o in field["options"]] == ["Drip", "Flood"]
    assert "options_from" not in field
    assert validate_payload(form, {"irrigation": "Drip"}) == {"irrigation": "Drip"}


def test_seont_and_icasa_mappings_still_attach():
    form = normalize_form({"title": "Maize phenotyping", "fields": [{
        "label": "Plant Height", "type": "decimal", "validation": {"min": 0, "max": 400},
        "semantic_concept": {"standard": "SEOnt", "uri": "http://x/AGRO_1", "label": "height"},
        "data_standard": {"standard": "ICASA", "variable_id": "1", "variable_name": "plant_height"},
    }]})
    field = form["fields"][0]

    assert field["semantic_concept"]["standard"] == "SEOnt"
    assert field["data_standard"]["standard"] == "ICASA"
    assert field["validation"] == {"min": 0, "max": 400}
    validate_config(form)


# --- the phrasings a model actually produces --------------------------------- #
@pytest.mark.parametrize("crop_name,feature_name", [
    ("selected_crop", "selected_feature"),
    ("crop", "crop_feature"),
    ("crop_type", "feature_name"),
    ("which_crop", "which_trait"),
    ("selected_crop", "selected_trait"),
    ("crop", "crop_characteristics"),
])
def test_a_feature_field_becomes_a_dropdown_however_it_is_named(crop_name, feature_name):
    """The reported bug: `selected_feature` stayed a text box because the name
    was matched whole. What a field *is* has to survive being renamed."""
    draft = {"fields": [
        {"name": crop_name, "label": crop_name.replace("_", " ").title(),
         "type": "select", "options": []},
        {"name": feature_name, "label": feature_name.replace("_", " ").title(),
         "type": "text", "options": []},
    ]}
    fields = crop.apply_dynamic_options(draft)["form_json"]["fields"]

    assert fields[0]["type"] == "select"
    assert fields[0]["options_from"] == {"source": "crop_ontology", "kind": "crop"}

    assert fields[1]["type"] == "select", f"{feature_name} was left as free text"
    assert fields[1]["options_from"] == {
        "source": "crop_ontology", "kind": "trait", "depends_on": crop_name,
    }


@pytest.mark.parametrize("name", [
    "crop_area", "crop_variety", "crop_damage_notes", "crop_count",
    "feature_value", "trait_value", "planting_date", "farmer_name",
])
def test_a_field_that_merely_mentions_crops_is_left_alone(name):
    """`feature_value` holds the reading, not the name of what was read."""
    draft = {"fields": [
        {"name": "selected_crop", "label": "Selected Crop", "type": "select", "options": []},
        {"name": name, "label": name.replace("_", " ").title(), "type": "text", "options": []},
    ]}
    field = crop.apply_dynamic_options(draft)["form_json"]["fields"][1]

    assert "options_from" not in field, f"{name} was wrongly rewired"
    assert field["type"] == "text"


@needs_import
def test_the_whole_phenotyping_form_works_end_to_end(no_network):
    """Selected crop and selected feature, from the draft a model produces
    through to an answer the server accepts — with the network blocked."""
    loaded = {o["ontology_id"] for o in variable_service.ontologies()}
    if not {MAIZE, RICE} <= loaded:
        pytest.skip("maize and rice are not both imported")

    # What the model hands over, placeholders and all.
    draft = {"title": "Crop Phenotyping Form", "fields": [
        {"name": "selected_crop", "label": "Selected Crop", "type": "select",
         "options": [{"label": "Wheat", "value": "wheat"},
                     {"label": "Corn", "value": "corn"}]},
        {"name": "selected_feature", "label": "Selected Feature", "type": "text",
         "options": [{"label": "Feature 1", "value": "feature_1"},
                     {"label": "Feature 2", "value": "feature_2"}]},
        {"name": "feature_value", "label": "Feature Value", "type": "decimal", "options": []},
    ]}

    form = normalize_form(crop.apply_dynamic_options(draft)["form_json"])
    validate_config(form)
    by_name = {f["name"]: f for f in form["fields"]}

    # Both invented lists are gone; the reading stays a reading.
    assert by_name["selected_crop"]["options"] == []
    assert by_name["selected_feature"]["options"] == []
    assert by_name["selected_feature"]["type"] == "select"
    assert by_name["feature_value"]["type"] == "decimal"
    assert "options_from" not in by_name["feature_value"]

    # Maize offers maize traits, rice offers rice traits, and they never overlap.
    maize_traits = dynamic_options.trait_options(MAIZE)
    rice_traits = dynamic_options.trait_options(RICE)
    assert maize_traits and rice_traits
    assert all(o["value"].startswith(f"{MAIZE}:") for o in maize_traits)
    assert all(o["value"].startswith(f"{RICE}:") for o in rice_traits)

    # An answer keeps Crop Ontology's own identifier.
    chosen = maize_traits[0]["value"]
    clean = validate_payload(form, {"selected_crop": MAIZE, "selected_feature": chosen,
                                    "feature_value": 12.5})
    assert clean["selected_feature"] == chosen
    assert clean["selected_crop"] == MAIZE

    # A maize trait is not an answer to a rice form.
    with pytest.raises(ValidationFailed) as caught:
        validate_payload(form, {"selected_crop": RICE, "selected_feature": chosen})
    assert "selected_feature" in caught.value.errors

    assert no_network == [], "something reached outside for this"
