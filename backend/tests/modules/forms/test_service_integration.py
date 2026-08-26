"""The pipeline where it actually guards persistence.

Needs Postgres; skipped when it is not reachable, so the pure tests still run
anywhere.
"""
import copy
import uuid

import pytest
from psycopg2 import sql

from app.modules.forms.config_validation import BUSINESS_RULE, STRUCTURAL, ConfigValidationError
from app.core.database import ping, transaction
from app.modules.forms import form_service
from app.modules.forms.tabular_service import tabular_name

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")


@pytest.fixture
def cleanup():
    """Removes whatever a test created, whichever way the test ends."""
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


def unique(config):
    config = copy.deepcopy(config)
    suffix = uuid.uuid4().hex[:8]
    config["title"] = f"Pipeline Test {suffix}"
    config["table_name"] = f"pipeline_test_{suffix}"
    return config


def count_forms(cur) -> int:
    cur.execute("SELECT COUNT(*) AS n FROM forms")
    return int(cur.fetchone()["n"])


def test_valid_config_is_saved(valid_config, cleanup):
    result = form_service.create_form(unique(valid_config), created_by="tests")
    cleanup.append((result["form_id"], result["table"]["table_name"]))
    assert result["version_no"] == 1
    assert result["field_count"] == 3


def test_structurally_invalid_config_never_reaches_the_database(valid_config):
    config = unique(valid_config)
    config["fields"][0]["type"] = "hologram"

    with transaction() as cur:
        before = count_forms(cur)

    with pytest.raises(ConfigValidationError) as caught:
        form_service.create_form(config, created_by="tests")
    assert caught.value.stage == STRUCTURAL

    with transaction() as cur:
        assert count_forms(cur) == before, "a rejected config was persisted"


def test_business_invalid_config_never_reaches_the_database(valid_config):
    config = unique(valid_config)
    config["fields"][1]["name"] = "farmer_name"  # duplicate

    with transaction() as cur:
        before = count_forms(cur)

    with pytest.raises(ConfigValidationError) as caught:
        form_service.create_form(config, created_by="tests")
    assert caught.value.stage == BUSINESS_RULE

    with transaction() as cur:
        assert count_forms(cur) == before


def test_no_table_is_created_for_a_rejected_config(valid_config):
    config = unique(valid_config)
    table = config["table_name"]
    config["fields"][0]["name"] = "form_data"  # reserved

    with pytest.raises(ConfigValidationError):
        form_service.create_form(config, created_by="tests")

    with transaction() as cur:
        cur.execute(
            "SELECT 1 FROM information_schema.tables WHERE table_name = %s", (table,)
        )
        assert cur.fetchone() is None


def test_unknown_parent_is_rejected(valid_config):
    with pytest.raises(ConfigValidationError) as caught:
        form_service.create_form(
            unique(valid_config), form_type="child", parent_id="FRM99999"
        )
    assert caught.value.issues[0].field == "parent_id"


def test_update_rejects_an_invalid_config_without_bumping_the_version(valid_config, cleanup):
    created = form_service.create_form(unique(valid_config), created_by="tests")
    form_id = created["form_id"]
    cleanup.append((form_id, created["table"]["table_name"]))

    broken = copy.deepcopy(created["form_json"])
    broken["fields"][1]["name"] = broken["fields"][0]["name"]  # duplicate

    with pytest.raises(ConfigValidationError):
        form_service.update_form(form_id, broken)

    assert form_service.get_form(form_id)["version_no"] == 1
    assert len(form_service.get_versions(form_id)) == 1


def test_a_saved_definition_can_always_be_saved_again(valid_config, cleanup):
    """What round-trips out of the database must round-trip back in."""
    created = form_service.create_form(unique(valid_config), created_by="tests")
    cleanup.append((created["form_id"], created["table"]["table_name"]))

    stored = form_service.get_form(created["form_id"])["form_json"]
    updated = form_service.update_form(created["form_id"], stored)
    assert updated["version_no"] == 2


# --- definitions that never went through the normalizer --------------------- #
def test_a_field_keyed_by_id_still_reads():
    """`name`/`key`/`id` are all accepted on input, so a read path must not
    assume the canonical one.

    Anything saved through `create_form` is normalized. A definition written
    straight into Postgres — a seed, a fixture, a hand-edited row — may still
    carry `id`, and one such row used to 500 the page that opened the form.
    """
    from app.modules.forms.form_schema import field_name
    from app.modules.forms.view_service import field_names

    legacy = {"fields": [
        {"id": "first_name", "type": "text", "label": "First Name"},
        {"key": "last_name", "type": "text", "label": "Last Name"},
        {"name": "gender", "type": "select"},
        {"label": "Village Name", "type": "text"},          # no key at all
        {"type": "text"},                                   # nothing to go on
    ]}

    assert field_names(legacy) == ["first_name", "last_name", "gender", "village_name"]
    assert field_name({}) == ""
    assert field_name("not a dict") == ""


