"""Converting a measurement between two units."""
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.deps import needs
from app.modules.units import service
from app.modules.units.permissions import UNITS_VIEW

router = APIRouter(prefix="/api/units", tags=["units"])


class ConvertRequest(BaseModel):
    value: float
    from_unit: str = Field(..., description="The unit the value is in, e.g. cm")
    to_unit: str = Field(..., description="The unit to express it in, e.g. m")


@router.get("")
def index(user: Dict[str, Any] = Depends(needs(UNITS_VIEW))):
    """Every unit this installation can convert."""
    return {"units": service.list_units()}


@router.post("/convert")
def convert(req: ConvertRequest, user: Dict[str, Any] = Depends(needs(UNITS_VIEW))):
    """`value` in `from_unit`, expressed in `to_unit`.

    Arithmetic against the `unit` table, never a model. Two units convert only
    within one dimension: cm to m, not cm to kg.
    """
    try:
        return service.convert(req.value, req.from_unit, req.to_unit)
    except service.UnknownUnit as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except service.IncompatibleUnits as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
