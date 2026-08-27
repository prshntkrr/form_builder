"""Downloading and reading Crop Ontology.

Source: https://cropontology.org/

Two published routes to the same data, and they are not equivalent — which is
why both are used:

    /ontology/{id}/rdf          OWL. Fast (a few seconds), and holds the whole
                                entity graph: traits, methods, scales, variables
                                and the links between them.

    /brapi/v1/variables/{id}    JSON. Slow — about fifty seconds for fifty
                                variables — but the only place a scale's data
                                type and its valid values are published.

So the OWL is the primary source and is what gets vendored, and the BrAPI pass
is opt-in. Until it has run, a scale has a name and nothing else: `data_type`
and `categories` stay null rather than being guessed. That is also why Crop
Ontology never turns a field into a dropdown on its own — the OWL simply does
not carry controlled values.

The structure below was read out of the published file, not assumed:

    Variable --variable_of--> Trait, Method and Scale   (exactly three links)
    Method   --method_of----> Trait
    Scale    --scale_of-----> Method

A class is therefore a Variable if it has `variable_of` links, a Method or Scale
if it is the subject of `method_of` / `scale_of`, and a Trait if it is only ever
a target.
"""
import json
import logging
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from psycopg2.extras import Json

from app.core.database import transaction

logger = logging.getLogger(__name__)

BASE_URL = "https://cropontology.org"
ONTOLOGY_LIST_URL = f"{BASE_URL}/brapi/v1/ontologies?pageSize=1000"
RDF_URL = BASE_URL + "/ontology/{ontology_id}/rdf"
VARIABLES_URL = BASE_URL + "/brapi/v1/variables/{ontology_id}?page={page}&pageSize={size}"

CO = "https://cropontology.org/rdf/"
SKOS_DEFINITION = "http://www.w3.org/2004/02/skos/core#definition"
SKOS_ALT_LABEL = "http://www.w3.org/2004/02/skos/core#altLabel"

# The BrAPI variables endpoint is slow enough that a larger page times out.
BRAPI_PAGE_SIZE = 50
BRAPI_TIMEOUT = 120


class CropOntologyProblem(RuntimeError):
    """The ontology could not be fetched or read."""


# --------------------------------------------------------------------------- #
# talking to cropontology.org — only ever from the importer, never at runtime
# --------------------------------------------------------------------------- #
def _get(url: str, timeout: int = 120) -> bytes:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CropOntologyProblem(f"Could not fetch {url}: {exc}") from exc


