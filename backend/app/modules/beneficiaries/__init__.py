"""Beneficiary types and master data registry.

Each beneficiary type (Farmer, Household, …) links to a standard form.
Data collected via that form feeds a master registry where duplicates are
detected — including voice matching at 80 % threshold — and records are
approved before a beneficiary card is issued.
"""
from pathlib import Path

from app.core.registry import Module

from . import permissions  # noqa: F401  (importing registers them)
from .routers import beneficiaries

MODULE = Module(
    name="beneficiaries",
    label="Beneficiaries",
    routers=[beneficiaries.router],
    tables=["beneficiary_types", "master_registry", "master_sequences"],
    schema_file=Path(__file__).resolve().parent / "schema.sql",
)
