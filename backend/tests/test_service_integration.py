"""The pipeline where it actually guards persistence.

Needs Postgres; skipped when it is not reachable, so the pure tests still run
anywhere.
"""
import copy
import uuid

import pytest
from psycopg2 import sql

from app.config_validation import BUSINESS_RULE, STRUCTURAL, ConfigValidationError
from app.database import ping, transaction
from app import form_service
from app.tabular_service import tabular_name

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
