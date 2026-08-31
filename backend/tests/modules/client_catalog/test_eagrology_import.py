"""Importing the client's own catalogue workbook — the "Catalogs" sheet.

Two workbook shapes, two readers, one set of tables. The CIMMYT Controlled
Vocabulary reader keeps its own sheets and its own requirements; this one reads
the client's list-per-row sheet and never sees them.

One row per value, not one per language: `Si` is one code with a Spanish label
and an English one. Splitting it would make the same answer two answers.
"""
import io
import uuid
from pathlib import Path

import pytest

from app.core.database import ping, transaction
from app.modules.client_catalog import (
    catalog_options,
    catalog_service,
    eagrology_import,
)

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

openpyxl = pytest.importorskip("openpyxl", reason="openpyxl is not installed")

# The client's real workbook, when it is on this machine. The tests below stand
# on their own without it; this only adds the regression against the file.
REAL_WORKBOOK = Path.home() / "Downloads" / "Catalogos e-Agrology Translation.xlsx"

HEADINGS = ["List", "Variable", "Label Spanish", "Label ENG"]

ROWS = [
    # A row naming the list with no value beside it — the group heading the
    # client's sheet puts above each catalogue.
    ["SiNo_list", "", "", ""],
    ["SiNo_list", "Si", "Si", "Yes"],
    ["SiNo_list", "No", "No", "No"],
    ["Escolaridad_list", "", "", ""],
    ["Escolaridad_list", "Sin_estudios ", "Sin estudios", "Without studies"],
    ["Escolaridad_list", "Primaria ", "Primaria", "Primary/Elementary school"],
    ["Escolaridad_list", "Secundaria", "Secundaria", "Secondary school"],
    # No English was supplied for this one, and none is invented.
    ["Escolaridad_list", "Otro", "Otro", ""],
]


def _workbook(headings=HEADINGS, rows=ROWS, sheet="Catalogs") -> bytes:
    book = openpyxl.Workbook()
    book.remove(book.active)
    ws = book.create_sheet(sheet)
    ws.append(headings)
    for row in rows:
        ws.append(row)

    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def _cimmyt_workbook(catalog_id: str) -> bytes:
    """The other shape, so the routing can be shown to still work."""
    book = openpyxl.Workbook()
    book.remove(book.active)

    sheets = {
        "04_Value_Catalogs": (["Catalog ID", "Catalog Name", "Definition"],
                              [[catalog_id, "Imported states", "From the workbook"]]),
        "05_Catalog_Values": (["Catalog ID", "Code", "Preferred Label EN", "Parent Code",
                               "Display Order", "Status"],
                              [[catalog_id, "MX-JAL", "Jalisco", "", "1", "Approved"],
                               [catalog_id, "MX-JAL-GDL", "Guadalajara", "MX-JAL", "2",
                                "Approved"]]),
    }
    for name, (headings, rows) in sheets.items():
        ws = book.create_sheet(name)
        ws.append([name.replace("_", " ")])
        ws.append(["What this sheet is for."])
        ws.append([])
        ws.append(headings)
        for row in rows:
            ws.append(row)

    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


@pytest.fixture
def catalogues():
    """Removes whatever a test imported, however the test ends."""
    made = []
    yield made
    with transaction() as cur:
        for catalog_id in reversed(made):
            cur.execute("DELETE FROM client_catalog WHERE catalog_id = %s", (catalog_id,))


@pytest.fixture
def suffix():
    return uuid.uuid4().hex[:6].upper()


@pytest.fixture
def imported(catalogues, suffix):
    """The sample workbook, with ids of its own so tests do not collide."""
    rows = [[f"{r[0]}_{suffix}", r[1], r[2], r[3]] for r in ROWS]
    catalogues.extend([f"SiNo_list_{suffix}", f"Escolaridad_list_{suffix}"])

    result = eagrology_import.import_workbook(_workbook(rows=rows), source="Catalogos.xlsx")
    return {"result": result, "yes_no": catalogues[0], "school": catalogues[1]}


# --- 1-3. which reader a workbook gets ------------------------------------------- #
def test_the_catalogs_sheet_is_recognised():
    assert eagrology_import.is_eagrology_workbook(_workbook()) is True


def test_a_cimmyt_workbook_is_not_taken_by_this_reader():
    """So it goes on to the reader that knows its sheets."""
    assert eagrology_import.is_eagrology_workbook(_cimmyt_workbook("CAT-X")) is False


