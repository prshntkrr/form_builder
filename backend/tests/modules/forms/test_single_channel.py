"""One form, one channel: Web / Mobile, WhatsApp or IVR.

    choosing        `channel` is one value, never a set of switches
    legacy          a form with no `channel` behaves exactly as before
    whatsapp        its conversation references the form's questions and
                    nothing else, and asks each one in a way WhatsApp allows
    publishing      a channel that cannot finish the form cannot go live; IVR
                    cannot go live at all yet
    fixed           a saved form keeps its channel
"""
import uuid

import pytest
from psycopg2 import sql

from app.core.database import ping, transaction
from app.modules.forms import channel_capabilities as caps
from app.modules.forms import channels, form_service
from app.modules.forms.config_validation import (
    BusinessContext, ConfigValidationError, validate_config, validate_publishable,
)
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.tabular_service import tabular_name

needs_db = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

NAME = {"name": "farmer_name", "label": "Farmer Name", "type": "text", "required": True}
CROP = {"name": "crop", "label": "Crop", "type": "select",
        "options": ["WHEAT", "RICE", "MAIZE", "COTTON"]}
IRRIGATED = {"name": "irrigated", "label": "Irrigated", "type": "boolean"}
AREA = {"name": "area", "label": "Area", "type": "decimal"}
PHOTO = {"name": "photo", "label": "Photo", "type": "image"}
BOUNDARY = {"name": "boundary", "label": "Farm Boundary", "type": "polygon", "required": True}
STATE = {"name": "state", "label": "State", "type": "select",
         "options_from": {"source": "client_catalog", "catalog": "states"}}


def config(fields, **extra):
    return {"title": "Single channel", "table_name": "single_channel", "fields": fields, **extra}


def refused(raw, context=None):
    with pytest.raises(ConfigValidationError) as caught:
        validate_config(raw, context)
    return caught.value.issues


# --------------------------------------------------------------------------- #
# one value
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("channel", ["web_mobile", "whatsapp", "ivr"])
def test_each_form_channel_is_a_single_value(channel):
    form = normalize_form(config([NAME], channel=channel))
    assert form["channel"] == channel
    assert channels.form_channel(form) == channel


def test_the_profile_is_derived_from_the_channel_not_stored_beside_it():
    form = normalize_form(config([NAME], channel="whatsapp",
                                 channels={"web": True, "mobile": True, "ivr": True}))
    assert form["channels"] == {"web": {"enabled": False}, "mobile": {"enabled": False},
                                "whatsapp": {"enabled": True}, "ivr": {"enabled": False}}


def test_web_mobile_is_one_choice_covering_both():
    form = normalize_form(config([NAME], channel="web_mobile"))
    assert channels.enabled(form, "web") and channels.enabled(form, "mobile")
    assert not channels.enabled(form, "whatsapp") and not channels.enabled(form, "ivr")


@pytest.mark.parametrize("bad", ["sms", "web", ["web_mobile", "whatsapp"],
                                 {"web_mobile": True, "whatsapp": True}])
def test_anything_but_one_known_channel_is_refused(bad):
    issues = refused(config([NAME], channel=bad))
    assert issues[0].field == "channel"


# --------------------------------------------------------------------------- #
# legacy forms
# --------------------------------------------------------------------------- #
def test_a_legacy_form_is_unchanged_and_reads_as_web_mobile():
    before = normalize_form(config([NAME]))
    assert "channel" not in before and "channels" not in before
    assert channels.form_channel(before) == "web_mobile"


def test_a_legacy_profile_is_kept_as_it_was():
    form = normalize_form(config([NAME], channels={"whatsapp": True, "web": False,
                                                   "mobile": False}))
    assert "channel" not in form
    assert form["channels"] == {"web": {"enabled": False}, "mobile": {"enabled": False},
                                "whatsapp": {"enabled": True}}
    assert channels.form_channel(form) == "whatsapp"


