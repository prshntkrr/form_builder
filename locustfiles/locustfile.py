"""
e-Agrology Master API load test for Locust.

This script executes the full entity lifecycle:
1. Setup: Logs in, creates a Project, creates a Form, and discovers all GET endpoints.
2. Write Load: Generates multi-channel submissions, media uploads, and review workflows.
3. Read Load: Generates dynamic GET traffic across all system modules.
"""

import json
import os
import random
import string
import re
from collections import defaultdict

from locust import HttpUser, between, task

EMAIL = os.getenv("LOCUST_EMAIL", "admin@example.org")
PASSWORD = os.getenv("LOCUST_PASSWORD", "Admin@321")
OPENAPI_PATH = os.getenv("LOCUST_OPENAPI_PATH", "/openapi.json")
API_PREFIX = os.getenv("LOCUST_API_PREFIX", "/api")

SKIP_EXACT = {"/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}
SKIP_PREFIXES = ("/static", "/api/dictionary", "/api/standards", "/api/crop-ontology", "/api/mcdc/ivr/routes","/api/dashboards", 
    "/api/external-db",           
    "/api/mcdc/whatsapp/routes" )

def random_string(length=8):
    return ''.join(random.choices(string.ascii_letters + string.digits, k=length))

def module_for_path(path: str) -> str:
    p = path.lower()
    if p.startswith("/api/auth"): return "auth"
    if p.startswith("/api/projects"): return "projects"
    if p.startswith("/api/forms") or p.startswith("/api/submissions"): return "forms"
    if p.startswith("/api/standards") or any(x in p for x in ("/seont", "/icasa", "/crop-ontology", "/units")): return "standards"
    if p.startswith("/api/client_catalog") or p.startswith("/api/client-catalog"): return "client_catalog"
    if p.startswith("/api/dashboards"): return "dashboards"
    if p.startswith("/api/mcdc"): return "mcdc"
    if p.startswith("/api/external"): return "external_db"
    return "core"

class EAgrologyUser(HttpUser):
    wait_time = between(1.0, 3.0)
    
    # State tracking for dynamic discovery
    routes = defaultdict(list)
    
    def on_start(self):
        """Executed once per simulated user before tasks begin."""
        self.token = None
        self.my_project_id = "PRJ00001"
        self.my_form_id = "FRM00001"
        self.my_survey_ids = ["000001"] # Default per-form 6-digit survey ID[cite: 1]

        self._login()
        self._setup_project_and_form_lifecycle()
        self._load_openapi()

    # ------------------------------------------------------------------
    # AUTHENTICATION
    # ------------------------------------------------------------------
    def _login(self):
        if not PASSWORD: return
        with self.client.post(
            f"{API_PREFIX}/auth/login",
            json={"email": EMAIL, "password": PASSWORD},
            name="auth: POST /api/auth/login",
            catch_response=True,
        ) as response:
            if response.status_code in (200, 201):
                data = response.json()
                self.token = data.get("access_token") or data.get("token")

    def _headers(self):
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    # ------------------------------------------------------------------
    # DATA LIFECYCLE SETUP (Create Project -> Create Form)
    # ------------------------------------------------------------------
    def _setup_project_and_form_lifecycle(self):
        """Creates the base entities that this user will operate on."""
        # 1. Create a Project
        with self.client.post(
            f"{API_PREFIX}/projects",
            headers=self._headers(),
            json={"name": f"Load Test Project {random_string()}", "description": "Locust test"},
            name="setup: POST /api/projects",
            catch_response=True
        ) as response:
            if response.status_code in (200, 201):
                self.my_project_id = str(response.json().get("id", ""))
            else:
                response.success() # Ignore failures during high concurrency setup

        # 2. Create a Form inside the Project (Forms are described as JSON[cite: 1])
        if self.my_project_id:
            form_payload = {
                "project_id": self.my_project_id,
                "title": f"Farmer Registration {random_string()}",
                "fields": [
                    {"name": "farmer_name", "type": "text", "required": True},
                    {"name": "main_crop", "type": "text", "required": True}
                ]
            }
            with self.client.post(
                f"{API_PREFIX}/forms",
                headers=self._headers(),
                json=form_payload,
                name="setup: POST /api/forms",
                catch_response=True
            ) as response:
                if response.status_code in (200, 201):
                    self.my_form_id = str(response.json().get("id", ""))

        # 3. Publish Form (Only published configurations leave for export/ingest[cite: 1])
        if self.my_form_id:
            with self.client.post(
                f"{API_PREFIX}/forms/{self.my_form_id}/publish",
                headers=self._headers(),
                json={"status": "published"},
                name="setup: POST /api/forms/{form_id}/publish",
                catch_response=True
            ) as response:
                response.success() # Safe pass if endpoint structure differs

    # ------------------------------------------------------------------
    # OPENAPI DISCOVERY
    # ------------------------------------------------------------------
    def _load_openapi(self):
        with self.client.get(OPENAPI_PATH, name="core: GET /openapi.json", catch_response=True) as response:
            if response.status_code != 200: return
            try: openapi = response.json()
            except ValueError: return

        paths = openapi.get("paths", {})
        for path, item in paths.items():
            if path in SKIP_EXACT or any(path.startswith(prefix) for prefix in SKIP_PREFIXES): continue
            if not path.startswith(API_PREFIX): continue

            get_operation = item.get("get")
            if get_operation:
                self.routes[module_for_path(path)].append({
                    "path": path,
                    "operation": get_operation,
                    "parameters": item.get("parameters", []),
                })

    # ------------------------------------------------------------------
    # PARAMETER RESOLUTION (Links tasks to created entities)
    # ------------------------------------------------------------------
    def _value_for_parameter(self, parameter):
        name = parameter.get("name", "")
        enum = parameter.get("schema", {}).get("enum")
        if enum: return str(random.choice(enum))

        key = name.lower()

        # Prioritize the IDs generated during setup!
        if key in ("project_id", "projectid") and self.my_project_id: return self.my_project_id
        if key in ("form_id", "formid", "id") and self.my_form_id: return self.my_form_id
        if key in ("survey_id", "submission_id"): return random.choice(self.my_survey_ids)

        # Standard Fallbacks
        if key in ("catalog_id", "catalogue_id"): return "Acti_prep_mecanica_suelo_list"
        if key in ("limit", "size", "per_page"): return 50
        if key in ("skip", "offset", "page"): return 0
        if key == "status": return "active"
        if key == "sort": return "desc"
        
        return "1"

    def _build_path(self, route):
        path = route["path"]
        query_params = {}

        for parameter in route.get("parameters", []):
            name = parameter.get("name")
            param_in = parameter.get("in")
            
            if param_in == "path":
                val = self._value_for_parameter(parameter)
                path = path.replace("{" + name + "}", str(val))
            elif param_in == "query":
                val = self._value_for_parameter(parameter)
                if val is not None: query_params[name] = val

        # Force replace un-mapped OpenAPI path variables
        unreplaced_params = re.findall(r'\{(.*?)\}', path)
        for missing_name in unreplaced_params:
            val = self._value_for_parameter({"name": missing_name})
            path = path.replace("{" + missing_name + "}", str(val))

        return path, query_params

    def _run_module_get(self, module):
        routes = self.routes.get(module, [])
        if not routes: return
        route = random.choice(routes)
        path, query_params = self._build_path(route)
        
        with self.client.get(
            path,
            headers=self._headers(),
            params=query_params,
            name=f"{module}: GET {route['path']}",
            catch_response=True,
        ) as response:
            if response.status_code >= 500:
                response.failure(f"Server Error {response.status_code}")

    # ==================================================================
    # WRITE TASKS (Heavy Load Simulation based on Workflows)
    # ==================================================================
    
    @task(10)
    def task_submit_ingest_data(self):
        """Simulates incoming data from multiple channels[cite: 1]"""
        if not self.my_form_id: return
        
        payload = {
            "channel": random.choice(["mobile", "whatsapp", "ivr"]), # Adapters share one pipeline[cite: 1]
            "payload": {
                "farmer_name": f"Farmer {random_string(4)}",
                "main_crop": "MAIZE"
            }
        }
        with self.client.post(
            f"{API_PREFIX}/forms/{self.my_form_id}/submissions/ingest",
            headers=self._headers(),
            json=payload,
            name="forms: POST /api/forms/{form_id}/submissions/ingest",
            catch_response=True
        ) as response:
            if response.status_code in (200, 201):
                # Save the 6-digit survey_id if returned
                survey_id = response.json().get("survey_id")
                if survey_id: self.my_survey_ids.append(str(survey_id))

    @task(3)
    def task_media_upload_request(self):
        """Simulates requesting an S3 presigned URL for media uploads[cite: 1]"""
        if not self.my_form_id: return
        survey_id = random.choice(self.my_survey_ids)
        
        payload = {
            "field_name": "photo",
            "filename": "image.jpg",
            "content_type": "image/jpeg",
            "file_size": 2048
        }
        
        with self.client.post(
            f"{API_PREFIX}/forms/{self.my_form_id}/submissions/{survey_id}/media/upload-url",
            headers=self._headers(),
            json=payload,
            name="forms: POST .../{survey_id}/media/upload-url",
            catch_response=True
        ) as response:
            # 404 is expected if the specific form field "photo" wasn't mapped in setup
            if response.status_code == 404: response.success()

    @task(2)
    def task_workflow_approval(self):
        """Simulates a manager approving a submitted record[cite: 1]"""
        if not self.my_form_id: return
        survey_id = random.choice(self.my_survey_ids)
        
        with self.client.post(
            f"{API_PREFIX}/submissions/{self.my_form_id}/{survey_id}/approve",
            headers=self._headers(),
            name="projects: POST /api/submissions/{form}/{survey}/approve",
            catch_response=True
        ) as response:
            if response.status_code in (404, 400, 422): response.success()

    @task(1)
    def task_export_connector(self):
        """Simulates exporting a published configuration to MCDC[cite: 1]"""
        if not self.my_form_id: return
        
        with self.client.post(
            f"{API_PREFIX}/forms/{self.my_form_id}/exports",
            headers=self._headers(),
            json={"connector": "mcdc"},
            name="forms: POST /api/forms/{form_id}/exports",
            catch_response=True
        ) as response:
            if response.status_code == 404: response.success()

    # ==================================================================
    # READ TASKS (Dynamic OpenAPI GET Traffic)
    # ==================================================================
    
    @task(5)
    def read_projects(self): self._run_module_get("projects")
    
    @task(5)
    def read_forms(self): self._run_module_get("forms")
    
    @task(3)
    def read_dashboards(self): self._run_module_get("dashboards")
    
    @task(2)
    def read_client_catalog(self): self._run_module_get("client_catalog")
    
    @task(2)
    def read_standards(self): self._run_module_get("standards")
    
    @task(1)
    def read_mcdc(self): self._run_module_get("mcdc")

    @task(1)
    def read_external_db(self): self._run_module_get("external_db")