"""Research Platforms & Long-Term Trials Module.

Enables structured, hierarchical tracking of agricultural research stations,
experimental trials, multi-year cycles, protocols, and observation data
(Operations, Plants, Yield, Biomass).
"""

from pathlib import Path

from app.core.registry import Module

from . import bootstrap
from . import permissions  # noqa: F401 (registers permissions and capabilities)
from .routers import research

MODULE = Module(
    name="research_platforms",
    label="Research Platforms & Long-Term Trials",
    routers=[research.router],
    tables=[
        "research_platform",
        "research_trial",
        "research_cycle",
        "research_protocol",
        "research_observation",
    ],
    schema_file=Path(__file__).resolve().parent / "schema.sql",
    migrations=[bootstrap.ensure_research_tables],
)
