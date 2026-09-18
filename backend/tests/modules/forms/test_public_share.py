"""A form, open to whoever holds the link.

These are the only routes in the application that take no session, so most of
what is worth asserting here is what a link does *not* open: no other form, no
collected answers, no way to name a table, and no way to claim somebody else's
submission as a parent.

Anything a test creates, it removes — the form and its table.
"""
import uuid

import pytest

from app.core import registry
from app.core.database import ping, transaction

pytestmark = [
    pytest.mark.skipif(not ping(), reason="Postgres is not reachable"),
    pytest.mark.skipif("forms" in registry.disabled(),
                       reason="forms is switched off (DISABLED_MODULES)"),
]


@pytest.fixture(scope="module")
def anonymous():
    """A client with no session at all — what somebody opening a link has."""
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


def _make_form(client, config, *, status="Active", extra_field=None):
    suffix = uuid.uuid4().hex[:8]
    config = {**config}
    config["title"] = f"Public Share {suffix}"
    config["table_name"] = f"public_share_{suffix}"

    if extra_field:
        config["fields"] = [*config["fields"], extra_field]

    made = client.post(
        "/api/forms", json={"form_json": config, "form_status": status}
    )
    assert made.status_code in (200, 201), made.text
    return made.json()


def _remove(client, made):
    client.delete(f"/api/forms/{made['form_id']}")

    table = (made.get("table") or {}).get("table_name")
    if table:
        try:
            with transaction() as cur:
                cur.execute(f'DROP TABLE IF EXISTS "{table}" CASCADE')
        except Exception:
            pass


@pytest.fixture
def form(admin_client, valid_config):
    made = _make_form(admin_client, valid_config)
    yield made
    _remove(admin_client, made)


def _share(client, form_id, **body):
    return client.post(f"/api/forms/{form_id}/public-share", json=body)


# ── issuing a link ──────────────────────────────────────────────

def test_a_form_that_is_not_active_cannot_be_shared(admin_client, valid_config):
    made = _make_form(admin_client, valid_config, status="Draft")

    try:
        response = _share(admin_client, made["form_id"])

        assert response.status_code == 409
        assert "active" in response.json()["detail"].lower()
    finally:
        _remove(admin_client, made)


def test_a_form_asking_for_a_photo_cannot_be_shared(admin_client, valid_config):
    """Nobody without an account can upload, so a form that needs one would
    half-work: a required photo that can never be given."""
    made = _make_form(admin_client, valid_config, extra_field={
        "name": "plot_photo", "label": "Plot photo", "type": "image",
        "required": False, "section": "basics", "options": [], "order": 99,
    })

    try:
        response = _share(admin_client, made["form_id"])

        assert response.status_code == 409
        assert "plot_photo" in response.json()["detail"]
    finally:
        _remove(admin_client, made)


def test_sharing_issues_an_unguessable_token(admin_client, form):
    state = _share(admin_client, form["form_id"]).json()

    assert state["enabled"] is True
    assert len(state["token"]) >= 32
    assert form["form_id"] not in state["token"]


def test_sharing_twice_keeps_the_same_link(admin_client, form):
    first = _share(admin_client, form["form_id"]).json()["token"]
    second = _share(admin_client, form["form_id"]).json()["token"]

    assert first == second


def test_regenerating_breaks_the_old_link(admin_client, anonymous, form):
    old = _share(admin_client, form["form_id"]).json()["token"]
    assert anonymous.get(f"/api/public/forms/{old}").status_code == 200

    new = _share(admin_client, form["form_id"], regenerate=True).json()["token"]

    assert new != old
    assert anonymous.get(f"/api/public/forms/{old}").status_code == 404
    assert anonymous.get(f"/api/public/forms/{new}").status_code == 200


def test_disabling_breaks_it_too(admin_client, anonymous, form):
    token = _share(admin_client, form["form_id"]).json()["token"]

    removed = admin_client.delete(f"/api/forms/{form['form_id']}/public-share")
    assert removed.status_code == 200
    assert removed.json()["enabled"] is False

    assert anonymous.get(f"/api/public/forms/{token}").status_code == 404


