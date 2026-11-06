"""Idempotent migrations and setup for Research Platforms & Long-Term Trials."""

import logging
from pathlib import Path
from app.core.database import table_exists, transaction

logger = logging.getLogger(__name__)
SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"

REQUIRED_TABLES = [
    "research_platform",
    "research_trial",
    "research_cycle",
    "research_protocol",
    "research_observation",
    "research_form",
    "research_form_submission",
]


def ensure_research_tables() -> bool:
    """Ensure all JSONB envelope tables exist and seed initial research templates if needed."""
    applied = False
    with transaction() as cur:
        missing = [t for t in REQUIRED_TABLES if not table_exists(cur, t)]
        if missing:
            logger.info("Applying research_platforms schema.sql (missing: %s)", ", ".join(missing))
            if SCHEMA_PATH.exists():
                cur.execute(SCHEMA_PATH.read_text(encoding="utf-8"))
                applied = True
            else:
                logger.error("schema.sql not found at %s", SCHEMA_PATH)

        # Ensure public share columns exist on research_form
        if table_exists(cur, "research_form"):
            cur.execute("""
                ALTER TABLE research_form ADD COLUMN IF NOT EXISTS public_token VARCHAR(64);
                ALTER TABLE research_form ADD COLUMN IF NOT EXISTS public_enabled BOOLEAN NOT NULL DEFAULT FALSE;
                ALTER TABLE research_form ADD COLUMN IF NOT EXISTS public_expires_on TIMESTAMP;
                ALTER TABLE research_form ADD COLUMN IF NOT EXISTS public_allow_multiple BOOLEAN NOT NULL DEFAULT TRUE;
                ALTER TABLE research_form ADD COLUMN IF NOT EXISTS public_shared_by VARCHAR(50);
                ALTER TABLE research_form ADD COLUMN IF NOT EXISTS public_shared_on TIMESTAMP;

                CREATE UNIQUE INDEX IF NOT EXISTS uq_research_form_public_token
                    ON research_form (public_token)
                    WHERE public_token IS NOT NULL;
            """)

        # Seed initial research templates if empty
        if table_exists(cur, "research_form"):
            cur.execute("SELECT COUNT(*) AS c FROM research_form")
            row = cur.fetchone()
            if row and row["c"] == 0:
                _seed_initial_templates(cur)

    return applied


def _seed_initial_templates(cur) -> None:
    """Seeds standard agronomic research templates."""
    import json

    templates = [
        {
            "form_id": "RFRM00001",
            "title": "Field Phenotyping & Plant Measurements",
            "description": "Standardized plot phenotyping, height measurements, SPAD chlorophyll index, and lodging assessments.",
            "category": "Physiology & Phenotyping",
            "form_json": {
                "title": "Field Phenotyping & Plant Measurements",
                "description": "Plot-level physiological and morphological trait evaluations.",
                "table_name": "phenotyping_measurements",
                "channel": "web_mobile",
                "version": 1,
                "sections": [
                    {"key": "sec_plot", "title": "Plot Identification", "description": "Experimental unit"},
                    {"key": "sec_canopy", "title": "Canopy & Morphology", "description": "Vegetative measurements"},
                    {"key": "sec_health", "title": "Plant Vigor & Quality", "description": "Health status and photos"}
                ],
                "fields": [
                    {"name": "plot_no", "label": "Plot Number", "type": "number", "required": True, "section": "sec_plot", "validation": {"min": 1, "max": 999}, "order": 1},
                    {"name": "measurement_date", "label": "Evaluation Date", "type": "date", "required": True, "section": "sec_plot", "order": 2},
                    {"name": "plant_height_cm", "label": "Average Plant Height (cm)", "type": "decimal", "required": True, "section": "sec_canopy", "validation": {"min": 0, "max": 450}, "order": 3},
                    {"name": "stem_diameter_mm", "label": "Stem Diameter (mm)", "type": "decimal", "required": False, "section": "sec_canopy", "order": 4},
                    {"name": "spad_index", "label": "Chlorophyll Index (SPAD)", "type": "decimal", "required": False, "section": "sec_canopy", "validation": {"min": 0, "max": 99.9}, "order": 5},
                    {"name": "lodging_pct", "label": "Lodging / Bedding Percentage (%)", "type": "number", "required": False, "section": "sec_health", "validation": {"min": 0, "max": 100}, "order": 6},
                    {"name": "canopy_photo", "label": "Canopy Photograph", "type": "image", "required": False, "section": "sec_health", "order": 7},
                    {"name": "phenotype_notes", "label": "Agronomist Notes & Observations", "type": "textarea", "required": False, "section": "sec_health", "order": 8}
                ]
            }
        },
        {
            "form_id": "RFRM00002",
            "title": "Soil Chemistry & Fertility Analysis",
            "description": "Comprehensive soil sampling log recording pH, macronutrients (N, P, K), organic matter %, and moisture content.",
            "category": "Soil & Water",
            "form_json": {
                "title": "Soil Chemistry & Fertility Analysis",
                "description": "Laboratory and field chemical analysis of soil samples.",
                "table_name": "soil_chemistry_analysis",
                "channel": "web_mobile",
                "version": 1,
                "sections": [
                    {"key": "sec_sample", "title": "Sample Identification", "description": "Core depth and plot"},
                    {"key": "sec_chem", "title": "Chemical Parameters", "description": "Soil pH and nutrient levels"}
                ],
                "fields": [
                    {"name": "plot_no", "label": "Plot Number", "type": "number", "required": True, "section": "sec_sample", "order": 1},
                    {"name": "sampling_depth_cm", "label": "Sampling Depth (cm)", "type": "select", "options": [{"label": "0 - 15 cm", "value": "0-15"}, {"label": "15 - 30 cm", "value": "15-30"}, {"label": "30 - 60 cm", "value": "30-60"}], "required": True, "section": "sec_sample", "order": 2},
                    {"name": "soil_ph", "label": "Soil pH (1:2.5 H2O)", "type": "decimal", "required": True, "section": "sec_chem", "validation": {"min": 3.0, "max": 11.0}, "order": 3},
                    {"name": "organic_matter_pct", "label": "Organic Matter (%)", "type": "decimal", "required": False, "section": "sec_chem", "validation": {"min": 0, "max": 20}, "order": 4},
                    {"name": "nitrogen_ppm", "label": "Nitrate Nitrogen (NO3-N ppm)", "type": "decimal", "required": False, "section": "sec_chem", "order": 5},
                    {"name": "phosphorus_ppm", "label": "Available Phosphorus Bray-1 (ppm)", "type": "decimal", "required": False, "section": "sec_chem", "order": 6},
                    {"name": "potassium_ppm", "label": "Exchangeable Potassium (ppm)", "type": "decimal", "required": False, "section": "sec_chem", "order": 7},
                    {"name": "soil_gps", "label": "Sampling Core Location", "type": "location", "required": False, "section": "sec_sample", "order": 8}
                ]
            }
        },
        {
            "form_id": "RFRM00003",
            "title": "Pest & Disease Scouting Log",
            "description": "In-season phytosanitary monitoring: incidence, severity rating (1-5), insect counts, and affected leaf area.",
            "category": "Pathology & Pests",
            "form_json": {
                "title": "Pest & Disease Scouting Log",
                "description": "Field scout log for pests, fungal diseases, and viral symptoms.",
                "table_name": "pest_disease_scouting",
                "channel": "web_mobile",
                "version": 1,
                "sections": [
                    {"key": "sec_scout", "title": "Scouting Overview", "description": "Plot and scouting date"},
                    {"key": "sec_symptoms", "title": "Phytosanitary Symptoms", "description": "Pathogen assessment"}
                ],
                "fields": [
                    {"name": "plot_no", "label": "Plot Number", "type": "number", "required": True, "section": "sec_scout", "order": 1},
                    {"name": "scout_date", "label": "Scouting Date", "type": "date", "required": True, "section": "sec_scout", "order": 2},
                    {"name": "target_organism", "label": "Target Organism Type", "type": "radio", "options": [{"label": "Fungal Disease", "value": "fungus"}, {"label": "Insect Pest", "value": "insect"}, {"label": "Weed Infestation", "value": "weed"}, {"label": "Nutrient Deficiency", "value": "deficiency"}], "required": True, "section": "sec_symptoms", "order": 3},
                    {"name": "pathogen_name", "label": "Specific Disease or Insect Name", "type": "text", "placeholder": "e.g. Fall Armyworm (Spodoptera frugiperda), Tar Spot", "required": True, "section": "sec_symptoms", "order": 4},
                    {"name": "severity_score", "label": "Severity Scale (1 to 5)", "type": "rating", "validation": {"max": 5}, "required": True, "section": "sec_symptoms", "order": 5},
                    {"name": "affected_incidence_pct", "label": "Incidence (% of plants affected)", "type": "number", "validation": {"min": 0, "max": 100}, "required": False, "section": "sec_symptoms", "order": 6},
                    {"name": "symptom_photo", "label": "Close-up Symptom Photo", "type": "image", "required": False, "section": "sec_symptoms", "order": 7}
                ]
            }
        },
        {
            "form_id": "RFRM00004",
            "title": "Grain Quality & Post-Harvest Lab",
            "description": "Grain quality laboratory evaluation: test weight (kg/hl), 1000-grain weight (TKW), protein %, and defect percentage.",
            "category": "Harvest & Quality",
            "form_json": {
                "title": "Grain Quality & Post-Harvest Lab",
                "description": "Post-harvest physical and chemical grain quality measurements.",
                "table_name": "grain_quality_lab",
                "channel": "web_mobile",
                "version": 1,
                "sections": [
                    {"key": "sec_grain", "title": "Physical Grain Quality", "description": "Weight and density"},
                    {"key": "sec_comp", "title": "Grain Composition", "description": "Chemical composition"}
                ],
                "fields": [
                    {"name": "plot_no", "label": "Plot Number", "type": "number", "required": True, "section": "sec_grain", "order": 1},
                    {"name": "tkw_grams", "label": "1000-Kernel Weight (TKW in g)", "type": "decimal", "required": True, "section": "sec_grain", "validation": {"min": 50, "max": 600}, "order": 2},
                    {"name": "test_weight_kghl", "label": "Test Weight / Hectoliter (kg/hl)", "type": "decimal", "required": True, "section": "sec_grain", "validation": {"min": 40, "max": 90}, "order": 3},
                    {"name": "grain_moisture_pct", "label": "Laboratory Grain Moisture (%)", "type": "decimal", "required": True, "section": "sec_grain", "validation": {"min": 5, "max": 35}, "order": 4},
                    {"name": "protein_content_pct", "label": "Crude Protein Content (%)", "type": "decimal", "required": False, "section": "sec_comp", "validation": {"min": 3, "max": 30}, "order": 5},
                    {"name": "defect_kernels_pct", "label": "Defective / Damaged Kernels (%)", "type": "decimal", "required": False, "section": "sec_comp", "validation": {"min": 0, "max": 100}, "order": 6}
                ]
            }
        }
    ]

    for t in templates:
        cur.execute(
            """
            INSERT INTO research_form (form_id, title, description, category, channel, status, form_json, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (form_id) DO NOTHING
            """,
            (
                t["form_id"],
                t["title"],
                t["description"],
                t["category"],
                "web_mobile",
                "Active",
                json.dumps(t["form_json"]),
                "CIMMYT_Standard",
            ),
        )
    logger.info("Seeded %d standard research form templates", len(templates))
