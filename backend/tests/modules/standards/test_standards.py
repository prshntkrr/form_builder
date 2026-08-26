"""The ICASA dictionary, and attaching standards to a form."""
from pathlib import Path

import pytest

from app.core import registry
from app.core.database import ping
from app.modules.forms.config_validation import validate_config
from app.modules.forms.form_schema import normalize_form
from app.modules.standards import enrichment, icasa_importer, variable_service

pytestmark = [
    pytest.mark.skipif(not ping(), reason="Postgres is not reachable"),
    pytest.mark.skipif("standards" in registry.disabled(),
                       reason="standards is switched off (DISABLED_MODULES)"),
]

ICASA_DIR = Path(__file__).resolve().parents[3].parent / "data_dictionary" / "icasa"

# Verified against the real files, not assumed from a prompt:
#   irrigation_operation  var_uid 302, code IROP, code-valued, 13 codes
#   soil_texture          var_uid 545, code SLTX
IRRIGATION_OPERATION = "302"
SOIL_TEXTURE = "545"

needs_files = pytest.mark.skipif(not ICASA_DIR.exists(), reason="ICASA CSVs are not present")
needs_import = pytest.mark.skipif(
    not variable_service.get_by_external_id(IRRIGATION_OPERATION, "ICASA"),
    reason="ICASA has not been imported - run: python import_icasa.py",
)


# --- reading the files ------------------------------------------------------ #
@needs_files
def test_the_dictionary_parses():
    variables, codes = icasa_importer.read_directory(ICASA_DIR)
    assert len(variables) > 0
    assert len(codes) > 0


@needs_files
def test_every_variable_keeps_its_icasa_identifier():
    """var_uid is the only unique identifier in the dictionary. Code_Display and
    Variable_Name both repeat, so neither can key a stored mapping."""
    variables, _ = icasa_importer.read_directory(ICASA_DIR)
    ids = [v["external_id"] for v in variables]

    assert all(ids), "a variable came through with no var_uid"
    assert len(set(ids)) == len(ids), "var_uid is not unique after all"


@needs_files
def test_units_and_types_come_from_the_files():
    variables, _ = icasa_importer.read_directory(ICASA_DIR)
    by_id = {v["external_id"]: v for v in variables}

    irrigation = by_id[IRRIGATION_OPERATION]
    assert irrigation["name"] == "irrigation_operation"
    assert irrigation["code"] == "IROP"
    assert irrigation["unit"] == "code"
    assert irrigation["definition"], "the description was not read"


@needs_files
def test_one_code_list_can_serve_several_variables():
    """Management_codes links codes through Code_Display, which sometimes names
    more than one variable at once - "IROP, IAME"."""
    _, codes = icasa_importer.read_directory(ICASA_DIR)
    assert "IROP" in codes and "IAME" in codes
    assert len(codes["IROP"]) > 0


@needs_files
def test_importing_twice_adds_nothing_the_second_time():
    first = icasa_importer.import_directory(ICASA_DIR)
    second = icasa_importer.import_directory(ICASA_DIR)

    assert second["variables_in_files"] == first["variables_in_files"]
    assert second["variables_added"] == 0, "the second import duplicated variables"
    assert second["options_total"] == first["options_total"], "options were duplicated"


# --- looking variables up --------------------------------------------------- #
@needs_import
def test_a_variable_is_searchable_by_name_and_by_code():
    by_name = variable_service.search("irrigation_operation")
    by_code = variable_service.search("IROP")

    assert by_name[0]["external_id"] == IRRIGATION_OPERATION
    assert by_code[0]["external_id"] == IRRIGATION_OPERATION


@needs_import
def test_search_finds_underscored_names_from_spaced_words():
    """Names in the dictionary are underscored; people type words."""
    assert any(v["name"] == "soil_texture" for v in variable_service.search("soil texture"))


@needs_import
def test_a_code_valued_variable_offers_its_codes():
    variable = variable_service.get_by_external_id(IRRIGATION_OPERATION, "ICASA")
    options = variable_service.as_field_options(variable["variable_id"])

    assert len(options) > 0
    assert all(o["value"] == o["standard_code"] for o in options), \
        "the standard's own code must be what gets stored"
    assert any("Sprinkler" in o["label"] for o in options)


@needs_import
def test_a_variable_with_no_codes_returns_an_empty_list():
    """Most variables have none - only 84 of 1384 carry a code list."""
    plain = next(v for v in variable_service.search("soil_pH_in_water")
                 if v["name"] == "soil_pH_in_water")
    assert variable_service.options(plain["variable_id"]) == []


@needs_import
def test_an_unknown_variable_is_reported():
    with pytest.raises(variable_service.VariableNotFound):
        variable_service.get(9_999_999)


# --- matching --------------------------------------------------------------- #
@needs_import
def test_an_exact_name_is_matched():
    result = enrichment.match_variable({"name": "irrigation_operation",
                                        "label": "Irrigation Operation"})
    assert result["match"]["variable_id"] == IRRIGATION_OPERATION
    assert result["match"]["unit"] == "code"
    assert result["confidence"] == enrichment.EXACT_NAME


@needs_import
def test_an_ambiguous_field_is_declined_and_its_candidates_offered():
    """"soil ph" fits soil_pH_in_water and soil_pH_in_buffer equally. Picking one
    would record a coin toss as a fact."""
    result = enrichment.match_variable({"name": "soil_ph", "label": "Soil pH"})

    assert result["match"] is None
    assert len(result["candidates"]) >= 2
    names = {c["variable_name"] for c in result["candidates"]}
    assert "soil_pH_in_water" in names and "soil_pH_in_buffer" in names


@needs_import
@pytest.mark.parametrize("name,label", [
    ("favorite_color", "Favorite Color"),
    ("emergency_contact", "Emergency Contact"),
    ("farmer_name", "Farmer Name"),
    ("mobile_number", "Mobile Number"),
    ("village", "Village"),
    ("remarks", "Remarks"),
])
def test_an_unrelated_field_is_never_given_a_standard(name, label):
    """The failure that matters. A wrong mapping is silently wrong in an exported
    dataset months later; a missing one is merely absent."""
    result = enrichment.match_variable({"name": name, "label": label})
    assert result["match"] is None, f"{name} was wrongly mapped"


@needs_import
def test_a_word_appearing_in_a_definition_is_not_a_match():
    """Only the variable's name counts. Definitions mention "crop" hundreds of
    times, and matching on them would attach it to everything."""
    for variable in variable_service.search("crop", limit=40):
        if "crop" not in variable["name"].lower():
            assert enrichment._score("crop", variable) == 0.0


# --- enriching a whole form ------------------------------------------------- #
@needs_import
def test_a_draft_is_enriched_without_being_asked():
    draft = {"fields": [
        {"name": "irrigation_operation", "label": "Irrigation Operation", "type": "select"},
        {"name": "favorite_color", "label": "Favorite Color", "type": "text"},
    ]}
    result = enrichment.enrich_form(draft)
    enriched, plain = result["form_json"]["fields"]

    assert enriched["data_standard"]["variable_id"] == IRRIGATION_OPERATION
    assert "data_standard" not in plain
    assert [a["field"] for a in result["attached"]] == ["irrigation_operation"]


@needs_import
def test_enrichment_does_not_overrule_a_choice_already_made():
    chosen = {"standard": "ICASA", "variable_id": SOIL_TEXTURE, "variable_name": "soil_texture"}
    draft = {"fields": [
        {"name": "irrigation_operation", "label": "Irrigation Operation",
         "data_standard": chosen},
    ]}
    field = enrichment.enrich_form(draft)["form_json"]["fields"][0]

    assert field["data_standard"] == chosen, "a person's choice was overwritten"


# --- what the form does with it --------------------------------------------- #
def test_a_field_can_carry_both_standards():
    form = normalize_form({"title": "Plot Survey", "fields": [{
        "label": "Irrigation Operation",
        "type": "select",
        "semantic_concept": {"standard": "SEOnt",
                             "uri": "http://purl.obolibrary.org/obo/AGRO_00000009",
                             "label": "irrigation source"},
        "data_standard": {"standard": "ICASA", "standard_version": "2026-01-29",
                          "variable_id": IRRIGATION_OPERATION, "variable_code": "IROP",
                          "variable_name": "irrigation_operation",
                          "unit": "code", "data_type": "text"},
        "options": ["Furrow", "Flood"],
    }]})
    field = form["fields"][0]

    assert field["name"] == "irrigation_operation", "stored-as is untouched"
    assert field["semantic_concept"]["uri"].endswith("AGRO_00000009")
    assert field["data_standard"]["variable_id"] == IRRIGATION_OPERATION
    validate_config(form)


def test_either_standard_alone_is_fine():
    form = normalize_form({"title": "T", "fields": [
        {"label": "Only Concept", "type": "text",
         "semantic_concept": {"standard": "SEOnt", "uri": "http://x/AGRO_1", "label": "a"}},
        {"label": "Only Variable", "type": "text",
         "data_standard": {"standard": "ICASA", "variable_id": "1", "variable_name": "v"}},
    ]})
    concept_only, variable_only = form["fields"]

    assert "data_standard" not in concept_only
    assert "semantic_concept" not in variable_only


def test_the_old_flat_seont_keys_still_read():
    """Definitions saved before the nested shape must keep working."""
    form = normalize_form({"title": "T", "fields": [{
        "label": "Irrigation Source", "type": "text",
        "ontology_concept_uri": "http://purl.obolibrary.org/obo/AGRO_00000009",
        "ontology_concept_label": "irrigation source",
    }]})
    concept = form["fields"][0]["semantic_concept"]

    assert concept["standard"] == "SEOnt"
    assert concept["uri"].endswith("AGRO_00000009")
    assert concept["label"] == "irrigation source"


def test_a_standard_without_an_identifier_is_dropped():
    """Without the published id the mapping cannot be looked up again, so it is
    not worth recording."""
    form = normalize_form({"title": "T", "fields": [
        {"label": "Vague", "type": "text", "data_standard": {"standard": "ICASA"}},
    ]})
    assert "data_standard" not in form["fields"][0]


def test_a_form_with_no_standards_is_unchanged():
    form = normalize_form({"title": "Farmer Registration", "fields": [
        {"label": "Farmer Name", "type": "text", "required": True},
        {"label": "Age", "type": "number", "validation": {"min": 1, "max": 80}},
    ]})

    for field in form["fields"]:
        assert "semantic_concept" not in field
        assert "data_standard" not in field
    assert form["fields"][1]["validation"] == {"min": 1, "max": 80}, \
        "validation stays the application's, never the standard's"
    validate_config(form)


def test_a_manual_dropdown_is_untouched():
    form = normalize_form({"title": "T", "fields": [
        {"label": "Crop", "type": "select", "options": ["Wheat", "Rice", "Maize"]},
    ]})
    field = form["fields"][0]

    assert [o["label"] for o in field["options"]] == ["Wheat", "Rice", "Maize"]
    assert "option_source" not in field
    validate_config(form)


# --- coded values reaching the form ----------------------------------------- #
@needs_import
def test_the_irrigation_variable_has_its_codes():
    """Verified against the real files: Management_codes links 13 codes to IROP."""
    options = variable_service.options_by_external_id(IRRIGATION_OPERATION)

    assert len(options) == 13
    codes = {o["value"] for o in options}
    assert "IR001" in codes and "IR999" in codes


@needs_import
def test_options_are_found_by_the_standards_own_identifier():
    """A row id changes on re-import; var_uid does not, so that is the key."""
    assert variable_service.options_by_external_id(IRRIGATION_OPERATION)
    assert variable_service.options_by_external_id("999999") == []


@needs_import
def test_a_coded_variable_turns_a_text_field_into_a_dropdown():
    draft = {"fields": [
        {"name": "irrigation_operation", "label": "Irrigation Operation",
         "type": "text", "options": []},
    ]}
    field = enrichment.enrich_form(draft)["form_json"]["fields"][0]

    assert field["type"] == "select", "a field with 13 known answers is not free text"
    assert field["option_source"] == "standard"
    assert len(field["options"]) == 13


@needs_import
def test_the_option_value_is_the_icasa_code():
    """IR004, not "sprinkler". The code is what every other ICASA consumer reads."""
    draft = {"fields": [
        {"name": "irrigation_operation", "label": "Irrigation Operation",
         "type": "text", "options": []},
    ]}
    options = enrichment.enrich_form(draft)["form_json"]["fields"][0]["options"]

    by_value = {o["value"]: o["label"] for o in options}
    assert "IR004" in by_value
    assert "Sprinkler" in by_value["IR004"]
    assert all(o["value"].startswith("IR") for o in options)


@needs_import
def test_a_variable_with_no_codes_leaves_the_field_alone():
    """Most ICASA variables are not coded. Those fields keep their type."""
    draft = {"fields": [
        {"name": "soil_ph_in_water", "label": "soil_pH_in_water",
         "type": "decimal", "options": [], "validation": {"min": 0, "max": 14}},
    ]}
    field = enrichment.enrich_form(draft)["form_json"]["fields"][0]

    assert field["data_standard"]["variable_code"] == "SLPHW", "it should still map"
    assert field["type"] == "decimal", "the type was changed without cause"
    assert field["options"] == []
    assert "option_source" not in field
    assert field["validation"] == {"min": 0, "max": 14}, \
        "ICASA's published bounds must never become application validation"


@needs_import
def test_choices_already_on_a_field_are_not_replaced():
    draft = {"fields": [
        {"name": "irrigation_operation", "label": "Irrigation Operation",
         "type": "select", "options": [{"label": "Drip", "value": "drip"}]},
    ]}
    field = enrichment.enrich_form(draft)["form_json"]["fields"][0]

    assert [o["value"] for o in field["options"]] == ["drip"]
    assert "option_source" not in field


@needs_import
def test_a_field_that_is_already_a_date_is_not_retyped():
    """Only free text becomes a dropdown. A deliberate type stands."""
    draft = {"fields": [
        {"name": "irrigation_operation", "label": "Irrigation Operation",
         "type": "date", "options": []},
    ]}
    field = enrichment.enrich_form(draft)["form_json"]["fields"][0]

    assert field["type"] == "date"
    assert len(field["options"]) == 13, "the codes are still worth having"


@needs_import
def test_a_manual_dropdown_with_no_standard_is_untouched():
    draft = {"fields": [
        {"name": "favorite_color", "label": "Favorite Color", "type": "select",
         "options": [{"label": "Red", "value": "red"}]},
    ]}
    field = enrichment.enrich_form(draft)["form_json"]["fields"][0]

    assert "data_standard" not in field
    assert [o["value"] for o in field["options"]] == ["red"]


@needs_import
def test_seont_still_works_beside_all_of_this():
    """The ontology half is unchanged: a concept attaches, and a field the
    ontology knows but ICASA does not keeps its own choices."""
    draft = {"fields": [
        {"name": "irrigation_method", "label": "Irrigation Method", "type": "select",
         "options": [{"label": "Drip", "value": "drip"},
                     {"label": "Sprinkler", "value": "sprinkler"}]},
    ]}
    field = enrichment.enrich_form(draft)["form_json"]["fields"][0]

    assert field["semantic_concept"]["standard"] == "SEOnt"
    assert field["semantic_concept"]["uri"].endswith("AGRO_00000054")
    assert [o["value"] for o in field["options"]] == ["drip", "sprinkler"]