def test_the_cimmyt_sheets_are_not_required(admin_client, catalogues, suffix):
    """The bug this fixes: the client's workbook was being told it was missing
    04_Value_Catalogs and 05_Catalog_Values, which it was never meant to have."""
    rows = [[f"{r[0]}_{suffix}", r[1], r[2], r[3]] for r in ROWS]
    catalogues.extend([f"SiNo_list_{suffix}", f"Escolaridad_list_{suffix}"])

    response = admin_client.post(
        "/api/client-catalogs/import",
        files={"file": ("Catalogos.xlsx", _workbook(rows=rows), "application/vnd.ms-excel")},
    )

    assert response.status_code == 200
    body = response.json()

    assert "04_Value_Catalogs" not in str(body)
    assert body["format"] == "eagrology"


def test_a_cimmyt_workbook_still_routes_to_its_own_reader(admin_client, catalogues, suffix):
    catalog_id = f"CAT-CIMMYT-{suffix}"
    catalogues.append(catalog_id)

    response = admin_client.post(
        "/api/client-catalogs/import",
        files={"file": ("cimmyt.xlsx", _cimmyt_workbook(catalog_id),
                        "application/vnd.ms-excel")},
    )

    assert response.status_code == 200
    assert response.json().get("format") != "eagrology"

    values = {v["code"]: v for v in catalog_service.get(catalog_id)["values"]}
    assert values["MX-JAL-GDL"]["parent_code"] == "MX-JAL", "the CIMMYT reader lost a parent"


def test_a_workbook_with_neither_shape_is_reported(admin_client):
    other = _workbook(headings=["A", "B"], rows=[["1", "2"]], sheet="Sheet1")

    response = admin_client.post(
        "/api/client-catalogs/import",
        files={"file": ("other.xlsx", other, "application/vnd.ms-excel")},
    )

    assert response.status_code == 422


def test_a_catalogs_sheet_with_no_label_column_is_refused():
    workbook = _workbook(headings=["List", "Variable"], rows=[["A_list", "A"]])

    assert eagrology_import.is_eagrology_workbook(workbook) is False


# --- 4-7. what it produces -------------------------------------------------------- #
def test_each_list_becomes_a_catalogue(imported):
    assert imported["result"]["catalogs_total"] == 2
    assert imported["result"]["catalogs_added"] == 2

    assert catalog_service.get(imported["yes_no"])["catalog_id"] == imported["yes_no"]
    assert catalog_service.get(imported["school"])["catalog_id"] == imported["school"]


def test_the_group_rows_are_not_values(imported):
    """A row naming the list with nothing beside it creates the catalogue, not a
    value in it."""
    assert imported["result"]["headers_skipped"] == 2
    assert len(catalog_service.get(imported["yes_no"])["values"]) == 2


def test_the_variable_becomes_the_code(imported):
    codes = [v["code"] for v in catalog_service.get(imported["yes_no"])["values"]]

    assert codes == ["Si", "No"]


def test_a_code_is_trimmed(imported):
    """The workbook has "Sin_estudios " with a trailing space. A code with a
    stray space is a different code, and would never match an answer."""
    codes = {v["code"] for v in catalog_service.get(imported["school"])["values"]}

    assert "Sin_estudios" in codes
    assert "Sin_estudios " not in codes


def test_the_spanish_label_is_preserved(imported):
    offered = catalog_options.options_for(imported["school"], language="es")

    assert [o["label"] for o in offered][:3] == ["Sin estudios", "Primaria", "Secundaria"]


def test_the_english_label_is_preserved(imported):
    offered = catalog_options.options_for(imported["school"], language="en")

    assert [o["label"] for o in offered][:3] == [
        "Without studies", "Primary/Elementary school", "Secondary school"]


def test_both_languages_are_reported(imported):
    assert imported["result"]["languages"] == ["en", "es"]


def test_one_value_carries_both_languages(imported):
    """Not two rows. Two rows would make the same answer two different answers."""
    values = catalog_service.get(imported["yes_no"])["values"]

    assert len(values) == 2
    assert {v["code"] for v in values} == {"Si", "No"}


# --- 5, 8, 11. codes, translation and the gaps ------------------------------------ #
def test_the_code_is_the_value_in_every_language(imported):
    spanish = catalog_options.options_for(imported["yes_no"], language="es")
    english = catalog_options.options_for(imported["yes_no"], language="en")

    assert [o["value"] for o in spanish] == [o["value"] for o in english] == ["Si", "No"]
    assert english[0] == {"label": "Yes", "value": "Si"}, "the label became the answer"


def test_a_translated_label_is_not_an_answer(imported):
    assert catalog_options.is_valid(imported["yes_no"], "Si") is True
    assert catalog_options.is_valid(imported["yes_no"], "Yes") is False


def test_a_missing_translation_falls_back_to_the_label(imported):
    """No English was given for "Otro". It shows as "Otro" rather than blank,
    and nothing translated it."""
    english = {o["value"]: o["label"] for o in
               catalog_options.options_for(imported["school"], language="en")}

    assert english["Otro"] == "Otro"