# --------------------------------------------------------------------------- #
# the WhatsApp configuration
# --------------------------------------------------------------------------- #
WHATSAPP = {
    "welcome_message": "Welcome to the farmer survey",
    "order": ["crop", "farmer_name"],
    "fields": {"crop": {"prompt": "What crop do you grow?", "interaction": "list"},
               "farmer_name": {"prompt": "What is your name?", "interaction": "text"}},
    "review": True,
    "completion_message": "Thank you",
}


def test_a_whatsapp_configuration_survives_normalization_and_validation():
    form = normalize_form(config([NAME, CROP], channel="whatsapp",
                                 channel_config={"whatsapp": WHATSAPP}))
    assert form["channel_config"] == {"whatsapp": WHATSAPP}
    validate_config(form)


def test_it_refers_to_questions_it_does_not_copy_them():
    form = normalize_form(config([NAME, CROP, STATE], channel="whatsapp",
                                 channel_config={"whatsapp": WHATSAPP}))
    assert [f["name"] for f in form["fields"]] == ["farmer_name", "crop", "state"]
    # The catalogue question is still a reference; nothing was copied into it.
    state = form["fields"][2]
    assert state["options"] == [] and state["options_from"]["catalog"] == "states"
    assert "options" not in str(form["channel_config"])


def test_nothing_else_can_be_stored_in_it():
    raw = {"whatsapp": {**WHATSAPP, "token": "secret", "business_number": "+91"},
           "picky_assist": {"token": "secret"}}
    form = normalize_form(config([NAME, CROP], channel="whatsapp", channel_config=raw))
    assert "secret" not in str(form) and "+91" not in str(form)

    issues = refused(config([NAME, CROP], channel="whatsapp", channel_config=raw))
    assert all(i.type == "structural" for i in issues)


def test_a_question_the_form_does_not_have_is_refused():
    raw = {"whatsapp": {"order": ["farmer_name", "ghost"],
                        "fields": {"phantom": {"prompt": "?"}}}}
    fields = [i.field for i in refused(normalize_form(
        config([NAME], channel="whatsapp", channel_config=raw)))]
    assert "channel_config.whatsapp.order.1" in fields
    assert "channel_config.whatsapp.fields.phantom" in fields


def test_an_interaction_whatsapp_does_not_have_is_refused():
    raw = {"whatsapp": {"fields": {"crop": {"interaction": "carousel"}}}}
    issues = refused(normalize_form(config([CROP], channel="whatsapp", channel_config=raw)))
    assert issues[0].field == "channel_config.whatsapp.fields.crop.interaction"


@pytest.mark.parametrize("field, interaction", [
    (CROP, "buttons"),            # four choices; WhatsApp allows three buttons
    (NAME, "list"),               # a name is typed, not picked
    (STATE, "list"),              # a catalogue has no fixed length
    ({**BOUNDARY, "required": False}, "text"),   # a boundary cannot be asked at all
])
def test_an_interaction_the_question_cannot_be_asked_as_is_refused(field, interaction):
    raw = {"whatsapp": {"fields": {field["name"]: {"interaction": interaction}}}}
    issues = refused(normalize_form(config([field], channel="whatsapp", channel_config=raw)))
    assert issues[0].field.endswith(".interaction")


def test_how_each_question_can_be_asked():
    assert caps.whatsapp_interactions(NAME) == ["text"]
    assert caps.whatsapp_interactions(AREA) == ["number"]
    assert caps.whatsapp_interactions(IRRIGATED) == ["buttons", "numbered"]
    assert caps.whatsapp_interactions(CROP) == ["list", "numbered"]
    assert caps.whatsapp_interactions({**CROP, "options": ["A", "B"]}) == \
        ["buttons", "list", "numbered"]
    assert caps.whatsapp_interactions(STATE) == ["numbered"]
    assert caps.whatsapp_interactions(PHOTO) == ["media"]
    assert caps.whatsapp_interactions(BOUNDARY) == []
    assert caps.default_whatsapp_interaction(CROP) == "list"


def test_whether_and_how_agree():
    """A type WhatsApp cannot ask has no interaction, and every other type has one."""
    from app.modules.forms.field_types import FIELD_TYPES
    for field_type in FIELD_TYPES:
        field = {"name": "q", "type": field_type, "options": ["A", "B"]}
        assert bool(caps.whatsapp_interactions(field)) == caps.supports("whatsapp", field_type)


def test_the_builder_offers_the_same_interactions():
    """`channelCapabilities.js` mirrors the table; every row must match."""
    import re
    from pathlib import Path

    js = (Path(__file__).resolve().parents[4]
          / "frontend/src/modules/forms/channelCapabilities.js")
    if not js.exists():
        pytest.skip("frontend is not checked out beside the backend")
    block = js.read_text(encoding="utf-8").split("export const WHATSAPP_BY_TYPE = {")[1]
    block = block.split("\n}")[0]

    rows = dict(re.findall(r"^\s*(\w+): \[(.*?)\],?\s*$", block, re.MULTILINE))
    assert set(rows) == set(caps._WHATSAPP_BY_TYPE)
    for field_type, ways in caps._WHATSAPP_BY_TYPE.items():
        assert re.findall(r"'(\w+)'", rows[field_type]) == list(ways), field_type


# --------------------------------------------------------------------------- #
# publishing
# --------------------------------------------------------------------------- #
DRAFT = BusinessContext(form_status="Draft")


def test_a_whatsapp_draft_may_hold_a_question_it_cannot_ask_yet():
    validate_config(normalize_form(config([NAME, BOUNDARY], channel="whatsapp")), DRAFT)


def test_but_it_cannot_go_live():
    issues = refused(normalize_form(config([NAME, BOUNDARY], channel="whatsapp")))
    assert [i.field for i in issues] == ["channels.whatsapp"]
    with pytest.raises(ConfigValidationError):
        validate_publishable(normalize_form(config([NAME, BOUNDARY], channel="whatsapp")))


def test_an_optional_question_it_cannot_ask_does_not_stop_it():
    validate_publishable(normalize_form(
        config([NAME, {**BOUNDARY, "required": False}], channel="whatsapp")))


def test_web_mobile_publishes_what_it_always_could():
    validate_publishable(normalize_form(config([NAME, BOUNDARY], channel="web_mobile")))
    validate_publishable(normalize_form(config([NAME, BOUNDARY])))


def test_an_ivr_form_can_be_drafted_but_not_published():
    validate_config(normalize_form(config([NAME], channel="ivr")), DRAFT)
    issues = refused(normalize_form(config([{"name": "q", "label": "Q", "type": "number"}],
                                           channel="ivr")))
    assert [i.field for i in issues] == ["channel"]


# --------------------------------------------------------------------------- #
# fixed once saved
# --------------------------------------------------------------------------- #
def test_a_saved_form_keeps_its_channel():
    issues = refused(normalize_form(config([NAME], channel="whatsapp")),
                     BusinessContext(updating=True, stored_channel="web_mobile"))
    assert [i.field for i in issues] == ["channel"]


def test_a_legacy_form_is_not_quietly_given_one():
    issues = refused(normalize_form(config([NAME], channel="web_mobile")),
                     BusinessContext(updating=True, stored_channel=None))
    assert [i.field for i in issues] == ["channel"]


def test_saving_with_the_same_channel_is_fine():
    validate_config(normalize_form(config([NAME], channel="whatsapp")),
                    BusinessContext(updating=True, stored_channel="whatsapp"))
    validate_config(normalize_form(config([NAME])),
                    BusinessContext(updating=True, stored_channel=None))


# --------------------------------------------------------------------------- #
# against the database
# --------------------------------------------------------------------------- #
@pytest.fixture
def forms():
    made = []
    yield made
    with transaction() as cur:
        for form_id, table in made:
            cur.execute("DELETE FROM submission_receipt WHERE form_id = %s", (form_id,))
            cur.execute("DELETE FROM submission_channel WHERE form_id = %s", (form_id,))
            for name in (tabular_name(table), table):
                cur.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(
                    sql.Identifier(name)))
            cur.execute(sql.SQL("DROP SEQUENCE IF EXISTS {}").format(
                sql.Identifier(f"{table[:43]}_survey_seq")))
            cur.execute("DELETE FROM form_version WHERE form_id = %s", (form_id,))
            cur.execute("DELETE FROM forms WHERE form_id = %s", (form_id,))


def _form(forms, fields=None, status="Active", **extra):
    created = form_service.create_form(normalize_form({
        "title": f"Single {uuid.uuid4().hex[:6]}",
        "table_name": f"sgl_{uuid.uuid4().hex[:8]}",
        "fields": fields or [NAME, CROP],
        **extra,
    }), created_by="tests", status=status)
    forms.append((created["form_id"], created["table"]["table_name"]))
    return created["form_id"]


@needs_db
def test_a_whatsapp_configuration_saves_and_reloads(forms):
    form_id = _form(forms, channel="whatsapp", channel_config={"whatsapp": WHATSAPP})
    stored = form_service.get_form(form_id)

    assert stored["channel"] == "whatsapp"
    assert stored["form_json"]["channel_config"] == {"whatsapp": WHATSAPP}
    assert [f["name"] for f in stored["form_json"]["fields"]] == ["farmer_name", "crop"]

    # Saved again, unchanged: still valid, still the same.
    form_service.update_form(form_id, stored["form_json"], updated_by="tests")
    again = form_service.get_form(form_id)["form_json"]
    assert again["channel_config"] == {"whatsapp": WHATSAPP}
    assert again["version"] == 2


@needs_db
def test_changing_a_saved_forms_channel_is_refused(forms):
    form_id = _form(forms, channel="web_mobile")
    definition = form_service.get_form(form_id)["form_json"]

    with pytest.raises(ConfigValidationError):
        form_service.update_form(form_id, {**definition, "channel": "whatsapp"},
                                 updated_by="tests")
    assert form_service.get_form(form_id)["channel"] == "web_mobile"


@needs_db
def test_publishing_a_whatsapp_draft_that_cannot_finish_is_refused(forms, editor_client):
    form_id = _form(forms, fields=[NAME, BOUNDARY], channel="whatsapp", status="Draft")

    answer = editor_client.patch(f"/api/forms/{form_id}/status", json={"form_status": "Active"})

    assert answer.status_code == 422
    assert answer.json()["detail"]["errors"][0]["field"] == "channels.whatsapp"
    assert form_service.get_form(form_id)["form_status"] == "Draft"


@needs_db
def test_publishing_a_compatible_whatsapp_draft_works(forms, editor_client):
    form_id = _form(forms, channel="whatsapp", status="Draft")
    answer = editor_client.patch(f"/api/forms/{form_id}/status", json={"form_status": "Active"})
    assert answer.status_code == 200


@needs_db
def test_an_ivr_draft_saves_and_cannot_be_published(forms, editor_client):
    form_id = _form(forms, fields=[{"name": "q", "label": "Q", "type": "number"}],
                    channel="ivr", status="Draft")

    answer = editor_client.patch(f"/api/forms/{form_id}/status", json={"form_status": "Active"})

    assert answer.status_code == 422
    assert form_service.get_form(form_id)["form_status"] == "Draft"
    with pytest.raises(ConfigValidationError):
        _form(forms, fields=[{"name": "q", "label": "Q", "type": "number"}], channel="ivr")


@needs_db
def test_legacy_forms_publish_and_list_as_before(forms, editor_client):
    form_id = _form(forms, status="Draft")
    assert editor_client.patch(f"/api/forms/{form_id}/status",
                               json={"form_status": "Active"}).status_code == 200

    listed = {f["form_id"]: f for f in editor_client.get("/api/forms").json()}
    assert listed[form_id]["channel"] == "web_mobile"


@needs_db
def test_the_forms_list_shows_one_channel_per_form(forms, editor_client):
    web = _form(forms, channel="web_mobile")
    chat = _form(forms, channel="whatsapp")
    ivr = _form(forms, fields=[{"name": "q", "label": "Q", "type": "number"}],
                channel="ivr", status="Draft")

    listed = {f["form_id"]: f["channel"] for f in editor_client.get("/api/forms").json()}
    assert (listed[web], listed[chat], listed[ivr]) == ("web_mobile", "whatsapp", "ivr")


@needs_db
def test_a_whatsapp_form_is_not_filled_on_the_web(forms, editor_client):
    web = _form(forms, channel="web_mobile")
    chat = _form(forms, channel="whatsapp")

    fillable = {f["form_id"] for f in editor_client.get("/api/forms/live/list").json()}
    assert web in fillable and chat not in fillable

    assert editor_client.get(f"/api/forms/{chat}/render").status_code == 409
    assert editor_client.get(f"/api/forms/{web}/render").status_code == 200


@needs_db
def test_each_form_takes_answers_on_its_own_channel_only(forms, editor_client):
    answers = {"farmer_name": "Ramesh", "crop": "RICE"}
    web = _form(forms, channel="web_mobile")
    chat = _form(forms, channel="whatsapp")

    def ingest(form_id, channel, payload):
        return editor_client.post(f"/api/forms/{form_id}/submissions/ingest",
                                  json={"channel": channel, "payload": payload})

    assert editor_client.post(f"/api/forms/{web}/submissions",
                              json={"data": answers}).status_code == 201
    assert ingest(web, "mobile", answers).status_code == 201
    assert ingest(web, "whatsapp", {"answers": answers}).status_code == 422

    assert ingest(chat, "whatsapp", {"answers": answers}).status_code == 201
    assert editor_client.post(f"/api/forms/{chat}/submissions",
                              json={"data": answers}).status_code == 422


@needs_db
def test_legacy_forms_still_take_every_channel_they_took(forms, editor_client):
    legacy = _form(forms)
    for channel, payload in (("mobile", {"farmer_name": "R", "crop": "RICE"}),
                             ("whatsapp", {"messages": ["R", "2"]}),
                             ("ivr", {"digits": {"crop": "2"}})):
        response = editor_client.post(f"/api/forms/{legacy}/submissions/ingest",
                                      json={"channel": channel, "payload": payload})
        # ivr sends no name, so it is refused for that — never for its channel.
        errors = response.json().get("detail", {}).get("errors", {}) \
            if response.status_code == 422 else {}
        assert "_channel" not in errors, channel


# --------------------------------------------------------------------------- #
# no silent channel change, through the API
# --------------------------------------------------------------------------- #
@needs_db
def test_saving_without_the_channel_does_not_turn_a_form_legacy(forms, editor_client):
    """A client that drops `channel` must not quietly make a WhatsApp form a
    legacy one — which would re-open it to every channel."""
    form_id = _form(forms, channel="whatsapp")
    definition = form_service.get_form(form_id)["form_json"]
    dropped = {k: v for k, v in definition.items() if k not in ("channel", "channels")}

    answer = editor_client.put(f"/api/forms/{form_id}", json={"form_json": dropped})

    assert answer.status_code == 422
    assert answer.json()["detail"]["errors"][0]["field"] == "channel"
    assert form_service.get_form(form_id)["channel"] == "whatsapp"


@needs_db
def test_switching_a_saved_forms_channel_through_the_api_is_refused(forms, editor_client):
    form_id = _form(forms, channel="web_mobile")
    definition = form_service.get_form(form_id)["form_json"]

    answer = editor_client.put(f"/api/forms/{form_id}",
                               json={"form_json": {**definition, "channel": "whatsapp"}})

    assert answer.status_code == 422
    assert form_service.get_form(form_id)["channel"] == "web_mobile"
    assert form_service.get_form(form_id)["form_json"]["version"] == 1


@needs_db
def test_creating_with_a_channel_that_is_not_one_is_refused(editor_client):
    answer = editor_client.post("/api/forms", json={"form_json": {
        "title": "Two channels", "fields": [NAME], "channel": "web_mobile,whatsapp"}})
    assert answer.status_code == 422
    assert answer.json()["detail"]["errors"][0]["field"] == "channel"


@needs_db
def test_a_legacy_form_saves_through_the_api_as_it_always_did(forms, editor_client):
    form_id = _form(forms)
    definition = form_service.get_form(form_id)["form_json"]

    answer = editor_client.put(f"/api/forms/{form_id}",
                               json={"form_json": {**definition, "title": "Renamed"}})

    assert answer.status_code == 200
    stored = form_service.get_form(form_id)
    assert "channel" not in stored["form_json"] and stored["channel"] == "web_mobile"
