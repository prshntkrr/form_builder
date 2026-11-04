"""FastAPI router for Research Platforms & Long-Term Trials."""

import io
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, File, Form, UploadFile
from fastapi.responses import StreamingResponse, RedirectResponse
from pydantic import BaseModel, Field

from app.core.deps import current_user, needs
from app.modules.research_platforms import calculations, permissions
from app.modules.research_platforms.s3_service import upload_file_to_s3, generate_presigned_download_url
from app.modules.research_platforms.services import (
    CycleService,
    FactorialDesignService,
    ObservationService,
    PlatformService,
    ProtocolService,
    ResearchExportService,
    ResearchFormService,
    TrialService,
)

router = APIRouter(prefix="/api/research", tags=["research_platforms"])
logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Pydantic Schemas
# --------------------------------------------------------------------------- #
class PlatformPayload(BaseModel):
    platform_id: Optional[str] = None
    name: str = Field(..., min_length=1, max_length=200)
    abbreviation: Optional[str] = ""
    country: Optional[str] = ""
    region: Optional[str] = ""
    state_province: Optional[str] = ""
    municipality: Optional[str] = ""
    address: Optional[str] = ""
    elevation: Optional[float] = None
    soil_type: Optional[str] = ""
    climate_type: Optional[str] = ""
    polygon_geojson: Optional[Any] = None
    surface_area_ha: Optional[float] = None
    surface_area_m2: Optional[float] = None
    hub: Optional[str] = ""
    installation_year: Optional[int] = None
    campus: Optional[str] = ""
    locality: Optional[str] = ""
    objective: Optional[str] = ""
    extra: Optional[Dict[str, Any]] = None


class TrialPayload(BaseModel):
    trial_id: Optional[str] = None
    name: str = Field(..., min_length=1, max_length=200)
    platform_id: Optional[str] = None
    objective: Optional[str] = ""
    hub: Optional[str] = ""
    installation_year: Optional[int] = None
    campus: Optional[str] = ""
    locality: Optional[str] = ""
    elevation: Optional[float] = None
    photos: Optional[List[str]] = Field(default_factory=list)
    location: Optional[Dict[str, Any]] = None
    polygon_geojson: Optional[Any] = None
    design: Optional[Dict[str, Any]] = None
    treatments_count: Optional[int] = 3
    replications_count: Optional[int] = 3
    subsamples_count: Optional[int] = 0
    factors: Optional[List[Dict[str, Any]]] = None
    extra: Optional[Dict[str, Any]] = None


class DesignPreviewRequest(BaseModel):
    treatments_count: int = 3
    replications_count: int = 3
    subsamples_count: int = 0
    factors: Optional[List[Dict[str, Any]]] = None
    custom_treatments: Optional[List[Dict[str, Any]]] = None


class CyclePayload(BaseModel):
    year: int
    season: str = Field(..., min_length=1, max_length=20)  # 'PV', 'OI'
    main_crop: Optional[str] = ""
    maize_type: Optional[str] = ""
    pv_humidity_regime: Optional[str] = ""
    oi_humidity_regime: Optional[str] = ""
    institution_collaborator: Optional[str] = ""
    project_name: Optional[str] = ""
    planting_system: Optional[str] = ""
    stratum: Optional[str] = ""
    status: Optional[str] = "Active"
    principal_investigator: Optional[Dict[str, Any]] = None
    technical_responsible: Optional[Dict[str, Any]] = None
    extra: Optional[Dict[str, Any]] = None


class ProtocolPayload(BaseModel):
    sowing_date: Optional[str] = None
    harvest_date: Optional[str] = None
    harvest_area_m2: Optional[float] = 24.0
    crop_varieties: Optional[str] = ""
    planting_density: Optional[float] = None
    planting_method: Optional[str] = ""
    tillage_practices: Optional[str] = ""
    fertilization_practices: Optional[str] = ""
    pest_weed_management: Optional[str] = ""
    disease_management: Optional[str] = ""
    irrigation_description: Optional[str] = ""
    observations: Optional[str] = ""
    avg_annual_precip_mm: Optional[float] = None
    avg_annual_temp_c: Optional[float] = None
    variables_to_collect: Optional[str] = ""
    frozen_treatments_snapshot: Optional[Dict[str, Any]] = None
    extra: Optional[Dict[str, Any]] = None


class ObservationPayload(BaseModel):
    plot_no: Optional[int] = None
    treatment_id: Optional[Any] = None
    crop: Optional[str] = ""
    date: Optional[str] = None
    raw_inputs: Dict[str, Any] = Field(default_factory=dict)
    notes: Optional[str] = ""
    extra: Optional[Dict[str, Any]] = None


class BulkObservationRequest(BaseModel):
    module_type: str
    observations: List[Dict[str, Any]]


class ResearchFormCreateRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = ""
    category: Optional[str] = "General Agronomy"
    platform_id: Optional[str] = None
    trial_id: Optional[str] = None
    status: Optional[str] = "Draft"
    form_json: Optional[Dict[str, Any]] = None


class ResearchFormUpdateRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = None
    form_json: Dict[str, Any]


class ResearchFormSubmitRequest(BaseModel):
    data: Dict[str, Any]
    trial_id: Optional[str] = None
    cycle_id: Optional[str] = None
    plot_no: Optional[int] = None
    treatment_id: Optional[int] = None


class YieldCalcRequest(BaseModel):
    area_m2: float
    grain_weight_kg: float
    moisture_pct: Optional[float] = 14.0
    standard_moisture_pct: Optional[float] = 14.0
    weight_1000_grains_g: Optional[float] = None
    weight_200g_sample_g: Optional[float] = None


class BiomassCalcRequest(BaseModel):
    area_m2: float
    wet_weight_kg: float
    dry_weight_kg: Optional[float] = None
    moisture_pct: Optional[float] = None


# --------------------------------------------------------------------------- #
# Platform Endpoints
# --------------------------------------------------------------------------- #
@router.get("/platforms")
def list_platforms(
    search: Optional[str] = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    return PlatformService.list_platforms(search=search, limit=limit, offset=offset)


@router.post("/platforms", status_code=201)
def create_platform(
    req: PlatformPayload,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_MANAGE)),
):
    payload = req.model_dump(exclude_unset=True)
    name = payload.pop("name")
    custom_id = payload.pop("platform_id", None)
    try:
        return PlatformService.create_platform(
            name=name,
            payload=payload,
            user_id=user.get("user_id"),
            platform_id=custom_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/platforms/{platform_id}")
def get_platform(
    platform_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    platform = PlatformService.get_platform(platform_id)
    if not platform:
        raise HTTPException(status_code=404, detail="Platform not found")
    return platform


@router.put("/platforms/{platform_id}")
def update_platform(
    platform_id: str,
    req: PlatformPayload,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_MANAGE)),
):
    payload = req.model_dump(exclude_unset=True)
    name = payload.pop("name")
    updated = PlatformService.update_platform(platform_id, name=name, payload=payload, user_id=user.get("user_id"))
    if not updated:
        raise HTTPException(status_code=404, detail="Platform not found")
    return updated


@router.delete("/platforms/{platform_id}")
def delete_platform(
    platform_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_MANAGE)),
):
    success = PlatformService.delete_platform(platform_id)
    if not success:
        raise HTTPException(status_code=404, detail="Platform not found")
    return {"status": "deleted", "platform_id": platform_id}


# --------------------------------------------------------------------------- #
# Media Upload & Presigned URL Endpoints (AWS S3)
# --------------------------------------------------------------------------- #
@router.post("/media/upload")
async def upload_research_media(
    file: UploadFile = File(...),
    category: str = Form("photos"),
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_MANAGE)),
):
    """Upload photo or sketch directly to configured AWS S3 bucket."""
    try:
        content = await file.read()
        if len(content) > 25 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="File size exceeds 25 MB limit.")
        result = upload_file_to_s3(
            file_bytes=content,
            filename=file.filename or "file",
            content_type=file.content_type or "image/jpeg",
            category=category,
        )
        return result
    except Exception as e:
        logger.error(f"S3 media upload failed: {e}")
        raise HTTPException(status_code=500, detail=f"S3 upload failed: {str(e)}")


@router.get("/media/view")
def view_research_media(
    key: str = Query(..., description="S3 object key"),
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    """Redirect to a freshly presigned S3 download URL."""
    try:
        url = generate_presigned_download_url(key)
        return RedirectResponse(url=url, status_code=307)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --------------------------------------------------------------------------- #
# Trial Endpoints
# --------------------------------------------------------------------------- #
@router.get("/trials")
def list_trials(
    platform_id: Optional[str] = None,
    independent: bool = False,
    search: Optional[str] = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    return TrialService.list_trials(
        platform_id=platform_id,
        independent_only=independent,
        search=search,
        limit=limit,
        offset=offset,
    )


@router.post("/trials", status_code=201)
def create_trial(
    req: TrialPayload,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_MANAGE)),
):
    payload = req.model_dump(exclude_unset=True)
    name = payload.pop("name")
    platform_id = payload.pop("platform_id", None)
    custom_trial_id = payload.pop("trial_id", None)
    try:
        return TrialService.create_trial(
            name=name,
            payload=payload,
            platform_id=platform_id,
            user_id=user.get("user_id"),
            trial_id=custom_trial_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/trials/{trial_id}")
def get_trial(
    trial_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    trial = TrialService.get_trial(trial_id)
    if not trial:
        raise HTTPException(status_code=404, detail="Trial not found")
    return trial


@router.put("/trials/{trial_id}")
def update_trial(
    trial_id: str,
    req: TrialPayload,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_MANAGE)),
):
    payload = req.model_dump(exclude_unset=True)
    name = payload.pop("name")
    platform_id = payload.pop("platform_id", None)
    updated = TrialService.update_trial(
        trial_id=trial_id,
        name=name,
        payload=payload,
        platform_id=platform_id,
        user_id=user.get("user_id"),
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Trial not found")
    return updated


@router.delete("/trials/{trial_id}")
def delete_trial(
    trial_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_MANAGE)),
):
    success = TrialService.delete_trial(trial_id)
    if not success:
        raise HTTPException(status_code=404, detail="Trial not found")
    return {"status": "deleted", "trial_id": trial_id}


@router.post("/trials/preview-design")
def preview_design(
    req: DesignPreviewRequest,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    """Generate live preview of Treatments table & Repeats table."""
    return FactorialDesignService.generate_matrix(
        treatments_count=req.treatments_count,
        replications_count=req.replications_count,
        subsamples_count=req.subsamples_count,
        factors=req.factors,
        custom_treatments=req.custom_treatments,
    )


@router.get("/trials/{trial_id}/export/excel")
def export_trial_excel(
    trial_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.DATA_EXPORT)),
):
    try:
        buffer = ResearchExportService.export_trial_workbook(trial_id)
        filename = f"Trial_{trial_id}_Report.xlsx"
        return StreamingResponse(
            buffer,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# --------------------------------------------------------------------------- #
# Cycle Endpoints
# --------------------------------------------------------------------------- #
@router.get("/trials/{trial_id}/cycles")
def list_cycles(
    trial_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    return CycleService.list_cycles(trial_id)


@router.post("/trials/{trial_id}/cycles", status_code=201)
def create_cycle(
    trial_id: str,
    req: CyclePayload,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_MANAGE)),
):
    payload = req.model_dump(exclude_unset=True)
    year = payload.pop("year")
    season = payload.pop("season")
    return CycleService.create_cycle(
        trial_id=trial_id,
        year=year,
        season=season,
        payload=payload,
        user_id=user.get("user_id"),
    )


@router.get("/cycles/{cycle_id}")
def get_cycle(
    cycle_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    cycle = CycleService.get_cycle(cycle_id)
    if not cycle:
        raise HTTPException(status_code=404, detail="Cycle not found")
    return cycle


@router.put("/cycles/{cycle_id}")
def update_cycle(
    cycle_id: str,
    req: CyclePayload,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_MANAGE)),
):
    payload = req.model_dump(exclude_unset=True)
    year = payload.pop("year")
    season = payload.pop("season")
    updated = CycleService.update_cycle(
        cycle_id=cycle_id,
        year=year,
        season=season,
        payload=payload,
        user_id=user.get("user_id"),
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Cycle not found")
    return updated


# --------------------------------------------------------------------------- #
# Protocol Endpoints
# --------------------------------------------------------------------------- #
@router.get("/cycles/{cycle_id}/protocol")
def get_cycle_protocol(
    cycle_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    protocol = ProtocolService.get_protocol_for_cycle(cycle_id)
    if not protocol:
        # Return empty payload indicator so UI can prompt to create
        return {"exists": False, "cycle_id": cycle_id}
    return {"exists": True, **protocol}


@router.post("/cycles/{cycle_id}/protocol")
def save_protocol(
    cycle_id: str,
    req: ProtocolPayload,
    user: Dict[str, Any] = Depends(needs(permissions.PROTOCOL_MANAGE)),
):
    payload = req.model_dump(exclude_unset=True)
    return ProtocolService.save_protocol(cycle_id=cycle_id, payload=payload, user_id=user.get("user_id"))


@router.get("/protocols/{protocol_id}")
def get_protocol(
    protocol_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    protocol = ProtocolService.get_protocol(protocol_id)
    if not protocol:
        raise HTTPException(status_code=404, detail="Protocol not found")
    return protocol


@router.get("/protocols/{protocol_id}/stats")
def get_protocol_statistics(
    protocol_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    return ObservationService.get_protocol_statistics(protocol_id)


# --------------------------------------------------------------------------- #
# Observation Endpoints
# --------------------------------------------------------------------------- #
@router.get("/protocols/{protocol_id}/observations")
def list_observations(
    protocol_id: str,
    module_type: Optional[str] = None,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    return ObservationService.list_observations(protocol_id, module_type=module_type)


@router.post("/protocols/{protocol_id}/observations", status_code=201)
def create_observation(
    protocol_id: str,
    module_type: str = Query(..., description="operations, plants, yield, biomass"),
    req: ObservationPayload = ...,
    user: Dict[str, Any] = Depends(needs(permissions.DATA_CAPTURE)),
):
    payload = req.model_dump(exclude_unset=True)
    return ObservationService.create_observation(
        protocol_id=protocol_id,
        module_type=module_type,
        payload=payload,
        user_id=user.get("user_id"),
    )


@router.post("/protocols/{protocol_id}/observations/bulk", status_code=201)
def bulk_save_observations(
    protocol_id: str,
    req: BulkObservationRequest,
    user: Dict[str, Any] = Depends(needs(permissions.DATA_CAPTURE)),
):
    return ObservationService.bulk_save_observations(
        protocol_id=protocol_id,
        module_type=req.module_type,
        observations=req.observations,
        user_id=user.get("user_id"),
    )


@router.delete("/observations/{obs_id}")
def delete_observation(
    obs_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.DATA_CAPTURE)),
):
    success = ObservationService.delete_observation(obs_id)
    if not success:
        raise HTTPException(status_code=404, detail="Observation not found")
    return {"status": "deleted", "obs_id": obs_id}


# --------------------------------------------------------------------------- #
# Live Calculation Helper Endpoints (Instant feedback for frontend)
# --------------------------------------------------------------------------- #
@router.post("/calc/yield")
def calculate_yield_endpoint(
    req: YieldCalcRequest,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    return calculations.calculate_yield(
        area_m2=req.area_m2,
        grain_weight_kg=req.grain_weight_kg,
        moisture_pct=req.moisture_pct,
        standard_moisture_pct=req.standard_moisture_pct or 14.0,
        weight_1000_grains_g=req.weight_1000_grains_g,
        weight_200g_sample_g=req.weight_200g_sample_g,
    )


@router.post("/calc/biomass")
def calculate_biomass_endpoint(
    req: BiomassCalcRequest,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    return calculations.calculate_biomass(
        area_m2=req.area_m2,
        wet_weight_kg=req.wet_weight_kg,
        dry_weight_kg=req.dry_weight_kg,
        moisture_pct=req.moisture_pct,
    )


# --------------------------------------------------------------------------- #
# Research Form Studio Endpoints (Visual Web/Mobile Form Builder for Scientists)
# --------------------------------------------------------------------------- #
@router.get("/forms")
def list_research_forms(
    platform_id: Optional[str] = Query(None),
    trial_id: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    return ResearchFormService.list_forms(
        platform_id=platform_id,
        trial_id=trial_id,
        category=category,
        status=status,
        search=search,
    )


@router.get("/forms/{form_id}")
def get_research_form(
    form_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    f = ResearchFormService.get_form(form_id)
    if not f:
        raise HTTPException(status_code=404, detail="Research form not found")
    return f


@router.post("/forms", status_code=201)
def create_research_form(
    req: ResearchFormCreateRequest,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_MANAGE)),
):
    username = user.get("username") or user.get("sub") or "scientist"
    return ResearchFormService.create_form(
        title=req.title,
        description=req.description or "",
        category=req.category or "General Agronomy",
        form_json=req.form_json,
        platform_id=req.platform_id,
        trial_id=req.trial_id,
        status=req.status or "Draft",
        created_by=username,
    )


@router.put("/forms/{form_id}")
def update_research_form(
    form_id: str,
    req: ResearchFormUpdateRequest,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_MANAGE)),
):
    try:
        return ResearchFormService.update_form(
            form_id=form_id,
            form_json=req.form_json,
            title=req.title,
            description=req.description,
            category=req.category,
            status=req.status,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/forms/{form_id}")
def delete_research_form(
    form_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_MANAGE)),
):
    success = ResearchFormService.delete_form(form_id)
    if not success:
        raise HTTPException(status_code=404, detail="Research form not found")
    return {"status": "deleted", "form_id": form_id}


@router.post("/forms/{form_id}/duplicate", status_code=201)
def duplicate_research_form(
    form_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_MANAGE)),
):
    username = user.get("username") or user.get("sub") or "scientist"
    try:
        return ResearchFormService.duplicate_form(form_id, created_by=username)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/forms/{form_id}/submissions", status_code=201)
def submit_research_form_data(
    form_id: str,
    req: ResearchFormSubmitRequest,
    user: Dict[str, Any] = Depends(needs(permissions.DATA_CAPTURE)),
):
    username = user.get("username") or user.get("sub") or "field_worker"
    return ResearchFormService.submit(
        form_id=form_id,
        data=req.data,
        trial_id=req.trial_id,
        cycle_id=req.cycle_id,
        plot_no=req.plot_no,
        treatment_id=req.treatment_id,
        created_by=username,
    )


@router.get("/forms/{form_id}/submissions")
def list_research_form_submissions(
    form_id: str,
    trial_id: Optional[str] = Query(None),
    cycle_id: Optional[str] = Query(None),
    plot_no: Optional[int] = Query(None),
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    return ResearchFormService.list_submissions(
        form_id=form_id,
        trial_id=trial_id,
        cycle_id=cycle_id,
        plot_no=plot_no,
    )


@router.get("/forms/{form_id}/package")
def get_research_form_offline_package(
    form_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    try:
        return ResearchFormService.get_package(form_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/forms/{form_id}/export")
def export_research_form_excel(
    form_id: str,
    user: Dict[str, Any] = Depends(needs(permissions.PLATFORM_VIEW)),
):
    try:
        buf = ResearchExportService.export_form_workbook(form_id)
        f = ResearchFormService.get_form(form_id)
        safe_name = (f["title"] if f else form_id).replace(" ", "_")[:30]
        return StreamingResponse(
            buf,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="Research_Form_{safe_name}.xlsx"'},
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