def test_an_unknown_language_falls_back(imported):
    offered = catalog_options.options_for(imported["yes_no"], language="de")

    assert [o["label"] for o in offered] == ["Si", "No"]


def test_no_language_asked_for_gives_the_primary_label(imported):
    """What every existing caller gets, unchanged."""
    assert [o["label"] for o in catalog_options.options_for(imported["yes_no"])] == ["Si", "No"]


def test_nothing_reaches_a_translation_service():
    """The workbook is the source of truth. No label is produced by a model, and
    nothing calls out at all."""
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
        eagrology_import.read_workbook(_workbook())
    finally:
        socket.socket.connect = real

    assert reached == []


# --- 9-10. importing twice, and what is settled ----------------------------------- #
def test_a_second_import_adds_nothing(imported, suffix):
    rows = [[f"{r[0]}_{suffix}", r[1], r[2], r[3]] for r in ROWS]

    again = eagrology_import.import_workbook(_workbook(rows=rows), source="Catalogos.xlsx")

    assert again["catalogs_added"] == 0
    assert again["catalogs_updated"] == 2
    assert again["values_added"] == 0
    assert len(catalog_service.get(imported["yes_no"])["values"]) == 2


def test_a_re_import_does_not_disturb_a_catalogue_the_client_has_settled(imported, suffix):
    """Name, version and status are the client's to set in the builder. A
    re-import brings values, not a change of standing."""
    catalog_service.update_catalog(imported["yes_no"],
                                   {"name": "Yes / No", "version": "2.0"})

    rows = [[f"{r[0]}_{suffix}", r[1], r[2], r[3]] for r in ROWS]
    eagrology_import.import_workbook(_workbook(rows=rows), source="Catalogos.xlsx")

    catalog = catalog_service.get(imported["yes_no"])
    assert catalog["name"] == "Yes / No"
    assert catalog["version"] == "2.0"


def test_an_approved_value_is_not_silently_reworded(imported, suffix):
    """Answers already carry the code, so its meaning cannot change underneath
    them. The conflict is reported instead."""
    catalog_service.update_catalog(imported["yes_no"], {"status": "Approved"})

    rows = [[f"SiNo_list_{suffix}", "Si", "Sí, claro", "Certainly"]]
    result = eagrology_import.import_workbook(_workbook(rows=rows), source="Catalogos.xlsx")

    assert result["conflict_count"] == 1
    assert result["conflicts"][0]["code"] == "Si"
    assert result["values_skipped"] == 1

    offered = catalog_options.options_for(imported["yes_no"], language="en")
    assert offered[0]["label"] == "Yes", "an approved value was overwritten"


def test_an_approved_value_may_still_gain_a_language(imported, suffix):
    """Filling in a language it did not have is not a change of meaning."""
    catalog_service.update_catalog(imported["school"], {"status": "Approved"})

    rows = [[f"Escolaridad_list_{suffix}", "Otro", "Otro", "Other"]]
    result = eagrology_import.import_workbook(_workbook(rows=rows), source="Catalogos.xlsx")

    assert result["conflict_count"] == 0
    assert result["values_updated"] == 1

    english = {o["value"]: o["label"] for o in
               catalog_options.options_for(imported["school"], language="en")}
    assert english["Otro"] == "Other"


def test_an_approved_catalogue_still_takes_new_values(imported, suffix):
    catalog_service.update_catalog(imported["yes_no"], {"status": "Approved"})

    rows = [[f"SiNo_list_{suffix}", "NS", "No sabe", "Does not know"]]
    result = eagrology_import.import_workbook(_workbook(rows=rows), source="Catalogos.xlsx")

    assert result["values_added"] == 1
    assert "NS" in {o["value"] for o in catalog_options.options_for(imported["yes_no"])}


def test_a_code_repeated_in_the_workbook_keeps_the_first(catalogues, suffix):
    catalog_id = f"Dup_list_{suffix}"
    catalogues.append(catalog_id)

    rows = [[catalog_id, "A", "Primero", "First"],
            [catalog_id, "A", "Segundo", "Second"]]
    result = eagrology_import.import_workbook(_workbook(rows=rows), source="dupes.xlsx")

    assert result["duplicate_count"] == 1
    assert len(catalog_service.get(catalog_id)["values"]) == 1
    assert catalog_options.options_for(catalog_id, language="en")[0]["label"] == "First"


# --- 12. no relationships are invented -------------------------------------------- #
def test_no_parent_relationship_is_invented(imported):
    """The sheet carries no parent column, so nothing here may decide that one
    list hangs off another."""
    for catalog_id in (imported["yes_no"], imported["school"]):
        catalog = catalog_service.get(catalog_id)

        assert catalog["parent_catalog_id"] is None
        assert all(v["parent_code"] is None for v in catalog["values"])


def test_an_existing_parent_relationship_is_not_disturbed(catalogues, suffix):
    """A dependency configured in the builder survives a re-import of the values."""
    states = f"CAT-STATE-{suffix}"
    districts = f"CAT-DISTRICT-{suffix}"
    catalogues.extend([states, districts])

    catalog_service.create_catalog(states, "States", version="1.0", created_by="tests")
    catalog_service.add_value(states, "MH", "Maharashtra")

    catalog_service.create_catalog(districts, "Districts", version="1.0",
                                   parent_catalog_id=states, created_by="tests")
    catalog_service.add_value(districts, "PUN", "Pune", parent_code="MH")

    eagrology_import.import_workbook(
        _workbook(rows=[[districts, "PUN", "Pune", "Pune"],
                        [districts, "NAG", "Nagpur", "Nagpur"]]),
        source="Catalogos.xlsx")

    catalog = catalog_service.get(districts)
    values = {v["code"]: v for v in catalog["values"]}

    assert catalog["parent_catalog_id"] == states
    assert values["PUN"]["parent_code"] == "MH", "an import cleared a parent"
    assert [o["value"] for o in
            catalog_options.options_for(districts, parent_code="MH")] == ["PUN"]


# --- 13-15. the rest of the application ------------------------------------------- #
def test_an_imported_catalogue_can_be_used_on_a_form(imported):
    """The Form Builder points a field at it; the definition carries a reference
    and never a copy."""
    from app.modules.forms.form_schema import normalize_form

    form = normalize_form({"title": "Encuesta", "fields": [
        {"name": "usa_tecnologia", "label": "¿Usa la tecnología?", "type": "select",
         "options_from": {"source": "client_catalog", "catalog": imported["yes_no"]}},
    ]})
    field = form["fields"][0]

    assert field["type"] == "select"
    assert field["options"] == []
    assert field["options_from"]["catalog"] == imported["yes_no"]


def test_a_submission_stores_the_code(imported):
    from app.modules.forms.form_schema import normalize_form
    from app.modules.forms.submission_service import ValidationFailed, validate_payload

    form = normalize_form({"title": "Encuesta", "fields": [
        {"name": "usa_tecnologia", "label": "¿Usa la tecnología?", "type": "select",
         "options_from": {"source": "client_catalog", "catalog": imported["yes_no"]}},
    ]})

    # answered in either language, stored the same way
    assert validate_payload(form, {"usa_tecnologia": "Si"}) == {"usa_tecnologia": "Si"}

    with pytest.raises(ValidationFailed):
        validate_payload(form, {"usa_tecnologia": "Yes"})


def test_the_options_endpoint_serves_the_chosen_language(admin_client, imported):
    """What the renderer asks for when somebody switches language."""
    spanish = admin_client.get(
        f"/api/client-catalogs/{imported['yes_no']}/options?language=es").json()
    english = admin_client.get(
        f"/api/client-catalogs/{imported['yes_no']}/options?language=en").json()

    assert spanish[0] == {"label": "Si", "value": "Si"}
    assert english[0] == {"label": "Yes", "value": "Si"}


def test_the_options_endpoint_is_unchanged_without_a_language(admin_client, imported):
    plain = admin_client.get(f"/api/client-catalogs/{imported['yes_no']}/options").json()

    assert plain == [{"label": "Si", "value": "Si"}, {"label": "No", "value": "No"}]


# --- the client's actual workbook -------------------------------------------------- #
@pytest.mark.skipif(not REAL_WORKBOOK.exists(),
                    reason="the client's workbook is not on this machine")
def test_the_clients_own_workbook_is_recognised():
    assert eagrology_import.is_eagrology_workbook(REAL_WORKBOOK.read_bytes()) is True


@pytest.mark.skipif(not REAL_WORKBOOK.exists(),
                    reason="the client's workbook is not on this machine")
def test_the_clients_own_workbook_reads():
    """Read only — nothing is written, so this leaves the database alone."""
    read = eagrology_import.read_workbook(REAL_WORKBOOK.read_bytes())

    assert len(read["catalogs"]) > 100, "the catalogues did not come through"
    assert read["languages"] == ["en", "es"]

    by_id = {c["catalog_id"]: c for c in read["catalogs"]}
    yes_no = {v["code"]: v["labels"] for v in by_id["SiNo_list"]["values"]}

    assert yes_no["Si"] == {"es": "Si", "en": "Yes"}
    assert yes_no["No"] == {"es": "No", "en": "No"}
