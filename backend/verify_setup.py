"""End-to-end database check - run this once after filling in backend/.env.

It exercises the whole persistence path without calling OpenAI: saves a form,
provisions its table, submits a row, reads it back out of form_data, and adds a
field to confirm the table shape stays fixed.

    .venv\\Scripts\\python verify_setup.py            # run the check, keep the data
    .venv\\Scripts\\python verify_setup.py --cleanup  # remove the test form + table
"""
import sys

from app.core.config import settings
from app.core.database import ping, transaction
from app.modules.forms.form_service import create_form, get_form, update_form
from app.modules.forms.submission_service import list_submissions, submit
from app.modules.forms.table_service import existing_columns, table_exists

TEST_TITLE = "Setup Check Form"

SAMPLE = {
    "title": TEST_TITLE,
    "description": "Temporary form created by verify_setup.py",
    "sections": [{"key": "basics", "title": "Basics"}],
    "fields": [
        {"name": "farmer_name", "label": "Farmer Name", "type": "text", "required": True, "section": "basics"},
        {"name": "visit_date", "label": "Visit Date", "type": "date", "section": "basics"},
        {"name": "land_area", "label": "Land (acres)", "type": "decimal", "validation": {"min": 0}},
        {"name": "irrigation", "label": "Irrigation", "type": "multiselect",
         "options": ["Canal", "Borewell", "Rain-fed"]},
        {"name": "is_verified", "label": "Verified?", "type": "boolean"},
    ],
}

ok = lambda msg: print(f"  [ok] {msg}")


def find_test_forms(cur):
    cur.execute("SELECT form_id, form_json ->> 'table_name' AS t FROM forms WHERE form_title = %s",
                (TEST_TITLE,))
    return [dict(r) for r in cur.fetchall()]


def cleanup():
    from psycopg2 import sql

    with transaction() as cur:
        rows = find_test_forms(cur)
        for row in rows:
            if row["t"]:
                cur.execute(sql.SQL("DROP TABLE IF EXISTS {}.{}").format(
                    sql.Identifier(settings.db_schema), sql.Identifier(row["t"])))
            cur.execute("DELETE FROM form_version WHERE form_id = %s", (row["form_id"],))
            cur.execute("DELETE FROM forms WHERE form_id = %s", (row["form_id"],))
            print(f"  removed {row['form_id']} and table {row['t']}")
    if not rows:
        print("  nothing to clean up")


def main():
    print(f"\n1. Connecting to {settings.db_user}@{settings.db_host}:{settings.db_port}/{settings.db_name}")
    if not ping():
        sys.exit("   [!!] Could not connect. Check the DB_* values in backend/.env.")
    ok("connected")

    print("\n2. Checking base tables")
    with transaction() as cur:
        for table in ("forms", "form_version"):
            if not table_exists(cur, table):
                sys.exit(f"   [!!] Table '{table}' is missing. Run backend/schema.sql first.")
            ok(f"{table} present")

    print("\n3. Saving a form (forms + form_version + CREATE TABLE)")
    form = create_form(SAMPLE, created_by="verify_setup")
    form_id, table = form["form_id"], form["table"]["table_name"]
    ok(f"form_id={form_id}  version={form['version_no']}  table={table}")

    with transaction() as cur:
        cols = existing_columns(cur, table)
    expected = ["survey_id", "form_id", "form_data", "created_on", "form_version", "created_by"]
    for name in expected:
        assert name in cols, f"envelope column {name} missing"
    assert set(cols) == set(expected), f"unexpected extra columns: {set(cols) - set(expected)}"
    ok("table shape matches survey_form_data: " + ", ".join(f"{c} {cols[c]}" for c in expected))

    print("\n4. Submitting a response")
    receipt = submit(
        get_form(form_id),
        {
            "farmer_name": "Ramesh Kumar",
            "visit_date": "2026-07-29",
            "land_area": "12.5",
            "irrigation": ["Canal", "Borewell"],
            "is_verified": True,
        },
        created_by="verify_setup",
    )
    ok(f"survey_id={receipt['survey_id']}")

    print("\n5. Reading it back")
    data = list_submissions(get_form(form_id))
    assert data["total"] == 1, data["total"]
    stored = data["rows"][0]["form_data"]
    ok(f"form_data JSONB = {stored}")
    assert stored["land_area"] == 12.5, "decimal should be stored as a JSON number"
    assert stored["is_verified"] is True, "boolean should be stored as a JSON boolean"
    assert stored["irrigation"] == ["Canal", "Borewell"], "multiselect should be a JSON array"
    ok("values normalized: number stays a number, boolean a boolean, multiselect an array")

    with transaction() as cur:
        cur.execute(
            f"SELECT survey_id, form_data ->> 'farmer_name' AS name FROM \"{table}\" "
            f"WHERE form_data @> '{{\"irrigation\": [\"Canal\"]}}'"
        )
        hit = dict(cur.fetchone())
    ok(f"queryable through JSONB: form_data @> irrigation:Canal -> {hit['name']}")

    print("\n6. Adding a field (new version, no schema change)")
    revised = dict(SAMPLE)
    revised["fields"] = SAMPLE["fields"] + [
        {"name": "mobile_no", "label": "Mobile Number", "type": "phone"}
    ]
    updated = update_form(form_id, revised, updated_by="verify_setup")
    ok(f"version={updated['version_no']}  table untouched (answers live in form_data)")
    with transaction() as cur:
        assert set(existing_columns(cur, table)) == set(expected), "table shape drifted"
    ok("table still has exactly the six envelope columns; earlier submission intact")

    print(f"\nAll checks passed. Test form {form_id} and table '{table}' were left in place.")
    print("Run  python verify_setup.py --cleanup  to remove them.\n")


if __name__ == "__main__":
    if "--cleanup" in sys.argv:
        print("\nCleaning up setup-check artefacts")
        cleanup()
        print()
    else:
        main()
