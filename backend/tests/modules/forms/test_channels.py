"""The shared channel foundation.

    capabilities      which channel can ask which kind of question
    profile           `form_json.channels`: normalized, validated, defaulted
    compatibility     a channel is enabled only if it can finish the form
    enforcement       a profiled form refuses answers from a closed channel
    validate_field    one question at a time, by the same code as a whole form
    receipts          the same submission sent twice is stored once
    atomicity         answers, receipt and channel note commit or vanish together

The claim running through all of it: a form with no channel profile — every
form that existed before this — behaves exactly as it did.
"""
import copy
import re
import threading
import uuid
from pathlib import Path

import pytest
from psycopg2 import sql

from app.core.database import ping, transaction
from app.modules.forms import (
    channel_capabilities, channels, form_service, ingestion, submission_service,
)
from app.modules.forms.config_validation import ConfigValidationError, validate_config
from app.modules.forms.field_types import FIELD_TYPES
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.tabular_service import tabular_name

needs_db = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

TEXT = {"name": "farm_name", "label": "Farm Name", "type": "text", "required": True}
BOUNDARY = {"name": "boundary", "label": "Farm Boundary", "type": "polygon", "required": True}


def config(fields, **extra):
    return {"title": "Channels", "table_name": "channels_test", "fields": fields, **extra}


def issues_of(raw):
    with pytest.raises(ConfigValidationError) as caught:
        validate_config(normalize_form(raw))
    return caught.value.issues


# --------------------------------------------------------------------------- #
# capabilities
# --------------------------------------------------------------------------- #
def test_every_registered_field_type_has_a_capability_on_every_channel():
    assert channel_capabilities.missing_entries() == []
    for field_type in FIELD_TYPES:
        for channel in channels.CHANNELS:
            assert channel_capabilities.capability(channel, field_type).level in \
                channel_capabilities.LEVELS


@pytest.mark.parametrize("channel", channels.CHANNELS)
def test_an_unknown_type_is_never_assumed_to_work(channel):
    can = channel_capabilities.capability(channel, "hologram")
    assert can.level == channel_capabilities.UNSUPPORTED
    assert not channel_capabilities.supports(channel, "hologram")


def test_an_unknown_channel_supports_nothing():
    assert not channel_capabilities.supports("sms", "text")


def test_aliases_resolve_like_the_rest_of_the_application():
    assert channel_capabilities.capability("ivr", "dropdown") == \
        channel_capabilities.capability("ivr", "select")


def test_web_and_mobile_ask_everything_the_builder_makes():
    for field_type in FIELD_TYPES:
        assert channel_capabilities.capability("web", field_type).level == "supported"
        assert channel_capabilities.capability("mobile", field_type).level == "supported"


def test_what_whatsapp_and_ivr_cannot_ask_says_why():
    polygon = channel_capabilities.capability("whatsapp", "polygon")
    assert polygon.level == "unsupported" and polygon.reason
    assert channel_capabilities.capability("ivr", "text").reason
    assert channel_capabilities.capability("whatsapp", "date").level == "limited"


def test_the_frontend_registry_says_the_same_thing():
    """`channelCapabilities.js` is a literal table; every level must match."""
    js = (Path(__file__).resolve().parents[4]
          / "frontend/src/modules/forms/channelCapabilities.js")
    if not js.exists():
        pytest.skip("frontend is not checked out beside the backend")

    text = js.read_text(encoding="utf-8")
    for field_type in FIELD_TYPES:
        row = re.search(rf"^\s*{field_type}: \{{(.*?)\}},?\s*$", text, re.MULTILINE)
        assert row, f"{field_type} is missing from channelCapabilities.js"
        for channel in channels.CHANNELS:
            level = re.search(rf"\b{channel}: (\w+)", row.group(1))
            assert level, f"{field_type}/{channel} is missing from channelCapabilities.js"
            expected = channel_capabilities.capability(channel, field_type).level
            assert level.group(1).lower() == expected, f"{field_type}/{channel}"


def test_the_gateway_knows_the_same_four_channels():
    from app.core import gateway
    assert tuple(gateway.CHANNELS) == channels.CHANNELS


# --------------------------------------------------------------------------- #
# defaults and availability
# --------------------------------------------------------------------------- #
def test_a_form_with_no_profile_is_on_the_web_and_mobile_only():
    assert channels.enabled_channels({"fields": [TEXT]}) == {
        "web": True, "mobile": True, "whatsapp": False, "ivr": False}
    assert channels.enabled_channels(None)["web"] is True


def test_an_explicit_profile_overrides_the_defaults():
    form_json = {"channels": {"whatsapp": {"enabled": True}, "web": {"enabled": False}}}
    assert channels.enabled_channels(form_json) == {
        "web": False, "mobile": True, "whatsapp": True, "ivr": False}


def test_a_label_that_is_not_a_channel_is_never_enabled():
    assert channels.enabled({"channels": {"sms": {"enabled": True}}}, "sms") is False
    assert channels.canonical("public_web") == "web"
    assert channels.canonical("carrier-pigeon") is None


# --------------------------------------------------------------------------- #
# normalization
# --------------------------------------------------------------------------- #
def test_a_legacy_form_normalizes_exactly_as_before():
    before = normalize_form(config([TEXT]))
    assert "channels" not in before
    assert normalize_form(config([TEXT], channels=None)) == before
    assert normalize_form(config([TEXT], channels={})) == before


def test_unknown_channels_and_keys_are_dropped():
    form = normalize_form(config([TEXT], channels={
        "sms": {"enabled": True},
        "WhatsApp": {"enabled": True, "token": "secret-token", "api_key": "k"},
        "web": {"enabled": True, "extra": {"nested": 1}},
    }))
    assert form["channels"] == {"web": {"enabled": True}, "whatsapp": {"enabled": True}}
    assert "secret-token" not in str(form)


@pytest.mark.parametrize("said, kept", [
    (True, True), (False, False), ("yes", True), ("no", False), ("1", True),
    (0, False), ("on", True), ("nonsense", False), (None, False),
])
def test_enabled_is_read_as_a_yes_no(said, kept):
    form = normalize_form(config([TEXT], channels={"whatsapp": {"enabled": said}}))
    assert form["channels"]["whatsapp"]["enabled"] is kept


def test_an_entry_that_does_not_say_takes_the_channel_default():
    form = normalize_form(config([TEXT], channels={"mobile": {}, "ivr": "garbage"}))
    assert form["channels"] == {"mobile": {"enabled": True}, "ivr": {"enabled": False}}


def test_the_shorthand_is_accepted():
    form = normalize_form(config([TEXT], channels={"whatsapp": True}))
    assert form["channels"] == {"whatsapp": {"enabled": True}}


def test_normalization_is_idempotent_and_does_not_touch_its_input():
    raw = config([TEXT], channels={"ivr": {"enabled": "false"}, "whatsapp": {"enabled": 1}})
    original = copy.deepcopy(raw)

    once = normalize_form(raw)
    twice = normalize_form(copy.deepcopy(once))

    assert raw == original
    assert once["channels"] == twice["channels"] == {
        "whatsapp": {"enabled": True}, "ivr": {"enabled": False}}


@pytest.mark.parametrize("raw", ["whatsapp", 3, ["web"], {"sms": True}])
def test_nothing_usable_leaves_no_profile(raw):
    assert "channels" not in normalize_form(config([TEXT], channels=raw))


def test_the_public_link_does_not_carry_the_profile():
    from app.modules.forms.routers.public_forms import _public_view

    shown = _public_view(normalize_form(config([TEXT], channels={"whatsapp": True})))
    assert "channels" not in shown


# --------------------------------------------------------------------------- #
# structural validation
# --------------------------------------------------------------------------- #
def test_a_normalized_profile_is_accepted():
    validate_config(normalize_form(config([TEXT], channels={"whatsapp": True})))


@pytest.mark.parametrize("profile", [
    {"sms": {"enabled": True}},
    {"whatsapp": {"enabled": "yes"}},
    {"whatsapp": {"enabled": True, "token": "abc"}},
    {"whatsapp": {}},
    {"whatsapp": True},
])
def test_a_malformed_profile_is_refused_when_not_normalized(profile):
    with pytest.raises(ConfigValidationError) as caught:
        validate_config(config([TEXT], channels=profile))
    assert caught.value.stage == "structural"
    assert all(i.field.startswith("channels") for i in caught.value.issues)


# --------------------------------------------------------------------------- #
# can the channel finish the form?
# --------------------------------------------------------------------------- #
def test_a_whatsapp_ready_form_is_valid():
    validate_config(normalize_form(config(
        [TEXT, {"name": "crop", "label": "Crop", "type": "select",
                "options": ["MAIZE", "RICE"], "required": True}],
        channels={"whatsapp": {"enabled": True}})))


def test_a_required_polygon_keeps_whatsapp_off():
    issues = issues_of(config([TEXT, BOUNDARY], channels={"whatsapp": {"enabled": True}}))
    assert [i.field for i in issues] == ["channels.whatsapp"]
    assert issues[0].type == "business_rule"
    assert "Farm Boundary" in issues[0].message


def test_an_optional_unsupported_question_is_skipped_not_refused():
    validate_config(normalize_form(config(
        [TEXT, {**BOUNDARY, "required": False}], channels={"whatsapp": True})))


def test_the_same_form_is_fine_on_the_web_and_mobile():
    validate_config(normalize_form(config(
        [TEXT, BOUNDARY], channels={"web": True, "mobile": True})))


def test_a_disabled_channel_is_not_checked():
    validate_config(normalize_form(config([TEXT, BOUNDARY], channels={"whatsapp": False})))


def test_every_enabled_channel_is_checked():
    issues = issues_of(config([TEXT, BOUNDARY], channels={"whatsapp": True, "ivr": True}))
    assert sorted({i.field for i in issues}) == ["channels.ivr", "channels.whatsapp"]


def test_a_question_reached_only_through_an_unaskable_one_is_unreachable():
    """Shown only once a boundary is drawn — which WhatsApp never draws."""
    validate_config(normalize_form(config(
        [TEXT,
         {"name": "sketch", "label": "Sketch", "type": "polygon"},
         {"name": "signed", "label": "Signed", "type": "signature", "required": True}],
        rules=[{"conditions": [{"field": "sketch", "operator": "is_not_empty"}],
                "logic": "AND", "action": "show",
                "target": {"type": "field", "name": "signed"}}],
        channels={"whatsapp": True})))


def test_a_conditional_question_the_channel_can_reach_still_counts():
    """Shown when the crop is rice — which WhatsApp can answer."""
    issues = issues_of(config(
        [TEXT,
         {"name": "crop", "label": "Crop", "type": "select", "options": ["MAIZE", "RICE"]},
         {**BOUNDARY}],
        rules=[{"conditions": [{"field": "crop", "operator": "equals", "value": "RICE"}],
                "logic": "AND", "action": "show",
                "target": {"type": "field", "name": "boundary"}}],
        channels={"whatsapp": True}))
    assert [i.field for i in issues] == ["channels.whatsapp"]


def test_a_section_the_channel_can_open_counts_too():
    issues = issues_of(config(
        [TEXT,
         {"name": "irrigated", "label": "Irrigated", "type": "boolean"},
         {**BOUNDARY, "section": "plots"}],
        sections=[{"key": "plots", "title": "Plots"}],
        rules=[{"conditions": [{"field": "irrigated", "operator": "equals", "value": True}],
                "logic": "AND", "action": "show",
                "target": {"type": "section", "key": "plots"}}],
        channels={"whatsapp": True}))
    assert [i.field for i in issues] == ["channels.whatsapp"]


def test_a_hide_rule_does_not_make_a_question_unreachable():
    """Hidden only when irrigated — so reachable whenever it is not."""
    issues = issues_of(config(
        [TEXT, {"name": "irrigated", "label": "Irrigated", "type": "boolean"}, BOUNDARY],
        rules=[{"conditions": [{"field": "irrigated", "operator": "equals", "value": True}],
                "logic": "AND", "action": "hide",
                "target": {"type": "field", "name": "boundary"}}],
        channels={"whatsapp": True}))
    assert [i.field for i in issues] == ["channels.whatsapp"]


@needs_db
def test_saving_an_incompatible_profile_is_refused(forms):
    with pytest.raises(ConfigValidationError):
        _form(forms, fields=[TEXT, BOUNDARY], channels={"whatsapp": True})


# --------------------------------------------------------------------------- #
# refusal
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("channel", ["web", "mobile", "whatsapp", "ivr", "public_web"])
def test_a_form_without_a_profile_refuses_nothing_it_took_before(channel):
    assert channels.refusal({"fields": [TEXT]}, channel) is None


def test_a_profiled_form_refuses_its_closed_channels():
    form_json = {"channels": {"whatsapp": {"enabled": True}}}
    assert channels.refusal(form_json, "whatsapp") is None
    assert channels.refusal(form_json, "web") is None          # default: open
    assert "IVR" in channels.refusal(form_json, "ivr")          # default: closed
    assert channels.refusal(form_json, "carrier-pigeon")


# --------------------------------------------------------------------------- #
# validate_field
# --------------------------------------------------------------------------- #
FORM = {
    "fields": [
        {"name": "farmer_name", "label": "Farmer name", "type": "text", "required": True,
         "validation": {"min_length": 3, "pattern": "^[A-Za-z ]+$"}},
        {"name": "age", "label": "Age", "type": "number",
         "validation": {"min": 18, "max": 99}},
        {"name": "crop", "label": "Crop", "type": "select", "options": [
            {"label": "Maize", "value": "MAIZE"}, {"label": "Rice", "value": "RICE"}]},
        {"name": "variety", "label": "Variety", "type": "text"},
        {"name": "village", "label": "Village", "type": "select",
         "options_from": {"source": "client_catalog", "catalog": "villages"}},
    ],
    "rules": [{"conditions": [{"field": "crop", "operator": "equals", "value": "RICE"}],
               "logic": "AND", "action": "show",
               "target": {"type": "field", "name": "variety"}}],
}


def field_error(name, value, answers=None):
    with pytest.raises(submission_service.ValidationFailed) as caught:
        submission_service.validate_field(FORM, name, value, answers)
    return caught.value.errors


def test_a_valid_answer_comes_back_as_it_would_be_stored():
    assert submission_service.validate_field(FORM, "farmer_name", "Ramesh") == "Ramesh"
    assert submission_service.validate_field(FORM, "age", "42") == 42


def test_a_value_of_the_wrong_type_is_refused():
    assert "age" in field_error("age", "forty")


def test_a_missing_required_answer_is_refused():
    assert "farmer_name" in field_error("farmer_name", "")


def test_range_length_and_pattern_still_apply():
    assert "18" in field_error("age", 12)["age"]
    assert "99" in field_error("age", 120)["age"]
    assert "farmer_name" in field_error("farmer_name", "Ra")
    assert "farmer_name" in field_error("farmer_name", "R4mesh")


def test_a_choice_must_be_offered():
    assert submission_service.validate_field(FORM, "crop", "RICE") == "RICE"
    assert "crop" in field_error("crop", "SORGHUM")


def test_a_question_that_does_not_apply_is_refused_an_answer():
    assert "variety" in field_error("variety", "IR64", answers={"crop": "MAIZE"})
    assert submission_service.validate_field(
        FORM, "variety", "IR64", answers={"crop": "RICE"}) == "IR64"


def test_a_catalogue_answer_is_checked_against_the_catalogue(monkeypatch):
    from app.modules.client_catalog import catalog_options

    monkeypatch.setattr(catalog_options, "is_valid",
                        lambda catalog, value, parent, allowed=None: value == "V001")
    assert submission_service.validate_field(FORM, "village", "V001") == "V001"
    assert "village" in field_error("village", "V999")


def test_an_unknown_question_is_a_key_error():
    with pytest.raises(KeyError):
        submission_service.validate_field(FORM, "nope", "x")


@pytest.mark.parametrize("payload", [
    {"farmer_name": "Ramesh", "age": 42, "crop": "RICE", "variety": "IR64"},
    {"farmer_name": "", "age": "old", "crop": "SORGHUM"},
    {"farmer_name": "Ra", "age": 12, "crop": "MAIZE", "variety": "IR64"},
])
def test_one_question_at_a_time_agrees_with_the_whole_form(payload):
    """validate_payload and validate_field are one implementation."""
    try:
        whole = submission_service.validate_payload(FORM, payload)
        whole_errors = {}
    except submission_service.ValidationFailed as failed:
        whole, whole_errors = None, failed.errors

    for field in FORM["fields"][:4]:
        name = field["name"]
        try:
            one = submission_service.validate_field(FORM, name, payload.get(name), payload)
        except submission_service.ValidationFailed as failed:
            assert failed.errors[name] == whole_errors[name], name
        else:
            assert name not in whole_errors, name
            if whole is not None:
                assert whole[name] == one, name


# --------------------------------------------------------------------------- #
# the database half
# --------------------------------------------------------------------------- #
FIELDS = [
    {"name": "farmer_name", "label": "Farmer name", "type": "text", "required": True},
    {"name": "main_crop", "label": "Main crop", "type": "select",
     "options": ["MAIZE", "WHEAT"]},
]


@pytest.fixture
def forms():
    made = []
    yield made
    with transaction() as cur:
        for form_id, table in made:
            cur.execute("DELETE FROM submission_receipt WHERE form_id = %s", (form_id,))
            cur.execute("DELETE FROM submission_channel WHERE form_id = %s", (form_id,))
            cur.execute("DELETE FROM form_survey_progress WHERE form_id = %s", (form_id,))
            for name in (tabular_name(table), table):
                cur.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(
                    sql.Identifier(name)))
            cur.execute(sql.SQL("DROP SEQUENCE IF EXISTS {}").format(
                sql.Identifier(f"{table[:43]}_survey_seq")))
            cur.execute("DELETE FROM form_version WHERE form_id = %s", (form_id,))
            cur.execute("DELETE FROM forms WHERE form_id = %s", (form_id,))


def _form(forms, fields=None, **extra):
    created = form_service.create_form(normalize_form({
        "title": f"Channel {uuid.uuid4().hex[:6]}",
        "table_name": f"chn_{uuid.uuid4().hex[:8]}",
        "fields": fields or FIELDS,
        **extra,
    }), created_by="tests", status="Active")
    forms.append((created["form_id"], created["table"]["table_name"]))
    return created["form_id"]


def _count(form_id, table):
    with transaction() as cur:
        cur.execute(sql.SQL("SELECT count(*) AS n FROM {}").format(sql.Identifier(table)))
        rows = cur.fetchone()["n"]
        cur.execute("SELECT count(*) AS n FROM submission_receipt WHERE form_id = %s",
                    (form_id,))
        receipts = cur.fetchone()["n"]
        cur.execute("SELECT count(*) AS n FROM submission_channel WHERE form_id = %s",
                    (form_id,))
        noted = cur.fetchone()["n"]
    return rows, receipts, noted


def _table(form_id):
    return form_service.get_form(form_id)["form_json"]["table_name"]


ANSWERS = {"farmer_name": "Ramesh", "main_crop": "MAIZE"}


@needs_db
def test_a_legacy_form_still_takes_web_and_mobile(forms, editor_client):
    form_id = _form(forms)
    assert "channels" not in form_service.get_form(form_id)["form_json"]

    web = editor_client.post(f"/api/forms/{form_id}/submissions", json={"data": ANSWERS})
    mobile = editor_client.post(f"/api/forms/{form_id}/submissions",
                                json={"data": ANSWERS, "channel": "mobile"})

    assert (web.status_code, mobile.status_code) == (201, 201)
    assert ingestion.channel_of(form_id, mobile.json()["survey_id"]) == "mobile"


@needs_db
def test_an_enabled_channel_is_accepted_and_a_closed_one_refused(forms, editor_client):
    form_id = _form(forms, channels={"whatsapp": True, "mobile": False})

    whatsapp = editor_client.post(
        f"/api/forms/{form_id}/submissions/ingest",
        json={"channel": "whatsapp", "payload": {"messages": ["Ramesh", "1"]}})
    mobile = editor_client.post(
        f"/api/forms/{form_id}/submissions/ingest",
        json={"channel": "mobile", "payload": ANSWERS})
    ivr = editor_client.post(
        f"/api/forms/{form_id}/submissions/ingest",
        json={"channel": "ivr", "payload": {"digits": {"main_crop": "1"}}})
    web = editor_client.post(f"/api/forms/{form_id}/submissions", json={"data": ANSWERS})

    assert whatsapp.status_code == 201
    assert web.status_code == 201
    for refused in (mobile, ivr):
        assert refused.status_code == 422
        assert "_channel" in refused.json()["detail"]["errors"]
    assert _count(form_id, _table(form_id))[0] == 2


@needs_db
def test_the_same_client_id_twice_stores_one_submission(forms, editor_client):
    form_id = _form(forms)
    body = {"data": ANSWERS, "channel": "mobile", "client_submission_id": "abc-123"}

    first = editor_client.post(f"/api/forms/{form_id}/submissions", json=body)
    again = editor_client.post(f"/api/forms/{form_id}/submissions", json=body)

    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json()["survey_id"] == first.json()["survey_id"]
    assert again.json()["replayed"] is True and first.json()["replayed"] is False
    assert _count(form_id, _table(form_id)) == (1, 1, 1)


@needs_db
def test_the_idempotency_key_header_is_the_same_thing(forms, editor_client):
    form_id = _form(forms)
    url = f"/api/forms/{form_id}/submissions"

    first = editor_client.post(url, json={"data": ANSWERS}, headers={"Idempotency-Key": "k1"})
    again = editor_client.post(url, json={"data": ANSWERS}, headers={"Idempotency-Key": "k1"})
    clash = editor_client.post(url, json={"data": ANSWERS, "client_submission_id": "k2"},
                               headers={"Idempotency-Key": "k3"})

    assert again.json()["survey_id"] == first.json()["survey_id"]
    assert clash.status_code == 422
    assert _count(form_id, _table(form_id))[0] == 1


@needs_db
def test_a_retry_after_republishing_still_gets_its_submission(forms, editor_client):
    form_id = _form(forms)
    body = {"data": ANSWERS, "client_submission_id": "offline-1", "form_version": 1}
    first = editor_client.post(f"/api/forms/{form_id}/submissions", json=body)

    definition = form_service.get_form(form_id)["form_json"]
    form_service.update_form(form_id, normalize_form({**definition, "title": "Renamed"}),
                             updated_by="tests")

    again = editor_client.post(f"/api/forms/{form_id}/submissions", json=body)
    assert again.status_code == 200
    assert again.json()["survey_id"] == first.json()["survey_id"]


@needs_db
def test_the_same_id_for_different_answers_is_a_conflict(forms, editor_client):
    form_id = _form(forms)
    url = f"/api/forms/{form_id}/submissions"
    editor_client.post(url, json={"data": ANSWERS, "client_submission_id": "dup"})

    changed = editor_client.post(url, json={"data": {**ANSWERS, "farmer_name": "Suresh"},
                                            "client_submission_id": "dup"})

    assert changed.status_code == 409
    assert _count(form_id, _table(form_id))[0] == 1


@needs_db
def test_the_same_id_from_another_channel_is_a_conflict(forms, editor_client):
    """The id is scoped to the form; the channel is part of what it names."""
    form_id = _form(forms)
    url = f"/api/forms/{form_id}/submissions"
    editor_client.post(url, json={"data": ANSWERS, "channel": "mobile",
                                  "client_submission_id": "ABC"})

    other = editor_client.post(
        f"/api/forms/{form_id}/submissions/ingest",
        json={"channel": "whatsapp", "payload": {"answers": ANSWERS},
              "client_submission_id": "ABC"})

    assert other.status_code == 409
    assert _count(form_id, _table(form_id))[0] == 1


@needs_db
def test_the_same_id_on_two_forms_is_two_submissions(forms, editor_client):
    a, b = _form(forms), _form(forms)
    body = {"data": ANSWERS, "client_submission_id": "ABC"}

    first = editor_client.post(f"/api/forms/{a}/submissions", json=body)
    second = editor_client.post(f"/api/forms/{b}/submissions", json=body)

    assert (first.status_code, second.status_code) == (201, 201)
    assert _count(a, _table(a))[:2] == (1, 1)
    assert _count(b, _table(b))[:2] == (1, 1)


@needs_db
def test_a_malformed_client_id_is_refused(forms, editor_client):
    form_id = _form(forms)
    answer = editor_client.post(f"/api/forms/{form_id}/submissions",
                                json={"data": ANSWERS, "client_submission_id": "no spaces!"})
    assert answer.status_code == 422
    assert "client_submission_id" in answer.json()["detail"]["errors"]


@needs_db
def test_concurrent_duplicates_store_one_submission(forms):
    """Two requests racing with one id: Postgres picks one; both get its answer."""
    form_id = _form(forms)
    form = form_service.get_form(form_id)
    start = threading.Barrier(4)
    results, failures = [], []

    def send():
        try:
            start.wait()
            results.append(submission_service.submit(
                form, dict(ANSWERS), created_by="tests", channel="mobile",
                client_submission_id="race-1"))
        except Exception as exc:  # pragma: no cover — reported below
            failures.append(exc)

    threads = [threading.Thread(target=send) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert failures == []
    assert len({r["survey_id"] for r in results}) == 1
    assert sum(1 for r in results if not r["replayed"]) == 1
    assert _count(form_id, _table(form_id)) == (1, 1, 1)


@needs_db
def test_a_failure_before_commit_leaves_nothing_behind(forms, monkeypatch):
    """Answers, receipt and channel note are one transaction."""
    form_id = _form(forms)
    form = form_service.get_form(form_id)

    def broken(*args, **kwargs):
        raise RuntimeError("the channel note could not be written")

    monkeypatch.setattr(ingestion, "record_channel", broken)

    with pytest.raises(RuntimeError):
        submission_service.submit(form, dict(ANSWERS), created_by="tests",
                                  channel="whatsapp", client_submission_id="atomic-1")

    assert _count(form_id, _table(form_id)) == (0, 0, 0)

    monkeypatch.undo()
    stored = submission_service.submit(form, dict(ANSWERS), created_by="tests",
                                       channel="whatsapp", client_submission_id="atomic-1")
    assert stored["replayed"] is False
    assert _count(form_id, _table(form_id)) == (1, 1, 1)
