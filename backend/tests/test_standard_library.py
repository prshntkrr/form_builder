"""The Standard Form Library.

Every entry is a row carrying its own copy of a definition, so these need
Postgres; skipped when it is not reachable.
"""
import copy
import uuid

import pytest
from psycopg2 import sql

from app import form_service, standard_library as lib
from app.config_validation import (
    BUSINESS_RULE,
    BusinessContext,
    ConfigValidationError,
    validate_config,
)
from app.database import ping, transaction
from app.tabular_service import tabular_name

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")


def drop_form(form_id: str, table: str) -> None:
    with transaction() as cur:
        for name in (tabular_name(table), table):
            cur.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(sql.Identifier(name)))
        cur.execute(sql.SQL("DROP SEQUENCE IF EXISTS {}").format(
            sql.Identifier(f"{table[:43]}_survey_seq")))
        cur.execute("DELETE FROM forms WHERE form_id = %s", (form_id,))


@pytest.fixture
def form(valid_config):
    """A saved form, cleaned up afterwards along with anything it left behind."""
    config = copy.deepcopy(valid_config)
    suffix = uuid.uuid4().hex[:8]
    config["title"] = f"Library Test {suffix}"
    config["table_name"] = f"library_test_{suffix}"

    created = form_service.create_form(config, created_by="tests")
    yield created

    with transaction() as cur:
        cur.execute("DELETE FROM standard_form_library WHERE form_id = %s OR form_id IS NULL "
                    "AND standard_id LIKE 'library_test%%'", (created["form_id"],))
    drop_form(created["form_id"], created["table"]["table_name"])


@pytest.fixture
def standard(form):
    """That form, offered as a standard."""
    entry = form_service.add_to_library(
        form["form_id"], category="Survey", tags=["a", "b"],
        summary="Use for tests.", added_by="tests",
    )
    yield entry
    with transaction() as cur:
        cur.execute("DELETE FROM standard_form_library WHERE standard_id = %s",
                    (entry["standard_id"],))


# --- adding ---------------------------------------------------------------- #
def test_a_saved_form_can_be_offered_as_a_standard(form, standard):
    stored = lib.get(standard["standard_id"])
    assert stored is not None
    assert stored.category == "Survey"
    assert stored.tags == ("a", "b")
    assert stored.field_count == 3
    assert stored.form_id == form["form_id"], "provenance is kept"


def test_the_definition_is_copied_in_not_referenced(form, standard):
    """The row holds the whole definition."""
    with transaction() as cur:
        cur.execute("SELECT form_json FROM standard_form_library WHERE standard_id = %s",
                    (standard["standard_id"],))
        stored = cur.fetchone()["form_json"]
    assert [f["name"] for f in stored["fields"]] == \
           [f["name"] for f in form["form_json"]["fields"]]


def test_the_copy_is_stripped_of_the_source_form(form, standard):
    definition = lib.get(standard["standard_id"]).definition()
    for key in ("form_id", "version", "table_name", "created_by", "updated_by"):
        assert key not in definition, key


def test_the_entry_is_a_valid_config(standard):
    validate_config(lib.get(standard["standard_id"]).definition())


def test_editing_the_source_form_does_not_change_the_standard(form, standard):
    before = [f["name"] for f in lib.get(standard["standard_id"]).definition()["fields"]]

    revised = copy.deepcopy(form["form_json"])
    revised["fields"].append({
        "name": "added_later", "label": "Added Later", "type": "text",
        "options": [], "validation": {}, "order": 99})
    form_service.update_form(form["form_id"], revised)

    after = [f["name"] for f in lib.get(standard["standard_id"]).definition()["fields"]]
    assert after == before


def test_the_standard_outlives_the_form_it_came_from(valid_config):
    """The point of storing a copy: deleting the form must not take it away."""
    config = copy.deepcopy(valid_config)
    suffix = uuid.uuid4().hex[:8]
    config["title"] = f"Outlives Test {suffix}"
    config["table_name"] = f"outlives_test_{suffix}"
    created = form_service.create_form(config, created_by="tests")

    entry = form_service.add_to_library(created["form_id"], standard_id=f"outlives_{suffix}")
    drop_form(created["form_id"], created["table"]["table_name"])

    try:
        survivor = lib.get(entry["standard_id"])
        assert survivor is not None, "the standard was deleted with its form"
        assert survivor.field_count == 3
        assert survivor.form_id is None, "provenance is cleared, the standard is not"
        validate_config(lib.start_from(entry["standard_id"]))
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM standard_form_library WHERE standard_id = %s",
                        (entry["standard_id"],))


def test_a_specific_version_can_be_offered(form):
    revised = copy.deepcopy(form["form_json"])
    revised["fields"] = revised["fields"][:2]
    form_service.update_form(form["form_id"], revised)

    entry = form_service.add_to_library(form["form_id"], version_no=1)
    try:
        assert lib.get(entry["standard_id"]).field_count == 3, "version 1 had three"
    finally:
        form_service.remove_from_library(entry["standard_id"])


def test_the_live_version_is_used_by_default(form):
    revised = copy.deepcopy(form["form_json"])
    revised["fields"] = revised["fields"][:2]
    form_service.update_form(form["form_id"], revised)

    entry = form_service.add_to_library(form["form_id"])
    try:
        assert entry["version_no"] == 2
        assert lib.get(entry["standard_id"]).field_count == 2
    finally:
        form_service.remove_from_library(entry["standard_id"])


def test_adding_again_refreshes_it_and_bumps_the_version(form, standard):
    revised = copy.deepcopy(form["form_json"])
    revised["fields"] = revised["fields"][:2]
    form_service.update_form(form["form_id"], revised)

    again = form_service.add_to_library(
        form["form_id"], standard_id=standard["standard_id"], summary="Revised")
    assert again["standard_version"] == 2
    assert lib.get(standard["standard_id"]).field_count == 2
    assert lib.get(standard["standard_id"]).summary == "Revised"


# --- guards ---------------------------------------------------------------- #
def test_one_library_entry_per_form(form, standard):
    with pytest.raises(lib.LibraryError) as caught:
        form_service.add_to_library(form["form_id"], standard_id="a_different_id")
    assert "already in the library" in str(caught.value)


def test_an_unknown_form_is_rejected():
    with pytest.raises(form_service.FormNotFound):
        form_service.add_to_library("FRM99999")


def test_an_unknown_version_is_rejected(form):
    with pytest.raises(form_service.FormServiceError):
        form_service.add_to_library(form["form_id"], version_no=99)


# --- withdrawing ----------------------------------------------------------- #
def test_withdrawing_removes_it_but_keeps_the_form(form, standard):
    assert form_service.remove_from_library(standard["standard_id"]) is True
    assert lib.get(standard["standard_id"]) is None
    assert form_service.get_form(form["form_id"])["form_id"] == form["form_id"]


def test_withdrawing_something_absent_reports_it():
    assert form_service.remove_from_library("never_existed") is False


# --- lookup ---------------------------------------------------------------- #
def test_get_returns_none_for_an_unknown_id():
    assert lib.get("does_not_exist") is None
    assert lib.get("") is None


def test_search_matches_title_summary_category_and_tags(standard):
    ids = lambda **kw: [e.standard_id for e in lib.search(**kw)]
    assert standard["standard_id"] in ids(query="library test")
    assert standard["standard_id"] in ids(query="use for tests")
    assert standard["standard_id"] in ids(query="survey")
    assert standard["standard_id"] in ids(category="Survey")
    assert ids(query="nothing matches this") == []


def test_search_is_case_insensitive(standard):
    assert lib.search("SURVEY") == lib.search("survey")


def test_summary_entry_omits_the_field_definitions(standard):
    entry = lib.get(standard["standard_id"]).summary_entry()
    assert "form_json" not in entry
    assert entry["field_count"] == 3


def test_the_definition_is_handed_out_as_a_copy(standard):
    first = lib.get(standard["standard_id"]).definition()
    first["fields"][0]["label"] = "Mutated"
    assert lib.get(standard["standard_id"]).definition()["fields"][0]["label"] != "Mutated"


# --- reuse: start from ----------------------------------------------------- #
def test_start_from_produces_a_valid_draft(standard):
    draft = lib.start_from(standard["standard_id"])
    validate_config(draft)
    assert draft["standard_id"] == standard["standard_id"]
    assert draft["standard_version"] == 1


def test_start_from_can_rename(standard):
    draft = lib.start_from(standard["standard_id"], title="Kharif Enrolment 2026")
    assert draft["title"] == "Kharif Enrolment 2026"
    assert draft["table_name"] == "kharif_enrolment_2026"
    assert draft["standard_id"] == standard["standard_id"]


def test_start_from_an_unknown_standard_is_an_error():
    with pytest.raises(LookupError):
        lib.start_from("does_not_exist")


def test_a_draft_from_a_standard_is_fully_editable(standard):
    """Nothing about it is locked: rename, reword, retype, add and remove."""
    draft = lib.start_from(standard["standard_id"])

    draft["title"] = "Something Else Entirely"
    draft["description"] = "Reworded"
    draft["fields"][0]["label"] = "Renamed Question"
    draft["fields"][0]["required"] = False
    draft["fields"][1]["type"] = "text"
    draft["fields"][1]["validation"] = {}
    draft["fields"] = draft["fields"][:2] + [{
        "name": "brand_new", "label": "Brand New", "type": "boolean",
        "options": [], "validation": {}, "section": None, "order": 3}]

    validate_config(draft)
    assert [f["name"] for f in draft["fields"]][-1] == "brand_new"


# --- reuse: borrow --------------------------------------------------------- #
@pytest.fixture
def draft():
    return {
        "title": "My Survey",
        "sections": [{"key": "own", "title": "Own section", "description": ""}],
        "fields": [
            {"name": "plot_code", "label": "Plot Code", "type": "text", "section": "own",
             "options": [], "validation": {}, "order": 1},
        ],
    }


def test_borrow_a_section_appends_its_fields(draft, standard):
    merged = lib.borrow(draft, standard["standard_id"], section="basics")
    validate_config(merged)

    names = [f["name"] for f in merged["fields"]]
    assert names[0] == "plot_code", "the draft's own fields come first"
    assert "farmer_name" in names
    assert "irrigation" not in names, "only the requested section"


def test_borrow_brings_the_section_definition_with_it(draft, standard):
    merged = lib.borrow(draft, standard["standard_id"], section="basics")
    assert {"own", "basics"} <= {s["key"] for s in merged["sections"]}


def test_borrow_everything_when_no_section_is_named(draft, standard):
    merged = lib.borrow(draft, standard["standard_id"])
    validate_config(merged)
    assert len(merged["fields"]) == 4


def test_borrow_suffixes_a_colliding_key_rather_than_overwriting(draft, standard):
    draft = copy.deepcopy(draft)
    draft["fields"].append(
        {"name": "farmer_name", "label": "Our Farmer", "type": "text",
         "options": [], "validation": {}, "order": 2})

    merged = lib.borrow(draft, standard["standard_id"], section="basics")
    validate_config(merged)   # would fail on a duplicate key

    names = [f["name"] for f in merged["fields"]]
    assert names.count("farmer_name") == 1
    assert "farmer_name_2" in names
    kept = next(f for f in merged["fields"] if f["name"] == "farmer_name")
    assert kept["label"] == "Our Farmer", "the draft's own field was kept"


def test_borrow_does_not_modify_the_draft(draft, standard):
    before = copy.deepcopy(draft)
    lib.borrow(draft, standard["standard_id"])
    assert draft == before


def test_borrow_renumbers_the_order(draft, standard):
    merged = lib.borrow(draft, standard["standard_id"])
    assert [f["order"] for f in merged["fields"]] == list(range(1, len(merged["fields"]) + 1))


def test_borrow_an_unknown_section_is_an_error(draft, standard):
    with pytest.raises(LookupError):
        lib.borrow(draft, standard["standard_id"], section="no_such_section")


def test_borrow_from_an_unknown_standard_is_an_error(draft):
    with pytest.raises(LookupError):
        lib.borrow(draft, "does_not_exist")


# --- provenance and drift -------------------------------------------------- #
def test_a_form_with_no_provenance_has_no_drift():
    assert lib.diff_against_standard({"title": "Hand made", "fields": []}) is None


def test_an_untouched_draft_has_not_drifted(standard):
    drift = lib.diff_against_standard(lib.start_from(standard["standard_id"]))
    assert drift["available"] is True
    assert drift["summary"]["identical"] is True
    assert drift["behind"] is False


def test_drift_reports_what_changed(standard):
    draft = lib.start_from(standard["standard_id"])
    draft["fields"] = [f for f in draft["fields"] if f["name"] != "land_area"]
    draft["fields"].append({
        "name": "tractor_owned", "label": "Owns a Tractor", "type": "boolean",
        "options": [], "validation": {}, "section": None, "order": 99})

    drift = lib.diff_against_standard(draft)
    assert [f["name"] for f in drift["added"]] == ["tractor_owned"]
    assert [f["name"] for f in drift["removed"]] == ["land_area"]


def test_drift_flags_a_draft_left_behind(form, standard):
    draft = lib.start_from(standard["standard_id"])
    form_service.add_to_library(form["form_id"], standard_id=standard["standard_id"])
    assert lib.diff_against_standard(draft)["behind"] is True


def test_citing_a_standard_that_no_longer_exists_is_reported():
    drift = lib.diff_against_standard(
        {"title": "Orphan", "fields": [], "standard_id": "retired_standard"})
    assert drift["available"] is False
    assert "no longer in the library" in drift["message"]


# --- the business rule ----------------------------------------------------- #
def test_a_known_standard_reference_is_accepted(standard):
    validate_config(
        lib.start_from(standard["standard_id"]),
        BusinessContext(known_standard_ids=lib.known_ids()),
    )


def test_an_unknown_standard_reference_is_rejected(valid_config):
    config = copy.deepcopy(valid_config)
    config["standard_id"] = "not_a_standard"

    with pytest.raises(ConfigValidationError) as caught:
        validate_config(config, BusinessContext(known_standard_ids=lib.known_ids()))

    issue = caught.value.issues[0]
    assert issue.type == BUSINESS_RULE
    assert issue.field == "standard_id"


def test_the_reference_is_not_checked_when_the_library_is_not_supplied(valid_config):
    config = copy.deepcopy(valid_config)
    config["standard_id"] = "not_a_standard"
    validate_config(config, BusinessContext())
