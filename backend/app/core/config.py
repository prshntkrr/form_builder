"""Application settings, loaded from environment / .env."""
from functools import lru_cache
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # Postgres
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "e_agrology"
    db_user: str = "postgres"
    db_password: str = "postgres"
    db_schema: str = "public"
    db_pool_min: int = 1
    db_pool_max: int = 10
    # Run schema.sql at startup so a fresh deployment needs no manual step.
    # Turn off where the app's database user may not run DDL.
    auto_create_tables: bool = True

    # OpenAI
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    openai_timeout: int = 90

    # Modules. Comma-separated names to switch off — a module named here is not
    # imported at all: no routes, no permissions, no tables. Use it to keep work
    # in progress out of a client's hands without maintaining a branch.
    #
    #     DISABLED_MODULES=dashboards
    #
    # A deny-list rather than an allow-list, so a new module is on by default and
    # nobody has to remember to add it.
    disabled_modules: str = ""

    # App
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    default_user: str = "system"
    # Where the frontend is served from — used to build password reset links.
    app_url: str = "http://localhost:5173"

    # Auth
    session_hours: int = 12
    reset_minutes: int = 60
    # The account created on first run, so there is somebody who can sign in.
    admin_email: str = "admin@e-agrology.local"
    admin_password: str = ""
    # Local development only: returns the reset link in the API response instead
    # of relying on the log. Never enable this where users are real.
    auth_expose_reset_link: bool = False

    # S3, for the images, recordings and documents a form collects. Without a
    # bucket the media endpoints answer 503 and everything else works as before.
    #
    # The key and secret are optional on purpose: left empty, boto3 falls back
    # to its usual chain — an instance role, a profile, the environment — which
    # is how a deployed server should be doing it. Credentials are never sent to
    # a browser; it is given a presigned URL and nothing else.
    aws_region: str = ""
    aws_s3_bucket: str = ""
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""
    # How long an upload or download link is good for, and how large one object
    # may be.
    s3_url_seconds: int = 900
    media_max_mb: int = 25

    # MCDC, the multi-channel collection layer a published form can be exported
    # to. Without a base URL this installation has nowhere to send a
    # configuration and says so rather than inventing an address; the key is
    # sent as a header and never reaches a browser or a form definition.
    mcdc_base_url: str = ""
    mcdc_api_key: str = ""
    mcdc_timeout: int = 20

    # The boundary channel traffic crosses: the MCDC routes, the published
    # configuration, and submissions. Not a proxy — see app/core/gateway.py.
    mcdc_gateway_enabled: bool = True
    # Control requests only. Media never passes through: the bytes go straight
    # to S3 on a presigned URL, so this stays small on purpose.
    mcdc_gateway_max_body_mb: int = 5
    # Per principal — the credential and the caller behind it — never one
    # counter for everybody. 0 turns throttling off.
    mcdc_gateway_rate_limit: int = 120
    mcdc_gateway_rate_window_seconds: int = 60
    # For the one genuinely remote thing this application calls: MCDC itself.
    # See `MCDC_TIMEOUT` above, which is the total; these are the halves for a
    # client that wants them separately.
    mcdc_gateway_connect_timeout: int = 5
    mcdc_gateway_read_timeout: int = 30

    # Email (optional). Without a host, reset links are written to the log.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    smtp_tls: bool = True

    @property
    def dsn(self) -> str:
        return (
            f"host={self.db_host} port={self.db_port} dbname={self.db_name} "
            f"user={self.db_user} password={self.db_password}"
        )

    @property
    def disabled_module_list(self) -> List[str]:
        return [m.strip().lower() for m in self.disabled_modules.split(",") if m.strip()]

    @property
    def cors_origin_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
