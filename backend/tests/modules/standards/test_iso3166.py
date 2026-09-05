"""ISO 3166-1, in the tables every other standard already uses.

    data_standard             ISO 3166-1, version 2020
      standard_variable       alpha_2 · alpha_3 · numeric
        …_option              MX / Mexico, and 248 others, three times over

No table of its own, no migration, and nothing in `client_catalog`: a country
list belongs to the world, and that module is for a client's own controlled
data. The tests below hold both halves of that — the standard works, and the
catalogue is untouched by it.
"""
import re
import uuid

import pytest
from psycopg2 import sql

from app.core.database import ping, transaction
from app.modules.forms import form_service
from app.modules.forms.form_schema import normalize_form
from app.modules.forms.tabular_service import tabular_name
from app.modules.standards.iso3166 import service
from app.modules.standards.iso3166.dataset import COUNTRIES, STANDARD_NAME, VERSION

pytestmark = pytest.mark.skipif(not ping(), reason="Postgres is not reachable")


@pytest.fixture(scope="module", autouse=True)
def imported():
    """The import, once, exactly as the module manifest runs it at startup."""
    service.import_iso3166()


@pytest.fixture
def forms():
    made = []
    yield made
    with transaction() as cur:
        for form_id, table in made:
            for name in ("form_media", "form_export", "submission_channel",
                         "form_survey_progress"):
                cur.execute(f"DELETE FROM {name} WHERE form_id = %s", (form_id,))
            for name in (tabular_name(table), table):
                cur.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(
                    sql.Identifier(name)))
            cur.execute(sql.SQL("DROP SEQUENCE IF EXISTS {}").format(
                sql.Identifier(f"{table[:43]}_survey_seq")))
            cur.execute("DELETE FROM form_version WHERE form_id = %s", (form_id,))
            cur.execute("DELETE FROM forms WHERE form_id = %s", (form_id,))


def _form(forms, fields, status="Active"):
    created = form_service.create_form(normalize_form({
        "title": f"ISO {uuid.uuid4().hex[:6]}",
        "table_name": f"iso_{uuid.uuid4().hex[:8]}",
        "fields": fields,
    }), created_by="tests", status=status)
    forms.append((created["form_id"], created["table"]["table_name"]))
    return created["form_id"]


COUNTRY_FIELD = {"name": "country", "label": "Country", "type": "select",
                 "options_from": {"source": "data_standard",
                                  "standard": "ISO_3166_1",
                                  "code_type": "alpha_2"}}


# --------------------------------------------------------------------------- #
# the dataset
# --------------------------------------------------------------------------- #
def test_the_dataset_is_the_officially_assigned_list():
    assert len(COUNTRIES) == 249


@pytest.mark.parametrize("index, code_type, shape", [
    (0, "alpha_2", r"^[A-Z]{2}$"),
    (1, "alpha_3", r"^[A-Z]{3}$"),
    (2, "numeric", r"^[0-9]{3}$"),
])
def test_every_code_has_the_shape_the_standard_gives_it(index, code_type, shape):
    wrong = [c for c in COUNTRIES if not re.fullmatch(shape, c[index])]

    assert wrong == []
    # And distinct, which is what the standard means by a code.
    assert len({c[index] for c in COUNTRIES}) == len(COUNTRIES)


def test_every_country_has_a_name_and_no_code_is_missing():
    for country in COUNTRIES:
        assert len(country) == 4
        assert all(part and isinstance(part, str) for part in country)


def test_numeric_codes_are_strings_and_keep_their_leading_zeros():
    afghanistan = next(c for c in COUNTRIES if c[0] == "AF")

    assert afghanistan[2] == "004"
    assert isinstance(afghanistan[2], str)
    # Every numeric code, not just that one.
    assert all(isinstance(c[2], str) and len(c[2]) == 3 for c in COUNTRIES)


def test_a_dataset_that_breaks_a_rule_is_refused_rather_than_trimmed():
    for broken, why in (
        ((("MX", "MEX", "484", "Mexico"), ("MY", "MEX", "458", "Malaysia")), "twice"),
        ((("M", "MEX", "484", "Mexico"),), "valid alpha_2"),
        ((("MX", "MEX", 484, "Mexico"),), "must be a string"),
        ((("MX", "MEX", "48", "Mexico"),), "valid numeric"),
        ((("MX", "MEX", "484", ""),), "needs a name"),
    ):
        with pytest.raises(service.DatasetInvalid) as refused:
            service.validate_dataset(broken)
        assert why in str(refused.value)


# --------------------------------------------------------------------------- #
# what the import wrote, and where
# --------------------------------------------------------------------------- #
def test_it_lives_in_the_standards_tables_and_nowhere_new():
    with transaction() as cur:
        cur.execute("""
            SELECT s.version,
                   (SELECT count(*) FROM standard_variable v
                     WHERE v.standard_id = s.standard_id) AS variables
            FROM data_standard s WHERE s.name = %s""", (STANDARD_NAME,))
        standard = dict(cur.fetchone())

    assert standard["version"] == VERSION
    assert standard["variables"] == 3


def test_no_iso_specific_table_was_created():
    """The architecture already had a home for this."""
    with transaction() as cur:
        cur.execute("""
            SELECT tablename FROM pg_tables
            WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
              AND (tablename LIKE '%%iso%%' OR tablename LIKE '%%countr%%')""")
        assert [r["tablename"] for r in cur.fetchall()] == []


def test_nothing_is_written_into_the_client_catalogue():
    """A standard is not a client's data. This is the distinction the whole
    module rests on: importing ISO must leave those tables exactly as they were.
    """
    def catalogue_counts():
        with transaction() as cur:
            cur.execute("SELECT count(*) n FROM client_catalog")
            catalogues = cur.fetchone()["n"]
            cur.execute("SELECT count(*) n FROM client_catalog_value")
            return catalogues, cur.fetchone()["n"]

    before = catalogue_counts()
    service.import_iso3166()

    assert catalogue_counts() == before

    # And no country ever became one of a client's values.
    with transaction() as cur:
        cur.execute("""
            SELECT count(*) n FROM client_catalog_value
            WHERE code IN ('MX', 'MEX', 'IND') AND lower(label) IN ('mexico', 'india')""")
        assert cur.fetchone()["n"] == 0

        cur.execute("SELECT count(*) n FROM client_catalog "
                    "WHERE lower(name) LIKE '%%iso 3166%%'")
        assert cur.fetchone()["n"] == 0


@pytest.mark.parametrize("code_type", ["alpha_2", "alpha_3", "numeric"])
def test_each_code_type_holds_every_country_exactly_once(code_type):
    with transaction() as cur:
        cur.execute("""
            SELECT count(*) AS rows, count(DISTINCT o.code) AS codes,
                   count(*) FILTER (WHERE o.code = '' OR o.label = '') AS empty
            FROM   standard_variable_option o
            JOIN   standard_variable v ON v.variable_id = o.variable_id
            JOIN   data_standard s ON s.standard_id = v.standard_id
            WHERE  s.name = %s AND v.code = %s""", (STANDARD_NAME, code_type))
        counted = dict(cur.fetchone())

    assert counted["rows"] == 249
    assert counted["codes"] == 249          # the uniqueness the standard requires
    assert counted["empty"] == 0


def test_every_option_carries_the_whole_country():
    """So one code type never loses the other two."""
    with transaction() as cur:
        cur.execute("""
            SELECT o.metadata FROM standard_variable_option o
            JOIN   standard_variable v ON v.variable_id = o.variable_id
            JOIN   data_standard s ON s.standard_id = v.standard_id
            WHERE  s.name = %s AND v.code = 'numeric' AND o.code = '484'""",
                    (STANDARD_NAME,))
        mexico = cur.fetchone()["metadata"]

    assert mexico == {"alpha_2": "MX", "alpha_3": "MEX", "numeric": "484",
                      "name": "Mexico"}
    assert isinstance(mexico["numeric"], str)


def test_importing_again_changes_nothing(imported):
    def counted():
        with transaction() as cur:
            cur.execute("""
                SELECT count(*) n FROM standard_variable_option o
                JOIN standard_variable v ON v.variable_id = o.variable_id
                JOIN data_standard s ON s.standard_id = v.standard_id
                WHERE s.name = %s""", (STANDARD_NAME,))
            return cur.fetchone()["n"]

    before = counted()
    again = service.import_iso3166()

    assert again["countries"] == 249
    assert counted() == before == 747       # 249 countries × 3 code types


def test_the_uniqueness_is_the_databases_own():
    """`UNIQUE (variable_id, code)` was already there; ISO needed no constraint
    of its own."""
    from psycopg2 import IntegrityError

    with transaction() as cur:
        cur.execute("""
            SELECT o.variable_id FROM standard_variable_option o
            JOIN standard_variable v ON v.variable_id = o.variable_id
            JOIN data_standard s ON s.standard_id = v.standard_id
            WHERE s.name = %s AND v.code = 'alpha_2' LIMIT 1""", (STANDARD_NAME,))
        variable_id = cur.fetchone()["variable_id"]

    with pytest.raises(IntegrityError):
        with transaction() as cur:
            cur.execute("INSERT INTO standard_variable_option "
                        "(variable_id, code, label) VALUES (%s, 'MX', 'Duplicate')",
                        (variable_id,))


# --------------------------------------------------------------------------- #
# reading it back
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("code, name", [
    ("MX", "Mexico"), ("mx", "Mexico"), ("MEX", "Mexico"), ("484", "Mexico"),
    ("IN", "India"), ("ind", "India"), ("356", "India"),
    ("AF", "Afghanistan"), ("004", "Afghanistan"),
])
def test_a_country_is_found_by_any_of_its_codes(code, name):
    found = service.lookup(code)

    assert found is not None, code
    assert found["name"] == name


@pytest.mark.parametrize("nonsense", ["XYZ", "ZZ", "999", "", "Mexico", "4840"])
def test_something_that_is_not_a_code_finds_nothing(nonsense):
    assert service.lookup(nonsense) is None


@pytest.mark.parametrize("term", ["mexico", "Mexico", "MEXICO", "mex", "MX", "mx",
                                  "484"])
def test_search_finds_mexico_however_it_is_typed(term):
    found = service.countries(term)

    assert "Mexico" in [c["name"] for c in found]


def test_search_is_a_database_query_not_a_download():
    """The whole list is not fetched to find one country."""
    assert len(service.countries("mexico")) < 5
    assert len(service.countries()) == 249
    assert len(service.countries(limit=10)) == 10


def test_the_options_a_field_gets_are_codes_and_names():
    alpha_2 = service.options("alpha_2")
    alpha_3 = service.options("alpha_3")
    numeric = service.options("numeric")

    assert {"value": "MX", "label": "Mexico"} in alpha_2
    assert {"value": "MEX", "label": "Mexico"} in alpha_3
    assert {"value": "484", "label": "Mexico"} in numeric
    assert len(alpha_2) == len(alpha_3) == len(numeric) == 249
    # Same shape as every other option source, so the renderer has no special case.
    assert set(alpha_2[0]) == {"value", "label"}


@pytest.mark.parametrize("code_type, good, bad", [
    ("alpha_2", "MX", ["MEX", "484", "Mexico", "XY", ""]),
    ("alpha_3", "MEX", ["MX", "484", "Mexico", "XYZ"]),
    ("numeric", "484", ["MX", "MEX", "Mexico", "999"]),
])
def test_a_code_is_only_valid_for_the_type_the_field_asked_for(code_type, good, bad):
    assert service.is_valid(code_type, good) is True
    for wrong in bad:
        assert service.is_valid(code_type, wrong) is False, wrong


