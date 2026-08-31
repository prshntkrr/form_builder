"""Converting a measurement between two units.

Arithmetic, from a table, every time. A conversion is a fact — there is nothing
here for a model to interpret, and nothing here belongs to ICASA or to Crop
Ontology.
"""
import pytest

from app.core.database import ping

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")


@pytest.fixture(scope="module", autouse=True)
def units_loaded():
    from app.modules.standards.units import service
    service.seed_units()


# --- the arithmetic ------------------------------------------------------------ #
def test_a_hundred_centimetres_is_one_metre():
    from app.modules.standards.units import service

    assert service.convert(100, "cm", "m") == {
        "input_value": 100,
        "input_unit": "cm",
        "output_value": 1,
        "output_unit": "m",
        "dimension": "length",
    }


def test_one_metre_is_a_hundred_centimetres():
    from app.modules.standards.units import service

    assert service.convert(1, "m", "cm")["output_value"] == 100


def test_two_and_a_half_metres_comes_back_exactly():
    """250 cm is 2.5 m, not 2.4999999999999996."""
    from app.modules.standards.units import service

    assert service.convert(250, "cm", "m")["output_value"] == 2.5


def test_the_same_unit_is_unchanged():
    from app.modules.standards.units import service

    assert service.convert(7.25, "m", "m")["output_value"] == 7.25


def test_a_tonne_per_hectare_is_a_thousand_kilos():
    from app.modules.standards.units import service

    assert service.convert(3, "t/ha", "kg/ha")["output_value"] == 3000


def test_a_scale_with_an_offset():
    """Celsius and Fahrenheit do not share a zero, so a factor alone is wrong."""
    from app.modules.standards.units import service

    assert service.convert(0, "C", "F")["output_value"] == pytest.approx(32)
    assert service.convert(100, "C", "F")["output_value"] == pytest.approx(212)
    assert service.convert(0, "C", "K")["output_value"] == pytest.approx(273.15)


def test_a_unit_is_recognised_by_another_spelling():
    from app.modules.standards.units import service

    assert service.convert(100, "centimeter", "meter")["output_value"] == 1


def test_the_case_does_not_matter():
    from app.modules.standards.units import service

    assert service.convert(1, "M", "CM")["output_value"] == 100


def test_a_negative_value_converts():
    from app.modules.standards.units import service

    assert service.convert(-40, "C", "F")["output_value"] == pytest.approx(-40)


# --- what it refuses ----------------------------------------------------------- #
def test_units_that_measure_different_things_do_not_convert():
    from app.modules.standards.units import service

    with pytest.raises(service.IncompatibleUnits):
        service.convert(100, "cm", "kg")


def test_an_unknown_unit_is_reported():
    from app.modules.standards.units import service

    with pytest.raises(service.UnknownUnit):
        service.convert(1, "smoots", "m")

    with pytest.raises(service.UnknownUnit):
        service.convert(1, "m", "smoots")


def test_a_value_that_is_not_a_number_is_refused():
    from app.modules.standards.units import service

    with pytest.raises(ValueError):
        service.convert("tall", "cm", "m")


# --- through the API ----------------------------------------------------------- #
def test_the_endpoint_converts(admin_client):
    response = admin_client.post("/api/units/convert",
                                  json={"value": 100, "from_unit": "cm", "to_unit": "m"})

    assert response.status_code == 200
    assert response.json() == {
        "input_value": 100,
        "input_unit": "cm",
        "output_value": 1,
        "output_unit": "m",
        "dimension": "length",
    }


def test_the_endpoint_refuses_incompatible_units(admin_client):
    response = admin_client.post("/api/units/convert",
                                  json={"value": 100, "from_unit": "cm", "to_unit": "kg"})

    assert response.status_code == 400


def test_the_endpoint_refuses_an_unknown_unit(admin_client):
    response = admin_client.post("/api/units/convert",
                                  json={"value": 1, "from_unit": "smoots", "to_unit": "m"})

    assert response.status_code == 400


def test_the_known_units_are_listed(admin_client):
    body = admin_client.get("/api/units").json()
    codes = {u["code"] for u in body["units"]}

    assert {"m", "cm", "kg", "ha", "C"} <= codes


def test_signing_in_is_required():
    from fastapi.testclient import TestClient

    from app.main import app

    assert TestClient(app).post(
        "/api/units/convert",
        json={"value": 1, "from_unit": "m", "to_unit": "cm"},
    ).status_code == 401


# --- what it leaves alone ------------------------------------------------------ #
def test_the_standards_keep_their_own_units():
    """ICASA records plant height in metres and Crop Ontology in centimetres.
    Both stay as they are: this module converts, it does not restate."""
    from app.modules.forms.form_schema import normalize_form

    form = normalize_form({"title": "Maize phenotyping", "fields": [{
        "name": "plant_height", "label": "Plant Height", "type": "decimal",
        "data_standard": {"standard": "ICASA", "variable_id": "935",
                          "variable_name": "PHTD", "unit": "m"},
        "crop_ontology": {"ontology_id": "CO_322", "variable_id": "CO_322:0000996",
                          "trait_name": "Plant height", "scale_name": "cm"},
    }]})
    field = form["fields"][0]

    assert field["data_standard"]["unit"] == "m"
    assert field["crop_ontology"]["scale_name"] == "cm"


def test_a_seed_run_twice_changes_nothing():
    from app.core.database import transaction
    from app.modules.standards.units import service

    with transaction() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM unit")
        before = int(cur.fetchone()["n"])

    service.seed_units()

    with transaction() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM unit")
        assert int(cur.fetchone()["n"]) == before
