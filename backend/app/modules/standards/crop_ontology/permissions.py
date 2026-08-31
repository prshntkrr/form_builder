"""What the crop ontology module lets a role do."""
from app.core.permissions import Permission, register

CROP_ONTOLOGY_VIEW = "crop_ontology.view"
CROP_ONTOLOGY_MANAGE = "crop_ontology.manage"

CATALOGUE = [
    Permission(CROP_ONTOLOGY_VIEW, "Use crop ontologies",
               "Search crop traits and variables, and attach one to a question",
               "Crop ontology"),
    Permission(CROP_ONTOLOGY_MANAGE, "Import crop ontologies",
               "Download and load crop ontologies, and remove one", "Crop ontology"),
]

register(
    permissions=CATALOGUE,
    groups=["Crop ontology"],
    grants={"editor": [CROP_ONTOLOGY_VIEW]},
    capabilities={"use_crop_ontology": CROP_ONTOLOGY_VIEW},
)
