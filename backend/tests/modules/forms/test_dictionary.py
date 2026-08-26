"""The data dictionary: agreed types and limits for known field names."""
import uuid

import pytest

from app.core.database import ping, transaction
from app.modules.forms import dictionary_service

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")


@pytest.fixture
def entry():
    """Throwaway entries, removed afterwards."""
    made = []

    def make(name, field_type="text", **kw):
        unique = f"{name}_{uuid.uuid4().hex[:6]}"
        created = dictionary_service.create_entry(unique, kw.pop("label", ""), field_type, **kw)
        made.append(created["entry_id"])
        return created

    yield make

    with transaction() as cur:
        for entry_id in made:
            cur.execute("DELETE FROM data_dictionary WHERE entry_id = %s", (entry_id,))


# --- writing entries -------------------------------------------------------- #
def test_an_entry_records_a_type_and_its_limits(entry):
    made = entry("plant_height", "decimal", label="Plant Height",
                 validation={"min": 0, "max": 25})

    assert made["field_type"] == "decimal"
    assert made["validation"] == {"min": 0, "max": 25}


def test_the_name_is_slugified(entry):
    made = entry("First Name")
    assert made["name"].startswith("first_name")


def test_a_label_is_derived_when_none_is_given(entry):
    made = entry("soil_ph")
    assert made["label"].lower().startswith("soil ph")


def test_a_made_up_type_is_refused():
    with pytest.raises(dictionary_service.DictionaryError) as caught:
        dictionary_service.create_entry("nonsense", "Nonsense", "hologram")
    assert "not a field type" in str(caught.value)


def test_the_same_name_twice_is_refused(entry):
    made = entry("duplicated")
    with pytest.raises(dictionary_service.DictionaryError):
        dictionary_service.create_entry(made["name"], "Again", "text")


def test_rules_the_field_spec_does_not_know_are_dropped(entry):
    made = entry("bounded", "number", validation={"min": 1, "colour": "red", "max": ""})
    assert made["validation"] == {"min": 1}


def test_aliases_are_slugified_and_never_repeat_the_name(entry):
    made = entry("height", "decimal", aliases=["Plant Ht", "plant ht", "height"])
    assert "plant_ht" in made["aliases"]
    assert made["name"] not in made["aliases"]


def test_changing_an_entry(entry):
    made = entry("changeable", "text")
    updated = dictionary_service.update_entry(
        made["entry_id"], field_type="number", validation={"min": 0})

    assert updated["field_type"] == "number"
    assert updated["validation"] == {"min": 0}
    assert updated["name"] == made["name"], "the name is the entry's identity"


def test_removing_an_entry(entry):
    made = entry("temporary")
    assert dictionary_service.delete_entry(made["entry_id"])["deleted"] is True
    with pytest.raises(dictionary_service.EntryNotFound):
        dictionary_service.get_entry(made["entry_id"])


# --- applying it to a draft ------------------------------------------------- #
def test_the_dictionary_decides_the_type_and_the_limits(entry):
    made = entry("age", "number", validation={"min": 1, "max": 120})

    draft = {"fields": [
        {"name": made["name"], "label": "Age", "type": "text", "options": [], "validation": {}},
    ]}
    result = dictionary_service.apply_to_form(draft)
    field = result["form_json"]["fields"][0]

    assert field["type"] == "number", "the model said text; the dictionary says otherwise"
    assert field["validation"] == {"min": 1, "max": 120}
    assert result["applied"][0]["field"] == made["name"]


def test_an_alias_matches_too(entry):
    made = entry("plant_height", "decimal", aliases=["ht"], validation={"max": 25})
    alias = made["aliases"][0]

    draft = {"fields": [
        {"name": alias, "label": "Ht", "type": "text", "options": [], "validation": {}},
    ]}
    field = dictionary_service.apply_to_form(draft)["form_json"]["fields"][0]

    assert field["type"] == "decimal"
    assert field["validation"] == {"max": 25}


def test_wording_is_only_filled_in_never_overwritten(entry):
    made = entry("first_name", "text", label="First Name", help_text="As on the ID card")

    draft = {"fields": [
        {"name": made["name"], "label": "Name of farmer", "type": "text",
         "help_text": "", "options": [], "validation": {}},
    ]}
    field = dictionary_service.apply_to_form(draft)["form_json"]["fields"][0]

    assert field["label"] == "Name of farmer", "the author's wording stands"
    assert field["help_text"] == "As on the ID card", "the empty one was filled in"


def test_a_field_nobody_agreed_is_left_alone(entry):
    entry("known", "number")

    draft = {"fields": [
        {"name": "something_else", "label": "Whatever", "type": "text",
         "options": [], "validation": {}},
    ]}
    result = dictionary_service.apply_to_form(draft)

    assert result["form_json"]["fields"][0]["type"] == "text"
    assert result["applied"] == []


def test_an_empty_dictionary_changes_nothing():
    draft = {"fields": [{"name": "anything", "type": "text"}]}
    with transaction() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM data_dictionary")
        if cur.fetchone()["n"]:
            pytest.skip("the dictionary has entries; this checks the empty case")

    result = dictionary_service.apply_to_form(draft)
    assert result["form_json"] is draft
    assert result["applied"] == []
