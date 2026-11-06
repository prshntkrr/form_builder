"""Permissions for Research Platforms & Long-Term Trials."""

from app.core.permissions import Permission, register

PLATFORM_VIEW = "research.platform.view"
PLATFORM_MANAGE = "research.platform.manage"
PROTOCOL_MANAGE = "research.protocol.manage"
DATA_CAPTURE = "research.data.capture"
DATA_EXPORT = "research.data.export"

register(
    permissions=[
        Permission(
            PLATFORM_VIEW,
            "View Research Platforms",
            "View research platforms, trials, and seasonal historical logs",
            "Research Platforms",
        ),
        Permission(
            PLATFORM_MANAGE,
            "Manage Research Platforms",
            "Create and configure research platforms, trials, and experimental designs",
            "Research Platforms",
        ),
        Permission(
            PROTOCOL_MANAGE,
            "Manage Protocols",
            "Define seasonal agronomic protocols and freeze trial design snapshots",
            "Research Platforms",
        ),
        Permission(
            DATA_CAPTURE,
            "Capture Research Data",
            "Log field operations, plant phenology, yield, and biomass observations",
            "Research Platforms",
        ),
        Permission(
            DATA_EXPORT,
            "Export Research Data",
            "Export comprehensive multi-sheet trial datasets to Excel",
            "Research Platforms",
        ),
    ],
    groups=["Research Platforms"],
    grants={
        "editor": [PLATFORM_VIEW, PLATFORM_MANAGE, PROTOCOL_MANAGE, DATA_CAPTURE, DATA_EXPORT],
        "standard": [PLATFORM_VIEW, DATA_CAPTURE],
    },
    capabilities={
        "use_research_platforms": PLATFORM_VIEW,
        "manage_research_platforms": PLATFORM_MANAGE,
        "manage_protocols": PROTOCOL_MANAGE,
        "capture_research_data": DATA_CAPTURE,
        "export_research_data": DATA_EXPORT,
    },
)
