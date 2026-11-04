"""Verify Research Platforms & Trials module end-to-end."""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import json
from app.core.database import init_pool, transaction, close_pool
from app.modules.research_platforms.bootstrap import ensure_research_tables
from app.modules.research_platforms.services import (
    PlatformService,
    TrialService,
    FactorialDesignService,
    CycleService,
    ProtocolService,
    ObservationService,
    ResearchExportService,
    ResearchFormService,
)
from app.modules.research_platforms.calculations import calculate_yield, calculate_biomass

def test_module():
    init_pool()
    print("Testing Research Platforms module...")

    # Ensure tables and seed data
    ensure_research_tables()

    # 1. Verify tables in database
    with transaction() as cur:
        cur.execute("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'research_%' ORDER BY table_name")
        tables = [r['table_name'] for r in cur.fetchall()]
        print("1. Tables verified:", tables)
        assert len(tables) == 7, f"Expected 7 tables, found {len(tables)}"

    # 2. Test Factorial Design generation
    design = FactorialDesignService.generate_matrix(
        treatments_count=3,
        replications_count=3,
        subsamples_count=0,
        factors=[
            {"name": "Tillage", "levels": ["Zero Tillage", "Conventional"]},
            {"name": "Residue", "levels": ["Retained", "Removed"]},
        ]
    )
    print("2. Generated Design:", design["treatments_count"], "treatments,", len(design["repeats_table"]), "plot rows")
    assert len(design["treatments"]) == 4, "2x2 factorial should produce 4 treatments"
    assert len(design["repeats_table"]) == 12, "4 treatments * 3 reps = 12 plot rows"

    # 3. Test Platform creation
    platform = PlatformService.create_platform(
        name="Texcoco Research Station D5",
        payload={
            "abbreviation": "TEX-D5",
            "country": "Mexico",
            "state_province": "State of Mexico",
            "municipality": "Texcoco",
            "elevation": 2250,
            "soil_type": "Clay loam",
            "climate_type": "Temperate sub-humid",
            "polygon_geojson": {
                "type": "Polygon",
                "coordinates": [[[-98.88, 19.50], [-98.87, 19.50], [-98.87, 19.49], [-98.88, 19.49], [-98.88, 19.50]]]
            },
            "surface_area_ha": 4.5,
        },
        user_id="test_admin"
    )
    plat_id = platform["platform_id"]
    print("3. Created Platform:", plat_id, platform["name"])

    # 4. Test Trial creation (linked to platform)
    trial = TrialService.create_trial(
        name="Long-Term Maize Conservation Trial",
        platform_id=plat_id,
        payload={
            "objective": "Evaluate 30-year yield stability under zero tillage vs conventional",
            "design": design,
        },
        user_id="test_admin"
    )
    trial_id = trial["trial_id"]
    print("4. Created Trial:", trial_id, trial["name"])

    # 5. Test Cycle creation
    cycle = CycleService.create_cycle(
        trial_id=trial_id,
        year=2025,
        season="PV",
        payload={
            "main_crop": "Maize",
            "maize_type": "White hybrid",
            "pv_humidity_regime": "Rainfed",
            "stratum": "High Valley",
            "principal_investigator": {"name": "Dr. Simon Fonteyne", "email": "s.fonteyne@cgiar.org"},
            "technical_responsible": {"name": "Daniel Nunez", "email": "d.nunez@cgiar.org"}
        },
        user_id="test_admin"
    )
    cycle_id = cycle["cycle_id"]
    print("5. Created Cycle:", cycle_id, cycle["year"], cycle["season"])

    # 6. Test Protocol creation and treatment snapshotting
    protocol = ProtocolService.save_protocol(
        cycle_id=cycle_id,
        payload={
            "sowing_date": "2025-06-10",
            "harvest_date": "2025-11-15",
            "harvest_area_m2": 24.0,
            "crop_varieties": "H-520",
            "planting_density": 65000,
            "fertilization_practices": "200-60-00 N-P-K split into 2 applications",
            "pest_weed_management": "Pre-emergence atrazine + post-emergence broadleaf herbicide",
        },
        user_id="test_admin"
    )
    protocol_id = protocol["protocol_id"]
    assert "frozen_treatments_snapshot" in protocol["payload"], "Snapshot must be inherited and frozen"
    print("6. Created Protocol with frozen snapshot:", protocol_id)

    # 7. Test Field Observations (Operations, Plants, Yield, Biomass)
    # Operations observation
    op_obs = ObservationService.create_observation(
        protocol_id=protocol_id,
        module_type="operations",
        payload={
            "date": "2025-06-10",
            "operation": "Sowing",
            "applicable_treatments": [1, 2, 3, 4],
            "cost_total": 450.0,
            "notes": "Mechanized sowing with precision planter"
        },
        user_id="test_admin"
    )
    print("7a. Logged Operation:", op_obs["obs_id"])

    # Yield observation with automated calculations
    yield_obs = ObservationService.create_observation(
        protocol_id=protocol_id,
        module_type="yield",
        payload={
            "plot_no": 101,
            "treatment_id": 1,
            "raw_inputs": {
                "harvest_area_m2": 24.0,
                "gross_grain_weight_kg": 19.5,
                "grain_moisture_percent": 16.8,
                "weight_1000_grains_g": 320.0
            }
        },
        user_id="test_admin"
    )
    calc = yield_obs["payload"]["computed_results"]
    print(f"7b. Logged Yield observation: Gross={calc['gross_grain_weight_kg']}kg, Adj={calc['adjusted_weight_kg']}kg, Yield={calc['yield_tha']} t/ha, Grains/m2={calc['grains_per_m2']}")
    assert calc["yield_tha"] > 0, "Yield must be calculated"

    # Add second yield plot for statistics test
    ObservationService.create_observation(
        protocol_id=protocol_id,
        module_type="yield",
        payload={
            "plot_no": 105,
            "treatment_id": 1,
            "raw_inputs": {
                "harvest_area_m2": 24.0,
                "gross_grain_weight_kg": 20.2,
                "grain_moisture_percent": 16.5,
            }
        },
        user_id="test_admin"
    )

    # 8. Test Statistical summary per treatment
    stats = ObservationService.get_protocol_statistics(protocol_id)
    print("8. Treatment Yield Statistics:", stats["yield_statistics"])
    assert len(stats["yield_statistics"]) > 0
    t1_stat = stats["yield_statistics"][0]
    print(f"   Treatment 1 Mean: {t1_stat['mean']} t/ha, Std Error: {t1_stat['std_error']}")

    # 9. Test Excel Workbook Export
    wb_buf = ResearchExportService.export_trial_workbook(trial_id)
    print("9. Excel Workbook exported successfully:", len(wb_buf.getvalue()), "bytes")

    # 10. Test Research Form Studio (Custom Web/Mobile Forms for Scientists)
    forms = ResearchFormService.list_forms()
    print(f"10a. Seeded Research Forms listed: {len(forms)} forms found")
    assert len(forms) >= 4, "Should have at least 4 default research form templates"

    # Create a custom research form for the trial
    custom_form = ResearchFormService.create_form(
        title="Canopy Temperature & Thermal Imaging",
        description="Infrared thermometry and canopy temperature depression evaluation",
        category="Physiology & Phenotyping",
        trial_id=trial_id,
        status="Active",
        form_json={
            "title": "Canopy Temperature & Thermal Imaging",
            "channel": "web_mobile",
            "sections": [{"key": "s1", "title": "Thermal Data", "description": ""}],
            "fields": [
                {"name": "plot_no", "label": "Plot Number", "type": "number", "required": True, "section": "s1"},
                {"name": "canopy_temp_c", "label": "Canopy Temperature (°C)", "type": "decimal", "required": True, "section": "s1"},
                {"name": "ambient_temp_c", "label": "Ambient Temperature (°C)", "type": "decimal", "required": True, "section": "s1"},
                {"name": "thermal_image", "label": "FLIR Thermal Image", "type": "image", "required": False, "section": "s1"},
            ]
        },
        created_by="scientist_dr_jane"
    )
    rf_id = custom_form["form_id"]
    print(f"10b. Created custom research form: {rf_id} - {custom_form['title']}")

    # Submit a plot observation for Plot 101
    submission = ResearchFormService.submit(
        form_id=rf_id,
        trial_id=trial_id,
        cycle_id=cycle_id,
        plot_no=101,
        data={
            "plot_no": 101,
            "canopy_temp_c": 22.4,
            "ambient_temp_c": 28.1,
            "thermal_notes": "Optimal transpiration and low water stress"
        },
        created_by="field_technician"
    )
    print(f"10c. Submitted custom research data: {submission['submission_id']}, Plot {submission['plot_no']}, Auto-assigned Treatment {submission['treatment_id']}")
    assert submission["plot_no"] == 101
    assert submission["treatment_id"] == 1, "Should auto-detect Treatment 1 from Plot 101 in frozen protocol"

    # Test Mobile offline package
    pkg = ResearchFormService.get_package(rf_id)
    print(f"10d. Generated mobile package: {pkg['form_id']}, channel: {pkg['channel']}, fields: {len(pkg['fields'])}")
    assert pkg["channel"] == "web_mobile"

    # Test updated Excel export with custom form sheet
    wb_buf2 = ResearchExportService.export_trial_workbook(trial_id)
    print(f"10e. Re-exported trial workbook with custom form sheet: {len(wb_buf2.getvalue())} bytes")

    print("\nALL BACKEND TESTS PASSED!")
    close_pool()

if __name__ == "__main__":
    test_module()
