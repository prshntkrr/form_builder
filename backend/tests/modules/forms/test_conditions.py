"""Conditional logic: which questions apply, given the answers so far.

A generic engine, not a set of special cases. Nothing here knows what consent,
employment or a crop is — a rule names a field key, an operator and a value, and
the same three pieces drive a question, a section or the whole questionnaire.
"""
import uuid

import pytest
from psycopg2 import sql

from app.core.database import ping, transaction
from app.modules.forms import conditions, form_service, translations
from app.modules.forms.config_validation import ConfigValidationError, validate_config
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.submission_service import ValidationFailed, validate_payload
from app.modules.forms.tabular_service import tabular_name

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")


def _rule(field, operator, value, target, action="show", logic="AND", extra=None):
    return {
        "conditions": [{"field": field, "operator": operator, "value": value}]
                      + (extra or []),
        "logic": logic,
        "action": action,
        "target": target,
    }


# --- 6-10. the operators ---------------------------------------------------------- #
@pytest.mark.parametrize("operator,value,answer,expected", [
    ("equals", "yes", "yes", True),
    ("equals", "yes", "no", False),
    ("equals", 18, "18", True),                 # the form sends text
    ("not_equals", "yes", "no", True),
    ("not_equals", "yes", "yes", False),
    ("is_empty", None, "", True),
    ("is_empty", None, "something", False),
    ("is_empty", None, [], True),
    ("is_not_empty", None, "something", True),
    ("is_not_empty", None, None, False),
    ("greater_than", 18, 21, True),
    ("greater_than", 18, 18, False),
    ("greater_than_or_equal", 18, 18, True),
    ("less_than", 18, 17, True),
    ("less_than_or_equal", 18, 18, True),
    ("greater_than", 18, "not a number", False),
    ("contains", "b", ["a", "b"], True),
    ("contains", "c", ["a", "b"], False),
    ("not_contains", "c", ["a", "b"], True),
])
def test_each_operator(operator, value, answer, expected):
    condition = {"field": "x", "operator": operator, "value": value}

    assert conditions.evaluate(condition, {"x": answer}) is expected


def test_an_unknown_operator_never_fires():
    """A definition from a newer version must not make this one unusable."""
    assert conditions.evaluate(
        {"field": "x", "operator": "sounds_like", "value": "y"}, {"x": "y"}) is False


def test_the_operators_are_a_table_not_a_chain():
    """Adding one is a line in the table, here and in the frontend's mirror."""
    assert set(conditions.OPERATORS) >= {
        "equals", "not_equals", "is_empty", "is_not_empty",
        "greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal",
        "contains", "not_contains",
    }


# --- 11-12. combining ------------------------------------------------------------- #
def test_conditions_combine_with_and():
    rule = _rule("consent", "equals", "yes", {"type": "form"},
                 extra=[{"field": "age", "operator": "greater_than_or_equal", "value": 18}])

    assert conditions.evaluate_rule(rule, {"consent": "yes", "age": 21}) is True
    assert conditions.evaluate_rule(rule, {"consent": "yes", "age": 16}) is False
    assert conditions.evaluate_rule(rule, {"consent": "no", "age": 21}) is False


def test_conditions_combine_with_or():
    rule = _rule("a", "equals", "1", {"type": "form"}, logic="OR",
                 extra=[{"field": "b", "operator": "equals", "value": "2"}])

    assert conditions.evaluate_rule(rule, {"a": "1", "b": ""}) is True
    assert conditions.evaluate_rule(rule, {"a": "", "b": "2"}) is True
    assert conditions.evaluate_rule(rule, {"a": "", "b": ""}) is False


def test_a_rule_with_no_conditions_never_fires():
    assert conditions.evaluate_rule({"conditions": [], "target": {"type": "form"}}, {}) is False


# --- 1-5. the four targets -------------------------------------------------------- #
def _form(rules, fields=None, sections=None):
    return normalize_form({
        "title": "T",
        "sections": sections or [{"key": "extra", "title": "Additional Information"}],
        "fields": fields or [
            {"name": "consent", "label": "Consent", "type": "select",
             "options": [{"label": "Yes", "value": "yes"}, {"label": "No", "value": "no"}]},
            {"name": "name", "label": "Name", "type": "text"},
            {"name": "age", "label": "Age", "type": "number"},
            {"name": "address", "label": "Address", "type": "text", "section": "extra"},
            {"name": "occupation", "label": "Occupation", "type": "text", "section": "extra"},
            {"name": "organization", "label": "Organization", "type": "text", "section": "extra"},
        ],
        "rules": rules,
    })


def test_a_rule_controls_one_question():
    form = _form([_rule("consent", "equals", "yes", {"type": "field", "name": "address"})])

    assert conditions.hidden(form, {"consent": "no"})["fields"] == ["address"]
    assert conditions.hidden(form, {"consent": "yes"})["fields"] == []


def test_a_rule_controls_a_whole_section():
    """One condition on the section, not the same condition on every field in it."""
    form = _form([_rule("consent", "equals", "yes", {"type": "section", "key": "extra"})])

    off = conditions.hidden(form, {"consent": "no"})
    assert off["sections"] == ["extra"]
    assert set(off["fields"]) == {"address", "occupation", "organization"}

    assert conditions.hidden(form, {"consent": "yes"})["fields"] == []


def test_group_is_another_word_for_section():
    form = _form([_rule("consent", "equals", "yes", {"type": "group", "key": "extra"})])

    assert form["rules"][0]["target"] == {"type": "section", "key": "extra"}
    assert "address" in conditions.hidden(form, {"consent": "no"})["fields"]


def test_a_rule_controls_the_whole_questionnaire():
    form = _form([_rule("consent", "equals", "yes", {"type": "form"})])

    off = conditions.hidden(form, {"consent": "no"})
    assert off["form"] is True
    assert set(off["fields"]) == {"name", "age", "address", "occupation", "organization"}

    assert conditions.hidden(form, {"consent": "yes"})["form"] is False


def test_the_controlling_question_is_never_hidden():
    """A form-level rule that hid the question deciding it could never be
    satisfied again."""
    form = _form([_rule("consent", "equals", "yes", {"type": "form"})])

    assert "consent" not in conditions.hidden(form, {"consent": "no"})["fields"]


def test_hide_is_show_the_other_way_round():
    form = _form([_rule("consent", "equals", "no", {"type": "field", "name": "address"},
                        action="hide")])

    assert conditions.hidden(form, {"consent": "no"})["fields"] == ["address"]
    assert conditions.hidden(form, {"consent": "yes"})["fields"] == []


def test_two_rules_on_one_target_both_count():
    form = _form([
        _rule("consent", "equals", "yes", {"type": "field", "name": "address"}),
        _rule("age", "greater_than_or_equal", 18, {"type": "field", "name": "address"}),
    ])

    assert conditions.hidden(form, {"consent": "yes", "age": 21})["fields"] == []
    assert conditions.hidden(form, {"consent": "yes", "age": 16})["fields"] == ["address"]
    assert conditions.hidden(form, {"consent": "no", "age": 21})["fields"] == ["address"]


# --- 13. it moves with the answers ------------------------------------------------ #
def test_visibility_follows_the_answer():
    form = _form([_rule("consent", "equals", "yes", {"type": "section", "key": "extra"})])

    assert conditions.hidden(form, {})["fields"], "unanswered should hide it"
    assert conditions.hidden(form, {"consent": "yes"})["fields"] == []
    assert conditions.hidden(form, {"consent": "no"})["fields"], "changing back should hide it"


# --- 14-15. the backend decides ---------------------------------------------------- #
def test_an_answer_to_a_question_that_was_not_asked_is_refused():
    form = _form([_rule("consent", "equals", "yes", {"type": "section", "key": "extra"})])

    with pytest.raises(ValidationFailed) as raised:
        validate_payload(form, {"consent": "no", "organization": "ABC"})

    assert "organization" in raised.value.errors


def test_a_hidden_question_is_stored_as_not_answered():
    form = _form([_rule("consent", "equals", "yes", {"type": "section", "key": "extra"})])

    clean = validate_payload(form, {"consent": "no", "name": "Asha"})

    assert clean["organization"] is None
    assert clean["name"] == "Asha"


def test_a_hidden_question_is_not_a_missing_required_answer():
    """It was not asked, so it cannot be missing."""
    form = _form([_rule(
        "consent", "equals", "yes", {"type": "field", "name": "address"})],
        fields=[
            {"name": "consent", "label": "Consent", "type": "select",
             "options": [{"label": "Yes", "value": "yes"}, {"label": "No", "value": "no"}]},
            {"name": "address", "label": "Address", "type": "text", "required": True},
        ], sections=[])

    assert validate_payload(form, {"consent": "no"}) == {"consent": "no", "address": None}

    with pytest.raises(ValidationFailed):
        validate_payload(form, {"consent": "yes"})


def test_a_visible_question_is_validated_as_it_always_was():
    form = _form([_rule("consent", "equals", "yes", {"type": "section", "key": "extra"})])

    clean = validate_payload(form, {"consent": "yes", "organization": "ABC"})

    assert clean["organization"] == "ABC"


# --- 19. configurations that cannot work ------------------------------------------- #
def test_a_question_cannot_decide_whether_it_is_asked():
    form = _form([_rule("address", "equals", "x", {"type": "field", "name": "address"})])

    with pytest.raises(ConfigValidationError) as raised:
        validate_config(form)

    assert any("its own answer" in i.message for i in raised.value.issues)


def test_a_rule_cannot_ask_about_a_question_that_does_not_exist():
    form = _form([_rule("nowhere", "equals", "x", {"type": "field", "name": "address"})])

    with pytest.raises(ConfigValidationError):
        validate_config(form)


def test_a_rule_cannot_control_a_section_the_form_does_not_have():
    form = _form([_rule("consent", "equals", "yes", {"type": "section", "key": "nowhere"})])

    with pytest.raises(ConfigValidationError):
        validate_config(form)


def test_rules_that_depend_on_each_other_in_a_circle_are_refused():
    form = _form([
        _rule("occupation", "equals", "x", {"type": "field", "name": "address"}),
        _rule("address", "equals", "y", {"type": "field", "name": "occupation"}),
    ])

    with pytest.raises(ConfigValidationError) as raised:
        validate_config(form)

    assert any("circle" in i.message for i in raised.value.issues)


def test_a_question_in_a_section_cannot_decide_that_section():
    form = _form([_rule("address", "equals", "x", {"type": "section", "key": "extra"})])

    with pytest.raises(ConfigValidationError):
        validate_config(form)


def test_a_valid_configuration_passes():
    validate_config(_form([_rule("consent", "equals", "yes",
                                 {"type": "section", "key": "extra"})]))


# --- what normalization keeps and drops -------------------------------------------- #
def test_a_rule_that_cannot_be_evaluated_is_dropped_not_stored():
    """Dropped leaves the target visible, which is the safe direction to fail."""
    form = _form([
        {"conditions": [{"field": "consent", "operator": "sounds_like", "value": "yes"}],
         "action": "show", "target": {"type": "field", "name": "address"}},
        {"conditions": [{"field": "consent", "operator": "equals", "value": "yes"}],
         "action": "show", "target": {"type": "nothing"}},
    ])

    assert form["rules"] == []


def test_an_operator_that_compares_to_nothing_carries_no_value():
    form = _form([_rule("name", "is_not_empty", "ignored",
                        {"type": "field", "name": "address"})])

    assert form["rules"][0]["conditions"][0] == {"field": "name", "operator": "is_not_empty"}


def test_the_defaults_are_filled_in():
    form = _form([{"conditions": [{"field": "consent", "operator": "equals", "value": "yes"}],
                   "target": {"type": "field", "name": "address"}}])

    assert form["rules"][0]["action"] == "show"
    assert form["rules"][0]["logic"] == "AND"


# --- 16-18. labels, languages and catalogues --------------------------------------- #
def test_a_rule_never_mentions_a_label():
    form = _form([_rule("consent", "equals", "yes", {"type": "field", "name": "address"})])
    condition = form["rules"][0]["conditions"][0]

    assert condition["field"] == "consent"
    assert condition["value"] == "yes"
    assert "Consent" not in str(form["rules"])


def test_translating_the_form_does_not_change_the_logic():
    form = normalize_form({
        "title": "Consentimiento",
        "default_language": "es",
        "languages": ["es", "en"],
        "fields": [
            {"name": "consent", "label": "Consentimiento", "type": "select",
             "options": [{"label": "Sí", "value": "yes"}, {"label": "No", "value": "no"}]},
            {"name": "org", "label": "Organización", "type": "text"},
        ],
        "translations": {"en": {"fields": {
            "consent": {"label": "Consent", "options": {"yes": "Yes", "no": "No"}},
            "org": {"label": "Organization"},
        }}},
        "rules": [_rule("consent", "equals", "yes", {"type": "field", "name": "org"})],
    })

    for language in ("es", "en"):
        shown = translations.translate_form(form, language)
        assert conditions.hidden(shown, {"consent": "no"})["fields"] == ["org"]
        assert conditions.hidden(shown, {"consent": "yes"})["fields"] == []

    # and the same on the way in
    with pytest.raises(ValidationFailed):
        validate_payload(form, {"consent": "no", "org": "ABC"}, language="en")


def test_a_rule_compares_the_option_value_not_its_label():
    form = normalize_form({
        "title": "T",
        "fields": [
            {"name": "state", "label": "State", "type": "select",
             "options": [{"label": "Maharashtra", "value": "MH"},
                         {"label": "Uttar Pradesh", "value": "UP"}]},
            {"name": "note", "label": "Note", "type": "text"},
        ],
        "rules": [_rule("state", "equals", "MH", {"type": "field", "name": "note"})],
    })

    assert conditions.hidden(form, {"state": "MH"})["fields"] == []
    assert conditions.hidden(form, {"state": "UP"})["fields"] == ["note"]
    # the label is not an answer and so is not a match either
    assert conditions.hidden(form, {"state": "Maharashtra"})["fields"] == ["note"]


@pytest.fixture
def catalogues():
    from app.modules.client_catalog import catalog_service

    suffix = uuid.uuid4().hex[:6].upper()
    states = f"CAT-STATE-{suffix}"
    districts = f"CAT-DISTRICT-{suffix}"

    catalog_service.create_catalog(states, "States", version="1.0", created_by="tests")
    catalog_service.add_value(states, "MH", "Maharashtra")
    catalog_service.add_value(states, "UP", "Uttar Pradesh")

    catalog_service.create_catalog(districts, "Districts", version="1.0",
                                   parent_catalog_id=states, created_by="tests")
    catalog_service.add_value(districts, "PUN", "Pune", parent_code="MH")
    catalog_service.add_value(districts, "LKO", "Lucknow", parent_code="UP")

    yield {"states": states, "districts": districts}

    with transaction() as cur:
        cur.execute("DELETE FROM client_catalog WHERE catalog_id IN %s",
                    ((districts, states),))


def test_a_rule_works_with_a_catalogue_and_its_dependent_list(catalogues):
    """Codes throughout: the rule, the catalogue and the dependency all agree."""
    form = normalize_form({
        "title": "T",
        "fields": [
            {"name": "state", "label": "Estado", "type": "select",
             "options_from": {"source": "client_catalog", "catalog": catalogues["states"]}},
            {"name": "district", "label": "Distrito", "type": "select",
             "options_from": {"source": "client_catalog", "catalog": catalogues["districts"],
                              "depends_on": "state"}},
            {"name": "mumbai_note", "label": "Note", "type": "text"},
        ],
        "rules": [_rule("state", "equals", "MH", {"type": "field", "name": "mumbai_note"})],
    })

    assert conditions.hidden(form, {"state": "MH"})["fields"] == []
    assert conditions.hidden(form, {"state": "UP"})["fields"] == ["mumbai_note"]

    # the dependent list still filters, and the rule still holds
    clean = validate_payload(form, {"state": "MH", "district": "PUN", "mumbai_note": "x"})
    assert clean == {"state": "MH", "district": "PUN", "mumbai_note": "x"}

    with pytest.raises(ValidationFailed):
        validate_payload(form, {"state": "MH", "district": "LKO"})


# --- 20, 22-23. everything that was already working --------------------------------- #
def test_a_form_with_no_rules_is_untouched():
    form = normalize_form({"title": "Farmer Registration", "fields": [
        {"name": "farmer_name", "label": "Farmer Name", "type": "text", "required": True},
        {"name": "plot_area", "label": "Plot Area", "type": "decimal"},
    ]})

    assert form["rules"] == []
    assert conditions.hidden(form, {})["fields"] == []
    assert validate_payload(form, {"farmer_name": "Asha", "plot_area": 2.5}) == \
        {"farmer_name": "Asha", "plot_area": 2.5}


def test_the_invariant_still_holds():
    """validate_config(normalize_form(x)) never raises — with rules or without."""
    for rules in ([], [_rule("consent", "equals", "yes", {"type": "field", "name": "address"})]):
        validate_config(_form(rules))


# --- 21-22. what the importer brings in --------------------------------------------- #
def test_imported_show_if_becomes_a_rule():
    from app.modules.forms import edit_view_import

    rows = [{"VARIABLE": "tipo_c", "FIELD TYPE": "select1", "LABEL": "Tipo",
             "REQUIRED": "Yes", "CATALOG": "Tipo_list", "LOGIC": ""},
            {"VARIABLE": "nombre_c", "FIELD TYPE": "text", "LABEL": "Nombre",
             "REQUIRED": "", "CATALOG": "",
             "LOGIC": "SHOW IF tipo_c IS Persona_fisica"}]

    form = normalize_form(edit_view_import.build_form(rows, source="registro.xlsx")[0])

    assert form["rules"] == [{
        "conditions": [{"field": "tipo_c", "operator": "equals", "value": "Persona_fisica"}],
        "logic": "AND", "action": "show",
        "target": {"type": "field", "name": "nombre_c"},
    }]


def test_the_original_condition_text_is_still_kept():
    """Unchanged: the client's own words stay on the field, whether or not this
    reader could act on them."""
    from app.modules.forms import edit_view_import

    rows = [{"VARIABLE": "tipo_c", "FIELD TYPE": "text", "LABEL": "Tipo", "LOGIC": ""},
            {"VARIABLE": "nombre_c", "FIELD TYPE": "text", "LABEL": "Nombre",
             "LOGIC": "SHOW IF tipo_c IS Persona_fisica"}]

    form = normalize_form(edit_view_import.build_form(rows, source="registro.xlsx")[0])
    by_name = {f["name"]: f for f in form["fields"]}

    assert by_name["nombre_c"]["source"]["skip_logic"] == "SHOW IF tipo_c IS Persona_fisica"


def test_a_condition_this_reader_cannot_read_is_reported_not_guessed():
    from app.modules.forms import edit_view_import

    rows = [{"VARIABLE": "a_c", "FIELD TYPE": "text", "LABEL": "A", "LOGIC": ""},
            {"VARIABLE": "b_c", "FIELD TYPE": "text", "LABEL": "B",
             "LOGIC": "Automatico: traer el nombre si aplica"}]

    definition = edit_view_import.build_form(rows, source="registro.xlsx")[0]

    assert definition["rules"] == [], "a condition was guessed at"
    assert definition["import_source"]["unread_logic"], "it was dropped without a word"
    assert definition["fields"][1]["source"]["skip_logic"] == \
        "Automatico: traer el nombre si aplica"


def test_an_imported_rule_naming_an_unknown_question_is_not_kept():
    from app.modules.forms import edit_view_import

    rows = [{"VARIABLE": "b_c", "FIELD TYPE": "text", "LABEL": "B",
             "LOGIC": "SHOW IF somewhere_else IS x"}]

    definition = edit_view_import.build_form(rows, source="registro.xlsx")[0]

    assert definition["rules"] == []
    assert definition["import_source"]["unread_logic"]


def test_the_real_workbooks_conditions_are_read():
    """The client's own register, whose LOGIC column is the shape this reads."""
    from pathlib import Path

    from app.modules.forms import edit_view_import

    workbook = Path.home() / "Downloads" / "05 Collaborators Register.xlsx"
    if not workbook.exists():
        pytest.skip("the client's workbook is not on this machine")

    form = normalize_form(
        edit_view_import.read_workbook(workbook.read_bytes(), source="registro.xlsx")[0])

    assert form["rules"], "no condition was read from the workbook"
    for rule in form["rules"]:
        assert rule["conditions"][0]["operator"] in conditions.OPERATORS
        assert rule["target"]["type"] == "field"

    validate_config(form)


# --- 22. the acceptance test -------------------------------------------------------- #
@pytest.fixture
def cleanup():
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


def test_the_consent_flow_end_to_end(cleanup):
    """Consent, name, age, and an Additional Information group that appears only
    when consent is given."""
    from app.modules.forms import submission_service

    definition = _form([_rule("consent", "equals", "yes", {"type": "section", "key": "extra"})])
    definition["title"] = f"Consent survey {uuid.uuid4().hex[:6]}"
    definition["table_name"] = f"consent_survey_{uuid.uuid4().hex[:8]}"

    created = form_service.create_form(definition, created_by="tests")
    cleanup.append((created["form_id"], created["table"]["table_name"]))
    form_service.set_status(created["form_id"], "Active")
    form = form_service.get_form(created["form_id"])

    # Case A — consent given, the group applies
    stored = form["form_json"]
    assert conditions.hidden(stored, {"consent": "yes"})["fields"] == []

    # Case B — consent refused, the group does not
    off = conditions.hidden(stored, {"consent": "no"})
    assert set(off["fields"]) == {"address", "occupation", "organization"}
    assert "consent" not in off["fields"], "the consent question disappeared"

    # A payload sent straight to the API, bypassing the form entirely
    with pytest.raises(ValidationFailed) as raised:
        submission_service.submit(form, {"consent": "no", "organization": "ABC"},
                                  created_by="tests")
    assert "organization" in raised.value.errors

    # and the valid one
    result = submission_service.submit(
        form, {"consent": "yes", "name": "Asha", "age": 30, "organization": "ABC"},
        created_by="tests")

    with transaction() as cur:
        cur.execute(
            sql.SQL("SELECT form_data FROM {} WHERE survey_id = %s").format(
                sql.Identifier(created["table"]["table_name"])),
            (result["survey_id"],),
        )
        row = cur.fetchone()["form_data"]

    assert row["organization"] == "ABC"
    assert row["consent"] == "yes"
