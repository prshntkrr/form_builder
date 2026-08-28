"""One form, more than one language.

A bilingual workbook produces one form definition, not one per language: the
same fields, the same answers, the same table. Only the words people read
change, and they come from the workbook — nothing here translates anything.
"""
import io
import uuid

import pytest
from psycopg2 import sql

from app.core.database import ping, transaction
from app.modules.forms import edit_view_import, form_service, translations
from app.modules.forms.config_validation import validate_config
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.submission_service import validate_payload
from app.modules.forms.tabular_service import tabular_name

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

openpyxl = pytest.importorskip("openpyxl", reason="openpyxl is not installed")


# --------------------------------------------------------------------------- #
# The Agronomic Logbook's shape: the client's Spanish beside their English.
# Built here rather than read from disk so the tests do not depend on any one
# file being present; the columns and spellings are the client's.
# --------------------------------------------------------------------------- #
HEADINGS = ["PANEL", "VARIABLE", "FIELD TYPE", "LABEL SPAN", "ETIQUETA ENG",
            "REQUIRED", "CATALOG", "FATHER LIST"]

ROWS = [
    ["Bitacora", "ciclo_c", "text", "Ciclo", "Cycle", "Yes", "", ""],
    ["", "anio_c", "integer", "Año", "Year", "Yes", "", ""],
    ["", "colaborador_c", "select1", "Colaborador", "Collaborator", "", "Colaboradores_list", ""],
    ["", "estado_c", "text", "Estado", "Status", "", "", ""],
    # A row the client wrote in Spanish only: there is no English for it, and
    # none is invented.
    ["", "observaciones_c", "memo", "Observaciones", "", "", "", ""],
]


def _workbook(headings=HEADINGS, rows=ROWS) -> bytes:
    book = openpyxl.Workbook()
    book.remove(book.active)
    sheet = book.create_sheet("Edit view")
    sheet.append(headings)
    for row in rows:
        sheet.append(row)

    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


@pytest.fixture
def logbook():
    return _workbook()


@pytest.fixture
def form(logbook):
    return normalize_form(
        edit_view_import.read_workbook(logbook, source="01 Agronomic Logbook.xlsx")[0])


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


def _labels(form_json, language):
    shown = translations.translate_form(form_json, language)
    return {f["name"]: f["label"] for f in shown["fields"]}


# --- 1-2. what the importer produces --------------------------------------------- #
def test_both_languages_are_detected(form):
    assert form["languages"] == ["es", "en"]


def test_the_workbooks_own_language_is_the_default(form):
    """LABEL SPAN is where the labels are, so the form is Spanish. English is
    not the default just because it is ours."""
    assert form["default_language"] == "es"


def test_the_spanish_label_is_kept_exactly(form):
    by_name = {f["name"]: f for f in form["fields"]}

    assert by_name["ciclo_c"]["label"] == "Ciclo"
    assert by_name["anio_c"]["label"] == "Año"
    assert by_name["colaborador_c"]["label"] == "Colaborador"
    assert by_name["estado_c"]["label"] == "Estado"


def test_the_english_label_is_kept_beside_it(form):
    english = form["translations"]["en"]["fields"]

    assert english["ciclo_c"]["label"] == "Cycle"
    assert english["anio_c"]["label"] == "Year"
    assert english["colaborador_c"]["label"] == "Collaborator"
    assert english["estado_c"]["label"] == "Status"


def test_neither_language_replaces_the_other(form):
    """The Spanish stays the field's label and the English stays a translation.
    Reading one back must never show the other."""
    by_name = {f["name"]: f for f in form["fields"]}

    assert by_name["ciclo_c"]["label"] != "Cycle"
    assert form["translations"]["en"]["fields"]["ciclo_c"]["label"] != "Ciclo"


def test_a_row_written_in_one_language_gets_no_translation(form):
    """No English was supplied for it, so none appears. Nothing is invented."""
    assert "observaciones_c" not in form["translations"]["en"]["fields"]


def test_one_definition_not_one_per_language(form):
    """Four questions with English, one without — five fields, once."""
    assert len(form["fields"]) == 5
    assert len({f["name"] for f in form["fields"]}) == 5


# --- 3-4. resolving a label ------------------------------------------------------- #
def test_spanish_shows_the_spanish_wording(form):
    assert _labels(form, "es")["ciclo_c"] == "Ciclo"


def test_english_shows_the_english_wording(form):
    assert _labels(form, "en")["ciclo_c"] == "Cycle"


def test_a_missing_translation_falls_back_to_the_original(form):
    """Never blank, and never the field name — the wording the client wrote."""
    assert _labels(form, "en")["observaciones_c"] == "Observaciones"


def test_an_unknown_language_falls_back_to_the_form_as_written(form):
    assert _labels(form, "de")["ciclo_c"] == "Ciclo"


def test_the_field_names_never_move(form):
    """What the whole thing rests on: the name is the key in form_data and the
    column in the mirror, so it cannot depend on what somebody is reading."""
    spanish = [f["name"] for f in translations.translate_form(form, "es")["fields"]]
    english = [f["name"] for f in translations.translate_form(form, "en")["fields"]]

    assert spanish == english == [f["name"] for f in form["fields"]]


def test_the_languages_a_form_offers_come_from_the_form(form):
    assert translations.form_languages(form) == ["es", "en"]


def test_an_english_only_form_offers_one_language():
    """So the renderer shows no language selector at all."""
    plain = normalize_form({"title": "Farmer Registration", "fields": [
        {"name": "farmer_name", "label": "Farmer Name", "type": "text"},
    ]})

    assert translations.form_languages(plain) == ["en"]
    assert plain["translations"] == {}


# --- 4. survival --------------------------------------------------------------- #
def test_the_translations_survive_normalization(form):
    again = normalize_form(form)

    assert again["languages"] == ["es", "en"]
    assert again["default_language"] == "es"
    assert again["translations"]["en"]["fields"]["ciclo_c"]["label"] == "Cycle"


def test_a_bilingual_form_is_saveable(form):
    validate_config(form)


def test_the_translations_survive_a_save_and_reopen(form, cleanup):
    definition = dict(form)
    definition["title"] = f"Bitacora {uuid.uuid4().hex[:6]}"
    definition["table_name"] = f"bitacora_{uuid.uuid4().hex[:8]}"

    created = form_service.create_form(definition, created_by="tests")
    cleanup.append((created["form_id"], created["table"]["table_name"]))

    stored = form_service.get_form(created["form_id"])["form_json"]

    assert stored["default_language"] == "es"
    assert stored["languages"] == ["es", "en"]
    assert stored["translations"]["en"]["fields"]["anio_c"]["label"] == "Year"


# --- 5-6. sections, help text and the rest --------------------------------------- #
def test_a_section_title_is_translated():
    form_json = normalize_form({
        "title": "Bitácora",
        "default_language": "es",
        "languages": ["es", "en"],
        "sections": [{"key": "crop_information", "title": "Información del cultivo"}],
        "fields": [{"name": "cultivo", "label": "Cultivo", "type": "text",
                    "section": "crop_information"}],
        "translations": {"en": {
            "title": "Logbook",
            "sections": {"crop_information": {"title": "Crop Information"}},
            "fields": {"cultivo": {"label": "Crop"}},
        }},
    })

    english = translations.translate_form(form_json, "en")

    assert english["title"] == "Logbook"
    assert english["sections"][0]["title"] == "Crop Information"
    assert english["sections"][0]["key"] == "crop_information", "a section key was translated"


def test_a_section_with_no_translation_keeps_its_title():
    form_json = normalize_form({
        "title": "Bitácora",
        "default_language": "es",
        "languages": ["es", "en"],
        "sections": [{"key": "otros", "title": "Otros"}],
        "fields": [{"name": "notas", "label": "Notas", "type": "text", "section": "otros"}],
        "translations": {"en": {"fields": {"notas": {"label": "Notes"}}}},
    })

    assert translations.translate_form(form_json, "en")["sections"][0]["title"] == "Otros"


def test_help_text_placeholder_and_the_wording_around_the_form():
    form_json = normalize_form({
        "title": "Bitácora",
        "description": "Registro de campo",
        "submit_label": "Enviar",
        "success_message": "Gracias",
        "default_language": "es",
        "languages": ["es", "en"],
        "fields": [{"name": "ciclo_c", "label": "Ciclo", "type": "text",
                    "help_text": "El ciclo agrícola", "placeholder": "2026"}],
        "translations": {"en": {
            "title": "Logbook",
            "description": "Field record",
            "submit_label": "Submit",
            "success_message": "Thank you",
            "fields": {"ciclo_c": {"label": "Cycle", "help_text": "The growing cycle",
                                   "placeholder": "2026"}},
        }},
    })

    english = translations.translate_form(form_json, "en")
    field = english["fields"][0]

    assert english["description"] == "Field record"
    assert english["submit_label"] == "Submit"
    assert english["success_message"] == "Thank you"
    assert field["help_text"] == "The growing cycle"


