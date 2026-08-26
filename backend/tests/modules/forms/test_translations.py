"""Showing one form in more than one language."""
import pytest

from app.modules.forms import translations
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.submission_service import validate_payload

FORM = {
    "title": "Farmer Registration",
    "submit_label": "Submit",
    "sections": [{"key": "land", "title": "Land", "description": ""}],
    "fields": [
        {
            "name": "farmer_name",
            "label": "Farmer Name",
            "type": "text",
            "required": True,
            "options": [],
            "validation": {},
        },
        {
            "name": "irrigation",
            "label": "Irrigation",
            "type": "select",
            "section": "land",
            "options": [{"value": "canal", "label": "Canal"}],
            "validation": {},
        },
    ],
    "translations": {
        "hi": {
            "title": "T-hi",
            "submit_label": "S-hi",
            "sections": {"land": {"title": "Sec-hi"}},
            "fields": {
                "farmer_name": {"label": "Name-hi"},
                "irrigation": {"label": "Irr-hi", "options": {"canal": "Canal-hi"}},
            },
        }
    },
}


# --- cleaning what arrives -------------------------------------------------- #
def test_an_unsupported_language_is_dropped():
    cleaned = translations.normalize_translations({"zz": {"title": "nope"}})
    assert cleaned == {}


def test_the_default_language_is_not_a_translation():
    """English is what the form is written in, so it has nothing to translate."""
    cleaned = translations.normalize_translations({"en": {"title": "duplicate"}})
    assert cleaned == {}


def test_empty_and_malformed_parts_are_left_out():
    cleaned = translations.normalize_translations({
        "hi": {
            "title": "kept",
            "description": "   ",
            "sections": "not a dict",
            "fields": {"a": {"label": "kept"}, "b": "not a dict", "c": {"label": ""}},
        }
    })
    assert cleaned["hi"] == {"title": "kept", "fields": {"a": {"label": "kept"}}}


def test_normalize_form_keeps_the_languages_it_can_use():
    out = normalize_form({
        "title": "T",
        "languages": ["hi", "zz"],
        "translations": {"hi": {"title": "T-hi"}},
        "fields": [{"label": "A note", "type": "text"}],
    })
    assert out["languages"] == ["en", "hi"]
    assert out["default_language"] == "en"
    assert out["translations"]["hi"]["title"] == "T-hi"


def test_a_translated_language_counts_even_if_nobody_listed_it():
    out = normalize_form({
        "title": "T",
        "translations": {"hi": {"title": "T-hi"}},
        "fields": [{"label": "A note", "type": "text"}],
    })
    assert out["languages"] == ["en", "hi"]


# --- showing the form ------------------------------------------------------- #
def test_translating_swaps_the_words():
    hindi = translations.translate_form(FORM, "hi")

    assert hindi["title"] == "T-hi"
    assert hindi["submit_label"] == "S-hi"
    assert hindi["sections"][0]["title"] == "Sec-hi"
    assert [f["label"] for f in hindi["fields"]] == ["Name-hi", "Irr-hi"]
    assert hindi["fields"][1]["options"][0]["label"] == "Canal-hi"


def test_field_names_and_option_values_never_change():
    """They are the keys answers are stored under. Translating one would mean the
    same answer arriving as two different values."""
    hindi = translations.translate_form(FORM, "hi")

    assert [f["name"] for f in hindi["fields"]] == ["farmer_name", "irrigation"]
    assert hindi["fields"][1]["options"][0]["value"] == "canal"


def test_the_original_is_left_alone():
    translations.translate_form(FORM, "hi")
    assert FORM["title"] == "Farmer Registration"
    assert FORM["fields"][0]["label"] == "Farmer Name"


def test_a_missing_translation_falls_back():
    """A half-finished translation still produces a usable form."""
    partial = dict(FORM)
    partial["translations"] = {"hi": {"fields": {"farmer_name": {"label": "Name-hi"}}}}

    hindi = translations.translate_form(partial, "hi")
    assert hindi["fields"][0]["label"] == "Name-hi"
    assert hindi["fields"][1]["label"] == "Irrigation", "untranslated keeps the original"
    assert hindi["title"] == "Farmer Registration"


def test_an_unknown_language_returns_the_form_unchanged():
    assert translations.translate_form(FORM, "zz") is FORM
    assert translations.translate_form(FORM, None) is FORM


def test_the_languages_a_form_offers():
    assert translations.form_languages(FORM) == ["en", "hi"]
    assert translations.form_languages({"fields": []}) == ["en"]


# --- what a person reads when something is wrong ---------------------------- #
def test_an_error_uses_the_translated_label_and_wording():
    with pytest.raises(Exception) as caught:
        validate_payload(FORM, {}, language="hi")

    errors = caught.value.errors
    assert "Name-hi" in errors["farmer_name"], "the translated label"
    assert "is required" not in errors["farmer_name"], "the English wording leaked through"


def test_english_is_unaffected():
    with pytest.raises(Exception) as caught:
        validate_payload(FORM, {})

    assert caught.value.errors["farmer_name"] == "Farmer Name is required"


def test_a_language_with_no_wording_still_works():
    """Marathi has no message list yet, so the words fall back to English while
    the label still comes from the translation."""
    marathi = dict(FORM)
    marathi["translations"] = {"mr": {"fields": {"farmer_name": {"label": "Name-mr"}}}}

    with pytest.raises(Exception) as caught:
        validate_payload(marathi, {}, language="mr")

    assert caught.value.errors["farmer_name"] == "Name-mr is required"


def test_answers_are_the_same_whatever_the_language():
    """The whole point: one table, one set of keys."""
    english = validate_payload(FORM, {"farmer_name": "Asha", "irrigation": "canal"})
    hindi = validate_payload(
        FORM, {"farmer_name": "Asha", "irrigation": "canal"}, language="hi"
    )
    assert english == hindi