def test_listing_a_form_with_no_data_table_has_the_usual_shape():
    """The empty case must carry the same keys as the full one.

    `/records` reads `limit` off the result; when the table was missing that key
    was absent and the endpoint raised instead of returning nothing.
    """
    from app.modules.forms.submission_service import list_submissions

    form = {"form_id": "FRMNONE", "form_json": {"table_name": None, "fields": []}}
    result = list_submissions(form, limit=25, offset=10)

    assert set(result) >= {"table_name", "columns", "total", "limit", "offset", "rows"}
    assert result["limit"] == 25 and result["offset"] == 10
    assert result["rows"] == [] and result["total"] == 0


# --- drafts ----------------------------------------------------------------- #
def _draft(client, cleanup, valid_config, title):
    """A form saved but not published, registered for removal."""
    import copy
    import uuid

    config = copy.deepcopy(valid_config)
    suffix = uuid.uuid4().hex[:6]
    config["title"] = f"{title} {suffix}"
    config["table_name"] = f"{title.lower().replace(' ', '_')}_{suffix}"

    made = client.post("/api/forms", json={"form_json": config, "form_status": "Draft"}).json()
    cleanup.append((made["form_id"], made["table"]["table_name"]))
    return made


def test_a_draft_is_built_but_not_live(editor_client, cleanup, valid_config):
    """A draft has its tables and its version, refuses answers, and stays out of
    every field officer's list until somebody publishes it."""
    made = _draft(editor_client, cleanup, valid_config, "draft test")
    form_id = made["form_id"]

    assert made["form_status"] == "Draft"
    assert made["table"]["table_name"], "a draft still gets its table"

    live = [f["form_id"] for f in editor_client.get("/api/forms/live/list").json()]
    assert form_id not in live

    refused = editor_client.post(f"/api/forms/{form_id}/submissions",
                                 json={"data": {"farmer_name": "Asha"}})
    assert refused.status_code == 422
    assert "draft" in str(refused.json()["detail"]).lower()

    published = editor_client.patch(f"/api/forms/{form_id}/status",
                                    json={"form_status": "Active"})
    assert published.json()["form_status"] == "Active"
    assert editor_client.post(f"/api/forms/{form_id}/submissions",
                              json={"data": {"farmer_name": "Asha"}}).status_code == 201


def test_testing_a_draft_writes_nothing(editor_client, cleanup, valid_config):
    """The dry run reports what would be stored, and stores none of it."""
    form_id = _draft(editor_client, cleanup, valid_config, "dry run")["form_id"]

    bad = editor_client.post(f"/api/forms/{form_id}/test-submission",
                             json={"data": {"land_area": 9000}}).json()
    assert bad["valid"] is False
    assert "farmer_name" in bad["errors"], "a required answer that is missing"
    assert "land_area" in bad["errors"], "a number outside its range"

    good = editor_client.post(
        f"/api/forms/{form_id}/test-submission",
        json={"data": {"farmer_name": "Asha", "land_area": "2.5"}},
    ).json()
    assert good["valid"] is True
    # Exactly what a real submission would store — coerced, and with the optional
    # answer nobody gave present as null rather than missing.
    assert good["form_data"] == {
        "farmer_name": "Asha", "land_area": 2.5, "irrigation": None,
    }

    stored = editor_client.get(f"/api/forms/{form_id}/submissions").json()
    assert stored["total"] == 0, "a dry run left a row behind"


def test_a_test_can_use_the_definition_on_screen(editor_client, cleanup, valid_config):
    """The builder tests unsaved edits, so a change can be tried before saving."""
    form_id = _draft(editor_client, cleanup, valid_config, "unsaved edit")["form_id"]

    on_screen = {"fields": [{"name": "nickname", "type": "text", "label": "Nickname",
                             "required": True, "options": [], "validation": {}}]}
    result = editor_client.post(
        f"/api/forms/{form_id}/test-submission",
        json={"data": {"nickname": "Ashu"}, "form_json": on_screen},
    ).json()

    assert result["valid"] is True
    assert result["form_data"] == {"nickname": "Ashu"}, "the saved definition was used instead"
