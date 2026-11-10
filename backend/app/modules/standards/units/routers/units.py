"""Units of measure: listing, converting, and CRUD management."""
import csv
import io
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel, Field

from app.core.deps import needs
from app.modules.standards.units import service
from app.modules.standards.units.permissions import UNITS_MANAGE, UNITS_VIEW

router = APIRouter(prefix="/api/units", tags=["units"])


class ConvertRequest(BaseModel):
    value: float
    from_unit: str = Field(..., description="The unit the value is in, e.g. cm")
    to_unit: str = Field(..., description="The unit to express it in, e.g. m")


class UnitCreate(BaseModel):
    code: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=200)
    dimension: str = Field(..., min_length=1, max_length=50)
    factor: str = "1"
    offset: str = "0"
    aliases: List[str] = []
    is_base: bool = False


class UnitUpdate(BaseModel):
    name: Optional[str] = None
    dimension: Optional[str] = None
    factor: Optional[str] = None
    offset: Optional[str] = None
    aliases: Optional[List[str]] = None
    is_base: Optional[bool] = None


@router.get("")
def index(user: Dict[str, Any] = Depends(needs(UNITS_VIEW))):
    """Every unit this installation can convert."""
    return {"units": service.list_units(), "dimensions": service.list_dimensions()}


@router.post("/import")
def import_excel(file: UploadFile = File(...), user: Dict[str, Any] = Depends(needs(UNITS_MANAGE))):
    """Bulk-import units from an Excel file.

    Expected columns: code, name, dimension, factor, offset, aliases, is_base.
    Rows with an existing code are skipped (no overwrite).
    """
    raw = file.file.read()
    name = (file.filename or "").lower()

    if name.endswith(".csv"):
        text = raw.decode("utf-8-sig")
        reader = csv.reader(io.StringIO(text))
        rows = [tuple(r) for r in reader]
    else:
        import openpyxl
        try:
            wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        except Exception:
            raise HTTPException(status_code=400, detail="Could not read file as Excel (.xlsx) or CSV")
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
        wb.close()

    if len(rows) < 2:
        raise HTTPException(status_code=400, detail="File has no data rows")

    header = [str(c or "").strip().lower().replace(" ", "_").replace("/", "_") for c in rows[0]]

    # Map CIMMYT-style headers to internal names
    COL_MAP = {
        "symbol": "code", "unit_id": "unit_id", "preferred_name": "name",
        "reference_unit_id": "reference_unit_id",
        "conversion_factor_to_reference": "factor",
        "standard___uri": "standard_uri", "notes": "notes",
    }
    header = [COL_MAP.get(h, h) for h in header]

    needs = {"name", "dimension"}
    code_col = "code" if "code" in header else None
    if not code_col:
        raise HTTPException(status_code=400, detail="Header must include Symbol (or code) and Dimension columns")
    if not needs.issubset(set(header)) and "dimension" not in header:
        raise HTTPException(status_code=400, detail="Header must include Preferred Name and Dimension columns")

    created, skipped, errors = [], [], []
    for i, row in enumerate(rows[1:], start=2):
        rec = dict(zip(header, row))
        code = str(rec.get("code") or "").strip()
        name = str(rec.get("name", "") or code).strip()
        dimension = str(rec.get("dimension") or "").strip()
        if not code or not dimension:
            skipped.append(f"Row {i}: missing symbol/dimension")
            continue
        factor = str(rec.get("factor", "1") or "1").strip()
        offset = str(rec.get("offset", "0") or "0").strip()
        ref_unit = str(rec.get("reference_unit_id", "") or "").strip()
        is_base = ref_unit == code if ref_unit else False
        aliases_raw = str(rec.get("aliases", "") or "").strip()
        aliases = [a.strip() for a in aliases_raw.split(",") if a.strip()] if aliases_raw else []
        try:
            service.create_unit(code, name, dimension, factor, offset, aliases, is_base)
            created.append(code)
        except service.DuplicateUnit:
            skipped.append(f"Row {i}: {code} already exists")
        except Exception as exc:
            errors.append(f"Row {i} ({code}): {exc}")

    return {"created": created, "skipped": skipped, "errors": errors}


@router.get("/{code}")
def get_one(code: str, user: Dict[str, Any] = Depends(needs(UNITS_VIEW))):
    try:
        return service.get_unit(code)
    except service.UnknownUnit as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("")
def create(req: UnitCreate, user: Dict[str, Any] = Depends(needs(UNITS_MANAGE))):
    try:
        return service.create_unit(
            req.code, req.name, req.dimension,
            req.factor, req.offset, req.aliases, req.is_base,
        )
    except service.DuplicateUnit as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except (ValueError, Exception) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/{code}")
def update(code: str, req: UnitUpdate, user: Dict[str, Any] = Depends(needs(UNITS_MANAGE))):
    try:
        return service.update_unit(
            code, name=req.name, dimension=req.dimension,
            factor=req.factor, offset=req.offset,
            aliases=req.aliases, is_base=req.is_base,
        )
    except service.UnknownUnit as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except (ValueError, Exception) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/{code}")
def delete(code: str, user: Dict[str, Any] = Depends(needs(UNITS_MANAGE))):
    try:
        service.delete_unit(code)
        return {"deleted": code}
    except service.UnknownUnit as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/convert")
def convert(req: ConvertRequest, user: Dict[str, Any] = Depends(needs(UNITS_VIEW))):
    try:
        return service.convert(req.value, req.from_unit, req.to_unit)
    except service.UnknownUnit as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except service.IncompatibleUnits as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
