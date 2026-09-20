"""How long a question may be, and how one is hidden without being deleted.

Two things that met in the same place. A question's **key** becomes a Postgres
column, so it is held to 55 characters; a **question** is a sentence somebody
writes, and used to be held to nothing at all — which meant the only length
rule a form author ever met was the column's, reported as "String should have
at most 55 characters" about a property they had never typed.

And `config.hide`: a question taken out of the form without being taken out of
the definition. It is hidden through the same engine that rules use, so every
reader — the form page, the submission service, what a channel can ask — treats
it as it already treats a question a rule has hidden.
"""
import pytest

from app.modules.forms import channel_capabilities, conditions
from app.modules.forms.config_validation import (
    MAX_HELP_TEXT, MAX_LABEL, MAX_OPTION_LABEL, ConfigValidationError,
    validate_structure,
)
from app.modules.forms.form_schema import MAX_IDENTIFIER, field_hidden, normalize_form


def form(**change):
    base = {
        "title": "Farmer survey",
        "table_name": "farmer_survey",
        "fields": [{"name": "farmer_name", "label": "Farmer name", "type": "text"}],
    }
    return {**base, **change}


def issues(raw):
    with pytest.raises(ConfigValidationError) as refused:
        validate_structure(raw)
    return {i.field: i.message for i in refused.value.issues}


# --------------------------------------------------------------------------- #
# what somebody writes
# --------------------------------------------------------------------------- #
LONG_QUESTION = (
    "Do you agree to take part in this programme, and to the terms and "
    "conditions of participation as they were read out to you today?")


def test_a_question_written_as_a_sentence_is_accepted():
    assert len(LONG_QUESTION) > MAX_IDENTIFIER
    config = validate_structure(form(fields=[
        {"name": "consent", "label": LONG_QUESTION, "type": "boolean"}]))
    assert config.fields[0].label == LONG_QUESTION

    # And survives normalization, which is what gets stored.
    kept = normalize_form(form(fields=[
        {"name": "consent", "label": LONG_QUESTION, "type": "boolean"}]))
    assert kept["fields"][0]["label"] == LONG_QUESTION


@pytest.mark.parametrize("prop,length", [
    ("label", MAX_LABEL), ("help_text", MAX_HELP_TEXT), ("placeholder", 200),
])
def test_user_facing_text_is_generous_but_bounded(prop, length):
    ok = form(fields=[{"name": "a", "label": "A", "type": "text", prop: "x" * length}])
    assert validate_structure(ok)

    too_long = form(fields=[{"name": "a", "label": "A", "type": "text",
                             prop: "x" * (length + 1)}])
    said = issues(too_long)[f"fields.0.{prop}"]
    assert f"'{prop}' is {length + 1} characters" in said
    assert f"the most allowed is {length}" in said


def test_a_long_description_and_section_title_are_accepted():
    assert validate_structure(form(
        description="A " * 900,
        sections=[{"key": "consent", "title": "Consent and participation terms",
                   "description": "Read this out before asking anything else. " * 20}]))


def test_an_option_label_has_a_limit_of_its_own():
    ok = [{"label": "y" * MAX_OPTION_LABEL, "value": "yes"}]
    assert validate_structure(form(fields=[
        {"name": "c", "label": "Crop", "type": "select", "options": ok}]))

    said = issues(form(fields=[{"name": "c", "label": "Crop", "type": "select",
                                "options": [{"label": "y" * 201, "value": "yes"}]}]))
    assert "'label' is 201 characters" in said["fields.0.options.0.label"]


# --------------------------------------------------------------------------- #
# what Postgres has to be able to name
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("prop,raw", [
    ("name", {"name": "a" * 56, "label": "A", "type": "text"}),
])
def test_a_key_is_still_a_column_name(prop, raw):
    said = issues(form(fields=[raw]))[f"fields.0.{prop}"]
    assert f"'{prop}' is 56 characters" in said
    assert f"the most allowed is {MAX_IDENTIFIER}" in said
    # …and says where it came from, because nobody typed this property.
    assert "made from the question's label" in said


def test_a_long_table_name_says_where_it_came_from():
    said = issues(form(table_name="t" * 60))["table_name"]
    assert "'table_name' is 60 characters" in said
    assert "made from the form's title" in said


def test_a_refusal_never_echoes_what_was_typed():
    """A validation error says how long a value is, never what it says."""
    secret = "z" * 600
    said = issues(form(fields=[{"name": "a", "label": secret, "type": "text"}]))
    for message in said.values():
        assert secret not in message
        assert "zzz" not in message


def test_a_key_the_builder_derives_is_never_too_long():
    """The length the frontend cuts to is the length the backend accepts."""
    kept = normalize_form(form(fields=[{"label": LONG_QUESTION, "type": "text"}]))
    name = kept["fields"][0]["name"]
    assert len(name) <= MAX_IDENTIFIER
    assert validate_structure({**form(), "fields": [kept["fields"][0]]})


# --------------------------------------------------------------------------- #
# hiding a question
# --------------------------------------------------------------------------- #
def test_every_question_carries_its_settings():
    kept = normalize_form(form(fields=[
        {"name": "a", "label": "A", "type": "text"},
        {"name": "b", "label": "B", "type": "text", "config": {"hide": True}},
        {"name": "c", "label": "C", "type": "text", "hide": True},
    ]))
    assert [f["config"] for f in kept["fields"]] == [
        {"hide": False}, {"hide": True}, {"hide": True}]


def test_a_form_written_before_this_existed_is_visible():
    """No `config` at all means what it always meant: nothing is hidden."""
    old = {"title": "Old", "table_name": "old",
           "fields": [{"name": "a", "label": "A", "type": "text"}]}
    assert field_hidden(old["fields"][0]) is False
    assert conditions.hidden(old, {})["fields"] == []
    assert normalize_form(old)["fields"][0]["config"] == {"hide": False}


def test_a_hidden_question_is_hidden_whatever_the_answers_are():
    definition = normalize_form(form(fields=[
        {"name": "a", "label": "A", "type": "text"},
        {"name": "b", "label": "B", "type": "text", "config": {"hide": True}}]))
    assert conditions.hidden(definition, {})["fields"] == ["b"]
    assert conditions.hidden(definition, {"a": "anything"})["fields"] == ["b"]


def test_hiding_wins_over_a_rule_that_reads_the_question():
    """A rule's controlling question stays answerable — unless it is hidden.

    Otherwise a question nobody can see would be put back on the form by the
    very rule that cannot be satisfied without it.
    """
    definition = normalize_form(form(
        fields=[
            {"name": "consent", "label": "Consent", "type": "boolean",
             "config": {"hide": True}},
            {"name": "details", "label": "Details", "type": "text"},
        ],
        rules=[{"conditions": [{"field": "consent", "operator": "equals", "value": True}],
                "action": "show", "target": {"type": "field", "name": "details"}}]))

    off = conditions.hidden(definition, {})["fields"]
    assert "consent" in off and "details" in off


def test_a_hidden_question_does_not_stop_a_channel_publishing():
    """A required question a channel cannot ask blocks publishing — unless it
    is hidden, in which case that channel is never going to be asked it."""
    definition = normalize_form(form(
        channel="whatsapp",
        fields=[
            {"name": "name", "label": "Name", "type": "text", "required": True},
            {"name": "plot", "label": "Plot boundary", "type": "polygon",
             "required": True, "config": {"hide": True}},
        ]))
    assert channel_capabilities.required_unreachable(definition, "whatsapp") == []

    # The same form with the boundary showing cannot be published to WhatsApp.
    shown = normalize_form({**definition, "fields": [
        {**f, "config": {"hide": False}} for f in definition["fields"]]})
    blocked = channel_capabilities.required_unreachable(shown, "whatsapp")
    assert [b["name"] for b in blocked] == ["plot"]


# --------------------------------------------------------------------------- #
# and what that means for an answer
# --------------------------------------------------------------------------- #
def hiding_one_required_question():
    return normalize_form(form(fields=[
        {"name": "farmer_name", "label": "Farmer name", "type": "text", "required": True},
        {"name": "old_code", "label": "Old code", "type": "text", "required": True,
         "config": {"hide": True}}]))


def test_a_hidden_question_is_not_required_of_anybody():
    from app.modules.forms.submission_service import validate_payload

    clean = validate_payload(hiding_one_required_question(), {"farmer_name": "Ramesh"})

    assert clean["farmer_name"] == "Ramesh"
    # Stored as "not asked", exactly as a rule-hidden question already is —
    # rather than refused for being missing.
    assert clean["old_code"] is None


def test_a_visible_required_question_is_still_required():
    from app.modules.forms.submission_service import ValidationFailed, validate_payload

    with pytest.raises(ValidationFailed) as refused:
        validate_payload(hiding_one_required_question(), {})
    assert "farmer_name" in refused.value.errors


def test_an_answer_to_a_hidden_question_is_refused_as_before():
    """Hidden is hidden on arrival too: the form did not ask, so it is not
    answered — the same refusal a rule-hidden question already gives."""
    from app.modules.forms.submission_service import ValidationFailed, validate_payload

    with pytest.raises(ValidationFailed) as refused:
        validate_payload(hiding_one_required_question(),
                         {"farmer_name": "Ramesh", "old_code": "sneaked in"})
    assert "old_code" in refused.value.errors


def test_the_published_package_carries_the_setting(monkeypatch):
    """What the mobile app is given says which questions to leave out."""
    from app.modules.forms import mobile_package, publishing

    definition = hiding_one_required_question()
    monkeypatch.setattr(publishing, "published", lambda form, project_id=None: {
        "form_id": "FRM1", "form_title": "Farmer survey", "form_description": "",
        "version": 1, "status": "Active", "published_at": None, "config": definition})
    built = mobile_package.build({"form_id": "FRM1"})

    fields = {f["name"]: f for f in built["config"]["fields"]}
    assert fields["old_code"]["config"]["hide"] is True
    assert fields["farmer_name"]["config"]["hide"] is False


def test_the_normalizer_cuts_to_what_the_validator_will_accept():
    """`validate_config(normalize_form(anything))` — the repo's invariant.

    Adding a length rule without teaching the normalizer to cut to it is how an
    LLM's over-long question becomes a form nobody can save. Both halves use
    the numbers in `constants`.
    """
    from app.modules.forms.config_validation import validate_config

    essay = normalize_form(form(
        description="D" * 5000,
        sections=[{"title": "S" * 400, "description": "d" * 5000}],
        fields=[{"name": "a", "label": "L" * 900, "help_text": "H" * 4000,
                 "placeholder": "P" * 900, "type": "select",
                 "options": [{"label": "o" * 500, "value": "v" * 500}]}]))

    assert len(essay["fields"][0]["label"]) == MAX_LABEL
    assert len(essay["fields"][0]["help_text"]) == MAX_HELP_TEXT
    assert len(essay["fields"][0]["options"][0]["label"]) == MAX_OPTION_LABEL
    validate_config(essay)
