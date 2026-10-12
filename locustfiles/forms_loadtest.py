import random

from locust import task

from common.base_user import (
    BaseEAgrologyUser,
    API_PREFIX,
    random_string,
)


class FormsLoadTestUser(BaseEAgrologyUser):
    """
    Forms and submissions load tests according to FORMS_API.md & SUBMISSIONS_API.md.

    Covers:
        - Form listing & live discovery
        - Form details & render config
        - Form creation
        - Publishing (PATCH /status)
        - Direct submissions (POST /submissions)
        - Ingestion (POST /submissions/ingest: mobile, whatsapp, ivr)
        - Media upload URL workflow
        - Approval workflow
        - Export workflow
        - Records & Submissions listing
    """

    # ==============================================================
    # FORM LIST & DISCOVERY
    # ==============================================================

    @task(6)
    def list_forms(self):
        with self.client.get(
            f"{API_PREFIX}/forms",
            headers=self._headers(),
            name="forms: GET /api/forms",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(5)
    def list_live_forms(self):
        # SUBMISSIONS_API.md §1.1: GET /api/forms/live/list
        with self.client.get(
            f"{API_PREFIX}/forms/live/list",
            headers=self._headers(),
            name="forms: GET /api/forms/live/list",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    # ==============================================================
    # FORM DETAILS & RENDER CONFIG
    # ==============================================================

    @task(5)
    def get_form(self):
        with self.client.get(
            f"{API_PREFIX}/forms/{self.my_form_id}",
            headers=self._headers(),
            name="forms: GET /api/forms/{form_id}",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(4)
    def get_form_render(self):
        # SUBMISSIONS_API.md §1.2: GET /api/forms/{form_id}/render
        with self.client.get(
            f"{API_PREFIX}/forms/{self.my_form_id}/render",
            headers=self._headers(),
            name="forms: GET /api/forms/{form_id}/render",
            catch_response=True,
        ) as response:

            if response.status_code in (404, 409):
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    # ==============================================================
    # CREATE FORM
    # ==============================================================

    @task(2)
    def create_form(self):
        # FORMS_API.md §3.1: POST /api/forms with form_json wrapper
        payload = {
            "form_json": {
                "title": f"Load Form {random_string()}",
                "fields": [
                    {
                        "name": "farmer_name",
                        "label": "Farmer Name",
                        "type": "text",
                        "required": True,
                    },
                    {
                        "name": "main_crop",
                        "label": "Main Crop",
                        "type": "dropdown",
                        "required": True,
                        "options": [
                            {"value": "MAIZE", "label": "Maize"},
                            {"value": "WHEAT", "label": "Wheat"},
                            {"value": "RICE", "label": "Rice"},
                        ],
                    },
                ],
            },
            "form_type": "parent",
            "form_status": "Active",
            "project_id": self.my_project_id,
        }

        with self.client.post(
            f"{API_PREFIX}/forms",
            headers=self._headers(),
            json=payload,
            name="forms: POST /api/forms",
            catch_response=True,
        ) as response:

            if response.status_code in (200, 201):
                try:
                    data = response.json()
                    fid = data.get("form_id")
                    if fid:
                        self.my_form_id = str(fid)
                except ValueError:
                    pass
                response.success()
            elif response.status_code in (400, 409):
                # Handled: slug/table collision under concurrency
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    # ==============================================================
    # PUBLISH FORM (status change)
    # ==============================================================

    @task(2)
    def publish_form(self):
        # FORMS_API.md §4.1: PATCH /api/forms/{form_id}/status
        with self.client.patch(
            f"{API_PREFIX}/forms/{self.my_form_id}/status",
            headers=self._headers(),
            json={
                "form_status": "Active",
            },
            name="forms: PATCH /api/forms/{form_id}/status",
            catch_response=True,
        ) as response:

            if response.status_code in (200, 204, 400, 404, 409):
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    # ==============================================================
    # DIRECT SUBMISSION
    # ==============================================================

    @task(6)
    def submit_direct(self):
        # SUBMISSIONS_API.md §2.1: POST /api/forms/{form_id}/submissions
        payload = {
            "data": self.random_farmer(),
            "channel": "web",
            "client_submission_id": f"sub_{random_string(12)}",
        }

        with self.client.post(
            f"{API_PREFIX}/forms/{self.my_form_id}/submissions",
            headers=self._headers(),
            json=payload,
            name="forms: POST /api/forms/{form_id}/submissions",
            catch_response=True,
        ) as response:

            if response.status_code in (200, 201):
                try:
                    data = response.json()
                    survey_id = data.get("survey_id")
                    if survey_id:
                        self.my_survey_ids.append(str(survey_id))
                except ValueError:
                    pass
                response.success()
            elif response.status_code in (400, 404, 409, 422):
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    # ==============================================================
    # SUBMISSION INGEST
    # ==============================================================

    @task(6)
    def submit_ingest_data(self):
        # SUBMISSIONS_API.md §2.2: Channel ingest with adapter-specific shapes
        channel = random.choice(["mobile", "whatsapp", "ivr"])
        answers = self.random_farmer()

        if channel == "mobile":
            channel_payload = answers
        elif channel == "whatsapp":
            channel_payload = {"answers": answers}
        else:
            channel_payload = {
                "digits": {
                    "farmer_name": answers["farmer_name"],
                    "main_crop": "1",
                }
            }

        payload = {
            "channel": channel,
            "payload": channel_payload,
        }

        with self.client.post(
            f"{API_PREFIX}/forms/{self.my_form_id}/submissions/ingest",
            headers=self._headers(),
            json=payload,
            name="forms: POST /api/forms/{form_id}/submissions/ingest",
            catch_response=True,
        ) as response:

            if response.status_code in (200, 201):
                try:
                    data = response.json()
                    survey_id = data.get("survey_id")
                    if survey_id:
                        self.my_survey_ids.append(str(survey_id))
                except ValueError:
                    pass
                response.success()
            elif response.status_code in (400, 404, 409, 422):
                # 422 can happen if target form's channel capability refuses IVR or answers don't fit schema
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    # ==============================================================
    # MEDIA UPLOAD URL
    # ==============================================================

    @task(3)
    def media_upload_request(self):
        # SUBMISSIONS_API.md §6.1
        survey_id = self.random_survey_id()
        payload = {
            "field_name": "photo",
            "filename": "image.jpg",
            "content_type": "image/jpeg",
            "file_size": 2048,
        }

        with self.client.post(
            f"{API_PREFIX}/forms/{self.my_form_id}/submissions/{survey_id}/media/upload-url",
            headers=self._headers(),
            json=payload,
            name="forms: POST .../{survey_id}/media/upload-url",
            catch_response=True,
        ) as response:

            if response.status_code in (400, 404, 422, 503):
                # 503 if S3 storage is unconfigured in test environment
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    # ==============================================================
    # APPROVAL WORKFLOW
    # ==============================================================

    @task(2)
    def workflow_approval(self):
        # SUBMISSIONS_API.md §7.5
        survey_id = self.random_survey_id()

        with self.client.post(
            f"{API_PREFIX}/submissions/{self.my_form_id}/{survey_id}/approve",
            headers=self._headers(),
            name="forms: POST /api/submissions/{form_id}/{survey_id}/approve",
            catch_response=True,
        ) as response:

            if response.status_code in (400, 404, 409, 422):
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    # ==============================================================
    # EXPORT
    # ==============================================================

    @task(1)
    def export_connector(self):
        # FORMS_API.md §6.2: echo connector
        payload = {
            "connector": "echo",
        }

        with self.client.post(
            f"{API_PREFIX}/forms/{self.my_form_id}/exports",
            headers=self._headers(),
            json=payload,
            name="forms: POST /api/forms/{form_id}/exports",
            catch_response=True,
        ) as response:

            if response.status_code in (404, 409):
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    # ==============================================================
    # SUBMISSIONS & RECORDS LIST
    # ==============================================================

    @task(4)
    def list_records(self):
        # SUBMISSIONS_API.md §3.1: GET /api/forms/{form_id}/records
        with self.client.get(
            f"{API_PREFIX}/forms/{self.my_form_id}/records",
            headers=self._headers(),
            name="forms: GET /api/forms/{form_id}/records",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(4)
    def list_submissions(self):
        # SUBMISSIONS_API.md §3.2: GET /api/forms/{form_id}/submissions
        with self.client.get(
            f"{API_PREFIX}/forms/{self.my_form_id}/submissions",
            headers=self._headers(),
            name="forms: GET /api/forms/{form_id}/submissions",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )