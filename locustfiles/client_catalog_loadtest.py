from locust import task

from common.base_user import (
    BaseEAgrologyUser,
    API_PREFIX,
)

# A default catalog code to test against if present
CATALOG_ID = "districts_ug"


class ClientCatalogLoadTestUser(BaseEAgrologyUser):
    """
    Client catalog load tests according to CATALOGS_API.md.
    Base paths:
        - GET /api/client-catalogs
        - GET /api/client-catalogs/{catalog_id}
        - GET /api/client-catalogs/{catalog_id}/values
    """

    def on_start(self):
        super().on_start()
        self.catalog_id = CATALOG_ID

    @task(8)
    def list_catalogs(self):
        with self.client.get(
            f"{API_PREFIX}/client-catalogs",
            headers=self._headers(),
            name="client_catalog: GET /api/client-catalogs",
            catch_response=True,
        ) as response:

            if response.status_code in (200, 201):
                try:
                    data = response.json()
                    catalogs = data.get("catalogs", [])
                    if catalogs:
                        self.catalog_id = catalogs[0].get("catalog_id", self.catalog_id)
                except ValueError:
                    pass
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(5)
    def get_catalog(self):
        with self.client.get(
            f"{API_PREFIX}/client-catalogs/{self.catalog_id}",
            headers=self._headers(),
            name="client_catalog: GET /api/client-catalogs/{catalog_id}",
            catch_response=True,
        ) as response:

            # If catalog ID doesn't exist in target environment, 404 is acceptable
            if response.status_code == 404:
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(3)
    def get_catalog_values(self):
        with self.client.get(
            f"{API_PREFIX}/client-catalogs/{self.catalog_id}/values",
            headers=self._headers(),
            name="client_catalog: GET /api/client-catalogs/{catalog_id}/values",
            catch_response=True,
        ) as response:

            if response.status_code == 404:
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )