"""Looking crop traits and variables up. Everything comes from PostgreSQL."""
import logging
from typing import Any, Dict, List, Optional

from app.core.database import transaction

logger = logging.getLogger(__name__)


class NotFound(LookupError):
    pass


def ontologies() -> List[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute("SELECT ontology_id, crop_name, ontology_name, version, licence "
                    "FROM crop_ontology ORDER BY crop_name")
        return [dict(row) for row in cur.fetchall()]


def search_variables(
    term: str,
    ontology_id: Optional[str] = None,
    limit: int = 25,
) -> List[Dict[str, Any]]:
    """Variables whose own name or their trait's name mentions `term`.

    A Crop Ontology variable is named like `PlantHt_M_cm`, which nobody types.
    The trait behind it is called "Plant height", so the trait name has to be
    searchable or the whole thing is unusable.
    """
    term = (term or "").strip()
    if not term:
        return []

    like = f"%{term}%"
    spread = "%" + "%".join(term.split()) + "%"

    clauses = ["(v.name ILIKE %s OR t.name ILIKE %s OR t.name ILIKE %s OR v.definition ILIKE %s)"]
    values: List[Any] = [like, like, spread, like]
    if ontology_id:
        clauses.append("v.ontology_id = %s")
        values.append(ontology_id)

    with transaction() as cur:
        cur.execute(
            f"""
            SELECT v.variable_id, v.ontology_id, v.name, v.definition,
                   v.trait_id, v.method_id, v.scale_id,
                   o.crop_name, o.ontology_name, o.version,
                   t.name AS trait_name, t.definition AS trait_definition,
                   m.name AS method_name, s.name AS scale_name,
                   s.data_type AS scale_data_type, s.categories AS scale_categories
            FROM   crop_variable v
            JOIN   crop_ontology o ON o.ontology_id = v.ontology_id
            LEFT   JOIN crop_trait t ON t.trait_id = v.trait_id
            LEFT   JOIN crop_method m ON m.method_id = v.method_id
            LEFT   JOIN crop_scale s ON s.scale_id = v.scale_id
            WHERE  {' AND '.join(clauses)}
            ORDER BY
                CASE WHEN lower(t.name) = lower(%s) THEN 0
                     WHEN lower(v.name) = lower(%s) THEN 1
                     ELSE 2 END,
                length(coalesce(t.name, v.name)), v.name
            LIMIT %s
            """,
            (*values, term, term, limit),
        )
        return [dict(row) for row in cur.fetchall()]


def search_traits(term: str, ontology_id: Optional[str] = None,
                  limit: int = 25) -> List[Dict[str, Any]]:
    term = (term or "").strip()
    if not term:
        return []

    clauses = ["(t.name ILIKE %s OR t.definition ILIKE %s)"]
    values: List[Any] = [f"%{term}%", f"%{term}%"]
    if ontology_id:
        clauses.append("t.ontology_id = %s")
        values.append(ontology_id)

    with transaction() as cur:
        cur.execute(
            f"""
            SELECT t.*, o.crop_name,
                   (SELECT COUNT(*) FROM crop_variable v WHERE v.trait_id = t.trait_id) AS variables
            FROM   crop_trait t
            JOIN   crop_ontology o ON o.ontology_id = t.ontology_id
            WHERE  {' AND '.join(clauses)}
            ORDER BY length(t.name), t.name
            LIMIT %s
            """,
            (*values, limit),
        )
        return [dict(row) for row in cur.fetchall()]


def get_variable(variable_id: str) -> Dict[str, Any]:
    """One variable and everything hanging off it, by its Crop Ontology id."""
    with transaction() as cur:
        cur.execute(
            """
            SELECT v.*, o.crop_name, o.ontology_name, o.version, o.licence, o.source_url,
                   t.name AS trait_name, t.definition AS trait_definition,
                   t.entity AS trait_entity, t.attribute AS trait_attribute,
                   m.name AS method_name, m.definition AS method_definition,
                   s.name AS scale_name, s.data_type AS scale_data_type,
                   s.categories AS scale_categories
            FROM   crop_variable v
            JOIN   crop_ontology o ON o.ontology_id = v.ontology_id
            LEFT   JOIN crop_trait t ON t.trait_id = v.trait_id
            LEFT   JOIN crop_method m ON m.method_id = v.method_id
            LEFT   JOIN crop_scale s ON s.scale_id = v.scale_id
            WHERE  v.variable_id = %s
            """,
            (variable_id,),
        )
        row = cur.fetchone()
    if not row:
        raise NotFound(f"No crop ontology variable {variable_id}")
    return dict(row)


def get_trait(trait_id: str) -> Dict[str, Any]:
    with transaction() as cur:
        cur.execute(
            """
            SELECT t.*, o.crop_name, o.ontology_name
            FROM   crop_trait t
            JOIN   crop_ontology o ON o.ontology_id = t.ontology_id
            WHERE  t.trait_id = %s
            """,
            (trait_id,),
        )
        row = cur.fetchone()
    if not row:
        raise NotFound(f"No crop ontology trait {trait_id}")
    return dict(row)


def scale_options(variable_id: str) -> List[Dict[str, str]]:
    """A variable's scale categories, shaped as form options.

    Empty unless a values pass has been run: the OWL does not publish valid
    values, so most scales have none recorded and nothing is invented.

    A category reads "1= colorless", so the code before the "=" becomes the
    stored value and the rest is the label.
    """
    variable = get_variable(variable_id)
    categories = variable.get("scale_categories") or []

    options = []
    for category in categories:
        text = str(category)
        code, _, label = text.partition("=")
        code, label = code.strip(), label.strip()
        if not code:
            continue
        options.append({
            "label": label or code,
            "value": code,
            "crop_ontology_scale": variable.get("scale_id"),
        })
    return options


def traits_in(ontology_id: str, limit: int = 500) -> List[Dict[str, Any]]:
    """Every trait one crop's ontology defines, for browsing rather than search."""
    with transaction() as cur:
        cur.execute(
            """
            SELECT t.*, o.crop_name,
                   (SELECT COUNT(*) FROM crop_variable v
                     WHERE v.trait_id = t.trait_id) AS variables
            FROM   crop_trait t
            JOIN   crop_ontology o ON o.ontology_id = t.ontology_id
            WHERE  t.ontology_id = %s
            ORDER  BY lower(t.name)
            LIMIT  %s
            """,
            (ontology_id, limit),
        )
        return [dict(row) for row in cur.fetchall()]


def variables_of_trait(trait_id: str, limit: int = 200) -> List[Dict[str, Any]]:
    """The variables measuring one trait, in the shape `search_variables` returns."""
    with transaction() as cur:
        cur.execute(
            """
            SELECT v.variable_id, v.ontology_id, v.name, v.definition,
                   v.trait_id, v.method_id, v.scale_id,
                   o.crop_name, o.ontology_name, o.version,
                   t.name AS trait_name, t.definition AS trait_definition,
                   m.name AS method_name, s.name AS scale_name,
                   s.data_type AS scale_data_type, s.categories AS scale_categories
            FROM   crop_variable v
            JOIN   crop_ontology o ON o.ontology_id = v.ontology_id
            LEFT   JOIN crop_trait t ON t.trait_id = v.trait_id
            LEFT   JOIN crop_method m ON m.method_id = v.method_id
            LEFT   JOIN crop_scale s ON s.scale_id = v.scale_id
            WHERE  v.trait_id = %s
            ORDER  BY lower(v.name)
            LIMIT  %s
            """,
            (trait_id, limit),
        )
        return [dict(row) for row in cur.fetchall()]
