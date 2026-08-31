"""Importing a client "Edit view" workbook as a Standard Form.

Separate from test_excel_import.py, which covers the CIMMYT Controlled
Vocabulary reader. The two readers are independent and both must keep working.

The theme running through all of it: the client's workbook and the client's
catalogs are the authority. The standards describe a field; they never restock
it, retype it or reword it, and nothing here translates anything.
"""
import io
import socket
import uuid

import pytest

from app.core.database import ping, transaction
from app.modules.forms import edit_view_import
from app.modules.forms.config_validation import validate_config
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.submission_service import validate_payload

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

openpyxl = pytest.importorskip("openpyxl", reason="openpyxl is not installed")


# --------------------------------------------------------------------------- #
# Workbooks in the client's own shape, so the tests do not depend on any one
# file being present. Column names and spellings are theirs; content is ours.
# --------------------------------------------------------------------------- #

# The Spanish register: catalogs, a dependent list, and conditional logic
# written across the unnamed columns after LOGIC.
SPANISH_HEADINGS = ["PANEL", "VARIABLE", "FIELD TYPE", "LABEL SPAN", "ETIQUETA ENG",
                    "LOCATION", "REQUIRED", "SIZE/ANOTATION", "CATALOG", "FATHER LIST",
                    "LOGIC", "", "", ""]

SPANISH_ROWS = [
    ["RColbP1", "rcl_tipo_colaborador_c", "select1", "Tipo de colaborador",
     "Type of collaborator", "IZQ", "Yes", "", "Tipo_colaborador_list", "", "", "", "", ""],
    ["", "rcl_nombre_c", "text", "Nombre (s)", "First name(s)", "IZQ", "", "", "", "",
     "SHOW IF", "rcl_tipo_colaborador_c", "IS", "Persona_fisica"],
    ["", "rcl_estado_colaborador_c", "select1", "Estado", "State", "IZQ", "", "",
     "EstadosMX_list", "", "", "", "", ""],
    ["", "rcl_municipio_colaborador_c", "select1 DIN", "Municipio", "Municipality",
     "DER", "", "", "Municipios_mx_list", "rcl_estado_colaborador_c", "", "", "", ""],
]

# The English phenotyping form: choice fields whose list the client did not
# name, and the fields the standards are expected to recognise.
ENGLISH_HEADINGS = ["VARIABLE", "LABEL", "FIELD TYPE", "REQUIRED", "SECTION",
                    "HELP TEXT", "CATALOG"]

ENGLISH_ROWS = [
    ["crop", "Crop", "text", "Yes", "Crop Information", "Name of the crop.", ""],
    ["irrigation_method", "Irrigation Method", "select1", "Yes", "Irrigation",
     "Method used for irrigation.", ""],
    ["soil_texture", "Soil Texture", "select1", "Yes", "Soil Measurements",
     "Texture classification.", ""],
    ["plant_height", "Plant Height", "decimal", "Yes", "Plant Measurements",
     "Height of the plant.", ""],
    ["planting_date", "Planting Date", "date", "Yes", "Crop Information",
     "Date planting occurred.", ""],
    ["farmer_name", "Farmer Name", "text", "Yes", "Farmer Information",
     "Full name of the farmer.", ""],
]

# Every other way the client writes "pick one from a list".
SPELLING_HEADINGS = ["VARIABLE", "LABEL", "FIELD TYPE", "REQUIRED", "CATALOG"]

SPELLING_ROWS = [
    ["a_select1", "Select one", "select1", "", ""],
    ["b_select", "Select", "select", "", ""],
    ["c_dropdown", "Dropdown", "dropdown", "", ""],
    ["d_choice", "Choice", "choice", "", ""],
    ["e_categorical", "Categorical", "categorical", "", ""],
    ["f_code", "Code", "code", "", ""],
    ["g_select_one", "Select one, spelled out", "select_one", "", ""],
    ["h_integer", "Integer", "integer", "", ""],
    ["i_decimal", "Decimal", "decimal", "", ""],
    ["j_date", "Date", "date", "", ""],
    ["k_text", "Text", "text", "", ""],
    ["l_boolean", "Boolean", "boolean", "", ""],
    ["m_memo", "Memo", "memo", "", ""],
]


def _workbook(headings, rows) -> bytes:
    """A .xlsx with a single "Edit view" sheet, the way the client exports it."""
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
def spanish_workbook():
    return _workbook(SPANISH_HEADINGS, SPANISH_ROWS)


@pytest.fixture
def english_workbook():
    return _workbook(ENGLISH_HEADINGS, ENGLISH_ROWS)


@pytest.fixture
def spanish_form(spanish_workbook):
    return normalize_form(
        edit_view_import.read_workbook(spanish_workbook, source="05 Collaborators Register.xlsx")[0])


@pytest.fixture
def english_form(english_workbook):
    return normalize_form(
        edit_view_import.read_workbook(english_workbook, source="Maize Phenotyping Form.xlsx")[0])


@pytest.fixture
def client_catalogs():
    """The client's own catalogs, in the database where they belong.

    Two states and their municipalities, so a dependent list has something real
    to be narrowed by, plus a yes/no/unknown list with the client's own codes.
    """
    suffix = uuid.uuid4().hex[:6]
    states = f"EstadosMX_list_{suffix}"
    towns = f"Municipios_mx_list_{suffix}"
    yes_no = f"Respuesta_list_{suffix}"

    with transaction() as cur:
        for catalog_id, name in ((states, "Estados"), (towns, "Municipios"), (yes_no, "Respuesta")):
            cur.execute(
                "INSERT INTO client_catalog (catalog_id, name) VALUES (%s, %s)",
                (catalog_id, name),
            )

        rows = [
            (states, "MX-JAL", "Jalisco", None, 1, "Approved"),
            (states, "MX-YUC", "Yucatán", None, 2, "Approved"),
            (towns, "GDL", "Guadalajara", "MX-JAL", 1, "Approved"),
            (towns, "ZAP", "Zapopan", "MX-JAL", 2, "Approved"),
            (towns, "MID", "Mérida", "MX-YUC", 1, "Approved"),
            (towns, "OLD", "Municipio retirado", "MX-JAL", 3, "Withdrawn"),
            (yes_no, "Y", "Yes", None, 1, "Approved"),
            (yes_no, "N", "No", None, 2, "Approved"),
            (yes_no, "UNK", "Unknown", None, 3, "Approved"),
        ]
        for row in rows:
            cur.execute(
                """
                INSERT INTO client_catalog_value
                    (catalog_id, code, label, parent_code, display_order, status)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                row,
            )

    yield {"states": states, "towns": towns, "yes_no": yes_no}

    with transaction() as cur:
        cur.execute("DELETE FROM client_catalog WHERE catalog_id IN %s",
                    ((states, towns, yes_no),))


@pytest.fixture
def library_cleanup():
    added = []
    yield added
    with transaction() as cur:
        for standard_id in added:
            cur.execute("DELETE FROM standard_form_library WHERE standard_id = %s",
                        (standard_id,))


@pytest.fixture
def no_network():
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
        yield reached
    finally:
        socket.socket.connect = real


# --- 1. select1 is a dropdown -------------------------------------------------- #
def test_select1_becomes_a_dropdown(english_form):
    """The client's Edit view writes "select1" for pick-one. It is a dropdown,
    not a text box that happens to accept anything typed into it."""
    by_name = {f["name"]: f for f in english_form["fields"]}

    assert by_name["irrigation_method"]["type"] == "select"
    assert by_name["soil_texture"]["type"] == "select"


def test_the_source_type_is_still_recorded(english_form):
    by_name = {f["name"]: f for f in english_form["fields"]}
    assert by_name["irrigation_method"]["source"]["field_type"] == "select1"


@pytest.mark.parametrize("name", [
    "a_select1", "b_select", "c_dropdown", "d_choice",
    "e_categorical", "f_code", "g_select_one",
])
def test_every_spelling_of_pick_one_becomes_a_dropdown(name):
    form = normalize_form(
        edit_view_import.read_workbook(_workbook(SPELLING_HEADINGS, SPELLING_ROWS))[0])
    by_name = {f["name"]: f for f in form["fields"]}

    assert by_name[name]["type"] == "select", f"{name} was not read as a dropdown"


@pytest.mark.parametrize("name,expected", [
    ("h_integer", "number"),
    ("i_decimal", "decimal"),
    ("j_date", "date"),
    ("k_text", "text"),
    ("l_boolean", "boolean"),
    ("m_memo", "textarea"),
])
def test_the_other_types_are_left_alone(name, expected):
    """Only the choice spellings changed. A number is still a number."""
    form = normalize_form(
        edit_view_import.read_workbook(_workbook(SPELLING_HEADINGS, SPELLING_ROWS))[0])
    by_name = {f["name"]: f for f in form["fields"]}

    assert by_name[name]["type"] == expected


def test_a_declared_list_survives_validation(english_form):
    """A dropdown whose catalog has not been imported is still a dropdown, and
    the definition is still saveable — the invariant the whole pipeline rests on."""
    validate_config(english_form)


# --- 2. the client's catalog is the authority ---------------------------------- #
def test_a_catalog_is_named_not_copied(spanish_form):
    by_name = {f["name"]: f for f in spanish_form["fields"]}
    field = by_name["rcl_tipo_colaborador_c"]

    assert field["type"] == "select"
    assert field["options_from"] == {
        "source": "client_catalog",
        "catalog": "Tipo_colaborador_list",
    }
    assert field["options"] == [], "the catalog's values were copied onto the form"


def test_the_catalog_is_marked_as_the_clients(spanish_form):
    by_name = {f["name"]: f for f in spanish_form["fields"]}
    source = by_name["rcl_tipo_colaborador_c"]["source"]

    assert source["catalog_id"] == "Tipo_colaborador_list"
    assert source["catalog_is_client_controlled"] is True


def test_the_values_come_from_the_database(client_catalogs):
    from app.modules.client_catalog import catalog_options

    values = catalog_options.options_for(client_catalogs["yes_no"])

    assert [o["value"] for o in values] == ["Y", "N", "UNK"], \
        "the client's own codes are what a field offers"
    assert [o["label"] for o in values] == ["Yes", "No", "Unknown"]


def test_a_withdrawn_value_is_not_offered(client_catalogs):
    from app.modules.client_catalog import catalog_options

    offered = {o["value"] for o in catalog_options.options_for(
        client_catalogs["towns"], parent_code="MX-JAL")}

    assert "OLD" not in offered
    assert offered == {"GDL", "ZAP"}


def test_a_standard_cannot_restock_a_client_catalog():
    """ICASA describes the field. What may be answered stays the client's."""
    from app.modules.standards.icasa import enrichment

    field = {
        "name": "irrigation_operation",
        "label": "Irrigation Operation",
        "type": "select",
        "options": [],
        "options_from": {"source": "client_catalog", "catalog": "Riego_list"},
        "source": {"catalog_id": "Riego_list", "catalog_is_client_controlled": True},
        "data_standard": {"standard": "ICASA", "variable_id": "302",
                          "variable_name": "irrigation_operation"},
    }

    assert enrichment._apply_standard_options(field) is None
    assert field["options"] == []
    assert field["options_from"]["catalog"] == "Riego_list"


def test_the_dictionary_cannot_retype_a_catalog_field():
    """A data dictionary entry describing "state" as text must not turn a
    catalog-backed dropdown into a text box and strand its catalog."""
    from app.modules.forms import dictionary_service

    form = {
        "title": "Registro",
        "fields": [{
            "name": "rcl_estado_colaborador_c",
            "label": "Estado",
            "type": "select",
            "options": [],
            "options_from": {"source": "client_catalog", "catalog": "EstadosMX_list"},
            "source": {"catalog_id": "EstadosMX_list", "catalog_is_client_controlled": True},
        }],
    }

    result = dictionary_service.apply_to_form(form)
    field = result["form_json"]["fields"][0]

    assert field["type"] == "select"
    assert field["options"] == []
    assert field["options_from"]["catalog"] == "EstadosMX_list"


def test_the_crop_ontology_cannot_replace_a_client_catalog():
    from app.modules.standards.crop_ontology import enrichment as crop_enrichment

    form = {"title": "Maize phenotyping", "fields": [{
        "name": "crop",
        "label": "Crop",
        "type": "select",
        "options": [],
        "options_from": {"source": "client_catalog", "catalog": "Cultivos_list"},
        "source": {"catalog_id": "Cultivos_list", "catalog_is_client_controlled": True},
    }]}

    field = crop_enrichment.apply_dynamic_options(form)["form_json"]["fields"][0]

    assert field["options_from"] == {"source": "client_catalog", "catalog": "Cultivos_list"}


# --- 3. a dependent list ------------------------------------------------------- #
def test_a_father_list_becomes_a_dependency(spanish_form):
    by_name = {f["name"]: f for f in spanish_form["fields"]}
    field = by_name["rcl_municipio_colaborador_c"]

    assert field["options_from"] == {
        "source": "client_catalog",
        "catalog": "Municipios_mx_list",
        "depends_on": "rcl_estado_colaborador_c",
    }
    assert field["source"]["father_list"] == "rcl_estado_colaborador_c"


def test_the_options_are_narrowed_by_the_parent(client_catalogs):
    from app.modules.client_catalog import catalog_options

    jalisco = {o["value"] for o in catalog_options.options_for(
        client_catalogs["towns"], parent_code="MX-JAL")}
    yucatan = {o["value"] for o in catalog_options.options_for(
        client_catalogs["towns"], parent_code="MX-YUC")}

    assert jalisco == {"GDL", "ZAP"}
    assert yucatan == {"MID"}


def _dependent_form(catalogs):
    return normalize_form({
        "title": "Registro",
        "fields": [
            {"name": "estado", "label": "Estado", "type": "select",
             "options_from": {"source": "client_catalog", "catalog": catalogs["states"]},
             "source": {"catalog_id": catalogs["states"], "catalog_is_client_controlled": True}},
            {"name": "municipio", "label": "Municipio", "type": "select",
             "options_from": {"source": "client_catalog", "catalog": catalogs["towns"],
                              "depends_on": "estado"},
             "source": {"catalog_id": catalogs["towns"], "catalog_is_client_controlled": True}},
        ],
    })


def test_a_matching_pair_is_accepted(client_catalogs):
    result = validate_payload(_dependent_form(client_catalogs),
                              {"estado": "MX-JAL", "municipio": "GDL"})

    assert result == {"estado": "MX-JAL", "municipio": "GDL"}


def test_a_municipality_of_another_state_is_refused(client_catalogs):
    """Mérida is a real municipality and MX-JAL is a real state. Together they
    are not an answer."""
    from app.modules.forms.submission_service import ValidationFailed

    with pytest.raises(ValidationFailed) as raised:
        validate_payload(_dependent_form(client_catalogs),
                         {"estado": "MX-JAL", "municipio": "MID"})

    assert "municipio" in raised.value.errors


def test_a_dependent_answer_with_no_parent_is_refused(client_catalogs):
    from app.modules.forms.submission_service import ValidationFailed

    with pytest.raises(ValidationFailed) as raised:
        validate_payload(_dependent_form(client_catalogs), {"municipio": "GDL"})

    assert "municipio" in raised.value.errors


def test_a_withdrawn_code_is_refused(client_catalogs):
    from app.modules.forms.submission_service import ValidationFailed

    with pytest.raises(ValidationFailed):
        validate_payload(_dependent_form(client_catalogs),
                         {"estado": "MX-JAL", "municipio": "OLD"})


def test_the_clients_own_codes_are_what_gets_stored(client_catalogs):
    form = normalize_form({"title": "Registro", "fields": [
        {"name": "usa_tecnologia", "label": "¿Usa la tecnología?", "type": "select",
         "options_from": {"source": "client_catalog", "catalog": client_catalogs["yes_no"]},
         "source": {"catalog_id": client_catalogs["yes_no"],
                    "catalog_is_client_controlled": True}},
    ]})

    assert validate_payload(form, {"usa_tecnologia": "UNK"}) == {"usa_tecnologia": "UNK"}


# --- 4. and 5. language, wording and conditional logic ------------------------- #
def test_a_spanish_workbook_imports_as_a_spanish_form(spanish_form):
    """The workbook decides. English is not the default just because it is ours."""
    assert spanish_form["default_language"] == "es"


def test_the_spanish_wording_is_kept_exactly(spanish_form):
    by_name = {f["name"]: f for f in spanish_form["fields"]}

    assert by_name["rcl_tipo_colaborador_c"]["label"] == "Tipo de colaborador"
    assert by_name["rcl_nombre_c"]["label"] == "Nombre (s)"


def test_the_clients_english_labels_are_carried_as_a_translation(spanish_form):
    """They wrote them. They are kept beside the Spanish, not in place of it,
    and nothing here produced them."""
    assert spanish_form["languages"] == ["es", "en"]

    english = spanish_form["translations"]["en"]["fields"]
    assert english["rcl_tipo_colaborador_c"]["label"] == "Type of collaborator"


def test_an_english_workbook_stays_english(english_form):
    assert english_form["default_language"] == "en"
    assert english_form["translations"] == {}, "a translation was invented"


def test_the_language_survives_a_round_trip(spanish_form):
    assert normalize_form(spanish_form)["default_language"] == "es"


def test_the_condition_is_kept_whole(spanish_form):
    """The condition runs across the unnamed columns after LOGIC. Keeping only
    "SHOW IF" would keep the useless half."""
    by_name = {f["name"]: f for f in spanish_form["fields"]}

    assert by_name["rcl_nombre_c"]["source"]["skip_logic"] == \
        "SHOW IF rcl_tipo_colaborador_c IS Persona_fisica"


def test_the_help_text_is_the_clients(english_form):
    by_name = {f["name"]: f for f in english_form["fields"]}
    assert by_name["plant_height"]["help_text"] == "Height of the plant."


def test_nothing_reaches_the_network_while_importing(english_workbook, no_network):
    normalize_form(edit_view_import.read_workbook(english_workbook, source="maize.xlsx")[0])
    assert no_network == []


# --- 6. the standards still attach, and stay independent ----------------------- #
def test_icasa_and_crop_ontology_can_both_sit_on_plant_height(english_workbook, admin_client):
    """Task's own example: plant_height carries the ICASA variable and the
    Crop Ontology variable at once, each with its own unit. Skipped where the
    standards have not been imported into this database."""
    draft = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("maize.xlsx", english_workbook, "application/vnd.ms-excel")},
    ).json()["forms"][0]["form_json"]

    field = {f["name"]: f for f in draft["fields"]}["plant_height"]

    if not field.get("data_standard") and not field.get("crop_ontology"):
        pytest.skip("no standards are imported in this database")

    if field.get("data_standard"):
        assert field["data_standard"]["standard"] == "ICASA"
    if field.get("crop_ontology"):
        assert field["crop_ontology"]["ontology_id"].startswith("CO_")
        # Independent of ICASA's: each standard keeps its own unit.
        assert field["crop_ontology"]["variable_id"].startswith(
            field["crop_ontology"]["ontology_id"])


def test_the_crop_question_is_answered_from_the_imported_ontologies(
        english_workbook, admin_client):
    """An import goes through the same dynamic-options pass a generated draft
    does. The workbook writes "crop" as free text; the question is which crop,
    and the answer to that is whichever ontologies are imported here."""
    draft = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("maize.xlsx", english_workbook, "application/vnd.ms-excel")},
    ).json()["forms"][0]["form_json"]

    field = {f["name"]: f for f in draft["fields"]}["crop"]

    assert field["type"] == "select", "the crop question came out as free text"
    assert field["options_from"] == {"source": "crop_ontology", "kind": "crop"}
    assert field["options"] == [], "crop names were written onto the form"
    assert field["required"] is True


def test_the_crop_question_keeps_its_seont_concept(english_workbook, admin_client):
    """The two are independent: SEOnt says what the field means, the ontology
    says what may be answered."""
    draft = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("maize.xlsx", english_workbook, "application/vnd.ms-excel")},
    ).json()["forms"][0]["form_json"]

    field = {f["name"]: f for f in draft["fields"]}["crop"]

    if not field.get("semantic_concept"):
        pytest.skip("SEOnt is not imported in this database")

    assert field["semantic_concept"]["uri"].endswith("AGRO_00000325")


def test_the_crop_choices_come_from_the_database(admin_client):
    """Read at render time from the local ontologies. Maize is offered because
    CO_322 was imported, not because anything here knows the word."""
    from app.modules.standards.crop_ontology import dynamic_options

    options = dynamic_options.options_for("crop")
    if not options:
        pytest.skip("no crop ontologies are imported in this database")

    assert all(o["value"].startswith("CO_") for o in options)

    served = admin_client.get("/api/crop-ontology/options?kind=crop").json()
    assert served == options, "the renderer is served something other than the database"


def test_the_other_fields_are_not_rewired(english_workbook, admin_client):
    """Only the crop question. A name, a date and a measurement are ordinary
    fields however the workbook happens to word them."""
    draft = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("maize.xlsx", english_workbook, "application/vnd.ms-excel")},
    ).json()["forms"][0]["form_json"]

    by_name = {f["name"]: f for f in draft["fields"]}

    for name in ("farmer_name", "planting_date", "plant_height", "soil_texture"):
        assert "options_from" not in by_name[name], f"{name} was wrongly rewired"


def test_a_field_that_merely_mentions_a_crop_is_left_alone(admin_client):
    """`crop_area` and `crop_variety` keep a second meaningful word, so they ask
    something else and are ordinary fields."""
    rows = [
        ["crop_area", "Crop Area", "decimal", "", "", "", ""],
        ["crop_variety", "Crop Variety", "text", "", "", "", ""],
        ["crop_residue_weight", "Crop Residue Weight", "decimal", "", "", "", ""],
    ]
    workbook = _workbook(ENGLISH_HEADINGS, rows)

    draft = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("other.xlsx", workbook, "application/vnd.ms-excel")},
    ).json()["forms"][0]["form_json"]

    for field in draft["fields"]:
        assert "options_from" not in field, f"{field['name']} was wrongly rewired"


def test_a_client_catalog_is_never_rewired_to_the_ontology(admin_client):
    """A crop question the client answers from their own catalog keeps that
    catalog. The workbook is the authority on its permitted values."""
    rows = [["crop", "Cultivo", "select1", "Yes", "", "", "Cultivos_list"]]
    workbook = _workbook(ENGLISH_HEADINGS, rows)

    draft = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("catalog.xlsx", workbook, "application/vnd.ms-excel")},
    ).json()["forms"][0]["form_json"]

    field = draft["fields"][0]

    assert field["options_from"] == {"source": "client_catalog", "catalog": "Cultivos_list"}


# --- 7. through the API: import, test, save, reopen ---------------------------- #
def test_the_edit_view_reader_is_chosen_for_an_edit_view_workbook(admin_client, spanish_workbook):
    response = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("registro.xlsx", spanish_workbook, "application/vnd.ms-excel")},
    )
    assert response.status_code == 200

    draft = response.json()["forms"][0]
    assert draft["form_json"]["import_source"]["kind"] == "edit_view_workbook"


def test_importing_saves_nothing(admin_client, spanish_workbook):
    before = {e["standard_id"] for e in admin_client.get("/api/standard-forms").json()["forms"]}

    admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("registro.xlsx", spanish_workbook, "application/vnd.ms-excel")},
    )

    after = {e["standard_id"] for e in admin_client.get("/api/standard-forms").json()["forms"]}
    assert after == before


def test_import_test_save_and_reopen(admin_client, spanish_workbook, library_cleanup):
    """The whole flow, end to end."""
    draft = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("registro.xlsx", spanish_workbook, "application/vnd.ms-excel")},
    ).json()["forms"][0]["form_json"]

    # tested first, and testing writes nothing
    tested = admin_client.post("/api/forms/test-definition",
                               json={"form_json": draft, "data": {}})
    assert tested.status_code == 200

    draft["title"] = f"Registro de Colaboradores {uuid.uuid4().hex[:6]}"

    saved = admin_client.post("/api/standard-forms/import/save", json={
        "form_json": draft, "category": "Imported", "source": "registro.xlsx",
    })
    assert saved.status_code == 201
    entry = saved.json()
    library_cleanup.append(entry["standard_id"])

    listed = {e["standard_id"] for e in admin_client.get("/api/standard-forms").json()["forms"]}
    assert entry["standard_id"] in listed

    form = admin_client.get(f"/api/standard-forms/{entry['standard_id']}").json()["form_json"]
    by_name = {f["name"]: f for f in form["fields"]}

    # language and wording
    assert form["default_language"] == "es"
    assert form["translations"]["en"]["fields"]["rcl_tipo_colaborador_c"]["label"] == \
        "Type of collaborator"
    assert by_name["rcl_tipo_colaborador_c"]["label"] == "Tipo de colaborador"

    # order, sections and requirement
    assert [f["name"] for f in form["fields"]] == [r[1] for r in SPANISH_ROWS]
    assert by_name["rcl_tipo_colaborador_c"]["required"] is True
    assert form["sections"], "the panels were lost"

    # catalogs and their dependency
    assert by_name["rcl_tipo_colaborador_c"]["options_from"]["catalog"] == "Tipo_colaborador_list"
    assert by_name["rcl_municipio_colaborador_c"]["options_from"]["depends_on"] == \
        "rcl_estado_colaborador_c"
    assert by_name["rcl_tipo_colaborador_c"]["source"]["catalog_is_client_controlled"] is True

    # provenance and conditional logic
    assert form["import_source"]["file"] == "registro.xlsx"
    assert form["import_source"]["imported_on"]
    assert by_name["rcl_nombre_c"]["source"]["skip_logic"] == \
        "SHOW IF rcl_tipo_colaborador_c IS Persona_fisica"


def test_a_saved_form_keeps_its_dynamic_crop_source(
        admin_client, english_workbook, library_cleanup):
    """Saving and reopening must not quietly turn the crop question back into
    free text — `options_from` has to survive validation and storage."""
    draft = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("maize.xlsx", english_workbook, "application/vnd.ms-excel")},
    ).json()["forms"][0]["form_json"]
    draft["title"] = f"Maize Phenotyping {uuid.uuid4().hex[:6]}"

    entry = admin_client.post("/api/standard-forms/import/save", json={
        "form_json": draft, "source": "maize.xlsx",
    }).json()
    library_cleanup.append(entry["standard_id"])

    form = admin_client.get(f"/api/standard-forms/{entry['standard_id']}").json()["form_json"]
    field = {f["name"]: f for f in form["fields"]}["crop"]

    assert field["type"] == "select"
    assert field["options_from"] == {"source": "crop_ontology", "kind": "crop"}
    assert field["options"] == []


# --- 8. everything that already worked ----------------------------------------- #
def test_an_ordinary_static_dropdown_is_untouched():
    """A dropdown that carries its own choices is the common case and none of
    this applies to it."""
    form = normalize_form({"title": "Farmer Registration", "fields": [
        {"label": "Crop", "type": "select", "options": ["Wheat", "Rice"]},
    ]})
    field = form["fields"][0]

    assert field["type"] == "select"
    assert [o["value"] for o in field["options"]] == ["Wheat", "Rice"]
    assert "options_from" not in field
    assert "source" not in field


def test_a_dropdown_with_no_choices_still_degrades_to_text():
    """Unchanged for anything but an import: a hand-built dropdown with nothing
    on it is a mistake, and shipping a dead control would hide it."""
    form = normalize_form({"title": "X", "fields": [
        {"label": "Crop", "type": "select", "options": []},
    ]})

    assert form["fields"][0]["type"] == "text"


def test_the_cimmyt_reader_is_still_used_for_a_cimmyt_workbook(admin_client):
    """The two readers are independent. A CIMMYT workbook has no VARIABLE/FIELD
    TYPE sheet, so it must not be handed to the Edit View reader."""
    from tests.modules.forms.test_excel_import import _workbook as cimmyt_workbook

    response = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("registro.xlsx", cimmyt_workbook(), "application/vnd.ms-excel")},
    )
    assert response.status_code == 200

    draft = response.json()["forms"][0]["form_json"]
    assert draft["import_source"]["kind"] != "edit_view_workbook"
    assert draft["default_language"] == "es"