# --- 7-8. catalogues, dependent lists and the codes ------------------------------- #
@pytest.fixture
def catalogues():
    """CAT-STATE and CAT-DISTRICT, the acceptance pair."""
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
    catalog_service.add_value(districts, "NAG", "Nagpur", parent_code="MH")
    catalog_service.add_value(districts, "LKO", "Lucknow", parent_code="UP")

    yield {"states": states, "districts": districts}

    with transaction() as cur:
        cur.execute("DELETE FROM client_catalog WHERE catalog_id IN %s",
                    ((districts, states),))


def _bilingual_survey(catalogues):
    return normalize_form({
        "title": "Bitácora",
        "default_language": "es",
        "languages": ["es", "en"],
        "fields": [
            {"name": "state", "label": "Estado", "type": "select",
             "options_from": {"source": "client_catalog", "catalog": catalogues["states"]}},
            {"name": "district", "label": "Distrito", "type": "select",
             "options_from": {"source": "client_catalog", "catalog": catalogues["districts"],
                              "depends_on": "state"}},
            {"name": "ciclo_c", "label": "Ciclo", "type": "text"},
        ],
        "translations": {"en": {"fields": {
            "state": {"label": "State"},
            "district": {"label": "District"},
            "ciclo_c": {"label": "Cycle"},
        }}},
    })


def test_a_catalogue_field_keeps_its_source_in_every_language(catalogues):
    """Translation touches words. Where the choices come from is not a word."""
    form_json = _bilingual_survey(catalogues)

    for language in ("es", "en"):
        fields = {f["name"]: f for f in translations.translate_form(form_json, language)["fields"]}
        assert fields["state"]["options_from"]["catalog"] == catalogues["states"]
        assert fields["district"]["options_from"]["depends_on"] == "state"


def test_the_dependent_list_still_filters_whatever_the_language(catalogues):
    from app.modules.client_catalog import catalog_options

    assert [o["value"] for o in
            catalog_options.options_for(catalogues["districts"], parent_code="MH")] == \
        ["PUN", "NAG"]
    assert [o["value"] for o in
            catalog_options.options_for(catalogues["districts"], parent_code="UP")] == ["LKO"]


def test_an_answer_is_the_code_in_every_language(catalogues):
    """The point of the whole thing: reading the form in English does not change
    what a Maharashtra answer is."""
    form_json = _bilingual_survey(catalogues)

    spanish = validate_payload(form_json, {"state": "MH", "district": "PUN",
                                           "ciclo_c": "2026"}, language="es")
    english = validate_payload(form_json, {"state": "MH", "district": "PUN",
                                           "ciclo_c": "2026"}, language="en")

    assert spanish == english == {"state": "MH", "district": "PUN", "ciclo_c": "2026"}


def test_a_translated_label_is_never_an_answer(catalogues):
    """Submitting what was on screen rather than the code has to fail, or the
    same answer would be two different values."""
    from app.modules.forms.submission_service import ValidationFailed

    with pytest.raises(ValidationFailed):
        validate_payload(_bilingual_survey(catalogues), {"state": "Maharashtra"})


def test_the_payload_is_keyed_by_field_name_not_label(form):
    """`ciclo_c`, never `Ciclo` and never `Cycle`."""
    clean = validate_payload(form, {"ciclo_c": "2026", "anio_c": 2026}, language="en")

    assert "ciclo_c" in clean
    assert "Ciclo" not in clean and "Cycle" not in clean


def test_an_error_is_worded_in_the_readers_language(form):
    """The rules are the same in every language; only what somebody reads changes."""
    from app.modules.forms.submission_service import ValidationFailed

    with pytest.raises(ValidationFailed) as spanish:
        validate_payload(form, {}, language="es")

    with pytest.raises(ValidationFailed) as english:
        validate_payload(form, {}, language="en")

    assert "Ciclo" in spanish.value.errors["ciclo_c"]
    assert "Cycle" in english.value.errors["ciclo_c"]
    assert set(spanish.value.errors) == set(english.value.errors), "the keys changed"


# --- through the live form ------------------------------------------------------- #
def _live(form_json, cleanup):
    definition = dict(form_json)
    definition["title"] = f"Bitacora {uuid.uuid4().hex[:6]}"
    definition["table_name"] = f"bitacora_{uuid.uuid4().hex[:8]}"

    created = form_service.create_form(definition, created_by="tests")
    cleanup.append((created["form_id"], created["table"]["table_name"]))
    form_service.set_status(created["form_id"], "Active")
    return created["form_id"], created["table"]["table_name"]


def test_the_render_endpoint_offers_both_languages(editor_client, form, cleanup):
    form_id, _ = _live(form, cleanup)

    body = editor_client.get(f"/api/forms/{form_id}/render").json()

    assert body["language"] == "es", "the form did not open in its own language"
    assert [l["code"] for l in body["languages"]] == ["es", "en"]
    assert {l["name"] for l in body["languages"]} == {"Español", "English"}


def test_the_rendered_form_carries_its_translations(editor_client, form, cleanup):
    """The page switches language without asking again, so the block has to
    still be there — that is what lets a switch keep the answers."""
    form_id, _ = _live(form, cleanup)

    form_json = editor_client.get(f"/api/forms/{form_id}/render").json()["form_json"]

    assert form_json["translations"]["en"]["fields"]["ciclo_c"]["label"] == "Cycle"
    assert {f["name"]: f["label"] for f in form_json["fields"]}["ciclo_c"] == "Ciclo"


def test_a_single_language_form_offers_one(editor_client, cleanup):
    plain = normalize_form({"title": "Farmer Registration", "fields": [
        {"name": "farmer_name", "label": "Farmer Name", "type": "text"},
    ]})
    form_id, _ = _live(plain, cleanup)

    body = editor_client.get(f"/api/forms/{form_id}/render").json()

    assert [l["code"] for l in body["languages"]] == ["en"]


def test_a_submission_stores_the_same_row_whatever_the_language(editor_client, form, cleanup):
    """Two people fill the same form in two languages. One table, one shape."""
    form_id, table = _live(form, cleanup)

    for language in ("es", "en"):
        response = editor_client.post(
            f"/api/forms/{form_id}/submissions",
            json={"data": {"ciclo_c": "2026", "anio_c": 2026}, "language": language},
        )
        assert response.status_code == 201

    with transaction() as cur:
        cur.execute(sql.SQL("SELECT form_data FROM {} ORDER BY survey_id").format(
            sql.Identifier(table)))
        rows = [r["form_data"] for r in cur.fetchall()]

    assert rows[0] == rows[1]
    assert rows[0]["ciclo_c"] == "2026"
    assert rows[0]["anio_c"] == 2026


# --- what was already working ----------------------------------------------------- #
def test_an_english_only_import_is_unchanged():
    """The Maize workbook has one label column. Nothing about it changed."""
    headings = ["VARIABLE", "LABEL", "FIELD TYPE", "REQUIRED"]
    rows = [["crop", "Crop", "text", "Yes"], ["plant_height", "Plant Height", "decimal", "Yes"]]

    imported = normalize_form(
        edit_view_import.read_workbook(_workbook(headings, rows), source="maize.xlsx")[0])

    assert imported["default_language"] == "en"
    assert imported["languages"] == ["en"]
    assert imported["translations"] == {}


def test_a_form_with_an_empty_translations_block_still_works():
    form_json = normalize_form({
        "title": "X", "languages": ["en"], "default_language": "en", "translations": {},
        "fields": [{"name": "a", "label": "A", "type": "text"}],
    })

    assert translations.translate_form(form_json, "en")["fields"][0]["label"] == "A"
    assert validate_payload(form_json, {"a": "1"}) == {"a": "1"}


def test_no_translation_service_is_reached_while_importing(logbook):
    """The workbook is the source of truth. Nothing calls a model to produce a
    label, and nothing calls out at all."""
    import socket

    real = socket.socket.connect
    reached = []

    def guard(self, address):
        host = address[0] if isinstance(address, tuple) else str(address)
        if host not in ("127.0.0.1", "::1", "localhost"):
            reached.append(host)
            raise AssertionError(f"an external request was made to {host}")
        return real(self, address)

    socket.socket.connect = guard
    try:
        normalize_form(edit_view_import.read_workbook(logbook, source="logbook.xlsx")[0])
    finally:
        socket.socket.connect = real

    assert reached == []
