from locust import task

from common.base_user import (
    BaseEAgrologyUser,
    API_PREFIX,
)


class ExternalDBLoadTestUser(BaseEAgrologyUser):
    """
    External database module load tests according to EXTERNAL_DB_API.md.
    Endpoints:
        - GET /api/external-db/connections
        - GET /api/external-db/imports
    """

    @task(6)
    def list_connections(self):
        with self.client.get(
            f"{API_PREFIX}/external-db/connections",
            headers=self._headers(),
            name="external_db: GET /api/external-db/connections",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(3)
    def list_imports(self):
        with self.client.get(
            f"{API_PREFIX}/external-db/imports",
            headers=self._headers(),
            name="external_db: GET /api/external-db/imports",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )