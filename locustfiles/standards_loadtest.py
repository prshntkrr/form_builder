from locust import task

from common.base_user import (
    BaseEAgrologyUser,
    API_PREFIX,
)


class StandardsLoadTestUser(BaseEAgrologyUser):
    """
    Standards & Reference Database load tests according to STANDARDS_API.md.
    Covers:
        - GET /api/standards
        - GET /api/standards/variables/search
        - GET /api/standards/iso3166
        - GET /api/units
        - GET /api/ontology (SEOnt)
        - GET /api/crop-ontology
        - GET /api/standard-forms
    """

    @task(5)
    def loaded_standards(self):
        with self.client.get(
            f"{API_PREFIX}/standards",
            headers=self._headers(),
            name="standards: GET /api/standards",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(4)
    def search_variables(self):
        with self.client.get(
            f"{API_PREFIX}/standards/variables/search?q=yield&limit=25",
            headers=self._headers(),
            name="standards: GET /api/standards/variables/search",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(3)
    def iso3166_countries(self):
        with self.client.get(
            f"{API_PREFIX}/standards/iso3166",
            headers=self._headers(),
            name="standards: GET /api/standards/iso3166",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(3)
    def units(self):
        with self.client.get(
            f"{API_PREFIX}/units",
            headers=self._headers(),
            name="standards: GET /api/units",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(3)
    def seont_ontology(self):
        # SEOnt is reached at /api/ontology per STANDARDS_API.md §7
        with self.client.get(
            f"{API_PREFIX}/ontology",
            headers=self._headers(),
            name="standards: GET /api/ontology",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(3)
    def crop_ontology(self):
        with self.client.get(
            f"{API_PREFIX}/crop-ontology",
            headers=self._headers(),
            name="standards: GET /api/crop-ontology",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )

    @task(4)
    def standard_forms(self):
        with self.client.get(
            f"{API_PREFIX}/standard-forms",
            headers=self._headers(),
            name="standards: GET /api/standard-forms",
            catch_response=True,
        ) as response:

            if response.status_code >= 500:
                response.failure(
                    f"Server Error {response.status_code}"
                )