def _unwrap(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    """BrAPI here nests `result.data` one level deeper than usual."""
    data = payload.get("result")
    if isinstance(data, dict):
        data = data.get("data")
    while isinstance(data, list) and data and isinstance(data[0], list):
        data = data[0]
    return data if isinstance(data, list) else []


def discover() -> List[Dict[str, Any]]:
    """Which crop ontologies exist, asked of the source rather than hard-coded."""
    payload = json.loads(_get(ONTOLOGY_LIST_URL, timeout=60).decode("utf-8"))

    found = []
    for row in _unwrap(payload):
        ontology_id = str(row.get("ontologyDbId") or "").strip()
        if not ontology_id:
            continue
        found.append({
            "ontology_id": ontology_id,
            "ontology_name": str(row.get("ontologyName") or "").strip(),
            "crop_name": str(row.get("ontologyName") or "").strip(),
            "version": str(row.get("version") or "").strip(),
            "licence": str(row.get("licence") or "").strip(),
            "description": str(row.get("description") or "").strip(),
            "source_url": RDF_URL.format(ontology_id=ontology_id),
        })
    return found


def download(ontology: Dict[str, Any], directory: Path) -> Path:
    """Save one ontology's OWL, and a note of where it came from.

    The file is written exactly as served — the archive is only worth having if
    it is untouched.
    """
    folder = directory / ontology["ontology_id"]
    folder.mkdir(parents=True, exist_ok=True)

    target = folder / "ontology.owl"
    target.write_bytes(_get(RDF_URL.format(ontology_id=ontology["ontology_id"])))

    (folder / "SOURCE.md").write_text(
        f"# {ontology['ontology_name']} ({ontology['ontology_id']})\n\n"
        f"Downloaded unmodified from Crop Ontology.\n\n"
        f"- Source: <{BASE_URL}/>\n"
        f"- Ontology ID: `{ontology['ontology_id']}`\n"
        f"- Crop / ontology name: {ontology['ontology_name']}\n"
        f"- Version: {ontology['version'] or 'not published'}\n"
        f"- Licence: {ontology['licence'] or 'not published'}\n"
        f"- Download URL: <{RDF_URL.format(ontology_id=ontology['ontology_id'])}>\n\n"
        f"{ontology['description']}\n\n"
        "This file is the local source archive and is never edited. PostgreSQL\n"
        "is the runtime source of truth; re-import with:\n\n"
        "    cd backend && python import_crop_ontology.py --crop "
        f"{ontology['ontology_id']}\n",
        encoding="utf-8",
    )
    return target


def download_values(ontology_id: str, directory: Path, limit_pages: Optional[int] = None) -> Path:
    """Fetch the BrAPI variables, which is where scale values are published.

    Slow on purpose-built terms: fifty variables a request, roughly fifty
    seconds each. Kept separate from the OWL download so a routine import never
    waits for it.
    """
    folder = directory / ontology_id
    folder.mkdir(parents=True, exist_ok=True)

    collected: List[Dict[str, Any]] = []
    page = 0
    while True:
        url = VARIABLES_URL.format(ontology_id=ontology_id, page=page, size=BRAPI_PAGE_SIZE)
        payload = json.loads(_get(url, timeout=BRAPI_TIMEOUT).decode("utf-8"))
        rows = _unwrap(payload)
        collected.extend(rows)

        pagination = (payload.get("metadata") or {}).get("pagination") or {}
        total_pages = int(pagination.get("totalPages") or 1)
        page += 1
        logger.info("  %s values: page %d of %d", ontology_id, page, total_pages)

        if page >= total_pages or (limit_pages and page >= limit_pages):
            break

    target = folder / "variables.brapi.json"
    target.write_text(json.dumps(collected, indent=1), encoding="utf-8")
    return target


# --------------------------------------------------------------------------- #
# reading the vendored files
# --------------------------------------------------------------------------- #
def read_owl(path: Path) -> Dict[str, List[Dict[str, Any]]]:
    """Parse one ontology's OWL into traits, methods, scales and variables.

    No database work, so this is the part that can be tested on its own.
    """
    try:
        from rdflib import OWL, RDFS, Graph, URIRef
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise CropOntologyProblem("rdflib is not installed") from exc

    if not path.exists():
        raise CropOntologyProblem(f"No ontology file at {path}")

    graph = Graph()
    try:
        graph.parse(str(path), format="xml")
    except Exception as exc:
        raise CropOntologyProblem(f"Could not read {path.name} as RDF/XML: {exc}") from exc

    definition_of = URIRef(SKOS_DEFINITION)

    def text(subject, predicate) -> str:
        value = graph.value(subject, predicate)
        return str(value).strip() if value else ""

    def local(uri) -> str:
        """Crop Ontology's own identifier, e.g. CO_322:0000850."""
        return str(uri).rsplit("/", 1)[-1]

    # subject -> {relation: [targets]}, read out of the OWL restrictions
    links: Dict[Any, Dict[str, List[Any]]] = {}
    for subject, restriction in graph.subject_objects(RDFS.subClassOf):
        if isinstance(restriction, URIRef):
            continue
        relation = graph.value(restriction, OWL.onProperty)
        target = graph.value(restriction, OWL.someValuesFrom)
        if relation is None or target is None:
            continue
        name = str(relation).rsplit("/", 1)[-1]
        links.setdefault(subject, {}).setdefault(name, []).append(target)

    variable_uris = [s for s, rel in links.items() if "variable_of" in rel]
    method_uris = [s for s, rel in links.items() if "method_of" in rel]
    scale_uris = [s for s, rel in links.items() if "scale_of" in rel]

    classified = set(variable_uris) | set(method_uris) | set(scale_uris)
    # A trait is only ever pointed at, never a subject of these relations.
    trait_uris = [
        target
        for rel in links.values()
        for targets in rel.values()
        for target in targets
        if target not in classified
    ]

    def described(uri) -> Dict[str, Any]:
        return {
            "external_id": local(uri),
            "name": text(uri, RDFS.label),
            "definition": text(uri, definition_of),
        }

    traits = []
    seen = set()
    for uri in trait_uris:
        if uri in seen:
            continue
        seen.add(uri)
        entry = described(uri)
        entry["entity"] = text(uri, URIRef(CO + "entity"))
        entry["attribute"] = text(uri, URIRef(CO + "attribute"))
        entry["metadata"] = {
            "acronym": text(uri, URIRef(CO + "acronym")),
            "alt_label": text(uri, URIRef(SKOS_ALT_LABEL)),
        }
        traits.append(entry)

    methods = []
    for uri in method_uris:
        entry = described(uri)
        targets = links[uri].get("method_of") or []
        entry["trait_id"] = local(targets[0]) if targets else None
        entry["metadata"] = {"acronym": text(uri, URIRef(CO + "acronym"))}
        methods.append(entry)

    scales = []
    for uri in scale_uris:
        entry = described(uri)
        entry["metadata"] = {}
        scales.append(entry)

    method_set = {local(u) for u in method_uris}
    scale_set = {local(u) for u in scale_uris}

    variables = []
    for uri in variable_uris:
        entry = described(uri)
        entry["trait_id"] = entry["method_id"] = entry["scale_id"] = None
        # A variable points at all three, in no guaranteed order, so each target
        # is placed by what it turned out to be.
        for target in links[uri].get("variable_of") or []:
            key = local(target)
            if key in method_set:
                entry["method_id"] = key
            elif key in scale_set:
                entry["scale_id"] = key
            else:
                entry["trait_id"] = key
        entry["metadata"] = {"acronym": text(uri, URIRef(CO + "acronym"))}
        variables.append(entry)

    return {"traits": traits, "methods": methods, "scales": scales, "variables": variables}


def read_values(path: Path) -> Dict[str, Dict[str, Any]]:
    """Scale data types and valid values, from a saved BrAPI file.

    Keyed by scale id. Returns nothing if the file was never fetched — the
    values are simply unknown then, which is not the same as there being none.
    """
    if not path.exists():
        return {}

    rows = json.loads(path.read_text(encoding="utf-8"))
    scales: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        scale = row.get("scale") or {}
        scale_id = str(scale.get("scaleDbId") or "").strip()
        if not scale_id:
            continue
        categories = ((scale.get("validValues") or {}).get("categories")) or None
        scales[scale_id] = {
            "data_type": scale.get("dataType"),
            "categories": categories,
        }
    return scales


# --------------------------------------------------------------------------- #
# storing it
# --------------------------------------------------------------------------- #
def import_ontology(ontology: Dict[str, Any], directory: Path) -> Dict[str, int]:
    """Read one vendored ontology into the database, and report what changed."""
    folder = directory / ontology["ontology_id"]
    parsed = read_owl(folder / "ontology.owl")
    values = read_values(folder / "variables.brapi.json")

    counts = {"traits": 0, "methods": 0, "scales": 0, "variables": 0, "existing": 0}

    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO crop_ontology
                (ontology_id, crop_name, ontology_name, version, source_url, licence, description)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (ontology_id) DO UPDATE
                -- Every field keeps what is already recorded when this import
                -- does not supply it. Re-importing from the vendored file knows
                -- the ontology id and little else, and must not blank the crop
                -- name or the version — a saved form is only interpretable
                -- against the version it was built with.
                SET crop_name = COALESCE(NULLIF(EXCLUDED.crop_name, ''), crop_ontology.crop_name),
                    ontology_name = COALESCE(NULLIF(EXCLUDED.ontology_name, ''),
                                             crop_ontology.ontology_name),
                    version = COALESCE(NULLIF(EXCLUDED.version, ''), crop_ontology.version),
                    source_url = COALESCE(NULLIF(EXCLUDED.source_url, ''),
                                          crop_ontology.source_url),
                    licence = COALESCE(NULLIF(EXCLUDED.licence, ''), crop_ontology.licence),
                    description = COALESCE(NULLIF(EXCLUDED.description, ''),
                                           crop_ontology.description),
                    imported_on = CURRENT_TIMESTAMP
            """,
            (ontology["ontology_id"], ontology.get("crop_name", ""),
             ontology.get("ontology_name", ""), ontology.get("version", ""),
             ontology.get("source_url", ""), ontology.get("licence", ""),
             ontology.get("description", "")),
        )

        cur.execute("SELECT COUNT(*) AS n FROM crop_variable WHERE ontology_id = %s",
                    (ontology["ontology_id"],))
        before = int(cur.fetchone()["n"])

        for trait in parsed["traits"]:
            cur.execute(
                """
                INSERT INTO crop_trait
                    (trait_id, ontology_id, name, definition, entity, attribute, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (trait_id) DO UPDATE
                    SET name = EXCLUDED.name, definition = EXCLUDED.definition,
                        entity = EXCLUDED.entity, attribute = EXCLUDED.attribute,
                        metadata = EXCLUDED.metadata, imported_on = CURRENT_TIMESTAMP
                """,
                (trait["external_id"], ontology["ontology_id"], trait["name"][:500],
                 trait["definition"], trait["entity"][:300], trait["attribute"][:300],
                 Json(trait["metadata"])),
            )
            counts["traits"] += 1

        for method in parsed["methods"]:
            cur.execute(
                """
                INSERT INTO crop_method
                    (method_id, ontology_id, name, definition, trait_id, metadata)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (method_id) DO UPDATE
                    SET name = EXCLUDED.name, definition = EXCLUDED.definition,
                        trait_id = EXCLUDED.trait_id, metadata = EXCLUDED.metadata,
                        imported_on = CURRENT_TIMESTAMP
                """,
                (method["external_id"], ontology["ontology_id"], method["name"][:500],
                 method["definition"], method["trait_id"], Json(method["metadata"])),
            )
            counts["methods"] += 1

        for scale in parsed["scales"]:
            extra = values.get(scale["external_id"]) or {}
            cur.execute(
                """
                INSERT INTO crop_scale
                    (scale_id, ontology_id, name, definition, data_type, categories, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (scale_id) DO UPDATE
                    SET name = EXCLUDED.name, definition = EXCLUDED.definition,
                        -- Keep what a values pass already established; a plain
                        -- OWL re-import knows nothing about them.
                        data_type = COALESCE(EXCLUDED.data_type, crop_scale.data_type),
                        categories = COALESCE(EXCLUDED.categories, crop_scale.categories),
                        metadata = EXCLUDED.metadata, imported_on = CURRENT_TIMESTAMP
                """,
                (scale["external_id"], ontology["ontology_id"], scale["name"][:500],
                 scale["definition"], extra.get("data_type"),
                 Json(extra["categories"]) if extra.get("categories") else None,
                 Json(scale["metadata"])),
            )
            counts["scales"] += 1

        for variable in parsed["variables"]:
            cur.execute(
                """
                INSERT INTO crop_variable
                    (variable_id, ontology_id, name, definition, trait_id, method_id,
                     scale_id, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (variable_id) DO UPDATE
                    SET name = EXCLUDED.name, definition = EXCLUDED.definition,
                        trait_id = EXCLUDED.trait_id, method_id = EXCLUDED.method_id,
                        scale_id = EXCLUDED.scale_id, metadata = EXCLUDED.metadata,
                        imported_on = CURRENT_TIMESTAMP
                """,
                (variable["external_id"], ontology["ontology_id"], variable["name"][:500],
                 variable["definition"], variable["trait_id"], variable["method_id"],
                 variable["scale_id"], Json(variable["metadata"])),
            )
            counts["variables"] += 1

        cur.execute("SELECT COUNT(*) AS n FROM crop_variable WHERE ontology_id = %s",
                    (ontology["ontology_id"],))
        counts["existing"] = before + counts["variables"] - int(cur.fetchone()["n"])

    return counts


def loaded() -> List[Dict[str, Any]]:
    """Which crop ontologies are in the database, and how big each one is."""
    with transaction() as cur:
        cur.execute(
            """
            SELECT o.*,
                   (SELECT COUNT(*) FROM crop_trait t WHERE t.ontology_id = o.ontology_id) AS traits,
                   (SELECT COUNT(*) FROM crop_method m WHERE m.ontology_id = o.ontology_id) AS methods,
                   (SELECT COUNT(*) FROM crop_scale s WHERE s.ontology_id = o.ontology_id) AS scales,
                   (SELECT COUNT(*) FROM crop_variable v WHERE v.ontology_id = o.ontology_id) AS variables
            FROM   crop_ontology o
            ORDER BY o.crop_name
            """
        )
        return [dict(row) for row in cur.fetchall()]


def remove(ontology_id: str) -> Dict[str, Any]:
    """Drop one crop ontology. Its traits, methods, scales and variables go with
    it. Forms keep the identifiers they recorded."""
    with transaction() as cur:
        cur.execute("DELETE FROM crop_ontology WHERE ontology_id = %s", (ontology_id,))
        removed = cur.rowcount
    return {"ontology_id": ontology_id, "removed": removed}
