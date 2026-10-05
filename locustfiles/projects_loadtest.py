import random

from locust import task

from common.base_user import (
    BaseEAgrologyUser,
    API_PREFIX,
    random_string,
)


class ProjectsLoadTestUser(BaseEAgrologyUser):
    """
    Project module load testing according to PROJECTS_API.md.
    Endpoints:
        - POST /api/projects
        - GET /api/projects
        - GET /api/projects/{project_id}
        - GET /api/projects/roles
    """
    
    # ==============================================================
    # CREATE PROJECT
    # ==============================================================

    @task(3)
    def create_project(self):

        payload = {
            "name": f"Load Project {random_string()}",
            # Description must be >= 5 characters.
            "description": "Created during Locust load testing",
        }

        with self.client.post(
            f"{API_PREFIX}/projects",
            headers=self._headers(),
            json=payload,
            name="projects: POST /api/projects",
            catch_response=True,
        ) as response:

            if response.status_code in (200, 201):
                try:
                    data = response.json()
                    pid = data.get("project_id")
                    if pid:
                        self.my_project_id = str(pid)
                except ValueError:
                    pass
                response.success()
            elif response.status_code in (400, 409):
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    # ==============================================================
    # LIST PROJECTS
    # ==============================================================

    @task(8)
    def list_projects(self):

        with self.client.get(
            f"{API_PREFIX}/projects",
            headers=self._headers(),
            name="projects: GET /api/projects",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    # ==============================================================
    # PROJECT DETAILS
    # ==============================================================

    @task(5)
    def get_project(self):

        with self.client.get(
            f"{API_PREFIX}/projects/{self.my_project_id}",
            headers=self._headers(),
            name="projects: GET /api/projects/{project_id}",
            catch_response=True,
        ) as response:

            if response.status_code == 404:
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    # ==============================================================
    # PROJECT ROLES
    # ==============================================================

    @task(3)
    def list_project_roles(self):
        # PROJECTS_API.md §2.3: GET /api/projects/roles
        with self.client.get(
            f"{API_PREFIX}/projects/roles",
            headers=self._headers(),
            name="projects: GET /api/projects/roles",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )