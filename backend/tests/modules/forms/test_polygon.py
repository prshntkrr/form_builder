"""The polygon field type.

A boundary drawn in the builder is part of the form's definition, and
`_normalize_field` rebuilds every field from a fixed list of keys — so the one
thing worth pinning down hardest is that the ring survives being saved. It did
not, before this: the ring went in, the form came back without it, and nothing
said so.

The rest is the arithmetic of a ring: at least three points, longitude first,
on the globe, closed on the way out.

Anything a test creates, it removes.
"""
import uuid

import pytest

from app.core import registry
from app.core.database import ping, transaction
from app.modules.forms.field_types import FieldValueError, get_type, normalize_type
from app.modules.forms.form_schema import normalize_form

pytestmark = [
    pytest.mark.skipif("forms" in registry.disabled(),
                       reason="forms is switched off (DISABLED_MODULES)"),
]

needs_db = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

# Delhi-ish, as in the specification's own example.
RING = [
    [77.3300, 28.5350],
    [77.4000, 28.5350],
    [77.4000, 28.6200],
    [77.3300, 28.6200],
]

TRIANGLE = [[77.33, 28.53], [77.40, 28.53], [77.40, 28.62]]


def field(**extra):
    return {"name": "farm_boundary", "label": "Farm Boundary",
            "type": "polygon", **extra}


def config(fields):
    suffix = uuid.uuid4().hex[:8]
    return {
        "title": f"Polygon Test {suffix}",
        "table_name": f"polygon_test_{suffix}",
        "sections": [],
        "fields": fields,
    }


# ── the type exists ─────────────────────────────────────────────

def test_polygon_is_a_field_type():
    spec = get_type("polygon")

    assert spec.name == "polygon"
    # Stored the way location is: in form_data, mirrored as TEXT.
    assert spec.pg_type == "TEXT"
    assert not spec.has_options


def test_the_words_people_use_reach_it():
    for word in ("polygon", "Polygon", "boundary", "area", "geo-polygon"):
        assert normalize_type(word) == "polygon", word


# ── the arithmetic of a ring ────────────────────────────────────

def test_three_points_are_enough():
    ring = get_type("polygon").coerce(TRIANGLE)

    assert ring[:3] == TRIANGLE


def test_four_or_more_are_fine_too():
    ring = get_type("polygon").coerce(RING)

    assert ring[:4] == RING


def test_the_ring_is_closed():
    ring = get_type("polygon").coerce(RING)

    assert ring[-1] == ring[0]
    assert len(ring) == len(RING) + 1


def test_a_ring_that_is_already_closed_is_not_closed_twice():
    closed = [*RING, list(RING[0])]

    ring = get_type("polygon").coerce(closed)

    assert len(ring) == len(closed)
    assert ring[-1] == ring[0]


def test_fewer_than_three_points_is_refused():
    with pytest.raises(FieldValueError) as refused:
        get_type("polygon").coerce([[77.33, 28.53], [77.40, 28.53]])

    assert "three points" in str(refused.value)


def test_longitude_off_the_globe_is_refused():
    with pytest.raises(FieldValueError) as refused:
        get_type("polygon").coerce([[200.0, 28.53], *TRIANGLE[1:]])

    assert "Longitude" in str(refused.value)


def test_latitude_off_the_globe_is_refused():
    with pytest.raises(FieldValueError) as refused:
        get_type("polygon").coerce([[77.33, 100.0], *TRIANGLE[1:]])

    assert "Latitude" in str(refused.value)


def test_something_that_is_not_a_number_is_refused():
    with pytest.raises(FieldValueError):
        get_type("polygon").coerce([["east", "north"], *TRIANGLE[1:]])


def test_something_that_is_not_a_pair_is_refused():
    with pytest.raises(FieldValueError):
        get_type("polygon").coerce([[77.33], *TRIANGLE[1:]])


def test_nothing_drawn_is_nothing_stored():
    assert get_type("polygon").coerce(None) is None
    assert get_type("polygon").coerce([]) is None


