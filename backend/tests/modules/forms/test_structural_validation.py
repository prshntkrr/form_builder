"""Stage 1 — shape, types, nesting, enums."""
import copy

import pytest

from app.modules.forms.config_validation import (
    STRUCTURAL,
    ConfigValidationError,
    FormConfig,
    validate_structure,
)


def fails(config) -> list:
    with pytest.raises(ConfigValidationError) as caught:
        validate_structure(config)
    issues = caught.value.issues
    assert issues, "an error was raised with no issues attached"
    assert all(i.type == STRUCTURAL for i in issues)
    return issues


def test_valid_config_passes(valid_config):
    config = validate_structure(valid_config)
    assert isinstance(config, FormConfig)
    assert config.title == "Farmer Registration"
    assert [f.name for f in config.fields] == ["farmer_name", "land_area", "irrigation"]


def test_config_must_be_an_object():
    for bad in ["a string", 42, None, ["a", "list"]]:
        issues = fails(bad)
        assert issues[0].field == "config"


def test_a_field_needs_a_name_or_a_label(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][0] = {"type": "text"}
    assert fails(config)[0].field.startswith("fields.0")


def test_key_may_arrive_as_name_key_or_id(valid_config):
    """The contract `normalize_form` already accepts."""
    for alias in ("name", "key", "id"):
        config = copy.deepcopy(valid_config)
        config["fields"][0] = {alias: "farmer_name", "label": "Farmer", "type": "text"}
        assert validate_structure(config).fields[0].name == "farmer_name"


def test_label_is_derived_from_the_key_when_absent(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][0] = {"name": "farmer_name", "type": "text"}
    assert validate_structure(config).fields[0].label == "Farmer Name"


def test_key_is_derived_from_the_label_when_absent(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][0] = {"label": "Farmer Name", "type": "text"}
    assert validate_structure(config).fields[0].name == "farmer_name"


def test_title_falls_back_when_absent(valid_config):
    config = copy.deepcopy(valid_config)
    del config["title"]
    assert validate_structure(config).title == "Untitled Form"


def test_missing_fields_property(valid_config):
    config = copy.deepcopy(valid_config)
    del config["fields"]
    assert fails(config)[0].field == "fields"


def test_empty_fields_list_is_rejected(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"] = []
    assert fails(config)[0].field == "fields"


def test_wrong_data_type(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][0]["required"] = "definitely"
    assert fails(config)[0].field == "fields.0.required"


def test_wrong_type_for_a_list(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"] = {"not": "a list"}
    assert fails(config)[0].field == "fields"


def test_invalid_nested_object(valid_config):
    """An option must be a scalar or an object, not a nested list."""
    config = copy.deepcopy(valid_config)
    config["fields"][2]["options"] = [["Canal", "canal"]]
    assert fails(config)[0].field.startswith("fields.2.options")


def test_empty_option_object_is_rejected(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][2]["options"] = [{}]
    assert fails(config)[0].field.startswith("fields.2.options.0")


def test_option_shorthands_are_accepted(valid_config):
    """`_normalize_options` takes these, so validation must too."""
    config = copy.deepcopy(valid_config)
    config["fields"][2]["options"] = ["Canal", "Borewell"]
    config["fields"][2]["default"] = ["Canal"]
    assert [o.value for o in validate_structure(config).fields[2].options] == ["Canal", "Borewell"]

    config["fields"][2]["options"] = [{"label": "Canal"}]
    config["fields"][2]["default"] = None
    assert validate_structure(config).fields[2].options[0].value == "Canal"

    config["fields"][2]["options"] = "Canal, Borewell"
    assert len(validate_structure(config).fields[2].options) == 2


def test_property_aliases_are_accepted():
    """The alias set `normalize_form` documents."""
    config = validate_structure({
        "form_title": "Aliased",
        "form_description": "via aliases",
        "questions": [
            {"key": "crop", "question": "Crop", "field_type": "dropdown",
             "choices": ["Wheat"], "is_required": True, "hint": "pick one"},
        ],
    })
    assert config.title == "Aliased"
    assert config.description == "via aliases"
    field = config.fields[0]
    assert (field.name, field.label, field.type) == ("crop", "Crop", "select")
    assert field.required is True
    assert field.help_text == "pick one"


def test_wrapped_payload_is_unwrapped():
    config = validate_structure({"form": {"title": "Wrapped", "fields": [
        {"name": "a", "label": "A", "type": "text"}]}})
    assert config.title == "Wrapped"


def test_sections_may_be_bare_titles():
    config = validate_structure({"title": "S", "sections": ["Basic details"],
                                 "fields": [{"name": "a", "label": "A", "type": "text"}]})
    assert config.sections[0].key == "basic_details"


def test_section_missing_its_title(valid_config):
    config = copy.deepcopy(valid_config)
    config["sections"][0] = {"key": "basics"}
    assert fails(config)[0].field == "sections.0.title"


def test_unknown_field_type_is_rejected(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][0]["type"] = "hologram"
    issue = fails(config)[0]
    assert issue.field == "fields.0.type"
    assert "not a supported field type" in issue.message


def test_type_aliases_are_accepted_and_resolved(valid_config):
    """The project's convention is that 'Multi-Select' means multiselect."""
    config = copy.deepcopy(valid_config)
    config["fields"][2]["type"] = "Multi-Select"
    config["fields"][1]["type"] = "currency"
    resolved = validate_structure(config)
    assert resolved.fields[2].type == "multiselect"
    assert resolved.fields[1].type == "decimal"


def test_field_name_must_be_an_identifier(valid_config):
    for bad in ["Farmer Name", "1st_field", "farmer-name", "FARMER"]:
        config = copy.deepcopy(valid_config)
        config["fields"][0]["name"] = bad
        assert fails(config)[0].field == "fields.0.name", bad


def test_field_name_length_is_bounded(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][0]["name"] = "f" * 200
    assert fails(config)[0].field == "fields.0.name"


def test_title_length_is_bounded(valid_config):
    """`forms.form_title` is VARCHAR(200)."""
    config = copy.deepcopy(valid_config)
    config["title"] = "x" * 201
    assert fails(config)[0].field == "title"


def test_validation_rules_must_be_the_right_types(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][1]["validation"] = {"min": "zero"}
    assert fails(config)[0].field.startswith("fields.1.validation")


def test_length_rules_must_be_positive(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][0]["validation"] = {"min_length": 0}
    assert fails(config)[0].field == "fields.0.validation.min_length"


def test_version_must_be_positive(valid_config):
    config = copy.deepcopy(valid_config)
    config["version"] = 0
    assert fails(config)[0].field == "version"


def test_malformed_config_reports_every_problem_at_once(valid_config):
    config = copy.deepcopy(valid_config)
    config["title"] = "x" * 300
    config["fields"][0]["type"] = "hologram"
    config["fields"][1]["required"] = "yes please"
    fields = {i.field for i in fails(config)}
    assert {"title", "fields.0.type", "fields.1.required"} <= fields


def test_unknown_properties_are_ignored(valid_config):
    """Matches `normalize_form`, which drops what it does not recognise."""
    config = copy.deepcopy(valid_config)
    config["colour_scheme"] = "green"
    config["fields"][0]["widget_hint"] = "fancy"
    result = validate_structure(config)
    assert not hasattr(result, "colour_scheme")
    assert result.fields[0].label == "Farmer Name"


def test_defaults_are_applied_for_optional_properties():
    config = validate_structure(
        {"title": "Bare", "fields": [{"name": "a", "label": "A", "type": "text"}]}
    )
    assert config.submit_label == "Submit"
    assert config.sections == []
    assert config.fields[0].required is False
    assert config.fields[0].options == []
