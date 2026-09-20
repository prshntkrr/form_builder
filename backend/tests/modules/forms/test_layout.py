"""Where each question sits on the page.

A layout refers to questions by name and never copies one, so what is worth
pinning down is what normalisation does to those references: keeps the ones
that point at real questions, drops the rest, places each question once, and
never removes a question from the form because the layout left it out.

The other thing worth pinning is what does *not* change: a form with no layout
normalises exactly as it did before layouts existed.

Pure — no database.
"""
import copy

import pytest

from app.core import registry
from app.modules.forms.form_schema import normalize_form

pytestmark = [
    pytest.mark.skipif("forms" in registry.disabled(),
                       reason="forms is switched off (DISABLED_MODULES)"),
]

ABSENT = object()

LAYOUT = {
    "sections": [
        {
            "id": "farmer",
            "title": "Farmer Information",
            "containers": [
                {"id": "row-1", "fields": [
                    {"fieldId": "farmer_name", "width": 6},
                    {"fieldId": "mobile", "width": 6},
                ]},
                {"id": "row-2", "fields": [
                    {"fieldId": "village", "width": 12},
                ]},
            ],
        },
    ],
}


def config(layout=ABSENT, names=("farmer_name", "mobile", "village")):
    cfg = {
        "title": "Layout Test",
        "table_name": "layout_test",
        "sections": [],
        "fields": [{"name": n, "label": n.replace("_", " ").title(), "type": "text"}
                   for n in names],
    }
    if layout is not ABSENT:
        cfg["layout"] = layout
    return cfg


def placed(form):
    """Every reference, in order, as (section, row, fieldId, width)."""
    return [
        (s["id"], c["id"], cell["fieldId"], cell["width"])
        for s in form["layout"]["sections"]
        for c in s["containers"]
        for cell in c["fields"]
    ]


# ── kept ────────────────────────────────────────────────────────

def test_a_layout_survives_normalization():
    form = normalize_form(config(LAYOUT))

    assert form["layout"] == LAYOUT


def test_the_order_of_sections_rows_and_questions_is_kept():
    layout = {"sections": [
        {"id": "b", "title": "B", "containers": [
            {"id": "b1", "fields": [{"fieldId": "village", "width": 4},
                                    {"fieldId": "farmer_name", "width": 8}]}]},
        {"id": "a", "title": "A", "containers": [
            {"id": "a2", "fields": [{"fieldId": "mobile", "width": 12}]},
            {"id": "a1", "fields": []}]},
    ]}

    form = normalize_form(config(layout))

    assert [s["id"] for s in form["layout"]["sections"]] == ["b", "a"]
    assert [c["id"] for c in form["layout"]["sections"][1]["containers"]] == ["a2", "a1"]
    assert placed(form)[:2] == [("b", "b1", "village", 4), ("b", "b1", "farmer_name", 8)]


def test_an_empty_row_is_kept_as_somewhere_to_drop_a_question():
    layout = copy.deepcopy(LAYOUT)
    layout["sections"][0]["containers"].append({"id": "row-3", "fields": []})

    form = normalize_form(config(layout))

    assert form["layout"]["sections"][0]["containers"][-1] == {"id": "row-3", "fields": []}


# ── references ──────────────────────────────────────────────────

def test_a_reference_to_a_question_the_form_lacks_is_dropped():
    layout = copy.deepcopy(LAYOUT)
    layout["sections"][0]["containers"][0]["fields"].append(
        {"fieldId": "no_such_question", "width": 6})

    form = normalize_form(config(layout))

    assert "no_such_question" not in [cell[2] for cell in placed(form)]


def test_a_question_placed_twice_keeps_only_its_first_place():
    layout = {"sections": [{"id": "s", "title": "", "containers": [
        {"id": "r1", "fields": [{"fieldId": "mobile", "width": 6},
                                {"fieldId": "mobile", "width": 3}]},
        {"id": "r2", "fields": [{"fieldId": "mobile", "width": 12}]},
    ]}]}

    form = normalize_form(config(layout))

    assert [c for c in placed(form) if c[2] == "mobile"] == [("s", "r1", "mobile", 6)]


def test_leaving_a_question_out_of_the_layout_does_not_remove_it():
    layout = {"sections": [{"id": "s", "title": "", "containers": [
        {"id": "r", "fields": [{"fieldId": "farmer_name", "width": 12}]}]}]}

    form = normalize_form(config(layout))

    assert [f["name"] for f in form["fields"]] == ["farmer_name", "mobile", "village"]


def test_the_layout_carries_references_not_copies():
    form = normalize_form(config(LAYOUT))

    for cell in (c for s in form["layout"]["sections"]
                 for r in s["containers"] for c in r["fields"]):
        assert set(cell) == {"fieldId", "width"}


# ── widths ──────────────────────────────────────────────────────

@pytest.mark.parametrize("given, kept", [
    (6, 6), (12, 12), (1, 1),
    (0, 1), (-4, 1), (20, 12),
    (6.7, 6), ("8", 8),
    ("abc", 12), (None, 12), (True, 12),
])
def test_a_width_is_a_whole_number_of_columns_from_1_to_12(given, kept):
    layout = {"sections": [{"id": "s", "title": "", "containers": [
        {"id": "r", "fields": [{"fieldId": "mobile", "width": given}]}]}]}

    form = normalize_form(config(layout))

    assert placed(form)[0][3] == kept


# ── ids ─────────────────────────────────────────────────────────

def test_ids_are_unique_and_safe_to_use_as_keys():
    layout = {"sections": [
        {"id": "farmer", "title": "", "containers": [
            {"id": "row", "fields": [{"fieldId": "mobile", "width": 6}]},
            {"id": "row", "fields": [{"fieldId": "village", "width": 6}]}]},
        {"id": "farmer", "title": "", "containers": []},
        {"id": "<script>'x'", "title": "", "containers": []},
        {"title": "no id", "containers": []},
    ]}

    form = normalize_form(config(layout))
    sections = form["layout"]["sections"]

    ids = [s["id"] for s in sections]
    assert len(set(ids)) == len(ids)
    assert ids[:2] == ["farmer", "farmer-2"]
    assert all(ch.isalnum() or ch in "-_" for ch in ids[2])
    assert ids[3] == "section-4"

    rows = [c["id"] for c in sections[0]["containers"]]
    assert rows == ["row", "row-2"]


# ── malformed ───────────────────────────────────────────────────

@pytest.mark.parametrize("layout", [
    "a layout", 42, [], None, {},
    {"sections": "not a list"},
    {"sections": []},
    {"sections": [1, "a", None]},
])
def test_something_that_is_not_a_layout_leaves_no_layout(layout):
    form = normalize_form(config(layout))

    assert "layout" not in form
    assert [f["name"] for f in form["fields"]] == ["farmer_name", "mobile", "village"]


@pytest.mark.parametrize("layout", [
    {"sections": [{"containers": "not a list"}]},
    {"sections": [{"containers": [1, "a", None, {"fields": "not a list"}]}]},
    {"sections": [{"containers": [{"fields": [1, "a", None, {"width": 6}]}]}]},
])
def test_malformed_parts_are_skipped_rather_than_breaking_the_form(layout):
    form = normalize_form(config(layout))

    assert placed(form) == []
    assert len(form["fields"]) == 3


# ── what does not change ────────────────────────────────────────

def test_a_form_without_a_layout_carries_none():
    assert "layout" not in normalize_form(config())


def test_an_existing_form_normalizes_exactly_as_before():
    """The same definition, with and without an empty layout key, is the same
    definition — so no stored form changes because layouts now exist."""
    before = normalize_form(config())
    with_nothing = normalize_form(config(None))

    assert before == with_nothing
    assert "layout" not in before


def test_normalization_is_deterministic_and_settles():
    once = normalize_form(config(LAYOUT))
    twice = normalize_form(copy.deepcopy(once))

    assert once["layout"] == twice["layout"]
    assert normalize_form(config(LAYOUT))["layout"] == once["layout"]


# ── the public form ─────────────────────────────────────────────

def test_a_public_form_keeps_its_layout_and_nothing_private():
    from app.modules.forms.routers.public_forms import _public_view

    stored = {**normalize_form(config(LAYOUT)),
              "form_id": "FRM00001", "created_by": "Somebody"}

    shown = _public_view(stored)

    assert shown["layout"] == LAYOUT
    assert "table_name" not in shown
    assert "form_id" not in shown
    assert "created_by" not in shown


def test_a_public_form_without_a_layout_is_unchanged():
    from app.modules.forms.routers.public_forms import _public_view

    shown = _public_view(normalize_form(config()))

    assert "layout" not in shown
    assert [f["name"] for f in shown["fields"]] == ["farmer_name", "mobile", "village"]
