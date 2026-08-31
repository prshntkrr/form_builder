"""What the Questions editor writes, and what it must never write.

The editor is a screen; these are the rules underneath it. Two of them matter
most:

* Editing a translation writes into the translation block. The wording the form
  was built in is never overwritten, and a field's `name` never moves — that is
  the key answers are stored under.
* Attaching a standard writes that standard's own key and nothing else. Three
  standards coexist on one field on purpose, and none of them ever reaches the
  label a person reads.
"""
import uuid

import pytest

from app.core.database import ping, transaction
from app.modules.forms import form_service, translations
from app.modules.forms.config_validation import validate_config
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.submission_service import validate_payload

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

MAIZE = "CO_322"


@pytest.fixture
def cleanup():
    made = []
    yield made
    with transaction() as cur:
        for form_id in made:
            cur.execute("DELETE FROM form_version WHERE form_id = %s", (form_id,))
            cur.execute("DELETE FROM forms WHERE form_id = %s", (form_id,))


def _logbook():
    """The Agronomic Logbook's shape: Spanish, with the client's English beside it."""
    return normalize_form({
        "title": "Bitácora Agronómica",
        "default_language": "es",
        "languages": ["es", "en"],
        "sections": [{"key": "bitacora", "title": "Bitácora"}],
        "fields": [
            {"name": "ciclo_c", "label": "Ciclo", "type": "text", "section": "bitacora",
             "help_text": "El ciclo agrícola"},
            {"name": "anio_c", "label": "Año", "type": "number", "section": "bitacora"},
        ],
        "translations": {"en": {
            "title": "Agronomic Logbook",
            "sections": {"bitacora": {"title": "Logbook"}},
            "fields": {"ciclo_c": {"label": "Cycle"}, "anio_c": {"label": "Year"}},
        }},
    })


# --- 1-2. the editor knows there is more than one language ------------------------ #
def test_a_bilingual_form_offers_both_languages():
    """What decides whether the Questions tab shows a language selector."""
    assert translations.form_languages(_logbook()) == ["es", "en"]


def test_a_single_language_form_offers_one():
    plain = normalize_form({"title": "Farmer Registration", "fields": [
        {"name": "farmer_name", "label": "Farmer Name", "type": "text"},
    ]})

    assert translations.form_languages(plain) == ["en"]


# --- 3-5. editing one language leaves the other alone ----------------------------- #
def _edit_translation(form_json, language, name, changes):
    """What the editor does when a language other than the form's own is chosen.

    Mirrors Builder.jsx's `translate` — the block is where a translation goes,
    and an emptied entry is removed rather than stored blank.
    """
    translations_block = {**(form_json.get("translations") or {})}
    block = {**translations_block.get(language, {})}
    fields = {**block.get("fields", {})}
    words = {**fields.get(name, {}), **changes}
    words = {k: v for k, v in words.items() if str(v or "").strip()}

    if words:
        fields[name] = words
    else:
        fields.pop(name, None)

    block["fields"] = fields
    translations_block[language] = block
    return {**form_json, "translations": translations_block}


def test_editing_the_english_label_leaves_the_spanish_untouched():
    form = _edit_translation(_logbook(), "en", "ciclo_c", {"label": "Growing cycle"})

    by_name = {f["name"]: f for f in form["fields"]}
    assert by_name["ciclo_c"]["label"] == "Ciclo", "the workbook's own label was overwritten"
    assert form["translations"]["en"]["fields"]["ciclo_c"]["label"] == "Growing cycle"


def test_editing_the_spanish_label_leaves_the_english_untouched():
    """The form's own language is edited on the field itself."""
    form = _logbook()
    form["fields"][0]["label"] = "Ciclo agrícola"

    assert form["translations"]["en"]["fields"]["ciclo_c"]["label"] == "Cycle"


def test_a_translation_never_renames_a_field():
    """The name is the key answers are stored under. A Spanish answer and an
    English one have to land in the same column."""
    form = _edit_translation(_logbook(), "en", "ciclo_c", {"label": "Growing cycle"})

    assert [f["name"] for f in form["fields"]] == ["ciclo_c", "anio_c"]


def test_an_emptied_translation_falls_back_rather_than_showing_blank():
    form = _edit_translation(_logbook(), "en", "anio_c", {"label": "   "})
    shown = translations.translate_form(normalize_form(form), "en")

    assert {f["name"]: f["label"] for f in shown["fields"]}["anio_c"] == "Año"


def test_a_translation_can_be_added_where_there_was_none():
    form = _edit_translation(_logbook(), "en", "ciclo_c", {"help_text": "The growing cycle"})
    shown = translations.translate_form(normalize_form(form), "en")
    field = {f["name"]: f for f in shown["fields"]}["ciclo_c"]

    assert field["help_text"] == "The growing cycle"
    assert field["label"] == "Cycle", "adding help text disturbed the label"


def test_the_edits_survive_normalization_and_a_save(cleanup):
    form = _edit_translation(_logbook(), "en", "ciclo_c", {"label": "Growing cycle"})
    form["title"] = f"Bitacora {uuid.uuid4().hex[:6]}"
    form["table_name"] = f"bitacora_{uuid.uuid4().hex[:8]}"

    created = form_service.create_form(normalize_form(form), created_by="tests")
    cleanup.append(created["form_id"])

    stored = form_service.get_form(created["form_id"])["form_json"]

    assert stored["translations"]["en"]["fields"]["ciclo_c"]["label"] == "Growing cycle"
    assert {f["name"]: f["label"] for f in stored["fields"]}["ciclo_c"] == "Ciclo"


# --- 6. the preview reads the same block ------------------------------------------ #
def test_the_preview_shows_what_was_edited():
    form = normalize_form(
        _edit_translation(_logbook(), "en", "ciclo_c", {"label": "Growing cycle"}))

    spanish = {f["name"]: f["label"] for f in translations.translate_form(form, "es")["fields"]}
    english = {f["name"]: f["label"] for f in translations.translate_form(form, "en")["fields"]}

    assert spanish["ciclo_c"] == "Ciclo"
    assert english["ciclo_c"] == "Growing cycle"


def test_a_section_title_is_translated_too():
    english = translations.translate_form(_logbook(), "en")

    assert english["sections"][0]["title"] == "Logbook"
    assert english["sections"][0]["key"] == "bitacora", "a section key was translated"


# --- 7-9. the standards a search can reach ---------------------------------------- #
@pytest.mark.parametrize("path", [
    "/api/ontology/search?q=irrigation",
    "/api/standards/variables/search?q=plant height",
    "/api/crop-ontology/search?q=plant height",
])
def test_each_standard_has_its_own_search(admin_client, path):
    """The three the selector offers. One search box, three sources — and
    "All standards" is those three asked together, not a fourth endpoint."""
    response = admin_client.get(path)

    assert response.status_code == 200, response.text
    assert isinstance(response.json(), list)


def test_an_icasa_search_returns_only_icasa(admin_client):
    hits = admin_client.get("/api/standards/variables/search?q=plant height").json()
    if not hits:
        pytest.skip("ICASA is not imported in this database")

    assert {h["standard"] for h in hits} == {"ICASA"}
    assert all("external_id" in h for h in hits), "not the ICASA shape"


def test_a_crop_ontology_search_returns_only_crop_ontology(admin_client):
    hits = admin_client.get("/api/crop-ontology/search?q=plant height").json()
    if not hits:
        pytest.skip("no crop ontology is imported in this database")

    assert all(h["variable_id"].startswith("CO_") for h in hits)
    assert all("ontology_id" in h for h in hits), "not the Crop Ontology shape"


# --- 10-12. attaching, and coexistence -------------------------------------------- #
def _attach(field, changes):
    """What the editor does on Add: write that standard's key, touch nothing else."""
    return {**field, **changes}


def test_attaching_icasa_leaves_crop_ontology_alone():
    field = {
        "name": "plant_height", "label": "Plant Height", "type": "decimal",
        "crop_ontology": {"ontology_id": MAIZE, "variable_id": f"{MAIZE}:0000996",
                          "trait_name": "Plant height", "scale_name": "cm"},
    }

    field = _attach(field, {"data_standard": {
        "standard": "ICASA", "variable_id": "935", "variable_code": "PHTD",
        "variable_name": "plant_height", "unit": "m"}})

    assert field["crop_ontology"]["variable_id"] == f"{MAIZE}:0000996"
    assert field["data_standard"]["variable_code"] == "PHTD"


def test_all_three_standards_coexist_on_one_field():
    form = normalize_form({"title": "Maize phenotyping", "fields": [{
        "name": "plant_height", "label": "Plant Height", "type": "decimal",
        "semantic_concept": {"standard": "SEOnt", "uri": "http://x/AGRO_1", "label": "height"},
        "data_standard": {"standard": "ICASA", "variable_id": "935",
                          "variable_code": "PHTD", "variable_name": "plant_height", "unit": "m"},
        "crop_ontology": {"ontology_id": MAIZE, "variable_id": f"{MAIZE}:0000996",
                          "trait_name": "Plant height", "scale_name": "cm"},
    }]})
    field = form["fields"][0]

    assert field["semantic_concept"]["standard"] == "SEOnt"
    assert field["data_standard"]["variable_code"] == "PHTD"
    assert field["crop_ontology"]["standard"] == "CropOntology"
    validate_config(form)


def test_removing_one_standard_leaves_the_others():
    field = {
        "name": "plant_height", "label": "Plant Height", "type": "decimal",
        "semantic_concept": {"standard": "SEOnt", "uri": "http://x/AGRO_1", "label": "height"},
        "data_standard": {"standard": "ICASA", "variable_id": "935", "unit": "m"},
        "crop_ontology": {"ontology_id": MAIZE, "variable_id": f"{MAIZE}:0000996"},
    }

    form = normalize_form({"title": "X", "fields": [_attach(field, {"data_standard": None})]})
    kept = form["fields"][0]

    assert "data_standard" not in kept
    assert kept["semantic_concept"]["uri"] == "http://x/AGRO_1"
    assert kept["crop_ontology"]["variable_id"] == f"{MAIZE}:0000996"


# --- 13. the label is the client's ------------------------------------------------ #
def test_a_standard_never_reaches_the_label():
    form = normalize_form({"title": "Maize phenotyping", "fields": [{
        "name": "plant_height", "label": "Plant Height", "type": "decimal",
        "data_standard": {"standard": "ICASA", "variable_id": "935",
                          "variable_code": "PHTD", "variable_name": "plant_height", "unit": "m"},
        "crop_ontology": {"ontology_id": MAIZE, "variable_id": f"{MAIZE}:0000996"},
    }]})
    field = form["fields"][0]

    assert field["label"] == "Plant Height"
    for token in ("ICASA", "PHTD", "935", MAIZE, "CropOntology"):
        assert token not in field["label"]
        assert token not in field["name"]


def test_a_standard_never_reaches_a_translated_label():
    form = normalize_form({
        "title": "Bitácora", "default_language": "es", "languages": ["es", "en"],
        "fields": [{"name": "altura", "label": "Altura de planta", "type": "decimal",
                    "data_standard": {"standard": "ICASA", "variable_id": "935",
                                      "variable_code": "PHTD", "unit": "m"}}],
        "translations": {"en": {"fields": {"altura": {"label": "Plant height"}}}},
    })

    english = translations.translate_form(form, "en")
    assert english["fields"][0]["label"] == "Plant height"
    assert english["fields"][0]["data_standard"]["variable_code"] == "PHTD"


# --- 14-15. everything the editor must not disturb -------------------------------- #
def test_attaching_a_standard_does_not_change_the_units_it_records():
    """The submission pipeline reads these. Attaching is metadata, not arithmetic."""
    form = normalize_form({"title": "Maize", "fields": [{
        "name": "plant_height", "label": "Plant Height", "type": "decimal",
        "data_standard": {"standard": "ICASA", "variable_id": "935",
                          "variable_code": "PHTD", "unit": "m"},
        "crop_ontology": {"ontology_id": MAIZE, "variable_id": f"{MAIZE}:0000996",
                          "scale_name": "cm"},
    }]})
    field = form["fields"][0]

    assert field["data_standard"]["unit"] == "m"
    assert field["crop_ontology"]["scale_name"] == "cm"


def test_the_conversion_still_happens_on_submission():
    """Unchanged and not the editor's business: 150 cm is stored as 1.5 m."""
    form = normalize_form({"title": "Maize", "fields": [{
        "name": "plant_height", "label": "Plant Height", "type": "decimal",
        "data_standard": {"standard": "ICASA", "variable_id": "935",
                          "variable_code": "PHTD", "unit": "m"},
        "crop_ontology": {"ontology_id": MAIZE, "variable_id": f"{MAIZE}:0000996",
                          "scale_name": "cm"},
    }]})

    from app.modules.standards.units import service
    service.seed_units()

    assert validate_payload(form, {"plant_height": 150}) == {"plant_height": 1.5}


def test_a_catalogue_field_is_untouched_by_a_standard():
    """Two authorities. A standard describes the question; the client's catalogue
    says what may be answered."""
    form = normalize_form({"title": "Registro", "fields": [{
        "name": "estado", "label": "Estado", "type": "select",
        "options_from": {"source": "client_catalog", "catalog": "EstadosMX_list"},
        "source": {"catalog_id": "EstadosMX_list", "catalog_is_client_controlled": True},
        "semantic_concept": {"standard": "SEOnt", "uri": "http://x/AGRO_1", "label": "state"},
    }]})
    field = form["fields"][0]

    assert field["options_from"] == {"source": "client_catalog", "catalog": "EstadosMX_list"}
    assert field["options"] == []
    assert field["semantic_concept"]["uri"] == "http://x/AGRO_1"


def test_a_dynamic_crop_field_is_untouched_by_a_standard():
    form = normalize_form({"title": "Maize", "fields": [{
        "name": "crop", "label": "Crop", "type": "select",
        "options_from": {"source": "crop_ontology", "kind": "crop"},
        "semantic_concept": {"standard": "SEOnt",
                             "uri": "http://purl.obolibrary.org/obo/AGRO_00000325",
                             "label": "crop"},
    }]})
    field = form["fields"][0]

    assert field["options_from"] == {"source": "crop_ontology", "kind": "crop"}
    assert field["semantic_concept"]["uri"].endswith("AGRO_00000325")
