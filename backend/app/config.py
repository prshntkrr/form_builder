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

    # App
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    default_user: str = "system"

    @property
    def dsn(self) -> str:
        return (
            f"host={self.db_host} port={self.db_port} dbname={self.db_name} "
            f"user={self.db_user} password={self.db_password}"
        )

    @property
    def cors_origin_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
