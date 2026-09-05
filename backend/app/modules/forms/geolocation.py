"""Where a submission was filled in, and whether that was somewhere allowed.

Two separate things, and the form configures them separately:

    location   {"enabled": true, "required": false}
    geofence   {"enabled": true, "polygon": [[lng, lat], ...]}

A form can collect a position without fencing it. A form cannot fence without
collecting one — there would be nothing to test.

The browser decides nothing here. It reports a position; whether that position
is acceptable is worked out again on this side, from the polygon stored on the
form. A page can say "you look outside the area" as a courtesy, and a page that
lies about it changes nothing.
"""
from typing import Any, Dict, List, Optional, Tuple


class LocationError(ValueError):
    """The position is missing, unusable, or outside the form's area."""


def read_position(raw: Any) -> Optional[Dict[str, Any]]:
    """The position a client reported, or None if it reported none.

    Four things are kept and nothing else: where, how sure, and when. Anything
    further the browser offers — heading, altitude, speed — is not asked for and
    is not stored.
    """
    if not isinstance(raw, dict):
        return None

    if raw.get("latitude") is None or raw.get("longitude") is None:
        return None

    try:
        latitude = float(raw["latitude"])
        longitude = float(raw["longitude"])
    except (TypeError, ValueError):
        raise LocationError("The location is not a pair of coordinates.")

    if not (-90 <= latitude <= 90) or not (-180 <= longitude <= 180):
        raise LocationError(
            f"{latitude}, {longitude} is not a place on Earth."
        )

    position: Dict[str, Any] = {"latitude": latitude, "longitude": longitude}

    accuracy = raw.get("accuracy")
    if accuracy is not None:
        try:
            position["accuracy"] = float(accuracy)
        except (TypeError, ValueError):
            pass

    captured = str(raw.get("captured_at") or "").strip()
    if captured:
        position["captured_at"] = captured[:40]

    return position


def point_in_ring(longitude: float, latitude: float,
                  ring: List[List[float]]) -> bool:
    """Whether a point is inside a polygon — the ray-casting rule.

    Count the edges a ray to the east crosses: an odd number means inside. The
    ring is treated as closed whether or not its last point repeats its first.

    A point exactly on an edge may fall either way. That is inherent to the
    method and not worth more code: a geofence is drawn around an area, not
    surveyed to the centimetre, and the accuracy of a phone's own reading is
    metres wide.
    """
    inside = False
    count = len(ring)

    for i in range(count):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % count][0], ring[(i + 1) % count][1]

        # Does the edge straddle the ray's latitude?
        if (y1 > latitude) == (y2 > latitude):
            continue

        # Where the edge crosses that latitude, in longitude.
        crossing = x1 + (latitude - y1) * (x2 - x1) / (y2 - y1)
        if longitude < crossing:
            inside = not inside

    return inside


def check(form_json: Dict[str, Any], raw: Any) -> Tuple[Optional[Dict[str, Any]], None]:
    """The position to store for this submission. Raises if it cannot be stored.

    In order:

        the form does not collect one   nothing is stored, whatever was sent
        required and missing            refused
        present but nonsense            refused
        a fence, and outside it         refused
        anything else                   stored

    Returns the position, or None for a form that collects none.
    """
    from app.modules.forms.form_schema import (
        collects_location, geofence_of, location_required,
    )

    if not collects_location(form_json):
        # Not asked for, so not kept — a client sending one anyway does not get
        # to add a column to somebody else's form.
        return None, None

    position = read_position(raw)

    if position is None:
        if location_required(form_json):
            raise LocationError(
                "This form records where it was filled in, and no location was "
                "given. Allow location access and try again."
            )
        return None, None

    fence = geofence_of(form_json)
    if fence and not point_in_ring(position["longitude"], position["latitude"],
                                   fence["polygon"]):
        raise LocationError("You are outside the allowed location for this form.")

    return position, None
