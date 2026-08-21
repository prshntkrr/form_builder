"""HTTP surface for dashboards.

Every route declares the permission it needs. Never test a role name — roles are
the installation's to define, permissions are the application's.
"""
import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends

from app.core.deps import needs
from app.modules.dashboards.permissions import DASHBOARDS_VIEW

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/dashboards", tags=["dashboards"])


@router.get("")
def list_dashboards(user: Dict[str, Any] = Depends(needs(DASHBOARDS_VIEW))):
    """Placeholder, so the module is reachable from day one."""
    return []
