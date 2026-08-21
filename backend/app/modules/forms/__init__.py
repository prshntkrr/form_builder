"""The forms module: build a form, publish it, collect answers.

Everything this module owns lives in this directory — its tables, its
permissions, its routers, its migrations. Core learns about all of it from the
`MODULE` manifest below and from nowhere else.
"""
from pathlib import Path

from app.core.registry import Module

from . import bootstrap, permissions  # noqa: F401  (importing registers the permissions)
from .routers import forms, standard_forms, submissions

MODULE = Module(
    name="forms",
    label="Forms",
    routers=[forms.router, standard_forms.router, submissions.router],
    tables=["forms", "form_version", "standard_form_library", "form_view"],
    schema_file=Path(__file__).resolve().parent / "schema.sql",
    migrations=[
        bootstrap.ensure_status_values,
        bootstrap.ensure_library_snapshots,
        bootstrap.ensure_relations,
    ],
)
