import json
import logging

logger = logging.getLogger(__name__)

SEED = [
    {"name": "Farmer Name", "data_type": "text", "category": "native", "ref_ontology": None,
     "field_json": {"type": "text", "required": True, "placeholder": "", "hint": "Full name of the farmer", "choices": [], "colWidth": 6}},
    {"name": "Phone Number", "data_type": "phone", "category": "native", "ref_ontology": None,
     "field_json": {"type": "phone", "required": True, "placeholder": "+91", "hint": "", "choices": [], "colWidth": 6}},
    {"name": "Village", "data_type": "text", "category": "native", "ref_ontology": None,
     "field_json": {"type": "text", "required": True, "placeholder": "", "hint": "Enter nearest village name", "choices": [], "colWidth": 6}},
    {"name": "GPS Coordinates", "data_type": "location", "category": "native", "ref_ontology": None,
     "field_json": {"type": "location", "required": False, "placeholder": "", "hint": "", "choices": [], "colWidth": 6}},
    {"name": "Crop Type", "data_type": "select", "category": "ontology", "ref_ontology": "CO_321:0000025",
     "field_json": {"type": "select", "required": True, "placeholder": "", "hint": "", "choices": ["Rice", "Wheat", "Maize", "Soybean", "Cotton", "Sugarcane", "Groundnut", "Mustard"], "colWidth": 4}},
    {"name": "Sowing Date", "data_type": "date", "category": "ontology", "ref_ontology": "CO_321:0000031",
     "field_json": {"type": "date", "required": True, "placeholder": "", "hint": "", "choices": [], "colWidth": 4}},
    {"name": "Harvest Date", "data_type": "date", "category": "ontology", "ref_ontology": "CO_321:0000032",
     "field_json": {"type": "date", "required": False, "placeholder": "", "hint": "", "choices": [], "colWidth": 4}},
    {"name": "Plot Area", "data_type": "decimal", "category": "ontology", "ref_ontology": "CO_321:0000017",
     "field_json": {"type": "decimal", "required": True, "placeholder": "0.00", "hint": "Area in hectares", "choices": [], "colWidth": 4}},
    {"name": "Irrigation Source", "data_type": "radio", "category": "native", "ref_ontology": None,
     "field_json": {"type": "radio", "required": False, "placeholder": "", "hint": "", "choices": ["Canal", "Borewell", "Rain-fed", "Drip", "Sprinkler"], "colWidth": 12}},
    {"name": "Soil Type", "data_type": "select", "category": "ontology", "ref_ontology": "CO_321:0000050",
     "field_json": {"type": "select", "required": False, "placeholder": "", "hint": "", "choices": ["Clay", "Sandy", "Loamy", "Silt", "Black Cotton", "Red"], "colWidth": 6}},
    {"name": "Fertilizer Used", "data_type": "multiselect", "category": "ontology", "ref_ontology": "CO_321:0000060",
     "field_json": {"type": "multiselect", "required": False, "placeholder": "", "hint": "", "choices": ["Urea", "DAP", "MOP", "SSP", "NPK", "Organic", "None"], "colWidth": 6}},
    {"name": "Pesticide Applied", "data_type": "boolean", "category": "native", "ref_ontology": None,
     "field_json": {"type": "boolean", "required": False, "placeholder": "", "hint": "", "choices": [], "colWidth": 6}},
    {"name": "Yield (kg/ha)", "data_type": "decimal", "category": "ontology", "ref_ontology": "CO_321:0000070",
     "field_json": {"type": "decimal", "required": False, "placeholder": "0.00", "hint": "Yield in kilograms per hectare", "choices": [], "colWidth": 4}},
    {"name": "Field Photo", "data_type": "image", "category": "native", "ref_ontology": None,
     "field_json": {"type": "image", "required": False, "placeholder": "", "hint": "Take a photo of the field", "choices": [], "colWidth": 12}},
    {"name": "Farmer Signature", "data_type": "signature", "category": "native", "ref_ontology": None,
     "field_json": {"type": "signature", "required": False, "placeholder": "", "hint": "", "choices": [], "colWidth": 12}},
    {"name": "State", "data_type": "select", "category": "native", "ref_ontology": None,
     "field_json": {"type": "select", "required": True, "placeholder": "", "hint": "", "choices": ["Maharashtra", "Karnataka", "Tamil Nadu", "Andhra Pradesh", "Telangana", "Madhya Pradesh", "Rajasthan", "Gujarat", "Punjab", "Haryana", "Uttar Pradesh", "Bihar"], "colWidth": 6}},
    {"name": "District", "data_type": "select", "category": "native", "ref_ontology": None,
     "field_json": {"type": "select", "required": False, "placeholder": "", "hint": "Depends on selected state", "choices": [], "colWidth": 6}},
    {"name": "Growth Stage", "data_type": "select", "category": "ontology", "ref_ontology": "CO_321:0000040",
     "field_json": {"type": "select", "required": False, "placeholder": "", "hint": "", "choices": ["Germination", "Seedling", "Vegetative", "Flowering", "Fruiting", "Maturity", "Harvest"], "colWidth": 6}},
    {"name": "Damage Type", "data_type": "multiselect", "category": "native", "ref_ontology": None,
     "field_json": {"type": "multiselect", "required": False, "placeholder": "", "hint": "", "choices": ["Pest", "Disease", "Drought", "Flood", "Hail", "Wind", "Animal"], "colWidth": 6}},
    {"name": "Damage Severity", "data_type": "rating", "category": "native", "ref_ontology": None,
     "field_json": {"type": "rating", "required": False, "placeholder": "", "hint": "1 = minor, 5 = total loss", "choices": [], "colWidth": 6}},
]


def seed_default_fields():
    from app.core.database import transaction

    with transaction() as cur:
        cur.execute("SELECT 1 FROM field_master LIMIT 1")
        if cur.fetchone():
            return

        logger.info("Seeding %d default field standards", len(SEED))
        for entry in SEED:
            cur.execute(
                "INSERT INTO field_master (name, data_type, category, ref_ontology, field_json)"
                " VALUES (%s, %s, %s, %s, %s)",
                (entry["name"], entry["data_type"], entry["category"],
                 entry["ref_ontology"], json.dumps(entry["field_json"])),
            )