def test_an_expired_link_stops_working(admin_client, anonymous, form):
    token = _share(
        admin_client, form["form_id"], expires_on="2020-01-01T00:00:00",
    ).json()["token"]

    assert anonymous.get(f"/api/public/forms/{token}").status_code == 404


# ── following one ───────────────────────────────────────────────

def test_a_link_opens_without_a_session(anonymous, admin_client, form):
    token = _share(admin_client, form["form_id"]).json()["token"]

    body = anonymous.get(f"/api/public/forms/{token}").json()

    assert body["form_json"]["title"].startswith("Public Share")
    assert any(f["name"] == "farmer_name" for f in body["form_json"]["fields"])


def test_a_link_gives_away_nothing_else(anonymous, admin_client, form):
    """Not the form's id, its table, its project or who built it."""
    token = _share(admin_client, form["form_id"]).json()["token"]

    body = anonymous.get(f"/api/public/forms/{token}").json()

    assert "form_id" not in body
    assert "table_name" not in body
    assert "created_by" not in body
    assert form["form_id"] not in str(body)


def test_a_token_that_names_nothing_is_a_404(anonymous):
    assert anonymous.get("/api/public/forms/not-a-real-token").status_code == 404


def test_the_rest_of_the_application_still_needs_a_session(anonymous):
    """One open door, not an open building."""
    assert anonymous.get("/api/forms").status_code in (401, 403)
    assert anonymous.get("/api/forms/live/list").status_code in (401, 403)


# ── answering it ────────────────────────────────────────────────

def test_a_public_submission_is_stored_and_marked_public_web(
    anonymous, admin_client, form,
):
    from app.modules.forms import ingestion

    token = _share(admin_client, form["form_id"]).json()["token"]

    response = anonymous.post(
        f"/api/public/forms/{token}/submissions",
        json={"data": {"farmer_name": "Ramesh", "land_area": 2}},
    )

    assert response.status_code == 201, response.text
    survey_id = response.json()["survey_id"]
    assert survey_id

    # Recorded the way every other channel is, beside the submission.
    assert ingestion.channel_of(form["form_id"], survey_id) == "public_web"


def test_a_public_submission_is_not_attributed_to_a_person(
    anonymous, admin_client, form,
):
    token = _share(admin_client, form["form_id"]).json()["token"]

    anonymous.post(
        f"/api/public/forms/{token}/submissions",
        json={"data": {"farmer_name": "Sunita", "land_area": 1}},
    )

    table = (form.get("table") or {}).get("table_name")
    with transaction() as cur:
        cur.execute(f'SELECT created_by FROM "{table}"')
        authors = {row["created_by"] for row in cur.fetchall()}

    assert authors == {"Public link"}


def test_the_answers_are_still_validated(anonymous, admin_client, form):
    """The public path is the ordinary path: a required answer is required."""
    token = _share(admin_client, form["form_id"]).json()["token"]

    response = anonymous.post(
        f"/api/public/forms/{token}/submissions", json={"data": {}},
    )

    assert response.status_code == 422
    assert "farmer_name" in str(response.json())


def test_a_public_caller_cannot_claim_a_parent_submission(
    anonymous, admin_client, form,
):
    """Extra claims are not read at all — the server decides every one of them."""
    token = _share(admin_client, form["form_id"]).json()["token"]

    response = anonymous.post(
        f"/api/public/forms/{token}/submissions",
        json={
            "data": {"farmer_name": "Anil", "land_area": 3},
            "parent_survey_id": "SOMEONE-ELSES",
            "survey_id": "CHOSEN-BY-ME",
        },
    )

    assert response.status_code == 201
    assert response.json()["survey_id"] != "CHOSEN-BY-ME"


def test_answering_needs_a_live_link(anonymous):
    response = anonymous.post(
        "/api/public/forms/not-a-real-token/submissions",
        json={"data": {"farmer_name": "Nobody"}},
    )

    assert response.status_code == 404
