"""Unit tests for Indev IVR integration."""
import unittest
from unittest.mock import MagicMock, patch

from app.core.config import settings
from app.modules.forms import indev_service, media_service


class TestIndevIVR(unittest.TestCase):

    def test_clean_did(self):
        self.assertEqual(indev_service.clean_did("+91 1205236308"), "911205236308")
        self.assertEqual(indev_service.clean_did("120-523-6308"), "1205236308")
        self.assertEqual(indev_service.clean_did("(120) 523 6308"), "1205236308")
        self.assertEqual(indev_service.clean_did(""), "")
        self.assertEqual(indev_service.clean_did(None), "")

    def test_build_indev_questions(self):
        form_json = {
            "title": "Kisan Feedback Survey",
            "description": "किसान प्रतिक्रिया सर्वेक्षण",
            "fields": [
                {
                    "name": "farmer_village",
                    "label": "अपने गाँव का नाम बताएं।",
                    "type": "text",
                },
                {
                    "name": "crop_satisfaction",
                    "label": "फसल संतुष्टि 1 से 5 में चुनें।",
                    "type": "rating",
                },
                {
                    "name": "irrigation_type",
                    "label": "सिंचाई का प्रकार: 1 नहर, 2 ट्यूबवेल, 3 बारिश",
                    "type": "select_one",
                    "options": [
                        {"value": "1", "label": "नहर"},
                        {"value": "2", "label": "ट्यूबवेल"},
                        {"value": "3", "label": "बारिश"},
                    ],
                },
            ],
            "channel_config": {
                "ivr": {
                    "welcome": "नमस्ते, ई-एग्रोलॉजी किसान सर्वेक्षण में आपका स्वागत है।",
                    "thank_you": "आपके उत्तर दर्ज कर लिए गए हैं। धन्यवाद।",
                }
            },
        }

        questions, seq_map = indev_service.build_indev_questions(form_json)

        # Seq 1: Intro info
        self.assertEqual(questions[0]["seq"], 1)
        self.assertEqual(questions[0]["type"], "info")
        self.assertIn("नमस्ते", questions[0]["text"])

        # Seq 2: farmer_village (text -> voice)
        self.assertEqual(questions[1]["seq"], 2)
        self.assertEqual(questions[1]["type"], "voice")
        self.assertEqual(questions[1]["validate"], "Y")
        self.assertEqual(seq_map["2"], "farmer_village")

        # Seq 3: crop_satisfaction (rating -> dtmf)
        self.assertEqual(questions[2]["seq"], 3)
        self.assertEqual(questions[2]["type"], "dtmf")
        self.assertEqual(questions[2]["maxdigits"], 1)
        self.assertEqual(seq_map["3"], "crop_satisfaction")

        # Seq 4: irrigation_type (select_one with 3 choices -> dtmf)
        self.assertEqual(questions[3]["seq"], 4)
        self.assertEqual(questions[3]["type"], "dtmf")
        self.assertEqual(questions[3]["maxdigits"], 1)
        self.assertEqual(seq_map["4"], "irrigation_type")

        # Seq 5: Completion announcement (type: info)
        self.assertEqual(len(questions), 5)
        self.assertEqual(questions[4]["seq"], 5)
        self.assertEqual(questions[4]["type"], "info")
        self.assertIn("आपके उत्तर दर्ज कर लिए गए हैं", questions[4]["text"])
        # Info announcement must NOT be in seq_map so it never pollutes answer mapping
        self.assertNotIn("5", seq_map)

    @patch("httpx.Client")
    def test_set_survey_status_off(self, mock_client_cls):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "application/json"}
        mock_response.json.return_value = {"status": "success", "did": "1205236308", "active": False}

        mock_client = MagicMock()
        mock_client.post.return_value = mock_response
        mock_client.__enter__.return_value = mock_client
        mock_client_cls.return_value = mock_client

        with patch("app.modules.forms.indev_service.get_indev_api_key", return_value="dummy_key"):
            res = indev_service.set_survey_status(did="1205236308", active=False)
            self.assertEqual(res.get("status"), "success")
            self.assertFalse(res.get("active"))
            mock_client.post.assert_called_once()
            call_kwargs = mock_client.post.call_args
            self.assertEqual(call_kwargs[1]["json"]["active"], False)
            self.assertEqual(call_kwargs[1]["json"]["did"], "1205236308")

    @patch("httpx.Client")
    def test_set_survey_status_fallback_404(self, mock_client_cls):
        # When survey_status.php returns 404, fallback should use survey_api.php with closed notice
        mock_status_response = MagicMock()
        mock_status_response.status_code = 404
        mock_status_response.headers = {"content-type": "text/html"}

        mock_fallback_response = MagicMock()
        mock_fallback_response.status_code = 200
        mock_fallback_response.headers = {"content-type": "application/json"}
        mock_fallback_response.json.return_value = {"status": "success"}

        mock_client = MagicMock()
        mock_client.post.side_effect = [mock_status_response, mock_fallback_response]
        mock_client.__enter__.return_value = mock_client
        mock_client_cls.return_value = mock_client

        with patch("app.modules.forms.indev_service.get_indev_api_key", return_value="dummy_key"):
            res = indev_service.set_survey_status(did="1205236308", active=False)
            self.assertEqual(res.get("status"), "success")
            self.assertTrue(res.get("fallback"))
            self.assertFalse(res.get("active"))
            self.assertEqual(mock_client.post.call_count, 2)

    def test_credential_resolution_fallback(self):
        with patch.object(settings, "indev_api_key", "env_test_api_key"):
            with patch("app.modules.forms.channel_settings.token", return_value=""):
                key = indev_service.get_indev_api_key(project_id="PROJ123")
                self.assertEqual(key, "env_test_api_key")

        with patch.object(settings, "indev_webhook_secret", "env_test_secret"):
            with patch("app.modules.forms.channel_settings.token", return_value=""):
                secret = indev_service.get_indev_webhook_secret(project_id="PROJ123")
                self.assertEqual(secret, "env_test_secret")

    def test_archive_indev_audio_no_s3(self):
        with patch.object(settings, "aws_s3_bucket", ""):
            res = media_service.archive_indev_audio(
                project_id=None,
                form_id="FRM001",
                survey_id="123456",
                recording_url="https://example.com/audio.wav",
                answers=[{"seq": 2, "audio_url": "https://example.com/q2.wav"}],
            )
            self.assertEqual(res, [])

    @patch("app.modules.forms.media_service.store_media_bytes")
    @patch("httpx.Client")
    def test_archive_indev_audio_with_s3(self, mock_client_cls, mock_store):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.content = b"RIFFWAVEmockbytes"

        mock_client = MagicMock()
        mock_client.get.return_value = mock_response
        mock_client.__enter__.return_value = mock_client
        mock_client_cls.return_value = mock_client

        mock_store.return_value = {"media_id": "MED12345", "s3_key": "test/key.wav"}

        with patch.object(settings, "aws_s3_bucket", "my-test-bucket"):
            answers = [{"seq": 2, "audio_url": "https://ivrs2.indevconsultancy.in/q2.wav"}]
            seq_map = {"2": "village"}

            res = media_service.archive_indev_audio(
                project_id="PROJ1",
                form_id="FRM01",
                survey_id="SURV99",
                recording_url="https://ivrs2.indevconsultancy.in/call.wav",
                answers=answers,
                seq_map=seq_map,
            )

            self.assertEqual(len(res), 2)  # 1 full call + 1 question
            self.assertEqual(mock_store.call_count, 2)


if __name__ == "__main__":
    unittest.main()
