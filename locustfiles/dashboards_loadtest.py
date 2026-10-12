from locust import task

from common.base_user import (
    BaseEAgrologyUser,
    API_PREFIX,
)


class DashboardsLoadTestUser(BaseEAgrologyUser):
    """
    Dashboard module load tests according to DASHBOARDS_API.md.
    Base paths:
        - GET /api/dashboards
        - GET /api/dashboards/{dashboard_id}
        - GET /api/dashboards/data-sources
    """

    def on_start(self):
        super().on_start()
        self.dashboard_id = "DSH00001"

    @task(8)
    def list_dashboards(self):
        with self.client.get(
            f"{API_PREFIX}/dashboards",
            headers=self._headers(),
            name="dashboards: GET /api/dashboards",
            catch_response=True,
        ) as response:

            if response.status_code in (200, 201):
                try:
                    dashboards = response.json()
                    if isinstance(dashboards, list) and dashboards:
                        # Grab first available dashboard ID if present
                        first_id = dashboards[0].get("dashboard_id") or dashboards[0].get("id")
                        if first_id:
                            self.dashboard_id = str(first_id)
                except ValueError:
                    pass
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(5)
    def get_dashboard(self):
        with self.client.get(
            f"{API_PREFIX}/dashboards/{self.dashboard_id}",
            headers=self._headers(),
            name="dashboards: GET /api/dashboards/{dashboard_id}",
            catch_response=True,
        ) as response:

            # If fallback ID does not exist yet, 404 is acceptable
            if response.status_code == 404:
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(3)
    def list_data_sources(self):
        with self.client.get(
            f"{API_PREFIX}/dashboards/data-sources",
            headers=self._headers(),
            name="dashboards: GET /api/dashboards/data-sources",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )