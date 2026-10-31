from pathlib import Path

from app.core.registry import Module

from . import bootstrap, permissions  # noqa: F401
from .routers import languages

MODULE = Module(
    name="languages",
    label="Languages",
    routers=[languages.router],
    tables=["language_pack"],
    schema_file=Path(__file__).resolve().parent / "schema.sql",
    migrations=[bootstrap.seed_default_packs],
)
