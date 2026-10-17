"""Test script to simulate an IVR call directly into the user's newly created form FRM00011 (IVR1)."""
import json
import time
from starlette.testclient import TestClient

from app.core.database import init_pool, transaction
from app.core.bootstrap import ensure_base_tables, run_module_migrations
from app.main import app
from app.modules.forms import form_service, routing

def test_user_form():
    print("=" * 60)
    print(">>> TESTING USER IVR FORM: FRM00011 ('IVR1')")
    print("=" * 60)

    init_pool()
    ensure_base_tables()
    run_module_migrations()

    form_id = "FRM00011"
    form = form_service.get_form(form_id)
    print(f"\n[1] Found Form: {form['form_id']} - '{form['form_title']}'")
    print(f"    Table: {form['table_name']}, Status: {form['form_status']}")

    from app.modules.projects import project_service
    project_id = project_service.project_of_form(form_id)
    print(f"    Project: {project_id}")

    test_did = "1205236308"
    print(f"\n[2] Binding DID '{test_did}' to form {form_id}...")
    existing = routing.list_routes(channel="ivr", project_id=project_id)
    # Point DID 1205236308 to FRM00011
    route = next((r for r in existing if r.get("form_id") == form_id), None)
    if route:
        routing.update_route(route["route_id"], receiver_number=test_did, enabled=True)
    else:
        route = routing.create_route(
            channel="ivr",
            route_key="1",
            form_id=form_id,
            project_id=project_id,
            receiver_number=test_did,
            enabled=True,
            created_by="test_user",
        )
    print(f"    DID {test_did} bound to {form_id} successfully.")

    # Generate unique call ID
    call_id = f"CALL_USER_{int(time.time())}"
    caller_phone = "919876543210"

    # In FRM00011:
    # seq 2 -> hello
    # seq 3 -> question_2
    webhook_payload = {
        "call_id": call_id,
        "caller": caller_phone,
        "did": test_did,
        "duration_seconds": 45,
        "recording_url": "https://raw.githubusercontent.com/mdn/webaudio-examples/master/audio-analyser/viper.mp3",
        "answers": [
            {
                "seq": 2,
                "question": "Hello",
                "type": "voice",
                "answer_text": "Namaste, this is Mohan testing IVR",
                "audio_url": "https://raw.githubusercontent.com/mdn/webaudio-examples/master/audio-analyser/viper.mp3"
            },
            {
                "seq": 3,
                "question": "question_2",
                "type": "dtmf",
                "answer_text": "1",
                "audio_url": None
            }
        ]
    }

    print(f"\n[3] Posting Call Completion Webhook to /api/integrations/ivr/indev...")
    from app.modules.forms import indev_service
    secret = indev_service.get_indev_webhook_secret(project_id)
    headers = {"X-Webhook-Secret": secret} if secret else {}
    print(f"    Using Webhook Secret: {'[CONFIGURED]' if secret else '[NONE]'}")

    client = TestClient(app)
    t0 = time.time()
    response = client.post("/api/integrations/ivr/indev", json=webhook_payload, headers=headers)
    elapsed = (time.time() - t0) * 1000

    print(f"    Status: {response.status_code}")
    print(f"    Time: {elapsed:.1f}ms")
    print(f"    Response: {response.json()}")

    assert response.status_code == 200, f"Expected 200, got {response.status_code}"
    survey_id = response.json().get("survey_id")
    print(f"\n[4] Success! New Submission Created: survey_id = {survey_id}")

    # Verify database
    with transaction() as cur:
        cur.execute(
            f"SELECT survey_id, form_id, form_data, created_by, created_on FROM {form['table_name']} WHERE survey_id = %s",
            (survey_id,)
        )
        row = cur.fetchone()
        if row:
            print(f"\n[5] Verified in PostgreSQL table '{form['table_name']}':")
            print(f"    - survey_id : {row['survey_id']}")
            print(f"    - created_by: {row['created_by']}")
            print(f"    - answers   : {json.dumps(row['form_data'], indent=6)}")
        else:
            print("    [FAIL] Row not found!")

    print("\n" + "=" * 60)
    print(">>> TEST COMPLETED! Open your browser at:")
    print(f"    http://localhost:5173/forms/{form_id}/records")
    print("=" * 60)

if __name__ == "__main__":
    test_user_form()
