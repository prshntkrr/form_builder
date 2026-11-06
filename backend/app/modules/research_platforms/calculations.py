"""Agronomic and statistical calculations for Research Platforms & Trials.

Implements the standard CIMMYT formulas for:
1. Moisture-adjusted grain yield (t/ha)
2. Grains per m2 estimation
3. Fresh and dry biomass yields (t/ha) and H2O biomass
4. Per-treatment statistical summaries (Mean, Variance, Std Deviation, Std Error)
"""

import math
from typing import Any, Dict, List, Optional


def calculate_yield(
    area_m2: float,
    grain_weight_kg: float,
    moisture_pct: Optional[float] = None,
    standard_moisture_pct: float = 14.0,
    weight_1000_grains_g: Optional[float] = None,
    weight_200g_sample_g: Optional[float] = None,
) -> Dict[str, Any]:
    """Calculate adjusted grain yield (t/ha) and density metrics.

    Formula:
        Adjusted Weight = Gross Weight * (100 - Harvest Moisture) / (100 - Standard Moisture)
        Yield (t/ha) = (Adjusted Weight (kg) / Area (m2)) * 10
    """
    if area_m2 <= 0 or grain_weight_kg < 0:
        return {
            "adjusted_weight_kg": 0.0,
            "yield_tha": 0.0,
            "grains_per_m2": None,
        }

    # If moisture is not specified, assume standard moisture
    m_pct = moisture_pct if moisture_pct is not None else standard_moisture_pct
    m_pct = max(0.0, min(100.0, float(m_pct)))
    std_m = max(0.0, min(100.0, float(standard_moisture_pct)))

    adjustment_factor = (100.0 - m_pct) / (100.0 - std_m) if std_m < 100.0 else 1.0
    adjusted_weight_kg = grain_weight_kg * adjustment_factor

    # Yield in metric tons per hectare
    yield_tha = (adjusted_weight_kg / area_m2) * 10.0

    # Grains per m2 calculation
    grains_m2 = None
    if weight_1000_grains_g and weight_1000_grains_g > 0:
        total_grams = grain_weight_kg * 1000.0
        total_grains = (total_grams / weight_1000_grains_g) * 1000.0
        grains_m2 = round(total_grains / area_m2, 1)

    return {
        "harvest_area_m2": round(area_m2, 2),
        "gross_grain_weight_kg": round(grain_weight_kg, 3),
        "grain_moisture_percent": round(m_pct, 2),
        "standard_moisture_percent": round(std_m, 2),
        "adjusted_weight_kg": round(adjusted_weight_kg, 3),
        "yield_tha": round(yield_tha, 3),
        "grains_per_m2": grains_m2,
        "weight_1000_grains_g": weight_1000_grains_g,
        "sample_200g_weight": weight_200g_sample_g,
    }


def calculate_biomass(
    area_m2: float,
    wet_weight_kg: float,
    dry_weight_kg: Optional[float] = None,
    moisture_pct: Optional[float] = None,
) -> Dict[str, Any]:
    """Calculate wet yield, dry yield (t/ha), and moisture metrics.

    Formula:
        Wet Yield (t/ha) = (Wet Weight / Area) * 10
        Dry Yield (t/ha) = (Dry Weight / Area) * 10
        H2O Biomass (t/ha) = ((Wet Weight - Dry Weight) / Area) * 10
    """
    if area_m2 <= 0 or wet_weight_kg < 0:
        return {
            "wet_yield_tha": 0.0,
            "dry_yield_tha": 0.0,
            "h2o_biomass_tha": 0.0,
            "moisture_pct": 0.0,
        }

    wet_yield_tha = (wet_weight_kg / area_m2) * 10.0

    if dry_weight_kg is not None and dry_weight_kg >= 0:
        calc_dry_kg = dry_weight_kg
        calc_moisture = (
            ((wet_weight_kg - calc_dry_kg) / wet_weight_kg * 100.0)
            if wet_weight_kg > 0
            else 0.0
        )
    elif moisture_pct is not None:
        calc_moisture = max(0.0, min(100.0, float(moisture_pct)))
        calc_dry_kg = wet_weight_kg * (1.0 - calc_moisture / 100.0)
    else:
        calc_dry_kg = wet_weight_kg
        calc_moisture = 0.0

    dry_yield_tha = (calc_dry_kg / area_m2) * 10.0
    h2o_biomass_tha = max(0.0, wet_yield_tha - dry_yield_tha)

    return {
        "area_m2": round(area_m2, 2),
        "wet_weight_kg": round(wet_weight_kg, 3),
        "dry_weight_kg": round(calc_dry_kg, 3),
        "moisture_pct": round(calc_moisture, 2),
        "wet_yield_tha": round(wet_yield_tha, 3),
        "dry_yield_tha": round(dry_yield_tha, 3),
        "h2o_biomass_tha": round(h2o_biomass_tha, 3),
    }


def compute_group_statistics(values: List[float]) -> Dict[str, Any]:
    """Calculate Mean, Variance, Standard Deviation, and Standard Error."""
    clean = [float(v) for v in values if v is not None and not math.isnan(float(v))]
    n = len(clean)
    if n == 0:
        return {
            "n": 0,
            "mean": None,
            "variance": None,
            "std_dev": None,
            "std_error": None,
        }

    mean_val = sum(clean) / n
    if n == 1:
        return {
            "n": 1,
            "mean": round(mean_val, 3),
            "variance": 0.0,
            "std_dev": 0.0,
            "std_error": 0.0,
        }

    variance_val = sum((x - mean_val) ** 2 for x in clean) / (n - 1)
    std_dev_val = math.sqrt(variance_val)
    std_error_val = std_dev_val / math.sqrt(n)

    return {
        "n": n,
        "mean": round(mean_val, 3),
        "variance": round(variance_val, 4),
        "std_dev": round(std_dev_val, 3),
        "std_error": round(std_error_val, 3),
    }


def aggregate_treatment_statistics(
    observations: List[Dict[str, Any]],
    metric_key: str,
    treatments_map: Optional[Dict[Any, str]] = None,
) -> List[Dict[str, Any]]:
    """Group observations by treatment_id and compute statistical metrics.

    metric_key: e.g. 'yield_tha', 'dry_yield_tha', etc.
    """
    by_treatment: Dict[Any, List[float]] = {}
    treatments_map = treatments_map or {}

    for obs in observations:
        payload = obs.get("payload", {})
        t_id = payload.get("treatment_id")
        if t_id is None:
            continue

        # Look for metric in computed_results or top level of payload
        computed = payload.get("computed_results", {})
        val = computed.get(metric_key, payload.get(metric_key))
        if val is not None:
            by_treatment.setdefault(t_id, []).append(float(val))

    results = []
    for t_id, values in sorted(by_treatment.items(), key=lambda x: str(x[0])):
        stats = compute_group_statistics(values)
        results.append({
            "treatment_id": t_id,
            "treatment_label": treatments_map.get(t_id, f"Treatment {t_id}"),
            "values": values,
            **stats,
        })

    return results
