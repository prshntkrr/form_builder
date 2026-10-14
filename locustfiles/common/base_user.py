import os
import random
import string

from locust import HttpUser, between


EMAIL = os.getenv("LOCUST_EMAIL", "admin@example.org")
PASSWORD = os.getenv("LOCUST_PASSWORD", "Admin@321")

API_PREFIX = os.getenv("LOCUST_API_PREFIX", "/api")


def random_string(length=8):
    return "".join(
        random.choices(
            string.ascii_letters + string.digits,
            k=length,
        )
    )


class BaseEAgrologyUser(HttpUser):
    """
    Common base class for all e-Agrology Locust users.

    Provides:
        - Authentication
        - Authorization headers
        - Resilient project & form discovery/setup
        - Shared IDs
        - Common random data
    """

    abstract = True

    wait_time = between(1.0, 3.0)

    def on_start(self):
        self.token = None

        # Default fallback IDs.
        self.my_project_id = "PRJ00001"
        self.my_form_id = "FRM00001"
        self.my_survey_ids = ["000001"]

        self._login()
        self._setup_project()
        self._setup_form()

    # ==============================================================
    # AUTHENTICATION
    # ==============================================================

    def _login(self):
        if not PASSWORD:
            return

        with self.client.post(
            f"{API_PREFIX}/auth/login",
            json={
                "email": EMAIL,
                "password": PASSWORD,
            },
            name="auth: POST /api/auth/login",
            catch_response=True,
        ) as response:

            if response.status_code in (200, 201):
                try:
                    data = response.json()
                    self.token = data.get("token")
                    if not self.token:
                        response.failure("Login successful but token was not returned")
                    else:
                        response.success()
                except ValueError:
                    response.failure("Login returned invalid JSON")
            else:
                response.failure(f"Login failed: HTTP {response.status_code}")

    def _headers(self):
        if not self.token:
            return {}

        return {
            "Authorization": f"Bearer {self.token}"
        }

    # ==============================================================
    # PROJECT SETUP (Discovers existing first to avoid concurrent DDL)
    # ==============================================================

    def _setup_project(self):
        # 1. Try to discover an existing project first
        res = self.client.get(
            f"{API_PREFIX}/projects",
            headers=self._headers(),
            name="setup: GET /api/projects",
        )
        if res.status_code == 200:
            try:
                data = res.json()
                projects = data.get("projects", [])
                if projects and isinstance(projects, list):
                    first_p = projects[0].get("project_id")
                    if first_p:
                        self.my_project_id = str(first_p)
                        return
            except ValueError:
                pass

        # 2. If no project exists yet, create one
        payload = {
            "name": f"Project {random_string(6)}",
            "description": "Locust automated load test project",
        }

        with self.client.post(
            f"{API_PREFIX}/projects",
            headers=self._headers(),
            json=payload,
            name="setup: POST /api/projects",
            catch_response=True,
        ) as response:

            if response.status_code in (200, 201):
                try:
                    data = response.json()
                    project_id = data.get("project_id")
                    if project_id:
                        self.my_project_id = str(project_id)
                    response.success()
                except ValueError:
                    response.success()
            elif response.status_code in (400, 409):
                # Another worker may have created or collided
                response.success()
            elif response.status_code >= 500:
                # Concurrent locks in Postgres during on_start
                response.failure(f"Setup Project Error {response.status_code}")

    # ==============================================================
    # FORM SETUP (Discovers existing active forms first)
    # ==============================================================

    def _setup_form(self):
        # 1. Try to find an existing active form first
        res = self.client.get(
            f"{API_PREFIX}/forms?status=Active",
            headers=self._headers(),
            name="setup: GET /api/forms",
        )
        if res.status_code == 200:
            try:
                forms = res.json()
                if isinstance(forms, list) and forms:
                    # Pick an active form
                    self.my_form_id = str(forms[0].get("form_id", self.my_form_id))
                    return
            except ValueError:
                pass

        # 2. If no active form found, create one
        unique_suffix = random_string(8)
        payload = {
            "form_json": {
                "title": f"Farmer Survey {unique_suffix}",
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
            name="setup: POST /api/forms",
            catch_response=True,
        ) as response:

            if response.status_code in (200, 201):
                try:
                    data = response.json()
                    form_id = data.get("form_id")
                    if form_id:
                        self.my_form_id = str(form_id)
                    response.success()
                except ValueError:
                    response.success()
            elif response.status_code in (400, 409):
                # 409 happens when two workers create a form with identical table slug simultaneously
                response.success()
            elif response.status_code >= 500:
                # Concurrent CREATE TABLE lock contention in Postgres
                response.failure(f"Setup Form Server Error {response.status_code}")

        self._publish_form()

    # ==============================================================
    # FORM PUBLISH
    # ==============================================================

    def _publish_form(self):
        if not self.my_form_id:
            return

        with self.client.patch(
            f"{API_PREFIX}/forms/{self.my_form_id}/status",
            headers=self._headers(),
            json={"form_status": "Active"},
            name="setup: PATCH /api/forms/{form_id}/status",
            catch_response=True,
        ) as response:

            if response.status_code in (200, 204, 400, 409):
                response.success()
            elif response.status_code >= 500:
                response.failure(f"Publish failed: HTTP {response.status_code}")

    # ==============================================================
    # COMMON HELPERS
    # ==============================================================

    def random_farmer(self):
        return {
            "farmer_name": f"Farmer {random_string(5)}",
            "main_crop": random.choice(["MAIZE", "WHEAT", "RICE"]),
        }

    def random_survey_id(self):
        return random.choice(self.my_survey_ids)