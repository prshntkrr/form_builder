"""Building a client's controlled lists by hand, and using them on a form.

Everything here goes through the same two tables the workbook importer fills, so
a catalogue built in the UI and one imported from a spreadsheet are the same
thing afterwards — and neither is ever replaced by a standard or by a model.
"""
import io
import uuid

import pytest
from psycopg2 import sql

from app.core.database import ping, transaction
from app.modules.client_catalog import catalog_options, catalog_service
from app.modules.forms import form_service
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.submission_service import ValidationFailed, validate_payload
from app.modules.forms.tabular_service import tabular_name

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")

openpyxl = pytest.importorskip("openpyxl", reason="openpyxl is not installed")


@pytest.fixture
def catalogues():
    """Removes whatever a test created, however the test ends."""
    made = []
    yield made
    with transaction() as cur:
        # Children first: a dependent catalogue references its parent.
        for catalog_id in reversed(made):
            cur.execute("DELETE FROM client_catalog WHERE catalog_id = %s", (catalog_id,))


@pytest.fixture
def suffix():
    return uuid.uuid4().hex[:6].upper()


@pytest.fixture
def states(catalogues, suffix):
    """CAT-STATE: MH → Maharashtra, UP → Uttar Pradesh."""
    catalog_id = f"CAT-STATE-{suffix}"
    catalog_service.create_catalog(catalog_id, "States", version="1.0",
                                   status="Candidate", created_by="tests")
    catalogues.append(catalog_id)

    catalog_service.add_value(catalog_id, "MH", "Maharashtra")
    catalog_service.add_value(catalog_id, "UP", "Uttar Pradesh")
    return catalog_id


@pytest.fixture
def districts(catalogues, states, suffix):
    """CAT-DISTRICT: Pune and Nagpur under MH, Lucknow under UP."""
    catalog_id = f"CAT-DISTRICT-{suffix}"
    catalog_service.create_catalog(catalog_id, "Districts", version="1.0",
                                   status="Candidate", parent_catalog_id=states,
                                   created_by="tests")
    catalogues.append(catalog_id)

    catalog_service.add_value(catalog_id, "PUN", "Pune", parent_code="MH")
    catalog_service.add_value(catalog_id, "NAG", "Nagpur", parent_code="MH")
    catalog_service.add_value(catalog_id, "LKO", "Lucknow", parent_code="UP")
    return catalog_id


@pytest.fixture
def forms_cleanup():
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


# --- 1-2. creating a catalogue -------------------------------------------------- #
def test_a_catalogue_is_created(catalogues, suffix):
    catalog_id = f"CAT-IRRIGATION-{suffix}"
    catalogues.append(catalog_id)

    made = catalog_service.create_catalog(
        catalog_id, "Irrigation Methods", description="Approved irrigation methods",
        version="1.0", status="Approved", created_by="tests")

    assert made["catalog_id"] == catalog_id
    assert made["name"] == "Irrigation Methods"
    assert made["version"] == "1.0"
    assert made["status"] == "Approved"
    assert made["values"] == []


def test_a_duplicate_catalogue_id_is_refused(states):
    with pytest.raises(catalog_service.CatalogError):
        catalog_service.create_catalog(states, "Another list", version="1.0")


@pytest.mark.parametrize("bad", [
    {"catalog_id": "", "name": "X", "version": "1.0"},
    {"catalog_id": "CAT X", "name": "X", "version": "1.0"},
    {"catalog_id": "CAT-Y", "name": "", "version": "1.0"},
    {"catalog_id": "CAT-Y", "name": "X", "version": ""},
    {"catalog_id": "CAT-Y", "name": "X", "version": "1.0", "status": "Live"},
])
def test_an_incomplete_catalogue_is_refused(bad):
    with pytest.raises(catalog_service.CatalogError):
        catalog_service.create_catalog(**bad)


def test_a_catalogue_is_revised(states):
    updated = catalog_service.update_catalog(
        states, {"name": "Indian States", "version": "2.0", "status": "Approved"})

    assert updated["name"] == "Indian States"
    assert updated["version"] == "2.0"
    assert updated["status"] == "Approved"


def test_a_catalogue_cannot_depend_on_itself(states):
    with pytest.raises(catalog_service.CatalogError):
        catalog_service.update_catalog(states, {"parent_catalog_id": states})


def test_a_catalogue_cannot_depend_on_one_that_does_not_exist(states):
    with pytest.raises(catalog_service.CatalogError):
        catalog_service.update_catalog(states, {"parent_catalog_id": "CAT-NOWHERE"})


# --- 3-5. values ---------------------------------------------------------------- #
def test_a_value_is_added(states):
    value = catalog_service.add_value(states, "GJ", "Gujarat")

    assert value["code"] == "GJ"
    assert value["label"] == "Gujarat"
    assert value["status"] == "Active"


def test_a_duplicate_code_in_one_catalogue_is_refused(states):
    with pytest.raises(catalog_service.CatalogError):
        catalog_service.add_value(states, "MH", "Maharashtra again")


def test_the_same_code_in_two_catalogues_is_fine(states, districts):
    """A code identifies a value within its catalogue, not across the database."""
    catalog_service.add_value(states, "PUN", "Punjab")

    states_pun = {v["code"]: v for v in catalog_service.get(states)["values"]}["PUN"]
    districts_pun = {v["code"]: v for v in catalog_service.get(districts)["values"]}["PUN"]

    assert states_pun["label"] == "Punjab"
    assert districts_pun["label"] == "Pune"


def test_a_value_without_a_code_is_refused(states):
    with pytest.raises(catalog_service.CatalogError):
        catalog_service.add_value(states, "  ", "No code")


def test_a_value_is_updated(states):
    updated = catalog_service.update_value(
        states, "MH", {"label": "Maharashtra State", "definition": "Western India"})

    assert updated["label"] == "Maharashtra State"
    assert updated["definition"] == "Western India"


def test_values_are_ordered_as_the_client_asked(states):
    catalog_service.update_value(states, "UP", {"display_order": 1})
    catalog_service.update_value(states, "MH", {"display_order": 2})

    assert [v["code"] for v in catalog_service.get(states)["values"]] == ["UP", "MH"]


# --- 7-8, 13, 15. status rather than deletion ------------------------------------ #
def test_a_withdrawn_value_is_not_offered(states):
    catalog_service.update_value(states, "UP", {"status": "Withdrawn"})

    assert [o["value"] for o in catalog_options.options_for(states)] == ["MH"]


def test_a_withdrawn_value_is_still_in_the_catalogue(states):
    """The management view keeps it, so it stays readable and can be brought
    back. It is only new answers that it is unavailable for."""
    catalog_service.update_value(states, "UP", {"status": "Withdrawn"})

    values = {v["code"]: v for v in catalog_service.get(states)["values"]}

    assert values["UP"]["status"] == "Withdrawn"
    assert values["UP"]["label"] == "Uttar Pradesh"


def test_a_withdrawn_value_is_brought_back(states):
    catalog_service.update_value(states, "UP", {"status": "Withdrawn"})
    catalog_service.update_value(states, "UP", {"status": "Active"})

    assert {o["value"] for o in catalog_options.options_for(states)} == {"MH", "UP"}


def test_an_answer_already_given_a_withdrawn_code_still_reads(states, forms_cleanup):
    """The point of withdrawing rather than deleting. An answer submitted while
    the value was Active is still in the table and still means what it meant."""
    from app.modules.forms import submission_service

    definition = normalize_form({
        "title": f"State survey {uuid.uuid4().hex[:6]}",
        "table_name": f"state_survey_{uuid.uuid4().hex[:8]}",
        "fields": [{"name": "state", "label": "State", "type": "select",
                    "options_from": {"source": "client_catalog", "catalog": states}}],
    })
    created = form_service.create_form(definition, created_by="tests")
    forms_cleanup.append((created["form_id"], created["table"]["table_name"]))

    form = form_service.get_form(created["form_id"])
    result = submission_service.submit(form, {"state": "UP"}, created_by="tests")

    catalog_service.update_value(states, "UP", {"status": "Withdrawn"})

    with transaction() as cur:
        cur.execute(
            sql.SQL("SELECT form_data FROM {} WHERE survey_id = %s").format(
                sql.Identifier(created["table"]["table_name"])),
            (result["survey_id"],),
        )
        assert cur.fetchone()["form_data"] == {"state": "UP"}


def test_there_is_no_way_to_delete_a_value():
    """Deliberate: this module cannot know whether a code has been answered."""
    assert not hasattr(catalog_service, "delete_value")


# --- 14. an approved catalogue keeps its meaning --------------------------------- #
def test_an_approved_catalogue_will_not_be_reworded(states):
    catalog_service.update_catalog(states, {"status": "Approved"})

    with pytest.raises(catalog_service.CatalogError) as raised:
        catalog_service.update_value(states, "MH", {"label": "Something else"})

    assert "Approved" in str(raised.value)


def test_an_approved_catalogue_may_still_gain_and_lose_values(states):
    """Neither changes what an existing code means, so neither needs a version."""
    catalog_service.update_catalog(states, {"status": "Approved"})

    catalog_service.add_value(states, "GJ", "Gujarat")
    catalog_service.update_value(states, "UP", {"status": "Withdrawn"})

    assert {o["value"] for o in catalog_options.options_for(states)} == {"MH", "GJ"}


def test_a_revision_goes_through_candidate(states):
    """Back to Candidate, reword, bump the version, approve again."""
    catalog_service.update_catalog(states, {"status": "Approved"})
    catalog_service.update_catalog(states, {"status": "Candidate"})

    catalog_service.update_value(states, "MH", {"label": "Maharashtra (revised)"})
    revised = catalog_service.update_catalog(states, {"version": "2.0", "status": "Approved"})

    assert revised["version"] == "2.0"
    values = {v["code"]: v for v in revised["values"]}
    assert values["MH"]["label"] == "Maharashtra (revised)"


# --- 6, 10-12. dependent lists --------------------------------------------------- #
def test_a_parent_relationship_is_stored(districts, states):
    catalog = catalog_service.get(districts)

    assert catalog["parent_catalog_id"] == states
    assert {v["code"]: v["parent_code"] for v in catalog["values"]} == {
        "PUN": "MH", "NAG": "MH", "LKO": "UP"}


def test_the_options_are_narrowed_by_the_parent(districts):
    assert [o["label"] for o in catalog_options.options_for(districts, parent_code="MH")] == \
        ["Pune", "Nagpur"]
    assert [o["label"] for o in catalog_options.options_for(districts, parent_code="UP")] == \
        ["Lucknow"]


def test_a_parent_code_that_does_not_exist_is_refused(districts):
    with pytest.raises(catalog_service.CatalogError) as raised:
        catalog_service.add_value(districts, "XXX", "Nowhere", parent_code="ZZ")

    assert "not a code" in str(raised.value)


def test_a_standalone_catalogue_needs_no_parent(states):
    """Most catalogues depend on nothing, and their values say nothing about a
    parent. Unchanged, and the common case."""
    value = catalog_service.add_value(states, "GJ", "Gujarat")

    assert value["parent_code"] is None
    assert value["status"] == "Active"
    assert "GJ" in {o["value"] for o in catalog_options.options_for(states)}


def test_a_live_value_in_a_dependent_catalogue_must_name_its_parent(districts):
    """A district under no state is unreachable: every list of districts is drawn
    for one state, so it would never be offered and could never be answered."""
    with pytest.raises(catalog_service.CatalogError) as raised:
        catalog_service.add_value(districts, "PUN2", "Pune East")

    assert "belongs to" in str(raised.value)


def test_an_unknown_parent_is_refused(districts):
    with pytest.raises(catalog_service.CatalogError) as raised:
        catalog_service.add_value(districts, "XXX", "Nowhere", parent_code="XX")

    assert "not a code" in str(raised.value)


def test_a_valid_parent_is_accepted(districts):
    value = catalog_service.add_value(districts, "NSK", "Nashik", parent_code="MH")

    assert value["parent_code"] == "MH"
    assert [o["value"] for o in catalog_options.options_for(districts, parent_code="MH")] == \
        ["PUN", "NAG", "NSK"]


def test_a_withdrawn_value_may_be_incomplete(districts):
    """What an older or half-finished row looks like. It is not offered anyway,
    and it still has to be readable."""
    value = catalog_service.add_value(districts, "TBD", "To be decided", status="Withdrawn")

    assert value["parent_code"] is None
    assert "TBD" not in {o["value"] for o in catalog_options.options_for(districts)}


def test_a_parentless_value_cannot_be_made_live(districts):
    """The rule is about the result, not about which half of it the request
    mentioned."""
    catalog_service.add_value(districts, "TBD", "To be decided", status="Withdrawn")

    with pytest.raises(catalog_service.CatalogError):
        catalog_service.update_value(districts, "TBD", {"status": "Active"})


def test_a_live_value_cannot_have_its_parent_taken_away(districts):
    with pytest.raises(catalog_service.CatalogError):
        catalog_service.update_value(districts, "PUN", {"parent_code": ""})


def test_naming_a_parent_makes_the_value_liveable(districts):
    catalog_service.add_value(districts, "TBD", "To be decided", status="Withdrawn")

    catalog_service.update_value(districts, "TBD", {"parent_code": "UP"})
    revived = catalog_service.update_value(districts, "TBD", {"status": "Active"})

    assert revived["parent_code"] == "UP"
    assert "TBD" in {o["value"] for o in catalog_options.options_for(districts, parent_code="UP")}


def test_a_withdrawn_parent_cannot_take_new_children(states, districts):
    """Filing a new district under a state nobody may choose any more would
    create a value that can never be reached."""
    catalog_service.update_value(states, "UP", {"status": "Withdrawn"})

    with pytest.raises(catalog_service.CatalogError) as raised:
        catalog_service.add_value(districts, "VNS", "Varanasi", parent_code="UP")

    assert "withdrawn" in str(raised.value).lower()


def test_an_existing_incomplete_value_is_flagged_not_mended(districts):
    """Rows that predate this rule stay exactly as they are. Which parent they
    belong to is the client's to say, and guessing would invent a relationship.
    """
    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO client_catalog_value (catalog_id, code, label, status, display_order)
            VALUES (%s, 'OLD', 'Legacy district', 'Active', 99)
            """,
            (districts,),
        )

    values = {v["code"]: v for v in catalog_service.get(districts)["values"]}

    assert values["OLD"]["parent_code"] is None, "a parent was invented"
    assert values["OLD"]["label"] == "Legacy district", "the value stopped being readable"
    assert values["OLD"]["incomplete"] is True
    assert values["PUN"]["incomplete"] is False


def test_an_existing_incomplete_value_is_not_offered_or_accepted(districts):
    """Readable, but unusable for a new answer until it names a parent."""
    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO client_catalog_value (catalog_id, code, label, status, display_order)
            VALUES (%s, 'OLD', 'Legacy district', 'Active', 99)
            """,
            (districts,),
        )

    assert "OLD" not in {o["value"] for o in catalog_options.options_for(districts)}
    assert catalog_options.is_valid(districts, "OLD") is False


def test_a_standalone_catalogues_values_are_still_offered(states):
    """The same query serves both. A catalogue that depends on nothing must not
    lose its values to the reachability rule."""
    assert {o["value"] for o in catalog_options.options_for(states)} == {"MH", "UP"}
    assert catalog_options.is_valid(states, "MH") is True


def test_the_endpoint_refuses_a_live_value_with_no_parent(admin_client, districts):
    response = admin_client.post(f"/api/client-catalogs/{districts}/values",
                                 json={"code": "PUN2", "label": "Pune East"})

    assert response.status_code == 400
    assert "belongs to" in response.json()["detail"]


def test_the_endpoint_accepts_a_live_value_with_a_parent(admin_client, districts):
    response = admin_client.post(f"/api/client-catalogs/{districts}/values",
                                 json={"code": "NSK", "label": "Nashik", "parent_code": "MH"})

    assert response.status_code == 201
    assert response.json()["parent_code"] == "MH"


def test_the_parent_dropdown_is_loaded_from_the_parent_catalogue(admin_client, states, districts):
    """What the builder offers in the Parent value dropdown: the parent
    catalogue's own options, labels shown and codes stored."""
    catalogue = admin_client.get(f"/api/client-catalogs/{districts}").json()
    assert catalogue["parent_catalog_id"] == states

    parents = admin_client.get(f"/api/client-catalogs/{states}/options").json()

    assert parents == [{"label": "Maharashtra", "value": "MH"},
                       {"label": "Uttar Pradesh", "value": "UP"}]


def test_a_parent_code_on_an_independent_catalogue_is_refused(states):
    """A catalogue that depends on nothing has no parent whose codes could be
    named, so naming one is a mistake rather than a relationship."""
    with pytest.raises(catalog_service.CatalogError):
        catalog_service.add_value(states, "XX", "Somewhere", parent_code="MH")


# --- 8, 14-16. a form uses the catalogue ------------------------------------------ #
def _survey(states, districts):
    """The acceptance form: two dependent catalogue fields, a text field and a
    measurement that converts."""
    return normalize_form({
        "title": f"Farmer survey {uuid.uuid4().hex[:6]}",
        "table_name": f"farmer_survey_{uuid.uuid4().hex[:8]}",
        "fields": [
            {"name": "state", "label": "State", "type": "select",
             "options_from": {"source": "client_catalog", "catalog": states}},
            {"name": "district", "label": "District", "type": "select",
             "options_from": {"source": "client_catalog", "catalog": districts,
                              "depends_on": "state"}},
            {"name": "farmer_name", "label": "Farmer Name", "type": "text"},
            {"name": "plant_height", "label": "Plant Height", "type": "decimal",
             "crop_ontology": {"ontology_id": "CO_322", "variable_id": "CO_322:0000996",
                               "trait_name": "Plant height", "scale_name": "cm"},
             "data_standard": {"standard": "ICASA", "variable_id": "935",
                               "variable_code": "PHTD", "unit": "m"}},
        ],
    })


def test_a_form_references_a_catalogue_and_copies_nothing(states, districts):
    form = _survey(states, districts)
    by_name = {f["name"]: f for f in form["fields"]}

    assert by_name["state"]["options_from"] == {
        "source": "client_catalog", "catalog": states}
    assert by_name["district"]["options_from"] == {
        "source": "client_catalog", "catalog": districts, "depends_on": "state"}

    for name in ("state", "district"):
        assert by_name[name]["options"] == [], \
            "catalogue values were copied into the form definition"


def test_a_valid_answer_is_accepted(states, districts):
    form = _survey(states, districts)

    assert validate_payload(form, {"state": "MH", "district": "PUN"})["district"] == "PUN"


def test_a_code_from_the_wrong_catalogue_is_refused(states, districts):
    form = _survey(states, districts)

    with pytest.raises(ValidationFailed) as raised:
        validate_payload(form, {"state": "PUN"})

    assert "state" in raised.value.errors


def test_a_district_of_another_state_is_refused(states, districts):
    """The acceptance case: MH and LKO both exist, and together they are not an
    answer."""
    form = _survey(states, districts)

    with pytest.raises(ValidationFailed) as raised:
        validate_payload(form, {"state": "MH", "district": "LKO"})

    assert "district" in raised.value.errors


def test_a_district_before_a_state_is_refused(states, districts):
    form = _survey(states, districts)

    with pytest.raises(ValidationFailed) as raised:
        validate_payload(form, {"district": "PUN"})

    assert "district" in raised.value.errors


def test_a_withdrawn_code_is_refused_on_a_new_answer(states, districts):
    catalog_service.update_value(districts, "NAG", {"status": "Withdrawn"})
    form = _survey(states, districts)

    with pytest.raises(ValidationFailed):
        validate_payload(form, {"state": "MH", "district": "NAG"})


# --- 19. the acceptance test ------------------------------------------------------ #
def test_the_whole_thing_end_to_end(states, districts, forms_cleanup):
    """Two catalogues, one dependent on the other, on a live form — with the
    unit conversion still doing its own job beside them."""
    from app.modules.forms import submission_service

    # the dependent list narrows
    assert [o["label"] for o in catalog_options.options_for(districts, parent_code="MH")] == \
        ["Pune", "Nagpur"]
    assert [o["label"] for o in catalog_options.options_for(districts, parent_code="UP")] == \
        ["Lucknow"]

    created = form_service.create_form(_survey(states, districts), created_by="tests")
    forms_cleanup.append((created["form_id"], created["table"]["table_name"]))
    form = form_service.get_form(created["form_id"])

    result = submission_service.submit(form, {
        "state": "MH", "district": "PUN",
        "farmer_name": "Test Farmer", "plant_height": 150,
    }, created_by="tests")

    with transaction() as cur:
        cur.execute(
            sql.SQL("SELECT form_data FROM {} WHERE survey_id = %s").format(
                sql.Identifier(created["table"]["table_name"])),
            (result["survey_id"],),
        )
        stored = cur.fetchone()["form_data"]

    assert stored == {
        "state": "MH",
        "district": "PUN",
        "farmer_name": "Test Farmer",
        "plant_height": 1.5,
    }


# --- 22. the standards are a different authority ---------------------------------- #
def test_a_crop_ontology_field_is_not_touched_by_the_catalogues(states):
    """Two authorities, side by side on one form. Neither is the other's."""
    from app.modules.standards.crop_ontology import enrichment as crop

    form = {"title": "Maize", "fields": [
        {"name": "crop", "label": "Crop", "type": "select", "options": [],
         "options_from": {"source": "crop_ontology", "kind": "crop"}},
        {"name": "state", "label": "State", "type": "select", "options": [],
         "options_from": {"source": "client_catalog", "catalog": states},
         "source": {"catalog_id": states, "catalog_is_client_controlled": True}},
    ]}

    fields = {f["name"]: f for f in crop.apply_dynamic_options(form)["form_json"]["fields"]}

    assert fields["crop"]["options_from"]["source"] == "crop_ontology"
    assert fields["state"]["options_from"]["source"] == "client_catalog"


# --- 19-20. importing, and the APIs that already existed --------------------------- #
def _catalog_workbook(catalog_id: str) -> bytes:
    """A CIMMYT catalog workbook, laid out the way the client's template is."""
    book = openpyxl.Workbook()
    book.remove(book.active)

    sheets = {
        "04_Value_Catalogs": (
            ["Catalog ID", "Catalog Name", "Definition"],
            [[catalog_id, "Imported states", "From the client's workbook"]],
        ),
        "05_Catalog_Values": (
            ["Catalog ID", "Code", "Preferred Label EN", "Parent Code",
             "Display Order", "Status"],
            [[catalog_id, "MX-JAL", "Jalisco", "", "1", "Approved"],
             [catalog_id, "MX-JAL-GDL", "Guadalajara", "MX-JAL", "2", "Approved"],
             [catalog_id, "MX-OLD", "Retirado", "", "3", "Withdrawn"]],
        ),
    }

    for name, (headings, rows) in sheets.items():
        sheet = book.create_sheet(name)
        sheet.append([name.replace("_", " ")])
        sheet.append(["What this sheet is for."])
        sheet.append([])
        sheet.append(headings)
        for row in rows:
            sheet.append(row)

    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def test_an_imported_catalogue_appears_in_the_builder(admin_client, catalogues, suffix):
    catalog_id = f"CAT-IMPORTED-{suffix}"
    catalogues.append(catalog_id)

    response = admin_client.post(
        "/api/client-catalogs/import",
        files={"file": ("catalogs.xlsx", _catalog_workbook(catalog_id),
                        "application/vnd.ms-excel")},
    )
    assert response.status_code == 200

    listed = {c["catalog_id"]: c for c in
              admin_client.get("/api/client-catalogs").json()["catalogs"]}

    assert catalog_id in listed
    assert listed[catalog_id]["value_count"] == 3
    assert listed[catalog_id]["active_count"] == 2, "a withdrawn value was counted as offered"


def test_the_parent_code_survives_an_import(admin_client, catalogues, suffix):
    catalog_id = f"CAT-IMPORTED-{suffix}"
    catalogues.append(catalog_id)

    admin_client.post(
        "/api/client-catalogs/import",
        files={"file": ("catalogs.xlsx", _catalog_workbook(catalog_id),
                        "application/vnd.ms-excel")},
    )

    values = {v["code"]: v for v in catalog_service.get(catalog_id)["values"]}
    assert values["MX-JAL-GDL"]["parent_code"] == "MX-JAL"

    offered = catalog_options.options_for(catalog_id, parent_code="MX-JAL")
    assert [o["value"] for o in offered] == ["MX-JAL-GDL"]


def test_a_re_import_updates_rather_than_duplicating(admin_client, catalogues, suffix):
    catalog_id = f"CAT-IMPORTED-{suffix}"
    catalogues.append(catalog_id)
    workbook = _catalog_workbook(catalog_id)

    for _ in range(2):
        admin_client.post(
            "/api/client-catalogs/import",
            files={"file": ("catalogs.xlsx", workbook, "application/vnd.ms-excel")},
        )

    assert len(catalog_service.get(catalog_id)["values"]) == 3


# --- 21, 23. RBAC and the endpoints that already existed --------------------------- #
def test_the_existing_read_endpoints_still_work(admin_client, states):
    assert admin_client.get(f"/api/client-catalogs/{states}").status_code == 200

    values = admin_client.get(f"/api/client-catalogs/{states}/values").json()
    assert {v["code"] for v in values["values"]} == {"MH", "UP"}

    options = admin_client.get(f"/api/client-catalogs/{states}/options").json()
    assert {o["value"] for o in options} == {"MH", "UP"}

    assert admin_client.get("/api/client-catalogs/CAT-NOWHERE").status_code == 404


def test_the_endpoints_build_a_catalogue(admin_client, catalogues, suffix):
    catalog_id = f"CAT-API-{suffix}"
    catalogues.append(catalog_id)

    made = admin_client.post("/api/client-catalogs", json={
        "catalog_id": catalog_id, "name": "Irrigation Methods",
        "description": "Approved irrigation methods", "version": "1.0",
        "status": "Approved",
    })
    assert made.status_code == 201

    added = admin_client.post(f"/api/client-catalogs/{catalog_id}/values",
                              json={"code": "DRIP", "label": "Drip irrigation"})
    assert added.status_code == 201
    assert added.json()["code"] == "DRIP"

    admin_client.post(f"/api/client-catalogs/{catalog_id}/values",
                      json={"code": "FLOOD", "label": "Flood irrigation"})

    withdrawn = admin_client.patch(
        f"/api/client-catalogs/{catalog_id}/values/FLOOD", json={"status": "Withdrawn"})
    assert withdrawn.status_code == 200

    options = admin_client.get(f"/api/client-catalogs/{catalog_id}/options").json()
    assert [o["value"] for o in options] == ["DRIP"]


def test_the_endpoints_refuse_a_duplicate_id(admin_client, states):
    response = admin_client.post("/api/client-catalogs", json={
        "catalog_id": states, "name": "Clash", "version": "1.0"})

    assert response.status_code == 400


def test_the_endpoints_report_a_missing_catalogue(admin_client):
    assert admin_client.post("/api/client-catalogs/CAT-NOWHERE/values",
                             json={"code": "X"}).status_code == 404
    assert admin_client.patch("/api/client-catalogs/CAT-NOWHERE",
                              json={"name": "X"}).status_code == 404


def test_building_needs_the_manage_permission(editor_client, states):
    """Rewriting the client's lists takes `client_catalog.manage`, which an
    editor does not hold. The screen hides the controls behind the same
    capability flag the endpoint checks, so the two cannot drift apart.
    """
    assert editor_client.post("/api/client-catalogs", json={
        "catalog_id": "CAT-NOPE", "name": "Nope", "version": "1.0"}).status_code == 403

    assert editor_client.post(f"/api/client-catalogs/{states}/values",
                              json={"code": "X", "label": "X"}).status_code == 403

    assert editor_client.patch(f"/api/client-catalogs/{states}/values/MH",
                               json={"status": "Withdrawn"}).status_code == 403


def test_signing_in_is_required():
    from fastapi.testclient import TestClient

    from app.main import app

    assert TestClient(app).get("/api/client-catalogs").status_code == 401


def test_the_search_finds_a_catalogue(admin_client, states):
    found = admin_client.get("/api/client-catalogs?search=states").json()["catalogs"]

    assert states in {c["catalog_id"] for c in found}


# --------------------------------------------------------------------------- #
# a field that offers part of a catalogue
#
# The form stores which values, never what they are called: `allowed_values` is
# a list of the client's own codes, and the labels still come from the
# catalogue every time the form is drawn. So a wording corrected tomorrow
# reaches the form on its own, and the filter keeps working.
# --------------------------------------------------------------------------- #
@pytest.fixture
def crops_of_many(catalogues):
    """A catalogue with enough in it to be worth narrowing."""
    made = catalog_service.create_catalog(
        catalog_id=f"CAT-CROPS-{uuid.uuid4().hex[:6]}", name="Cultivos", version="1.0")
    catalogues.append(made["catalog_id"])

    for order, code in enumerate(
            ["MAIZE", "RICE", "WHEAT", "BARLEY", "SOYBEAN", "SORGHUM"]):
        catalog_service.add_value(made["catalog_id"], code=code,
                                  label=code.title(), display_order=order,
                                  status="Active")
    return made["catalog_id"]


def _field(catalog, allowed=None):
    source = {"source": "client_catalog", "catalog": catalog}
    if allowed is not None:
        source["allowed_values"] = allowed
    return normalize_form({
        "title": "T", "table_name": f"t_{uuid.uuid4().hex[:8]}",
        "fields": [{"name": "crop", "label": "Crop", "type": "select",
                    "options_from": source}],
    })


def test_a_field_offering_everything_stores_no_list(crops_of_many):
    """What every field written before this says, and what most say now."""
    field = _field(crops_of_many)["fields"][0]

    assert field["options_from"] == {"source": "client_catalog", "catalog": crops_of_many}
    assert "allowed_values" not in field["options_from"]


def test_choosing_some_values_stores_only_their_codes(crops_of_many):
    field = _field(crops_of_many, ["RICE", "WHEAT"])["fields"][0]

    assert field["options_from"]["allowed_values"] == ["RICE", "WHEAT"]
    # Codes, and nothing else: no labels, no options, no copy of the catalogue.
    assert field["options"] == []
    assert "Rice" not in str(field)


def test_an_empty_choice_means_the_whole_catalogue(crops_of_many):
    """"Offer none of them" is not a thing anybody means."""
    field = _field(crops_of_many, [])["fields"][0]

    assert "allowed_values" not in field["options_from"]


def test_duplicates_and_blanks_are_cleaned_but_order_is_the_authors(crops_of_many):
    field = _field(crops_of_many, ["WHEAT", " WHEAT ", "", "RICE"])["fields"][0]

    assert field["options_from"]["allowed_values"] == ["WHEAT", "RICE"]


def test_only_the_chosen_values_are_offered(crops_of_many):
    everything = catalog_options.options_for(crops_of_many)
    some = catalog_options.options_for(crops_of_many, allowed=["RICE", "WHEAT"])

    assert len(everything) == 6
    assert [o["value"] for o in some] == ["RICE", "WHEAT"]


def test_the_labels_still_come_from_the_catalogue(crops_of_many):
    """The point of storing codes: the client corrects a wording and the form
    shows it, without anybody reopening the form."""
    catalog_service.update_value(crops_of_many, "RICE", {"label": "Arroz"})

    some = catalog_options.options_for(crops_of_many, allowed=["RICE", "WHEAT"])

    assert [o["label"] for o in some] == ["Arroz", "Wheat"]
    assert [o["value"] for o in some] == ["RICE", "WHEAT"]


def test_narrowing_by_nothing_is_the_whole_list(crops_of_many):
    assert len(catalog_options.options_for(crops_of_many, allowed=[])) == 6
    assert len(catalog_options.options_for(crops_of_many, allowed=None)) == 6


def test_a_value_the_field_does_not_offer_is_refused(crops_of_many):
    allowed = ["RICE", "WHEAT"]

    assert catalog_options.is_valid(crops_of_many, "RICE", allowed=allowed) is True
    # In the catalogue, but not on offer here.
    assert catalog_options.is_valid(crops_of_many, "MAIZE", allowed=allowed) is False
    # Not in the catalogue at all.
    assert catalog_options.is_valid(crops_of_many, "NOPE", allowed=allowed) is False
    # And without a narrowing, the catalogue alone decides, exactly as before.
    assert catalog_options.is_valid(crops_of_many, "MAIZE") is True


def test_submitting_a_value_the_field_does_not_offer_fails(crops_of_many):
    definition = _field(crops_of_many, ["RICE", "WHEAT"])

    assert validate_payload(definition, {"crop": "RICE"})["crop"] == "RICE"

    with pytest.raises(ValidationFailed) as refused:
        validate_payload(definition, {"crop": "MAIZE"})
    assert "crop" in refused.value.errors


def test_a_withdrawn_value_is_still_withdrawn_when_it_was_chosen(crops_of_many):
    """Both rules hold: on offer here, and still offered by the catalogue."""
    catalog_service.update_value(crops_of_many, "RICE", {"status": "Withdrawn"})

    assert catalog_options.options_for(crops_of_many, allowed=["RICE", "WHEAT"]) == [
        {"label": "Wheat", "value": "WHEAT"}]
    assert catalog_options.is_valid(crops_of_many, "RICE",
                                    allowed=["RICE", "WHEAT"]) is False


def test_an_existing_catalogue_field_is_untouched(crops_of_many):
    """Backward compatibility, stated directly: a field saved before this
    normalizes to the bytes it had."""
    before = {"source": "client_catalog", "catalog": crops_of_many}
    after = _field(crops_of_many)["fields"][0]["options_from"]

    assert after == before
    assert [o["value"] for o in catalog_options.options_for(crops_of_many)] == [
        "MAIZE", "RICE", "WHEAT", "BARLEY", "SOYBEAN", "SORGHUM"]


def test_narrowing_works_on_a_dependent_catalogue(catalogues):
    """A district list narrowed both by its state and by what the field offers."""
    states = f"CAT-ST-{uuid.uuid4().hex[:6]}"
    catalog_service.create_catalog(catalog_id=states, name="States", version="1.0")
    catalogues.append(states)
    catalog_service.add_value(states, "MH", "Maharashtra")

    districts = f"CAT-DI-{uuid.uuid4().hex[:6]}"
    catalog_service.create_catalog(catalog_id=districts, name="Districts",
                                   version="1.0", parent_catalog_id=states)
    catalogues.append(districts)
    for code, label in (("PUN", "Pune"), ("NAG", "Nagpur"), ("SOL", "Solapur")):
        catalog_service.add_value(districts, code, label, parent_code="MH")

    offered = catalog_options.options_for(districts, parent_code="MH",
                                          allowed=["PUN", "SOL"])
    assert [o["value"] for o in offered] == ["PUN", "SOL"]
    assert catalog_options.is_valid(districts, "NAG", parent_code="MH",
                                    allowed=["PUN", "SOL"]) is False


def test_the_options_endpoint_takes_the_narrowing(crops_of_many, editor_client):
    everything = editor_client.get(
        f"/api/client-catalogs/{crops_of_many}/options").json()
    some = editor_client.get(
        f"/api/client-catalogs/{crops_of_many}/options",
        params={"allowed": ["RICE", "WHEAT"]}).json()

    assert len(everything) == 6
    assert [o["value"] for o in some] == ["RICE", "WHEAT"]


def test_narrowing_a_large_catalogue(catalogues):
    """The filter is a WHERE, not a pass over everything in Python."""
    big = f"CAT-BIG-{uuid.uuid4().hex[:6]}"
    catalog_service.create_catalog(catalog_id=big, name="Big", version="1.0")
    catalogues.append(big)
    for i in range(200):
        catalog_service.add_value(big, f"C{i:03d}", f"Value {i}", display_order=i)

    assert len(catalog_options.options_for(big)) == 200
    assert [o["value"] for o in catalog_options.options_for(
        big, allowed=["C007", "C042", "C199"])] == ["C007", "C042", "C199"]