def test_a_lowercase_answer_is_still_that_country():
    assert service.is_valid("alpha_2", "mx") is True
    assert service.is_valid("alpha_3", "mex") is True


# --------------------------------------------------------------------------- #
# over HTTP
# --------------------------------------------------------------------------- #
def test_the_standard_says_what_it_is(editor_client):
    body = editor_client.get("/api/standards/iso3166").json()

    assert body["loaded"] is True
    assert body["standard"] == "ISO 3166-1"
    assert body["version"] == "2020"
    assert body["countries"] == 249
    assert body["code_types"] == ["alpha_2", "alpha_3", "numeric"]


def test_the_country_list_carries_all_three_codes(editor_client):
    body = editor_client.get("/api/standards/iso3166/countries").json()

    assert body["count"] == 249
    mexico = next(c for c in body["items"] if c["name"] == "Mexico")
    assert mexico == {"name": "Mexico", "alpha_2": "MX", "alpha_3": "MEX",
                      "numeric": "484"}


def test_searching_over_http(editor_client):
    found = editor_client.get("/api/standards/iso3166/countries?q=mex").json()

    assert "Mexico" in [c["name"] for c in found["items"]]


def test_one_country_over_http(editor_client):
    for code in ("MX", "mex", "484"):
        answer = editor_client.get(f"/api/standards/iso3166/countries/{code}")
        assert answer.status_code == 200
        assert answer.json()["alpha_2"] == "MX"


def test_a_code_that_is_not_one_answers_404(editor_client):
    answer = editor_client.get("/api/standards/iso3166/countries/XYZ")

    assert answer.status_code == 404
    assert "ISO 3166-1" in answer.json()["detail"]


def test_options_over_http(editor_client):
    body = editor_client.get(
        "/api/standards/iso3166/options?code_type=alpha_3").json()

    assert {"value": "MEX", "label": "Mexico"} in body


def test_a_code_type_that_does_not_exist_is_refused(editor_client):
    answer = editor_client.get("/api/standards/iso3166/options?code_type=alpha_9")

    assert answer.status_code == 400
    assert "alpha_2" in answer.json()["detail"]


def test_signing_in_is_required(editor_client):
    from fastapi.testclient import TestClient

    from app.main import app

    assert TestClient(app).get(
        "/api/standards/iso3166/countries").status_code == 401


def test_somebody_who_fills_forms_in_can_read_the_country_list():
    """A country question is unanswerable without its countries.

    A Standard User holds `records.create` and not `standards.view`, and the
    endpoint takes either — the same reasoning as the catalogue and ontology
    option lists.
    """
    from fastapi.testclient import TestClient

    from app.core import auth_service
    from app.main import app

    email = f"filler.{uuid.uuid4().hex[:8]}@example.test"
    password = "correct horse battery"
    made = auth_service.create_user(email, password, role="standard",
                                    full_name="Filler")
    try:
        client = TestClient(app, headers={
            "Authorization": f"Bearer {auth_service.login(email, password)['token']}"})
        answer = client.get("/api/standards/iso3166/options")

        assert answer.status_code == 200
        assert {"value": "MX", "label": "Mexico"} in answer.json()
        # And reading a standard is not managing one.
        assert client.delete("/api/standards/ISO 3166-1").status_code in (403, 404)
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM app_user WHERE user_id = %s", (made["user_id"],))


# --------------------------------------------------------------------------- #
# on a form
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("code_type, stored", [
    ("alpha_2", "MX"), ("alpha_3", "MEX"), ("numeric", "484"),
])
def test_a_country_question_accepts_the_code_it_asked_for(forms, editor_client,
                                                          code_type, stored):
    form_id = _form(forms, [{**COUNTRY_FIELD,
                             "options_from": {**COUNTRY_FIELD["options_from"],
                                              "code_type": code_type}}])

    answer = editor_client.post(f"/api/forms/{form_id}/submissions",
                                json={"data": {"country": stored}})

    assert answer.status_code == 201, answer.text


def test_the_default_stored_value_is_alpha_2(forms, editor_client):
    """Somebody picks Mexico; MX is what is kept."""
    form_id = _form(forms, [COUNTRY_FIELD])
    editor_client.post(f"/api/forms/{form_id}/submissions",
                       json={"data": {"country": "MX"}})

    table = form_service.get_form(form_id)["form_json"]["table_name"]
    with transaction() as cur:
        cur.execute(sql.SQL("SELECT form_data FROM {}").format(sql.Identifier(table)))
        stored = cur.fetchone()["form_data"]

    assert stored["country"] == "MX"
    assert "Mexico" not in str(stored)


@pytest.mark.parametrize("wrong", ["XYZ", "Mexico", "484", "MEX", "zz"])
def test_something_that_is_not_an_alpha_2_country_is_refused(forms, editor_client,
                                                             wrong):
    form_id = _form(forms, [COUNTRY_FIELD])

    answer = editor_client.post(f"/api/forms/{form_id}/submissions",
                                json={"data": {"country": wrong}})

    assert answer.status_code == 422
    assert "country" in answer.json()["detail"]["errors"]


def test_a_question_called_country_that_names_no_standard_is_left_alone(forms,
                                                                       editor_client):
    """Validation follows the configuration, never the label."""
    form_id = _form(forms, [{"name": "country", "label": "Country", "type": "text"}])

    answer = editor_client.post(f"/api/forms/{form_id}/submissions",
                                json={"data": {"country": "Wherever they said"}})

    assert answer.status_code == 201


def test_the_configuration_survives_publication_and_export(forms, editor_client):
    """A published form keeps the reference — not a copy of 249 countries."""
    form_id = _form(forms, [COUNTRY_FIELD])

    published = editor_client.get(f"/api/forms/{form_id}/published").json()
    field = next(f for f in published["config"]["fields"] if f["name"] == "country")

    assert field["options_from"] == {"source": "data_standard",
                                     "standard": "ISO_3166_1",
                                     "code_type": "alpha_2"}
    # The reference, not the list. MCDC fetches the countries from the standards
    # API, as this application does.
    assert field["options"] == []
    assert "Mexico" not in str(published)

    exported = editor_client.post(f"/api/forms/{form_id}/exports",
                                  json={"connector": "echo"})
    assert exported.status_code == 201
    assert exported.json()["status"] == "EXPORTED"


def test_the_other_option_sources_are_untouched(forms, editor_client):
    """A catalogue field and an ontology field still behave exactly as before."""
    form_id = _form(forms, [
        {"name": "from_catalogue", "label": "Municipality", "type": "select",
         "options_from": {"source": "client_catalog", "catalog": "Municipios_mx_list"}},
        {"name": "from_ontology", "label": "Crop", "type": "select",
         "options_from": {"source": "crop_ontology", "kind": "crop"}},
        {"name": "from_the_form", "label": "Yes or no", "type": "select",
         "options": ["yes", "no"]},
    ])

    definition = form_service.get_form(form_id)["form_json"]
    sources = {f["name"]: (f.get("options_from") or {}).get("source")
               for f in definition["fields"]}

    assert sources == {"from_catalogue": "client_catalog",
                       "from_ontology": "crop_ontology",
                       "from_the_form": None}
    assert editor_client.post(f"/api/forms/{form_id}/submissions",
                              json={"data": {"from_the_form": "yes"}}).status_code == 201


def test_a_standard_a_form_names_that_does_not_exist_is_not_a_source(forms):
    """The name is looked up, never used to reach anything."""
    definition = normalize_form({
        "title": "t", "table_name": f"iso_{uuid.uuid4().hex[:8]}",
        "fields": [{"name": "q", "label": "Q", "type": "select",
                    "options": ["a"],
                    "options_from": {"source": "data_standard",
                                     "standard": "../../etc/passwd"}}]})

    assert definition["fields"][0].get("options_from") is None
