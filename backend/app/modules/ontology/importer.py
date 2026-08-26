"""Reading an ontology file into the database.

Deliberately narrow. It takes named OWL classes and the direct `rdfs:subClassOf`
links between them, and stores nothing else — no axioms, no restrictions, no
blank nodes. That is all the application asks of an ontology: what a field
means, and what its standardised answers are.

Anonymous classes are skipped everywhere. In OWL they carry restrictions like
"irrigated by some water body", which are meaningful to a reasoner and useless
as a dropdown value — this ontology has 630 of them.

Re-running the import is safe: concepts are upserted on their URI and relations
on their (parent, child, type). Nothing is deleted, so a concept that has since
been referenced by a form survives an import of a smaller file.
"""
import logging
from pathlib import Path
from typing import Any, Dict, List, Tuple

from app.core.database import transaction

logger = logging.getLogger(__name__)

DEFAULT_ONTOLOGY = "SEOnt"

# Where an OBO-style ontology keeps a human-readable definition. Checked in
# order, so an ontology using a different predicate still yields something.
DEFINITION_PREDICATES = (
    "http://purl.obolibrary.org/obo/IAO_0000115",   # OBO "definition"
    "http://www.w3.org/2004/02/skos/core#definition",
    "http://www.w3.org/2000/01/rdf-schema#comment",
)


class ImportError_(RuntimeError):
    """The file could not be read as an ontology."""


def _rdflib():
    """Imported here, not at module load, so the application still starts if
    rdflib is missing — only importing an ontology needs it."""
    try:
        from rdflib import RDF, RDFS, OWL, Graph, URIRef
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise ImportError_(
            "rdflib is not installed. Add it with: pip install rdflib"
        ) from exc
    return RDF, RDFS, OWL, Graph, URIRef


def read_file(path: Path) -> Tuple[List[Dict[str, Any]], List[Tuple[str, str]], int]:
    """Parse the file and return (concepts, subclass pairs, triple count).

    No database work happens here, so this is the part that can be tested
    without Postgres.
    """
    RDF, RDFS, OWL, Graph, URIRef = _rdflib()

    if not path.exists():
        raise ImportError_(f"No ontology file at {path}")

    graph = Graph()
    try:
        graph.parse(str(path), format="xml")
    except Exception as exc:
        raise ImportError_(f"Could not read {path.name} as RDF/XML: {exc}") from exc

    definition_predicates = [URIRef(p) for p in DEFINITION_PREDICATES]

    concepts = []
    named_uris = set()
    for subject in graph.subjects(RDF.type, OWL.Class):
        # A blank node has no URI, so it can be neither referenced by a form nor
        # shown to anyone. Skip it as a concept.
        if not isinstance(subject, URIRef):
            continue

        uri = str(subject)
        label = graph.value(subject, RDFS.label)
        definition = None
        for predicate in definition_predicates:
            definition = graph.value(subject, predicate)
            if definition:
                break

        named_uris.add(uri)
        concepts.append({
            "concept_uri": uri,
            # A class with no label is still worth keeping — its URI ending is
            # the only name anyone has for it.
            "label": str(label).strip() if label else uri.rsplit("/", 1)[-1],
            "definition": str(definition).strip() if definition else "",
        })

    relations = []
    for child, parent in graph.subject_objects(RDFS.subClassOf):
        # Both ends must be named. A subClassOf pointing at a restriction is the
        # common case in OWL and is not a parent/child anyone can pick from.
        if not isinstance(child, URIRef) or not isinstance(parent, URIRef):
            continue
        if str(child) in named_uris and str(parent) in named_uris:
            relations.append((str(parent), str(child)))

    return concepts, relations, len(graph)


def import_file(
    path: Path,
    ontology_name: str = DEFAULT_ONTOLOGY,
) -> Dict[str, Any]:
    """Read the file and bring the database in line with it.

    Returns a summary: how many concepts and relations were seen, and how many
    of those were new. Run it twice and the second run adds nothing.
    """
    concepts, relations, triples = read_file(path)

    if not concepts:
        raise ImportError_(
            f"{path.name} parsed, but held no named OWL classes to import."
        )

    with transaction() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM ontology_concept WHERE ontology_name = %s",
                    (ontology_name,))
        before_concepts = int(cur.fetchone()["n"])

        for concept in concepts:
            cur.execute(
                """
                INSERT INTO ontology_concept (ontology_name, concept_uri, label, definition)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (concept_uri) DO UPDATE
                    SET label = EXCLUDED.label,
                        definition = EXCLUDED.definition,
                        ontology_name = EXCLUDED.ontology_name,
                        imported_on = CURRENT_TIMESTAMP
                """,
                (ontology_name, concept["concept_uri"], concept["label"][:500],
                 concept["definition"]),
            )

        cur.execute("SELECT COUNT(*) AS n FROM ontology_relation")
        before_relations = int(cur.fetchone()["n"])

        for parent_uri, child_uri in relations:
            cur.execute(
                """
                INSERT INTO ontology_relation (parent_uri, child_uri, relation_type)
                VALUES (%s, %s, 'subClassOf')
                ON CONFLICT DO NOTHING
                """,
                (parent_uri, child_uri),
            )

        cur.execute("SELECT COUNT(*) AS n FROM ontology_concept WHERE ontology_name = %s",
                    (ontology_name,))
        after_concepts = int(cur.fetchone()["n"])
        cur.execute("SELECT COUNT(*) AS n FROM ontology_relation")
        after_relations = int(cur.fetchone()["n"])

    summary = {
        "ontology": ontology_name,
        "file": path.name,
        "triples": triples,
        "concepts_in_file": len(concepts),
        "concepts_added": after_concepts - before_concepts,
        "relations_in_file": len(relations),
        "relations_added": after_relations - before_relations,
    }

    logger.info(
        "Imported %s: %d concepts (%d new), %d subclass links (%d new), from %d triples",
        ontology_name, summary["concepts_in_file"], summary["concepts_added"],
        summary["relations_in_file"], summary["relations_added"], triples,
    )
    return summary


def loaded() -> List[Dict[str, Any]]:
    """Which ontologies are in the database, and how big each one is."""
    with transaction() as cur:
        cur.execute(
            """
            SELECT ontology_name,
                   COUNT(*)          AS concepts,
                   MAX(imported_on)  AS imported_on
            FROM   ontology_concept
            GROUP BY ontology_name
            ORDER BY ontology_name
            """
        )
        return [dict(row) for row in cur.fetchall()]


def remove(ontology_name: str) -> Dict[str, Any]:
    """Drop one ontology. Its relations go with it, through the cascade.

    A form field referencing a removed concept keeps its URI and its options —
    the form holds its own copy of what it needs, so nothing breaks.
    """
    with transaction() as cur:
        cur.execute("DELETE FROM ontology_concept WHERE ontology_name = %s", (ontology_name,))
        removed = cur.rowcount
    logger.info("Removed ontology %s (%d concepts)", ontology_name, removed)
    return {"ontology": ontology_name, "removed": removed}
