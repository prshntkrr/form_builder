from pathlib import Path

from app.core.registry import Module

from . import bootstrap, permissions  # noqa: F401
from .routers import field_master

MODULE = Module(
    name="field_master",
    label="Field Standards",
    routers=[field_master.router],
    tables=["field_master"],
    schema_file=Path(__file__).resolve().parent / "schema.sql",
    migrations=[bootstrap.seed_default_fields],
)
