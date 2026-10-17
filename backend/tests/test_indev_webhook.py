"""Unit tests for Indev IVR Webhook endpoint."""
import unittest
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from starlette.testclient import TestClient

from app.modules.forms.routers.ivr_webhook import router

app = FastAPI()
app.include_router(router)
client = TestClient(app)


class TestIndevWebhook(unittest.TestCase):

    def test_health_check(self):
        resp = client.get("/api/integrations/ivr/health")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"status": "ok", "service": "e-agrology-ivr"})

    @patch("app.modules.forms.indev_service.get_indev_webhook_secret")
    @patch("app.modules.forms.routing.list_routes")
    def test_webhook_unauthorized_secret(self, mock_routes, mock_get_secret):
        mock_routes.return_value = [
            {
                "route_id": 10,
                "form_id": "FRM_TEST",
                "receiver_number": "1205236308",
                "enabled": True,
                "project_id": "PROJ1",
            }
        ]
        mock_get_secret.return_value = "secret_12345"

        payload = {
            "call_id": "CALL_001",
            "caller": "9876543210",
            "did": "1205236308",
            "answers": [],
        }

        # Send with wrong secret
        resp = client.post(
            "/api/integrations/ivr/indev",
            json=payload,
            headers={"X-Webhook-Secret": "wrong_secret"},
        )
        self.assertEqual(resp.status_code, 401)
        self.assertIn("invalid X-Webhook-Secret", resp.json().get("error", ""))

    @patch("app.modules.forms.media_service.archive_indev_audio")
    @patch("app.modules.forms.submission_service.submit")
    @patch("app.modules.forms.form_service.get_form")
    @patch("app.modules.forms.indev_service.get_indev_webhook_secret")
    @patch("app.modules.forms.routing.list_routes")
    def test_webhook_successful_ingestion(
        self,
        mock_routes,
        mock_get_secret,
        mock_get_form,
        mock_submit,
        mock_archive,
    ):
        mock_routes.return_value = [
            {
                "route_id": 10,
                "form_id": "FRM_TEST",
                "receiver_number": "1205236308",
                "enabled": True,
                "project_id": "PROJ1",
            }
        ]
        mock_get_secret.return_value = "secret_12345"

        mock_get_form.return_value = {
            "form_id": "FRM_TEST",
            "form_title": "Test Survey",
            "form_json": {
                "fields": [
                    {"name": "village", "label": "Village Name", "type": "text"},
                    {"name": "rating", "label": "Service Rating", "type": "rating"},
                    {"name": "phone", "label": "Phone Number", "type": "phone"},
                ],
                "channel_config": {
                    "ivr": {
                        "seq_map": {
                            "2": "village",
                            "3": "rating",
                        }
                    }
                },
            },
        }

        mock_submit.return_value = {
            "survey_id": "987654",
            "form_id": "FRM_TEST",
            "table_name": "test_survey",
            "replayed": False,
        }

        payload = {
            "call_id": "CALL_1205236308_999",
            "caller": "9876543210",
            "did": "1205236308",
            "recording_url": "https://ivrs2.indevconsultancy.in/call.wav",
            "answers": [
                {
                    "seq": 2,
                    "question": "Village Name",
                    "type": "voice",
                    "answer_text": "Rampur",
                    "audio_url": "https://ivrs2.indevconsultancy.in/ans2.wav",
                },
                {
                    "seq": 3,
                    "question": "Service Rating",
                    "type": "dtmf",
                    "answer_text": "5",
                    "audio_url": None,
                },
            ],
        }

        resp = client.post(
            "/api/integrations/ivr/indev",
            json=payload,
            headers={"X-Webhook-Secret": "secret_12345"},
        )

        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["survey_id"], "987654")
        self.assertEqual(data["call_id"], "CALL_1205236308_999")

        # Verify submission_service.submit was called with mapped payload
        mock_submit.assert_called_once()
        _, kwargs = mock_submit.call_args
        submitted_answers = kwargs["payload"]
        self.assertEqual(submitted_answers["village"], "Rampur")
        self.assertEqual(submitted_answers["rating"], "5")
        self.assertEqual(submitted_answers["phone"], "9876543210")  # Auto-filled from caller
        self.assertEqual(kwargs["channel"], "ivr")
        self.assertEqual(kwargs["client_submission_id"], "CALL_1205236308_999")


if __name__ == "__main__":
    unittest.main()
