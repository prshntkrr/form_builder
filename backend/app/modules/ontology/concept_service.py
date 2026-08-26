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
