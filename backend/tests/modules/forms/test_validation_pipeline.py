"""The pipeline itself: ordering, short-circuiting, and the API contract."""
import copy

import pytest

from app.modules.forms import config_validation
from app.modules.forms.config_validation import (
    BUSINESS_RULE,
    STRUCTURAL,
    ConfigValidationError,
    validate_config,
)
from app.modules.forms.form_schema import FormSchemaError, normalize_form


# --- ordering -------------------------------------------------------------- #
def test_both_valid_is_accepted(valid_config):
    assert validate_config(valid_config).title == "Farmer Registration"


def test_structural_failure_skips_business_validation(valid_config, monkeypatch):
    """A business rule must never see a malformed document."""
    ran = []
    monkeypatch.setattr(
        config_validation, "validate_business",
        lambda config, ctx=None: ran.append(True),
    )

    config = copy.deepcopy(valid_config)
    config["fields"][0]["type"] = "hologram"   # structural
    config["fields"][1]["name"] = "farmer_name"  # business, must not be reached

    with pytest.raises(ConfigValidationError) as caught:
        validate_config(config)

    assert ran == [], "business validation ran despite a structural failure"
    assert all(i.type == STRUCTURAL for i in caught.value.issues)


def test_valid_structure_runs_business_validation(valid_config, monkeypatch):
    ran = []
    monkeypatch.setattr(
        config_validation, "validate_business",
        lambda config, ctx=None: ran.append(True) or config,
    )
    validate_config(valid_config)
    assert ran == [True]


def test_a_config_failing_both_reports_only_the_structural_stage(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][0]["type"] = "hologram"     # structural
    config["fields"][1]["name"] = "farmer_name"  # business
    with pytest.raises(ConfigValidationError) as caught:
        validate_config(config)
    types = {i.type for i in caught.value.issues}
    assert types == {STRUCTURAL}


# --- error payload --------------------------------------------------------- #
def test_payload_shape_for_a_structural_failure(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][0]["required"] = "maybe"
    with pytest.raises(ConfigValidationError) as caught:
        validate_config(config)

    payload = caught.value.as_payload()
    assert payload["valid"] is False
    assert payload["errors"]
    error = payload["errors"][0]
    assert set(error) == {"type", "field", "message"}
    assert error["type"] == STRUCTURAL
    assert error["field"] == "fields.0.required"
    assert error["message"]


def test_payload_shape_for_a_business_failure(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][1]["name"] = "farmer_name"
    with pytest.raises(ConfigValidationError) as caught:
        validate_config(config)

    payload = caught.value.as_payload()
    assert payload["valid"] is False
    assert payload["errors"][0]["type"] == BUSINESS_RULE
    assert payload["errors"][0]["field"] == "fields.1.name"


def test_stage_reports_which_layer_failed(valid_config):
    config = copy.deepcopy(valid_config)
    config["fields"][1]["name"] = "farmer_name"
    with pytest.raises(ConfigValidationError) as caught:
        validate_config(config)
    assert caught.value.stage == BUSINESS_RULE


# --- the compatibility guarantee ------------------------------------------- #
# `normalize_form` repairs LLM output instead of rejecting it, and the pipeline
# must never reject what it produces — otherwise a generated form could not be
# saved. Every case below is something the normalizer is expected to repair.
MESSY_CONFIGS = [
    pytest.param(
        {"title": "Aliases", "fields": [
            {"label": "Irrigation", "type": "Multi-Select", "options": ["Canal", "Borewell"]},
            {"label": "Area", "type": "currency"},
            {"label": "Plot", "type": "geopoint"},
        ]}, id="type-aliases"),
    pytest.param(
        {"title": "Duplicates", "fields": [
            {"label": "Farmer Name", "type": "text"},
            {"label": "Farmer Name", "type": "text"},
        ]}, id="duplicate-labels"),
    pytest.param(
        {"title": "Reserved", "fields": [
            {"name": "created_on", "label": "Visit Date", "type": "date"},
            {"name": "form_id", "label": "Reference", "type": "text"},
        ]}, id="reserved-names"),
    pytest.param(
        {"title": "Empty dropdown", "fields": [
            {"label": "Crop", "type": "dropdown", "options": []},
        ]}, id="option-less-dropdown"),
    pytest.param(
        {"title": "Bad ranges", "fields": [
            {"label": "Area", "type": "decimal", "validation": {"min": 500, "max": 10}},
            {"label": "Name", "type": "text", "validation": {"min_length": 50, "max_length": 5}},
        ]}, id="inverted-ranges"),
    pytest.param(
        {"title": "Misplaced rules", "fields": [
            {"label": "Name", "type": "text", "validation": {"min": 1, "max": 10}},
            {"label": "Count", "type": "number", "validation": {"pattern": "^[0-9]+$"}},
        ]}, id="rules-on-the-wrong-type"),
    pytest.param(
        {"fields": [{"id": "first_name", "type": "text", "label": "First Name"},
                    {"id": "gender", "type": "dropdown"}]},
        id="legacy-config-using-id-and-no-title"),
    pytest.param(
        {"title": "Bad pattern", "fields": [
            {"label": "Code", "type": "text", "validation": {"pattern": "^[0-9"}},
        ]}, id="uncompilable-pattern"),
    pytest.param(
        {"title": "Bad default", "fields": [
            {"label": "Crop", "type": "select", "default": "Maize",
             "options": ["Wheat", "Rice"]},
        ]}, id="default-outside-options"),
    pytest.param(
        {"title": "Digit-leading names", "fields": [
            {"name": "1_score", "label": "Score", "type": "scale"},
        ]}, id="digit-leading-name"),
    pytest.param(
        {"title": "Dangling sections", "sections": ["Basics"], "fields": [
            {"label": "Name", "type": "text", "section": "nowhere"},
        ]}, id="dangling-section"),
    pytest.param(
        {"form": {"title": "Wrapped", "fields": [{"label": "Name", "type": "String"}]}},
        id="wrapped-payload"),
    pytest.param(
        {"title": "x" * 400, "submit_label": "y" * 200, "success_message": "z" * 400,
         "fields": [{"label": "Name", "type": "text"}]},
        id="over-long-strings"),
]


@pytest.mark.parametrize("messy", MESSY_CONFIGS)
def test_normalized_output_always_passes_validation(messy):
    """validate_config(normalize_form(x)) never raises."""
    normalized = normalize_form(messy)
    validate_config(normalized)


def test_normalizer_still_rejects_a_config_with_no_usable_fields():
    """Unchanged behaviour: the normalizer has nothing to repair here."""
    with pytest.raises(FormSchemaError):
        normalize_form({"title": "Empty", "fields": []})
