"""A question's key may be 150 characters. A Postgres name may not.

The two used to be the same number, 55, because a key became a column in the
flat `<form>_tabular` reporting mirror. Postgres cuts an identifier at 63 bytes
without saying so, which is why that number existed — and why raising it is not
just a matter of changing it: the mirror now maps a long key to a short,
deterministic column, and everything else (the `form_data` key, a rule, the
layout, the mobile package) carries the key in full.

These tests run against the real database for the parts that are about
Postgres, because a truncated identifier is exactly the kind of thing that
passes in a unit test and fails in a table.
"""
import uuid

import pytest
from psycopg2 import sql

from app.core.database import ping, transaction
from app.modules.forms import form_service, tabular_service
from app.modules.forms.config_validation import ConfigValidationError, validate_structure
from app.modules.forms.form_schema import (
    MAX_FIELD_NAME, MAX_IDENTIFIER, normalize_form, safe_field_name,
)

KEY_150 = ("do_you_agree_to_take_part_in_this_programme_and_to_the_terms_and_"
           "conditions_of_participation_as_they_were_read_out_to_you_today_x")


def form(fields, **change):
    return {"title": "Long names", "table_name": "long_names", "fields": fields, **change}


def a_field(name, **change):
    return {"name": name, "label": "A question", "type": "text", **change}


# --------------------------------------------------------------------------- #
# the limit itself
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("length", [1, 55, 100, 150])
def test_a_key_of_up_to_150_characters_is_accepted(length):
    name = ("a" * length) if length == 1 else ("a" + "b" * (length - 1))
    config = validate_structure(form([a_field(name)]))
    assert config.fields[0].name == name


def test_151_characters_is_refused_and_says_so():
    with pytest.raises(ConfigValidationError) as refused:
        validate_structure(form([a_field("a" * 151)]))
    said = refused.value.issues[0]
    assert said.field == "fields.0.name"
    assert "'name' is 151 characters" in said.message
    assert "the most allowed is 150" in said.message


def test_a_key_is_still_a_safe_identifier():
    """Longer, not looser: the shape of a key has not changed."""
    for bad in ("Has Capitals", "has spaces", "has-hyphens", "1starts_with_a_digit",
                "has.dots", 'quote"inside'):
        with pytest.raises(ConfigValidationError):
            validate_structure(form([a_field(bad)]))


def test_a_table_name_is_still_held_to_the_postgres_limit():
    """It really is a Postgres name, so it keeps the shorter limit."""
    with pytest.raises(ConfigValidationError) as refused:
        validate_structure(form([a_field("a")], table_name="t" * 56))
    assert f"the most allowed is {MAX_IDENTIFIER}" in refused.value.issues[0].message


# --------------------------------------------------------------------------- #
# deriving one, and keeping them apart
# --------------------------------------------------------------------------- #
def test_a_long_label_now_keeps_its_words_in_the_key():
    """What an AI-generated form does with a question written as a sentence."""
    label = ("Do you agree to take part in this programme, and to the terms and "
             "conditions of participation as they were read out to you today?")
    kept = normalize_form(form([{"label": label, "type": "boolean"}]))
    name = kept["fields"][0]["name"]

    assert len(name) > MAX_IDENTIFIER
    assert len(name) <= MAX_FIELD_NAME
    assert name.startswith("do_you_agree_to_take_part")
    assert name.endswith("today")
    validate_structure({**form([]), "fields": kept["fields"]})


def test_two_long_labels_that_start_alike_get_different_keys():
    taken = set()
    base = "x" * 148
    first = safe_field_name(base, taken)
    second = safe_field_name(base, taken)

    assert first != second
    assert second.endswith("_2")
    assert len(second) <= MAX_FIELD_NAME


def test_a_form_written_before_this_is_untouched():
    kept = normalize_form(form([a_field("farmer_name"), a_field("village")]))
    assert [f["name"] for f in kept["fields"]] == ["farmer_name", "village"]


# --------------------------------------------------------------------------- #
# the reporting mirror
# --------------------------------------------------------------------------- #
def test_a_short_key_is_still_its_own_column():
    """Every mirror already built keeps exactly the columns it has."""
    for name in ("farmer_name", "a" * MAX_IDENTIFIER):
        assert tabular_service.column_for(name) == name


def test_a_long_key_gets_a_column_postgres_can_hold():
    column = tabular_service.column_for(KEY_150)

    assert len(column) <= MAX_IDENTIFIER
    assert column.startswith("do_you_agree")
    # Stable, so the same key finds the same column on the next deploy.
    assert column == tabular_service.column_for(KEY_150)


def test_two_long_keys_sharing_a_prefix_do_not_share_a_column():
    """The failure that made this necessary: Postgres cuts at 63 bytes."""
    one = "a" * 120 + "_first_question"
    two = "a" * 120 + "_second_question"
    assert one[:63] == two[:63]
    assert tabular_service.column_for(one) != tabular_service.column_for(two)


# --------------------------------------------------------------------------- #
# and in a real database
# --------------------------------------------------------------------------- #
pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")


@pytest.fixture(scope="module")
def a_saved_form():
    """A published form with one very long question, dropped afterwards.

    One form for the whole module: form ids are handed out from the highest one
    in the table, so creating and deleting several in a row asks for the same
    id twice.
    """
    made = form_service.create_form(
        normalize_form({
            "title": f"Long keys {uuid.uuid4().hex[:6]}",
            "table_name": f"longkey_{uuid.uuid4().hex[:8]}",
            "fields": [
                {"name": "farmer_name", "label": "Farmer name", "type": "text",
                 "required": True},
                {"name": KEY_150, "label": "The long one", "type": "text"},
            ]}),
        created_by="tests", status="Active")
    yield made
    table = made["table"]["table_name"]
    with transaction() as cur:
        for name in (tabular_service.tabular_name(table), table):
            cur.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(sql.Identifier(name)))
        cur.execute(sql.SQL("DROP SEQUENCE IF EXISTS {}").format(
            sql.Identifier(f"{table[:43]}_survey_seq")))
        cur.execute("DELETE FROM form_version WHERE form_id = %s", (made["form_id"],))
        cur.execute("DELETE FROM forms WHERE form_id = %s", (made["form_id"],))


def test_a_form_with_a_150_character_key_can_be_created_and_published(a_saved_form):
    table = a_saved_form["table"]["table_name"]
    mirror = tabular_service.tabular_name(table)
    expected = tabular_service.column_for(KEY_150)

    with transaction() as cur:
        columns = set(tabular_service.existing_columns(cur, mirror))

    assert "farmer_name" in columns          # unchanged, as short keys always were
    assert expected in columns
    assert all(len(c) <= 63 for c in columns)


def test_an_answer_to_it_is_stored_and_mirrored(a_saved_form):
    from app.modules.forms import form_service
    from app.modules.forms.submission_service import submit

    form_id = a_saved_form["form_id"]
    answers = {"farmer_name": "Ramesh", KEY_150: "the long answer"}
    receipt = submit(form_service.get_form(form_id), answers, created_by="tests")

    table = a_saved_form["table"]["table_name"]
    mirror = tabular_service.tabular_name(table)
    column = tabular_service.column_for(KEY_150)

    with transaction() as cur:
        cur.execute(sql.SQL("SELECT form_data FROM {} WHERE survey_id = %s")
                    .format(sql.Identifier(table)), (receipt["survey_id"],))
        stored = cur.fetchone()["form_data"]
        cur.execute(sql.SQL("SELECT {} AS answer FROM {} WHERE survey_id = %s").format(
            sql.Identifier(column), sql.Identifier(mirror)), (receipt["survey_id"],))
        mirrored = cur.fetchone()["answer"]

    # The key is kept in full where it is a key…
    assert stored[KEY_150] == "the long answer"
    # …and the reporting mirror holds the same answer under its column.
    assert mirrored == "the long answer"
