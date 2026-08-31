"""The order questions are asked in.

One authority: the field list. The builder writes it, the definition stores it,
`order` on each field mirrors its position, and everything downstream reads the
list. Nothing anywhere sorts by anything else, and nothing depends on when a
field was created or when a row was inserted.
"""
import uuid

import pytest
from psycopg2 import sql

from app.core.database import ping, transaction
from app.modules.forms import form_service
from app.modules.forms.config_validation import validate_config
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.tabular_service import tabular_name

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")


def _form(names, sections=None, section_of=None):
    section_of = section_of or {}
    return normalize_form({
        "title": "Ordering",
        "sections": sections or [],
        "fields": [{"name": n, "label": n.title(), "type": "text",
                    "section": section_of.get(n)} for n in names],
    })


def _names(form_json):
    return [f["name"] for f in form_json["fields"]]


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


def _saved(definition, cleanup):
    definition = dict(definition)
    definition["title"] = f"Ordering {uuid.uuid4().hex[:6]}"
    definition["table_name"] = f"ordering_{uuid.uuid4().hex[:8]}"
    created = form_service.create_form(definition, created_by="tests")
    cleanup.append((created["form_id"], created["table"]["table_name"]))
    return created["form_id"]


# --- the list is the order -------------------------------------------------------- #
def test_the_list_decides_the_order():
    assert _names(_form(["name", "age", "gender"])) == ["name", "age", "gender"]


def test_order_mirrors_the_position():
    form = _form(["name", "age", "gender"])

    assert [f["order"] for f in form["fields"]] == [1, 2, 3]


def test_a_field_moved_to_the_top_stays_at_the_top():
    """The reported case: Consent added last, dragged to the front."""
    form = _form(["consent", "name", "age", "gender"])

    assert _names(form) == ["consent", "name", "age", "gender"]
    assert form["fields"][0]["order"] == 1


def test_bottom_to_top():
    assert _names(_form(["gender", "name", "age"])) == ["gender", "name", "age"]


def test_top_to_bottom():
    assert _names(_form(["age", "gender", "name"])) == ["age", "gender", "name"]


def test_a_field_moved_between_two_others():
    assert _names(_form(["name", "consent", "age", "gender"])) == \
        ["name", "consent", "age", "gender"]


def test_an_incoming_order_property_does_not_override_the_list():
    """A definition whose `order` numbers disagree with its list. The list wins,
    and the numbers are rewritten to match — one authority, not two."""
    form = normalize_form({"title": "T", "fields": [
        {"name": "consent", "label": "Consent", "type": "text", "order": 99},
        {"name": "name", "label": "Name", "type": "text", "order": 1},
    ]})

    assert _names(form) == ["consent", "name"]
    assert [f["order"] for f in form["fields"]] == [1, 2]


def test_the_numbers_stay_contiguous_when_a_field_is_dropped():
    """A field the normalizer cannot use leaves no gap behind it."""
    form = normalize_form({"title": "T", "fields": [
        {"name": "a", "label": "A", "type": "text"},
        "not a field",
        {"name": "b", "label": "B", "type": "text"},
    ]})

    assert [f["order"] for f in form["fields"]] == [1, 2]


# --- saving and reading back ------------------------------------------------------- #
def test_the_order_survives_a_save_and_reload(cleanup):
    form_id = _saved(_form(["consent", "name", "age", "gender"]), cleanup)

    stored = form_service.get_form(form_id)["form_json"]

    assert _names(stored) == ["consent", "name", "age", "gender"]
    assert [f["order"] for f in stored["fields"]] == [1, 2, 3, 4]


def test_reordering_an_existing_form_survives(cleanup):
    """What the builder does: the same fields, a different list."""
    form_id = _saved(_form(["name", "age", "gender"]), cleanup)

    stored = form_service.get_form(form_id)["form_json"]
    moved = dict(stored)
    moved["fields"] = [stored["fields"][2]] + stored["fields"][:2]

    form_service.update_form(form_id, moved, updated_by="tests")

    assert _names(form_service.get_form(form_id)["form_json"]) == ["gender", "name", "age"]


def test_the_api_returns_the_same_order(editor_client, cleanup):
    form_id = _saved(_form(["consent", "name", "age", "gender"]), cleanup)

    body = editor_client.get(f"/api/forms/{form_id}").json()

    assert _names(body["form_json"]) == ["consent", "name", "age", "gender"]


def test_the_render_endpoint_returns_the_same_order(editor_client, cleanup):
    """What the published form is drawn from."""
    form_id = _saved(_form(["consent", "name", "age", "gender"]), cleanup)
    form_service.set_status(form_id, "Active")

    body = editor_client.get(f"/api/forms/{form_id}/render").json()

    assert _names(body["form_json"]) == ["consent", "name", "age", "gender"]


def test_a_new_version_keeps_the_order(cleanup):
    form_id = _saved(_form(["name", "age"]), cleanup)

    stored = form_service.get_form(form_id)["form_json"]
    grown = dict(stored)
    grown["fields"] = [
        {"name": "consent", "label": "Consent", "type": "text"},
        *stored["fields"],
    ]
    form_service.update_form(form_id, grown, updated_by="tests")

    reopened = form_service.get_form(form_id)

    assert reopened["version_no"] == 2, "the change did not make a new version"
    assert _names(reopened["form_json"]) == ["consent", "name", "age"]


# --- sections ---------------------------------------------------------------------- #
SECTIONS = [{"key": "basics", "title": "Basics"}, {"key": "extra", "title": "Extra"}]


def test_a_section_does_not_reorder_the_list():
    form = _form(["consent", "name", "age"], SECTIONS,
                 {"name": "basics", "age": "basics"})

    assert _names(form) == ["consent", "name", "age"]


def test_fields_keep_their_order_inside_a_section():
    form = _form(["name", "age", "gender"], SECTIONS,
                 {"name": "basics", "age": "basics", "gender": "basics"})

    assert _names(form) == ["name", "age", "gender"]


def test_moving_within_a_section_does_not_disturb_another():
    form = _form(["age", "name", "address", "occupation"], SECTIONS,
                 {"age": "basics", "name": "basics",
                  "address": "extra", "occupation": "extra"})

    assert _names(form) == ["age", "name", "address", "occupation"]
    assert [f["section"] for f in form["fields"]] == ["basics", "basics", "extra", "extra"]


def test_a_field_naming_a_section_that_does_not_exist_keeps_its_place():
    form = _form(["consent", "name"], SECTIONS, {"name": "nowhere"})

    assert _names(form) == ["consent", "name"]
    assert form["fields"][1]["section"] is None


# --- every path that renders or serializes a form ----------------------------------- #
def test_the_records_view_lists_columns_in_the_same_order(editor_client, cleanup):
    """What Review shows. Its columns are the questions, so they follow them."""
    form_id = _saved(_form(["consent", "name", "age", "gender"]), cleanup)

    body = editor_client.get(f"/api/forms/{form_id}/submissions").json()

    assert [c["name"] for c in body["columns"]] == ["consent", "name", "age", "gender"]


def test_the_export_header_is_in_the_same_order(editor_client, cleanup):
    form_id = _saved(_form(["consent", "name", "age", "gender"]), cleanup)
    form_service.set_status(form_id, "Active")

    header = editor_client.get(f"/api/forms/{form_id}/submissions/export").text.splitlines()[0]

    # The header carries the labels, in the questions' own order.
    assert header.split(",")[4:] == ["Consent", "Name", "Age", "Gender"]


def test_the_dry_run_reports_the_definitions_order(editor_client, cleanup):
    """What Preview's "test these answers" hands back."""
    form_id = _saved(_form(["consent", "name", "age"]), cleanup)

    body = editor_client.post(f"/api/forms/{form_id}/test-submission",
                              json={"data": {"consent": "x", "name": "y", "age": "z"}}).json()

    assert list(body["form_data"]) == ["consent", "name", "age"]


def test_the_library_keeps_the_order(admin_client, cleanup):
    """A form contributed as a standard, and a draft started from it."""
    from app.modules.forms import standard_library

    form_id = _saved(_form(["consent", "name", "age", "gender"]), cleanup)
    standard_id = f"std_{uuid.uuid4().hex[:8]}"

    entry = form_service.add_to_library(form_id, 1, standard_id=standard_id,
                                        category="Test", added_by="tests")
    try:
        assert _names(standard_library.get(entry["standard_id"]).full_entry()["form_json"]) ==             ["consent", "name", "age", "gender"]

        started = admin_client.post(f"/api/standard-forms/{entry['standard_id']}/start",
                                    json={}).json()["form_json"]
        assert _names(started) == ["consent", "name", "age", "gender"]
    finally:
        form_service.remove_from_library(entry["standard_id"])


def test_an_imported_workbook_keeps_the_workbooks_order():
    """The workbook is where an imported form's order comes from, and nothing
    downstream re-sorts it."""
    from app.modules.forms import edit_view_import

    rows = [{"VARIABLE": n, "FIELD TYPE": "text", "LABEL": n.title()}
            for n in ("consent", "name", "age", "gender")]

    assert _names(normalize_form(edit_view_import.build_form(rows, source="x.xlsx")[0])) ==         ["consent", "name", "age", "gender"]


# --- nothing else decides ----------------------------------------------------------- #
def test_no_service_sorts_the_fields():
    """The guarantee behind all of the above: the list is read, never re-sorted.

    A sort anywhere between the builder and the renderer would be a second
    authority, and the two would eventually disagree — which is exactly the bug
    this file exists to stop coming back.
    """
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[3] / "app" / "modules" / "forms"
    offenders = []

    # The importers are where a list first comes from — a workbook's own Display
    # Order column is how its questions are sequenced, and reading it is not a
    # second authority. Everything after that must leave the list alone.
    builds_the_list = {"excel_import.py", "edit_view_import.py"}

    for path in root.rglob("*.py"):
        if path.name in builds_the_list:
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"sort.*\border\b|\border\b.*sort", line) and "ORDER BY" not in line:
                offenders.append(f"{path.name}:{number}: {line.strip()}")

    assert not offenders, "something sorts fields by `order`:\n" + "\n".join(offenders)


def test_the_order_is_not_the_insertion_order_of_anything(cleanup):
    """Saved with the list deliberately against alphabetical and against the
    order the fields were first written in."""
    form_id = _saved(_form(["zulu", "alpha", "mike"]), cleanup)

    assert _names(form_service.get_form(form_id)["form_json"]) == ["zulu", "alpha", "mike"]


def test_the_invariant_still_holds():
    for names in (["a"], ["consent", "name", "age", "gender"]):
        validate_config(_form(names))
