from locust import task

from common.base_user import (
    BaseEAgrologyUser,
    API_PREFIX,
)


class MCDCLoadTestUser(BaseEAgrologyUser):
    """
    MCDC channels & routing load tests according to CHANNELS_API.md.
    Endpoints:
        - GET /api/mcdc/forms (Mobile forms)
        - GET /api/mcdc/routes (Channel routes)
        - GET /api/mcdc/whatsapp/webhooks (Webhooks)
        - GET /api/mcdc/whatsapp/settings (WhatsApp settings)
        - GET /api/mcdc/ivr/settings (IVR settings)
    """

    @task(6)
    def mcdc_forms(self):
        # CHANNELS_API.md §2: GET /api/mcdc/forms
        params = {"project": self.my_project_id} if self.my_project_id else {}
        with self.client.get(
            f"{API_PREFIX}/mcdc/forms",
            headers=self._headers(),
            params=params,
            name="mcdc: GET /api/mcdc/forms",
            catch_response=True,
        ) as response:

            if response.status_code in (403, 404):
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(5)
    def mcdc_routes(self):
        # CHANNELS_API.md §3.1: GET /api/mcdc/routes
        with self.client.get(
            f"{API_PREFIX}/mcdc/routes",
            headers=self._headers(),
            name="mcdc: GET /api/mcdc/routes",
            catch_response=True,
        ) as response:

            if response.status_code in (403, 404):
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(3)
    def whatsapp_settings(self):
        # CHANNELS_API.md §4.4: GET /api/mcdc/whatsapp/settings
        params = {"project": self.my_project_id} if self.my_project_id else {}
        with self.client.get(
            f"{API_PREFIX}/mcdc/whatsapp/settings",
            headers=self._headers(),
            params=params,
            name="mcdc: GET /api/mcdc/whatsapp/settings",
            catch_response=True,
        ) as response:

            if response.status_code in (403, 404):
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(3)
    def ivr_settings(self):
        # CHANNELS_API.md §6.2: GET /api/mcdc/ivr/settings
        params = {"project": self.my_project_id} if self.my_project_id else {}
        with self.client.get(
            f"{API_PREFIX}/mcdc/ivr/settings",
            headers=self._headers(),
            params=params,
            name="mcdc: GET /api/mcdc/ivr/settings",
            catch_response=True,
        ) as response:

            if response.status_code in (403, 404):
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(3)
    def whatsapp_webhooks(self):
        # CHANNELS_API.md §5.1: GET /api/mcdc/whatsapp/webhooks
        params = {"project": self.my_project_id} if self.my_project_id else {}
        with self.client.get(
            f"{API_PREFIX}/mcdc/whatsapp/webhooks",
            headers=self._headers(),
            params=params,
            name="mcdc: GET /api/mcdc/whatsapp/webhooks",
            catch_response=True,
        ) as response:

            if response.status_code in (403, 404):
                response.success()
            elif response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )