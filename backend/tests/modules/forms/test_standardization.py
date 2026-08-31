"""Storing an answer in its standard's unit.

Maize plant height is collected in centimetres, because that is the Crop
Ontology scale for CO_322:0000996. ICASA records the same variable in metres.
Both definitions stay exactly as they are; the arithmetic between them happens
once, on submission, and the standardized figure is what gets stored.

    submitted   {"crop_type": "CO_322", "plant_height": 150}
    stored      {"crop_type": "CO_322", "plant_height": 1.5}

No unit goes into `form_data`: the field definition says what unit that number
is in, and the definition is versioned alongside the answers.
"""
import copy
import uuid

import pytest
from psycopg2 import sql

from app.core.database import ping, transaction
from app.modules.forms import form_service
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.submission_service import ValidationFailed, validate_payload
from app.modules.forms.tabular_service import tabular_name

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

MAIZE = "CO_322"
PLANT_HEIGHT = f"{MAIZE}:0000996"


@pytest.fixture(scope="module", autouse=True)
def units_loaded():
    from app.modules.standards.units import service
    service.seed_units()


@pytest.fixture
def cleanup():
    made = []
    yield made
    with transaction() as cur:
        for form_id, table in made:
            for name in (tabular_name(table), table):
                cur.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(sql.Identifier(name)))
            cur.execute(sql.SQL("DROP SEQUENCE IF EXISTS {}").format(
                sql.Identifier(f"{table[:43]}_survey_seq")))
            cur.execute("DELETE FROM form_version WHERE form_id = %s", (form_id,))
            cur.execute("DELETE FROM forms WHERE form_id = %s", (form_id,))


# The test form from the brief: a Crop Ontology scale of cm, an ICASA unit of m.
def _form(input_unit=None, standard_unit="m", scale_name="cm"):
    field = {
        "name": "plant_height",
        "label": "Plant Height",
        "type": "decimal",
        "crop_ontology": {
            "ontology_id": MAIZE,
            "variable_id": PLANT_HEIGHT,
            "trait_name": "Plant height",
            "scale_name": scale_name,
        },
        "data_standard": {
            "standard": "ICASA",
            "variable_id": "935",
            "variable_code": "PHTD",
            "variable_name": "plant_height",
            "unit": standard_unit,
        },
    }
    if input_unit:
        field["input_unit"] = input_unit

    return normalize_form({
        "title": "Maize Plant Height Unit Conversion Test",
        "fields": [
            {"name": "crop_type", "label": "Crop", "type": "select",
             "options_from": {"source": "crop_ontology", "kind": "crop"}},
            field,
        ],
    })


def _stored(form, payload):
    """The plant_height as it would land in `form_data`."""
    return validate_payload(form, payload)["plant_height"]


# --- the conversion ------------------------------------------------------------ #
def test_a_hundred_and_fifty_centimetres_is_stored_as_one_and_a_half_metres():
    """The example from the brief, through the ordinary validation path."""
    assert validate_payload(_form(), {"crop_type": MAIZE, "plant_height": 150}) == \
        {"crop_type": MAIZE, "plant_height": 1.5}


def test_a_hundred_centimetres_is_one_metre():
    assert _stored(_form(), {"plant_height": 100}) == 1


def test_two_hundred_and_fifty_centimetres_is_two_and_a_half_metres():
    assert _stored(_form(), {"plant_height": 250}) == 2.5


def test_one_metre_in_a_form_that_records_metres_is_one_metre():
    """Input unit and standard unit agree, so the number does not move."""
    assert _stored(_form(input_unit="m"), {"plant_height": 1}) == 1


def test_the_conversion_runs_in_either_direction():
    """A form collecting metres against a standard in centimetres. Nothing
    about the arithmetic is one-way."""
    assert _stored(_form(input_unit="m", standard_unit="cm"), {"plant_height": 1}) == 100


def test_the_written_input_unit_wins_over_the_scale():
    """A form author who says outright what the field is collected in is the
    best evidence there is."""
    assert _stored(_form(input_unit="mm"), {"plant_height": 1500}) == 1.5


def test_the_arithmetic_is_not_a_lookup_table():
    """Any value, not just the one in the brief."""
    form = _form()

    assert _stored(form, {"plant_height": 37}) == 0.37
    assert _stored(form, {"plant_height": 249.5}) == 2.495


def test_no_conversion_metadata_is_stored_beside_the_answer():
    clean = validate_payload(_form(), {"crop_type": MAIZE, "plant_height": 150})

    assert set(clean) == {"crop_type", "plant_height"}
    assert "_standardized" not in clean
    assert "plant_height_unit" not in clean


# --- what it refuses ----------------------------------------------------------- #
def test_units_measuring_different_things_are_refused():
    """A field collected in centimetres against a standard in kilograms is a
    mistake in the form. Storing a number nobody can interpret is worse."""
    with pytest.raises(ValidationFailed) as raised:
        validate_payload(_form(standard_unit="kg"), {"plant_height": 150})

    assert "plant_height" in raised.value.errors


def test_a_standard_unit_nobody_knows_is_refused():
    with pytest.raises(ValidationFailed) as raised:
        validate_payload(_form(standard_unit="smoots"), {"plant_height": 150})

    assert "plant_height" in raised.value.errors


def test_a_scale_that_is_not_a_unit_is_left_alone():
    """Crop Ontology scales are not all units — `1-9` is a rating. There is
    nothing to convert and nothing to complain about."""
    assert validate_payload(_form(scale_name="1-9"), {"plant_height": 7}) == \
        {"crop_type": None, "plant_height": 7}


@pytest.mark.parametrize("unit", ["code", "date", "text", "number", ""])
def test_an_icasa_unit_that_is_not_a_measurement_is_left_alone(unit):
    """ICASA fills its unit column for coded and dated variables too."""
    assert _stored(_form(standard_unit=unit), {"plant_height": 150}) == 150


# --- everything that was already working ---------------------------------------- #
def test_a_form_with_no_standards_is_unchanged():
    form = normalize_form({"title": "Farmer Registration", "fields": [
        {"name": "farmer_name", "label": "Farmer Name", "type": "text"},
        {"name": "plot_area", "label": "Plot Area", "type": "decimal"},
    ]})

    assert validate_payload(form, {"farmer_name": "Asha", "plot_area": 2.5}) == \
        {"farmer_name": "Asha", "plot_area": 2.5}


def test_a_standard_with_no_units_involved_is_unchanged():
    """SEOnt says what a field means. It says nothing about units, and nothing
    about it changed."""
    form = normalize_form({"title": "Crop", "fields": [
        {"name": "crop", "label": "Crop", "type": "text",
         "semantic_concept": {"standard": "SEOnt", "uri": "http://x/AGRO_00000325",
                              "label": "crop"}},
    ]})

    assert validate_payload(form, {"crop": "Maize"}) == {"crop": "Maize"}


def test_a_text_answer_is_never_converted():
    form = normalize_form({"title": "X", "fields": [
        {"name": "plant_height", "label": "Plant Height", "type": "text",
         "input_unit": "cm",
         "data_standard": {"standard": "ICASA", "variable_id": "935", "unit": "m"}},
    ]})

    assert validate_payload(form, {"plant_height": "tall"}) == {"plant_height": "tall"}


def test_an_unanswered_field_converts_nothing():
    assert validate_payload(_form(), {"plant_height": None}) == \
        {"crop_type": None, "plant_height": None}


def test_the_form_definitions_units_are_untouched():
    """The whole point: ICASA still says metres, Crop Ontology still says
    centimetres, and the conversion changed neither."""
    form = _form()
    before = copy.deepcopy(form["fields"][1])

    validate_payload(form, {"crop_type": MAIZE, "plant_height": 150})

    assert form["fields"][1] == before
    assert form["fields"][1]["data_standard"]["unit"] == "m"
    assert form["fields"][1]["crop_ontology"]["scale_name"] == "cm"


def test_the_form_rules_are_checked_against_what_was_entered():
    """A limit written on the form is the client's limit in the client's unit.
    "no taller than 250" means 250 cm, and is checked before anything converts."""
    form = _form()
    form["fields"][1]["validation"] = {"max": 250}

    assert _stored(form, {"plant_height": 150}) == 1.5

    with pytest.raises(ValidationFailed):
        validate_payload(form, {"plant_height": 300})


# --- through an actual submission ----------------------------------------------- #
def _live_form(cleanup, **kwargs):
    definition = _form(**kwargs)
    suffix = uuid.uuid4().hex[:8]
    definition["title"] = f"Maize Plant Height Unit Conversion Test {suffix}"
    definition["table_name"] = f"maize_height_test_{suffix}"

    created = form_service.create_form(definition, created_by="tests")
    cleanup.append((created["form_id"], created["table"]["table_name"]))
    return created


def test_a_submission_stores_the_standardized_value(cleanup):
    """End to end: 150 goes in, the row holds 1.5."""
    from app.modules.forms import submission_service

    created = _live_form(cleanup)
    form = form_service.get_form(created["form_id"])

    result = submission_service.submit(form, {"crop_type": MAIZE, "plant_height": 150},
                                       created_by="tests")

    with transaction() as cur:
        cur.execute(
            sql.SQL("SELECT form_data FROM {} WHERE survey_id = %s").format(
                sql.Identifier(created["table"]["table_name"])),
            (result["survey_id"],),
        )
        stored = cur.fetchone()["form_data"]

    assert stored == {"crop_type": MAIZE, "plant_height": 1.5}


def test_the_flat_mirror_holds_the_standardized_value(cleanup):
    """The mirror is built from `form_data`, so standardizing the value there
    standardizes the column too — no change to the tabular architecture."""
    from app.modules.forms import submission_service

    created = _live_form(cleanup)
    form = form_service.get_form(created["form_id"])
    table = created["table"]["table_name"]

    submission_service.submit(form, {"crop_type": MAIZE, "plant_height": 150},
                              created_by="tests")

    with transaction() as cur:
        cur.execute(sql.SQL("SELECT plant_height FROM {}").format(
            sql.Identifier(tabular_name(table))))
        assert float(cur.fetchone()["plant_height"]) == 1.5


def test_a_rebuilt_mirror_agrees_with_the_stored_answers(cleanup):
    """Rebuild repopulates the mirror from `form_data`. Because the standardized
    figure is the stored answer, a rebuild cannot disagree with a submission."""
    from app.modules.forms import submission_service, tabular_service

    created = _live_form(cleanup)
    form = form_service.get_form(created["form_id"])
    table = created["table"]["table_name"]

    submission_service.submit(form, {"crop_type": MAIZE, "plant_height": 150},
                              created_by="tests")

    with transaction() as cur:
        tabular_service.rebuild(cur, form["form_json"], form["form_id"])
        cur.execute(sql.SQL("SELECT plant_height FROM {}").format(
            sql.Identifier(tabular_name(table))))
        assert float(cur.fetchone()["plant_height"]) == 1.5


def test_a_submission_with_bad_units_is_refused_and_stores_nothing(cleanup):
    from app.modules.forms import submission_service

    created = _live_form(cleanup, standard_unit="kg")
    form = form_service.get_form(created["form_id"])

    with pytest.raises(ValidationFailed):
        submission_service.submit(form, {"plant_height": 150}, created_by="tests")

    with transaction() as cur:
        cur.execute(sql.SQL("SELECT COUNT(*) AS n FROM {}").format(
            sql.Identifier(created["table"]["table_name"])))
        assert int(cur.fetchone()["n"]) == 0


def test_testing_a_draft_shows_the_standardized_value_without_storing_it(editor_client):
    """The preview reports exactly what would be stored."""
    body = editor_client.post("/api/forms/test-definition",
                              json={"form_json": _form(),
                                    "data": {"crop_type": MAIZE, "plant_height": 150}}).json()

    assert body["valid"] is True
    assert body["form_data"] == {"crop_type": MAIZE, "plant_height": 1.5}
    assert body["columns"] == ["crop_type", "plant_height"]
