"""What the ontology module lets a role do."""
from app.core.permissions import Permission, register

ONTOLOGY_VIEW = "ontology.view"
ONTOLOGY_MANAGE = "ontology.manage"

CATALOGUE = [
    Permission(ONTOLOGY_VIEW, "Use the ontology",
               "Search concepts and pull standardised choices into a form", "Ontology"),
    Permission(ONTOLOGY_MANAGE, "Import ontologies",
               "Load an ontology file, and remove one that is no longer used", "Ontology"),
]

register(
    permissions=CATALOGUE,
    groups=["Ontology"],
    grants={"editor": [ONTOLOGY_VIEW]},
    capabilities={"use_ontology": ONTOLOGY_VIEW},
)