# ── surviving the definition ────────────────────────────────────

def test_coordinates_survive_normalization():
    """The bug this type was born with: the ring saved, and came back gone."""
    form = normalize_form(config([field(coordinates=RING)]))

    kept = form["fields"][0]

    assert kept["type"] == "polygon"
    assert kept["coordinates"][:4] == RING
    # Closed by the definition, so nothing downstream has to close it.
    assert kept["coordinates"][-1] == kept["coordinates"][0]


def test_a_polygon_nobody_drew_keeps_no_coordinates():
    form = normalize_form(config([field()]))

    assert "coordinates" not in form["fields"][0]


def test_a_ring_too_short_to_enclose_anything_is_not_kept():
    form = normalize_form(config([field(coordinates=[[77.33, 28.53]])]))

    assert "coordinates" not in form["fields"][0]


def test_nonsense_points_are_dropped_rather_than_breaking_the_form():
    ring = [*RING, ["east", "north"], [999.0, 999.0]]

    form = normalize_form(config([field(coordinates=ring)]))

    assert form["fields"][0]["coordinates"][:4] == RING


def test_only_a_polygon_may_carry_coordinates():
    """No other type gets to smuggle a boundary into a form definition."""
    form = normalize_form(config([
        {"name": "farmer_name", "label": "Name", "type": "text",
         "coordinates": RING},
    ]))

    assert "coordinates" not in form["fields"][0]


def test_who_may_redraw_it_is_recorded():
    creator_defined = normalize_form(config([field(coordinates=RING)]))
    respondent_drawn = normalize_form(
        config([field(coordinates=RING, editable=True)]))

    # Read-only unless the form says otherwise: a boundary somebody drew is
    # usually the question rather than the answer.
    assert creator_defined["fields"][0]["editable"] is False
    assert respondent_drawn["fields"][0]["editable"] is True


# ── the existing location work, untouched ───────────────────────

def test_the_location_field_still_behaves():
    spec = get_type("location")

    assert spec.coerce({"lat": 28.6, "lng": 77.3}) == {"lat": 28.6, "lng": 77.3}
    assert spec.coerce(None) is None


def test_a_geofence_still_normalizes_as_it_did():
    """Fences are left open on purpose — `point_in_ring` closes them itself,
    and every fence already stored is open."""
    form = normalize_form({
        **config([field(coordinates=RING)]),
        "location": {"enabled": True, "required": True},
        "geofence": {"enabled": True, "polygon": RING},
    })

    assert form["location"] == {"enabled": True, "required": True}
    assert form["geofence"]["polygon"] == RING
    assert form["geofence"]["polygon"][-1] != form["geofence"]["polygon"][0]


def test_a_geofence_of_two_points_still_normalizes_away():
    form = normalize_form({
        **config([field()]),
        "geofence": {"enabled": True, "polygon": RING[:2]},
    })

    assert form.get("geofence") is None


# ── saved, and read back ────────────────────────────────────────

@needs_db
def test_coordinates_survive_a_save_and_a_reload(admin_client):
    made = admin_client.post(
        "/api/forms",
        json={"form_json": config([field(coordinates=RING)]),
              "form_status": "Active"},
    )
    assert made.status_code in (200, 201), made.text
    saved = made.json()

    try:
        reloaded = admin_client.get(f"/api/forms/{saved['form_id']}")
        assert reloaded.status_code == 200, reloaded.text

        fields = reloaded.json()["form_json"]["fields"]
        polygon = next(f for f in fields if f["type"] == "polygon")

        assert polygon["coordinates"][:4] == RING
        assert polygon["coordinates"][-1] == polygon["coordinates"][0]
    finally:
        admin_client.delete(f"/api/forms/{saved['form_id']}")

        table = (saved.get("table") or {}).get("table_name")
        if table:
            try:
                with transaction() as cur:
                    cur.execute(f'DROP TABLE IF EXISTS "{table}" CASCADE')
            except Exception:
                pass
