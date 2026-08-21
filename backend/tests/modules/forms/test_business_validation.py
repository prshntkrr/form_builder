"""Stage 2 — rules about whether the config describes a runnable form."""
import copy

import pytest

from app.modules.forms.config_validation import (
    BUSINESS_RULE,
    BusinessContext,
    ConfigValidationError,
    validate_business,
    validate_structure,
)


def check(config, context=None):
    """Structural validation must pass first, as it does in the pipeline."""
    return validate_business(validate_structure(config), context)


def fails(config, context=None) -> list:
    with pytest.raises(ConfigValidationError) as caught:
        check(config, context)
    issues = caught.value.issues
    assert issues
    assert all(i.type == BUSINESS_RULE for i in issues)
    return issues


def test_valid_config_passes(valid_config):
    assert check(valid_config) is not None


# --- uniqueness ------------------------------------------------------------ #
def test_duplicate_field_names_are_rejected(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][1]["name"] = "farmer_name"
    issue = fails(config)[0]
    assert issue.field == "fields.1.name"
    assert "unique" in issue.message


def test_duplicate_option_values_are_rejected(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][2]["options"] = [
        {"label": "Canal", "value": "canal"},
        {"label": "Canal irrigation", "value": "canal"},
    ]
    assert fails(config)[0].field == "fields.2.options.1.value"


def test_duplicate_section_keys_are_rejected(valid_config):
    config = copy.deepcopy(valid_config)
    config["sections"][1]["key"] = "basics"
    assert fails(config)[0].field == "sections.1.key"


# --- reserved names -------------------------------------------------------- #
@pytest.mark.parametrize(
    "reserved", ["survey_id", "form_id", "form_data", "created_on", "form_version", "created_by"]
)
def test_envelope_column_names_are_rejected(valid_config, reserved):
    config = copy.deepcopy(valid_config)
    config["fields"][0]["name"] = reserved
    assert fails(config)[0].field == "fields.0.name"


def test_reserved_table_name_is_rejected(valid_config):
    config = copy.deepcopy(valid_config)
    config["table_name"] = "forms"
    assert fails(config)[0].field == "table_name"


# --- field type dependencies ----------------------------------------------- #
@pytest.mark.parametrize("choice_type", ["select", "radio", "multiselect"])
def test_choice_fields_need_options(valid_config, choice_type):
    config = copy.deepcopy(valid_config)
    config["fields"][2]["type"] = choice_type
    config["fields"][2]["options"] = []
    config["fields"][2].pop("default", None)
    issue = fails(config)[0]
    assert issue.field == "fields.2.options"
    assert "at least one option" in issue.message


def test_default_must_be_an_available_option(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][2]["default"] = ["drip"]
    assert fails(config)[0].field == "fields.2.default"


def test_default_matching_an_option_is_fine(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][2]["default"] = ["borewell"]
    assert check(config)


# --- references ------------------------------------------------------------ #
def test_field_referencing_an_undeclared_section_is_rejected(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][0]["section"] = "nowhere"
    issue = fails(config)[0]
    assert issue.field == "fields.0.section"
    assert "not declared" in issue.message


def test_child_form_must_name_a_parent(valid_config):
    ctx = BusinessContext(form_type="child", parent_id=None)
    assert fails(valid_config, ctx)[0].field == "parent_id"


def test_parent_must_exist(valid_config):
    ctx = BusinessContext(
        form_type="child", parent_id="FRM99999", known_form_ids=["FRM00001"]
    )
    issue = fails(valid_config, ctx)[0]
    assert issue.field == "parent_id"
    assert "does not exist" in issue.message


def test_known_parent_is_accepted(valid_config):
    ctx = BusinessContext(
        form_type="child", parent_id="FRM00001", known_form_ids=["FRM00001"]
    )
    assert check(valid_config, ctx)


def test_form_cannot_be_its_own_parent(valid_config):
    ctx = BusinessContext(
        form_id="FRM00001", form_type="child", parent_id="FRM00001",
        known_form_ids=["FRM00001"],
    )
    assert fails(valid_config, ctx)[0].field == "parent_id"


def test_unknown_form_type_is_rejected(valid_config):
    assert fails(valid_config, BusinessContext(form_type="grandparent"))[0].field == "form_type"


def test_unknown_status_is_rejected(valid_config):
    assert fails(valid_config, BusinessContext(form_status="Archived"))[0].field == "form_status"


# --- ranges ---------------------------------------------------------------- #
def test_min_above_max_is_rejected(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][1]["validation"] = {"min": 500, "max": 10}
    issue = fails(config)[0]
    assert issue.field == "fields.1.validation"
    assert "above its" in issue.message


def test_min_length_above_max_length_is_rejected(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][0]["validation"] = {"min_length": 50, "max_length": 5}
    assert fails(config)[0].field == "fields.0.validation"


def test_equal_bounds_are_allowed(valid_config):
    """A fixed-width identifier is min == max."""
    config = copy.deepcopy(valid_config)
    config["fields"][0]["validation"] = {"min_length": 12, "max_length": 12}
    assert check(config)


# --- incompatible combinations --------------------------------------------- #
def test_a_rule_aimed_at_the_wrong_type_is_tolerated(valid_config):
    """Inert rather than wrong: `normalize_form` drops these, and forms already
    in the database carry them, so rejecting would make them uneditable."""
    config = copy.deepcopy(valid_config)
    config["fields"][0]["validation"] = {"min": 1, "max": 10}      # on text
    config["fields"][1]["validation"] = {"pattern": "^[0-9]+$"}    # on decimal
    assert check(config)


def test_uncompilable_pattern_is_rejected(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][0]["validation"] = {"pattern": "^[0-9"}
    issue = fails(config)[0]
    assert issue.field == "fields.0.validation.pattern"
    assert "invalid pattern" in issue.message


def test_valid_pattern_on_text_is_accepted(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][0]["validation"] = {"pattern": "^[A-Za-z ]+$"}
    assert check(config)


def test_every_broken_rule_is_reported_at_once(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][1]["name"] = "farmer_name"      # duplicate
    config["fields"][0]["section"] = "nowhere"       # dangling reference
    config["table_name"] = "forms"                   # reserved
    fields = {i.field for i in fails(config)}
    assert {"fields.1.name", "fields.0.section", "table_name"} <= fields
