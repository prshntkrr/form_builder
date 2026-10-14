from locust import task

from common.base_user import BaseEAgrologyUser, API_PREFIX, EMAIL, PASSWORD


class AuthLoadTestUser(BaseEAgrologyUser):
    """
    Authentication load tests according to AUTH_API.md.
    Endpoints:
        - POST /api/auth/login
        - GET /api/auth/me
    """

    @task(10)
    def login(self):
        with self.client.post(
            f"{API_PREFIX}/auth/login",
            json={
                "email": EMAIL,
                "password": PASSWORD,
            },
            name="auth: POST /api/auth/login",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(5)
    def whoami(self):
        with self.client.get(
            f"{API_PREFIX}/auth/me",
            headers=self._headers(),
            name="auth: GET /api/auth/me",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )