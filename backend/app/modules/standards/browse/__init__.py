"""Browsing the standards, instead of searching them.

No tables and no permissions of its own — it reads the three vocabularies
through their own services and answers to their own permissions. It exists so
that one screen can walk any of them without knowing which it is walking, and so
that the walking logic is written once rather than three times.

Switched off with `DISABLED_MODULES=standards_browse`, which leaves the
vocabularies themselves untouched.
"""
from app.core.registry import Module

from .routers import browse

MODULE = Module(
    name="standards_browse",
    label="Standards browser",
    routers=[browse.router],
    tables=[],
    schema_file=None,
    migrations=[],
)
