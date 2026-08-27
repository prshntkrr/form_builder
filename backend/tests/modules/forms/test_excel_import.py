"""Importing a client workbook as a Standard Form."""
import io
import socket
import uuid

import pytest

from app.core.database import ping, transaction
from app.modules.forms import excel_import
from app.modules.forms.config_validation import validate_config
from app.modules.forms.form_schema import normalize_form

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

openpyxl = pytest.importorskip("openpyxl", reason="openpyxl is not installed")


# --------------------------------------------------------------------------- #
# A workbook built to the client's own shape, so the tests do not depend on any
# one file being present. The sheet names, the header row and the column names
# are the template's; the content is ours.
# --------------------------------------------------------------------------- #
SHEETS = {
    "03_Variables": (
        ["Variable ID", "Concept ID", "Preferred Variable Name", "Operational Definition",
         "Data Type", "Unit ID", "Catalog ID", "Status"],
        [
            ["VAR-001", "CON-001", "Superficie de parcela", "Área medida de la parcela",
             "Decimal", "UNIT-HA", "", "Approved"],
            ["VAR-002", "CON-002", "Variedad sembrada", "Variedad usada en la parcela",
             "Code", "", "CAT-VARIEDAD", "Approved"],
            ["VAR-003", "CON-003", "Municipio", "Municipio de la parcela",
             "Code", "", "CAT-MUNICIPIO", "Approved"],
        ],
    ),
    "04_Value_Catalogs": (
        ["Catalog ID", "Catalog Name", "Definition"],
        [["CAT-VARIEDAD", "Variedades aprobadas", "Lista del cliente"],
         ["CAT-MUNICIPIO", "Municipios", "Lista jerárquica"]],
    ),
    "05_Catalog_Values": (
        ["Catalog ID", "Code", "Preferred Label EN", "Parent Code", "Display Order", "Status"],
        [
            ["CAT-VARIEDAD", "V-01", "Criollo", "", "2", "Approved"],
            ["CAT-VARIEDAD", "V-02", "Híbrido", "", "1", "Approved"],
            ["CAT-VARIEDAD", "V-99", "Retirada", "", "3", "Deprecated"],
            ["CAT-MUNICIPIO", "MX-JAL", "Jalisco", "", "1", "Approved"],
            ["CAT-MUNICIPIO", "MX-JAL-GDL", "Guadalajara", "MX-JAL", "2", "Approved"],
        ],
    ),
    "06_Units": (["Unit ID", "Symbol", "Preferred Name"], [["UNIT-HA", "ha", "hectare"]]),
    "11_Question_Items": (
        ["Question ID", "Variable ID", "Language Tag", "Question Text",
         "Response Catalog ID", "Skip Logic Ref.", "Instructions / Enumerator Note"],
        [
            ["QST-001", "VAR-001", "es", "¿Cuál es la superficie de la parcela?", "", "", ""],
            ["QST-002", "VAR-002", "es", "¿Qué variedad sembró?", "CAT-VARIEDAD",
             "IF VAR-001 > 0", "Elija de la lista aprobada"],
            ["QST-003", "VAR-003", "es", "¿En qué municipio está la parcela?",
             "CAT-MUNICIPIO", "", ""],
        ],
    ),
    "10_Multilingual_Labels": (
        ["Label ID", "Target Type", "Target ID", "Language Tag", "Label", "Label Role"],
        [["LAB-001", "Variable", "VAR-001", "en", "Plot area", "preferred"]],
    ),
    "14_Profiles": (
        ["Profile ID", "Profile Name", "Profile Version", "Use Case / Scope",
         "Variable ID", "Requirement Level", "Display Order"],
        [
            ["PROF-ES-01", "Registro de Parcela", "1.0", "Levantamiento en campo",
             "VAR-002", "Required", "2"],
            ["PROF-ES-01", "Registro de Parcela", "1.0", "Levantamiento en campo",
             "VAR-001", "Required", "1"],
            ["PROF-ES-01", "Registro de Parcela", "1.0", "Levantamiento en campo",
             "VAR-003", "Recommended", "3"],
        ],
    ),
}


def _workbook(sheets=None) -> bytes:
    """A .xlsx laid out the way the client's template is: title, blurb, header."""
    book = openpyxl.Workbook()
    book.remove(book.active)

    for name, (headings, rows) in (sheets or SHEETS).items():
        sheet = book.create_sheet(name)
        sheet.append([name.replace("_", " ")])       # the sheet's title row
        sheet.append(["What this sheet is for."])    # its description
        sheet.append([])                             # a blank row
        sheet.append(headings)
        for row in rows:
            sheet.append(row)

    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


@pytest.fixture
def workbook():
    return _workbook()


@pytest.fixture
def imported(workbook):
    return excel_import.import_workbook(workbook, source="registro.xlsx")


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


@pytest.fixture
def library_cleanup():
    """Remove whatever a test put in the library."""
    added = []
    yield added
    with transaction() as cur:
        for standard_id in added:
            cur.execute("DELETE FROM standard_form_library WHERE standard_id = %s",
                        (standard_id,))


# --- reading the file -------------------------------------------------------- #
def test_a_workbook_is_read(workbook):
    sheets = excel_import.read_workbook(workbook)
    assert sheets["03_Variables"], "no variables were read"
    assert sheets["05_Catalog_Values"], "no catalog values were read"


def test_the_header_is_found_below_the_title_rows(workbook):
    """Each sheet opens with a title and a description before the real header."""
    rows = excel_import.read_workbook(workbook)["03_Variables"]
    assert rows[0]["Variable ID"] == "VAR-001", "the title row was mistaken for a header"


def test_a_file_that_is_not_a_workbook_is_refused():
    with pytest.raises(excel_import.WorkbookProblem):
        excel_import.read_workbook(b"this is not a spreadsheet")


def test_a_workbook_with_no_variables_is_refused():
    empty = _workbook({"03_Variables": (["Variable ID"], [])})
    with pytest.raises(excel_import.WorkbookProblem) as caught:
        excel_import.read_workbook(empty)
    assert "03_Variables" in str(caught.value)


# --- what a profile becomes --------------------------------------------------- #
def test_a_profile_becomes_a_form(imported):
    assert len(imported) == 1
    form = imported[0]
    assert form["title"] == "Registro de Parcela"
    assert form["import_source"]["profile_id"] == "PROF-ES-01"
    assert form["import_source"]["file"] == "registro.xlsx"


def test_fields_follow_the_display_order(imported):
    names = [f["name"] for f in imported[0]["fields"]]
    assert names == ["superficie_de_parcela", "variedad_sembrada", "municipio"]


def test_the_requirement_level_becomes_required(imported):
    by_name = {f["name"]: f for f in imported[0]["fields"]}
    assert by_name["superficie_de_parcela"]["required"] is True
    assert by_name["municipio"]["required"] is False, "Recommended is not Required"


def test_the_data_type_comes_from_the_workbook(imported):
    by_name = {f["name"]: f for f in imported[0]["fields"]}
    assert by_name["superficie_de_parcela"]["type"] == "decimal"
    assert by_name["variedad_sembrada"]["type"] == "select", "a coded variable is a choice"


def test_the_unit_and_variable_id_are_kept(imported):
    source = imported[0]["fields"][0]["source"]
    assert source["variable_id"] == "VAR-001"
    assert source["unit_id"] == "UNIT-HA"
    assert source["unit"] == "ha"


# --- language ----------------------------------------------------------------- #
def test_the_workbook_language_is_preserved(imported):
    """A Spanish workbook makes a Spanish form. Nothing here translates."""
    form = imported[0]
    assert form["default_language"] == "es"

    labels = [f["label"] for f in form["fields"]]
    assert "¿Cuál es la superficie de la parcela?" in labels
    assert all(not label.startswith("What") for label in labels)


def test_the_question_wording_is_used_exactly(imported):
    by_name = {f["name"]: f for f in imported[0]["fields"]}
    assert by_name["variedad_sembrada"]["label"] == "¿Qué variedad sembró?"


def test_an_existing_translation_is_carried_not_regenerated(imported):
    """The client wrote an English label for one variable. It is kept as theirs,
    and no other language is invented alongside it."""
    translations = imported[0]["translations"]
    assert set(translations) == {"en"}
    assert translations["en"]["fields"]["superficie_de_parcela"]["label"] == "Plot area"


def test_the_language_survives_normalization(imported):
    form = normalize_form(imported[0])
    assert form["default_language"] == "es"
    assert "en" in form["languages"]
    assert form["translations"]["en"]["fields"]["superficie_de_parcela"]["label"] == "Plot area"
    validate_config(form)


# --- the client's controlled lists -------------------------------------------- #
def test_catalog_values_are_the_clients(imported):
    by_name = {f["name"]: f for f in imported[0]["fields"]}
    options = by_name["variedad_sembrada"]["options"]

    assert [o["value"] for o in options] == ["V-02", "V-01"], "display order was not honoured"
    assert [o["label"] for o in options] == ["Híbrido", "Criollo"]


def test_a_withdrawn_code_is_not_offered(imported):
    options = {o["value"] for o in imported[0]["fields"][1]["options"]}
    assert "V-99" not in options, "a deprecated code was offered"


def test_a_parent_list_keeps_its_parent_codes(imported):
    """`Parent Code` is how the client nests one list under another."""
    by_name = {f["name"]: f for f in imported[0]["fields"]}
    options = {o["value"]: o for o in by_name["municipio"]["options"]}

    assert options["MX-JAL-GDL"]["parent_code"] == "MX-JAL"
    assert "parent_code" not in options["MX-JAL"], "a top-level code has no parent"


def test_the_catalog_is_marked_as_the_clients(imported):
    source = imported[0]["fields"][1]["source"]
    assert source["catalog_id"] == "CAT-VARIEDAD"
    assert source["catalog_name"] == "Variedades aprobadas"
    assert source["catalog_is_client_controlled"] is True


def test_the_conditional_logic_is_kept_as_written(imported):
    """Recorded, not interpreted — re-expressing the client's rule would be
    inventing a meaning this reader cannot verify."""
    source = imported[0]["fields"][1]["source"]
    assert source["skip_logic"] == "IF VAR-001 > 0"


def test_client_options_survive_normalization(imported):
    form = normalize_form(imported[0])
    options = {f["name"]: f["options"] for f in form["fields"]}
    assert [o["value"] for o in options["variedad_sembrada"]] == ["V-02", "V-01"]
    assert options["municipio"][1]["parent_code"] == "MX-JAL"


# --- the standards add, they do not replace ------------------------------------ #
def test_a_client_catalog_is_never_replaced_by_a_standard(imported):
    """The workbook is the authority on its own permitted values."""
    from app.modules.crop_ontology import enrichment as crop

    form = normalize_form(imported[0])
    # Name a field so the crop rewiring would take it if it were allowed to.
    form["fields"][1]["name"] = "crop"
    form["fields"][1]["label"] = "Crop"

    result = crop.apply_dynamic_options(form)
    field = result["form_json"]["fields"][1]

    assert "options_from" not in field, "a client catalog was replaced by the ontology"
    assert [o["value"] for o in field["options"]] == ["V-02", "V-01"]


def test_the_dictionary_leaves_a_client_catalog_alone(imported):
    from app.modules.forms import dictionary_service

    form = normalize_form(imported[0])
    before = [o["value"] for o in form["fields"][1]["options"]]
    after = dictionary_service.apply_to_form(form)["form_json"]["fields"][1]

    assert [o["value"] for o in after["options"]] == before


def test_nothing_reaches_the_network_while_importing(workbook, no_network):
    """Every standard is read from the local database."""
    forms = excel_import.import_workbook(workbook, source="registro.xlsx")
    normalize_form(forms[0])
    assert no_network == []


# --- through the API ----------------------------------------------------------- #
def test_upload_returns_drafts_and_saves_nothing(admin_client, workbook):
    before = admin_client.get("/api/standard-forms").json()["forms"]

    response = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("registro.xlsx", workbook,
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert response.status_code == 200
    body = response.json()

    assert body["source"] == "registro.xlsx"
    assert len(body["forms"]) == 1
    assert body["forms"][0]["form_json"]["default_language"] == "es"

    after = admin_client.get("/api/standard-forms").json()["forms"]
    assert len(after) == len(before), "the import created a library entry on its own"


def test_a_file_that_is_not_xlsx_is_refused(admin_client):
    response = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert response.status_code == 400


def test_an_imported_draft_can_be_tested_without_saving(admin_client, workbook):
    draft = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("registro.xlsx", workbook, "application/vnd.ms-excel")},
    ).json()["forms"][0]["form_json"]

    refused = admin_client.post("/api/forms/test-definition",
                                json={"form_json": draft, "data": {}}).json()
    assert refused["valid"] is False, "a required answer was missing"

    accepted = admin_client.post("/api/forms/test-definition", json={
        "form_json": draft,
        "data": {"superficie_de_parcela": 2.5, "variedad_sembrada": "V-01"},
    }).json()
    assert accepted["valid"] is True
    assert accepted["form_data"]["variedad_sembrada"] == "V-01", \
        "the client's own code is what gets stored"


def test_a_test_answer_is_never_stored(admin_client, workbook):
    """There is no form and no table behind a draft, so a test cannot write."""
    draft = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("registro.xlsx", workbook, "application/vnd.ms-excel")},
    ).json()["forms"][0]["form_json"]

    admin_client.post("/api/forms/test-definition", json={
        "form_json": draft, "data": {"superficie_de_parcela": 2.5, "variedad_sembrada": "V-01"},
    })

    with transaction() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM forms WHERE form_title = %s",
                    ("Registro de Parcela",))
        assert int(cur.fetchone()["n"]) == 0, "testing created a form"


def test_cancelling_leaves_the_library_untouched(admin_client, workbook):
    """Uploading and walking away is the whole of cancelling — there is nothing
    to undo, because nothing was written."""
    before = {e["standard_id"] for e in admin_client.get("/api/standard-forms").json()["forms"]}

    admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("registro.xlsx", workbook, "application/vnd.ms-excel")},
    )

    after = {e["standard_id"] for e in admin_client.get("/api/standard-forms").json()["forms"]}
    assert after == before


def test_saving_creates_the_library_entry(admin_client, workbook, library_cleanup):
    draft = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("registro.xlsx", workbook, "application/vnd.ms-excel")},
    ).json()["forms"][0]["form_json"]

    title = f"Registro de Parcela {uuid.uuid4().hex[:6]}"
    draft["title"] = title

    saved = admin_client.post("/api/standard-forms/import/save", json={
        "form_json": draft, "category": "Imported", "source": "registro.xlsx",
    })
    assert saved.status_code == 201
    entry = saved.json()
    library_cleanup.append(entry["standard_id"])

    listed = {e["standard_id"] for e in admin_client.get("/api/standard-forms").json()["forms"]}
    assert entry["standard_id"] in listed


def test_reopening_a_saved_import_keeps_everything(admin_client, workbook, library_cleanup):
    draft = admin_client.post(
        "/api/standard-forms/import",
        files={"file": ("registro.xlsx", workbook, "application/vnd.ms-excel")},
    ).json()["forms"][0]["form_json"]
    draft["title"] = f"Registro {uuid.uuid4().hex[:6]}"

    entry = admin_client.post("/api/standard-forms/import/save", json={
        "form_json": draft, "source": "registro.xlsx",
    }).json()
    library_cleanup.append(entry["standard_id"])

    reopened = admin_client.get(f"/api/standard-forms/{entry['standard_id']}").json()
    form = reopened["form_json"]

    assert form["default_language"] == "es", "the language changed on the way back"
    assert form["translations"]["en"]["fields"]["superficie_de_parcela"]["label"] == "Plot area"
    by_name = {f["name"]: f for f in form["fields"]}
    assert [o["value"] for o in by_name["variedad_sembrada"]["options"]] == ["V-02", "V-01"]
    assert by_name["variedad_sembrada"]["source"]["catalog_id"] == "CAT-VARIEDAD"
    assert by_name["variedad_sembrada"]["source"]["skip_logic"] == "IF VAR-001 > 0"
    assert form["import_source"]["file"] == "registro.xlsx"
    assert form["import_source"]["imported_on"], "when it was imported was not recorded"


# --- everything that was already working ---------------------------------------- #
def test_a_hand_built_form_is_unaffected():
    """An ordinary form carries none of the import's keys."""
    form = normalize_form({"title": "Farmer Registration", "fields": [
        {"label": "Farmer Name", "type": "text", "required": True},
        {"label": "Crop", "type": "select", "options": ["Wheat", "Rice"]},
    ]})

    assert form["default_language"] == "en"
    assert "import_source" not in form
    for field in form["fields"]:
        assert "source" not in field
    assert [o["label"] for o in form["fields"][1]["options"]] == ["Wheat", "Rice"]
    validate_config(form)
