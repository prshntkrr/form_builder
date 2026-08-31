"""Looking concepts up, and finding the standardised answers under one.

Two questions, which is all the form builder asks:

    what concept do I mean?     -> search
    what are its known values?  -> children
"""
import logging
from typing import Any, Dict, List, Optional

from app.core.database import transaction

logger = logging.getLogger(__name__)


class ConceptNotFound(LookupError):
    pass


def search(term: str, ontology: Optional[str] = None, limit: int = 25) -> List[Dict[str, Any]]:
    """Concepts whose label contains `term`, case-insensitively.

    Exact matches first, then ones that start with the term, then the rest —
    searching "irrigation" should put "irrigation" above "surface irrigation".
    """
    term = (term or "").strip()
    if not term:
        return []

    clauses = ["label ILIKE %s"]
    values: List[Any] = [f"%{term}%"]
    if ontology:
        clauses.append("ontology_name = %s")
        values.append(ontology)

    with transaction() as cur:
        cur.execute(
            f"""
            SELECT c.concept_id, c.ontology_name, c.concept_uri, c.label, c.definition,
                   (SELECT COUNT(*) FROM ontology_relation r
                     WHERE r.parent_uri = c.concept_uri) AS child_count
            FROM   ontology_concept c
            WHERE  {' AND '.join(clauses)}
            ORDER BY
                CASE WHEN lower(c.label) = lower(%s) THEN 0
                     WHEN lower(c.label) LIKE lower(%s) THEN 1
                     ELSE 2 END,
                length(c.label),
                c.label
            LIMIT %s
            """,
            (*values, term, f"{term}%", limit),
        )
        return [dict(row) for row in cur.fetchall()]


def get(concept_id: int) -> Dict[str, Any]:
    with transaction() as cur:
        cur.execute(
            """
            SELECT concept_id, ontology_name, concept_uri, label, definition
            FROM   ontology_concept WHERE concept_id = %s
            """,
            (concept_id,),
        )
        row = cur.fetchone()
    if not row:
        raise ConceptNotFound(f"No concept {concept_id}")
    return dict(row)


def get_by_uri(concept_uri: str) -> Optional[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute(
            """
            SELECT concept_id, ontology_name, concept_uri, label, definition
            FROM   ontology_concept WHERE concept_uri = %s
            """,
            (concept_uri,),
        )
        row = cur.fetchone()
    return dict(row) if row else None


def children(concept_id: int) -> List[Dict[str, Any]]:
    """The named subclasses of a concept, which is what can become a dropdown.

    An empty list is a normal answer, not a failure: about half the concepts in
    a typical ontology have no named children at all. "irrigation method" is one
    — it has plenty of semantic relationships, but nothing to pick from.
    """
    concept = get(concept_id)

    with transaction() as cur:
        cur.execute(
            """
            SELECT c.concept_id, c.ontology_name, c.concept_uri, c.label, c.definition
            FROM   ontology_relation r
            JOIN   ontology_concept c ON c.concept_uri = r.child_uri
            WHERE  r.parent_uri = %s AND r.relation_type = 'subClassOf'
            ORDER BY c.label
            """,
            (concept["concept_uri"],),
        )
        return [dict(row) for row in cur.fetchall()]


def as_options(concept_id: int) -> List[Dict[str, str]]:
    """A concept's children, shaped as form field options.

    The URI rides along on each option, so a stored answer can always be traced
    back to the concept it came from — the form definition is what makes that
    possible, which is why nothing extra has to be written with the response.
    """
    options = []
    for child in children(concept_id):
        options.append({
            "label": child["label"],
            "value": _value_for(child),
            "ontology_uri": child["concept_uri"],
        })
    return options


def _value_for(concept: Dict[str, Any]) -> str:
    """What gets stored when somebody picks this concept.

    The label, slugified — readable in a CSV export and stable, where the URI
    would be neither. The URI stays on the option for anyone who needs it.
    """
    from app.modules.forms.form_schema import slugify_identifier

    return slugify_identifier(concept["label"], "") or concept["concept_uri"].rsplit("/", 1)[-1]


def roots(ontology: str, limit: int = 500) -> List[Dict[str, Any]]:
    """The concepts nothing else is the parent of — where browsing starts.

    An ontology is a graph, not a list, and it has no "first page". These are
    its top: every concept that is not a named subclass of another one.
    """
    with transaction() as cur:
        cur.execute(
            """
            SELECT c.concept_id, c.ontology_name, c.concept_uri, c.label, c.definition,
                   (SELECT COUNT(*) FROM ontology_relation r
                     WHERE r.parent_uri = c.concept_uri
                       AND r.relation_type = 'subClassOf') AS child_count
            FROM   ontology_concept c
            WHERE  c.ontology_name = %s
              AND  NOT EXISTS (
                     SELECT 1 FROM ontology_relation r
                     WHERE r.child_uri = c.concept_uri
                       AND r.relation_type = 'subClassOf')
            ORDER  BY lower(c.label)
            LIMIT  %s
            """,
            (ontology, limit),
        )
        return [dict(row) for row in cur.fetchall()]


def child_counts(concept_ids: List[int]) -> Dict[int, int]:
    """How many named children each of these concepts has, in one query.

    So a dropdown can say which of its options can be descended into without
    asking once per option.
    """
    if not concept_ids:
        return {}

    with transaction() as cur:
        cur.execute(
            """
            SELECT c.concept_id,
                   (SELECT COUNT(*) FROM ontology_relation r
                     WHERE r.parent_uri = c.concept_uri
                       AND r.relation_type = 'subClassOf') AS child_count
            FROM   ontology_concept c
            WHERE  c.concept_id = ANY(%s)
            """,
            (list(concept_ids),),
        )
        return {row["concept_id"]: int(row["child_count"]) for row in cur.fetchall()}


def ancestry(concept_id: int, ceiling: int = 12) -> List[Dict[str, Any]]:
    """A concept and everything it is a subclass of, from the top down.

    What a breadcrumb needs: the branch that was walked to reach it. An
    ontology is a graph rather than a tree, so a concept can have more than one
    parent — the first is followed, which gives one true path rather than all of
    them. `ceiling` stops a cycle in a badly-formed import from looping.
    """
    chain: List[Dict[str, Any]] = []
    seen = set()
    current = get(concept_id)

    while current and current["concept_id"] not in seen and len(chain) < ceiling:
        seen.add(current["concept_id"])
        chain.append(current)

        with transaction() as cur:
            cur.execute(
                """
                SELECT c.concept_id, c.ontology_name, c.concept_uri, c.label,
                       c.definition
                FROM   ontology_relation r
                JOIN   ontology_concept c ON c.concept_uri = r.parent_uri
                WHERE  r.child_uri = %s AND r.relation_type = 'subClassOf'
                ORDER  BY c.label
                LIMIT  1
                """,
                (current["concept_uri"],),
            )
            row = cur.fetchone()

        current = dict(row) if row else None

    chain.reverse()
    return chain
