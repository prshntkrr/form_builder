"""Choices that come from the imported crop ontologies, not from a form.

Some answers are a list the application already holds. Which crops exist, and
which traits belong to a crop, are both facts in the database — so a form should
not carry a copy of them, and a model should certainly not invent one.

A field says where its choices come from instead:

    {"name": "crop",
     "options_from": {"source": "crop_ontology", "kind": "crop"}}

    {"name": "crop_feature",
     "options_from": {"source": "crop_ontology", "kind": "trait",
                      "depends_on": "crop"}}

The second depends on the first: pick Maize and the features offered are maize
traits, read from `crop_trait` for `CO_322`.

Values are Crop Ontology's own identifiers — `CO_322` for the crop, and
`CO_322:0000994` for the trait — so a stored answer stays meaningful outside
this application and after a re-import.

Everything here reads PostgreSQL. Nothing calls cropontology.org.
"""
import logging
from typing import Any, Dict, List, Optional

from app.core.database import transaction

logger = logging.getLogger(__name__)

SOURCE = "crop_ontology"

# What a field can ask this module for.
CROP = "crop"
TRAIT = "trait"
VARIABLE = "variable"
KINDS = (CROP, TRAIT, VARIABLE)


def crop_options() -> List[Dict[str, str]]:
    """Every imported crop. The value is its ontology id."""
    with transaction() as cur:
        cur.execute(
            """
            SELECT o.ontology_id, o.crop_name, o.ontology_name
            FROM   crop_ontology o
            WHERE  EXISTS (SELECT 1 FROM crop_trait t WHERE t.ontology_id = o.ontology_id)
            ORDER BY o.crop_name
            """
        )
        rows = cur.fetchall()

    options = []
    for row in rows:
        options.append({
            "label": row["crop_name"] or row["ontology_name"] or row["ontology_id"],
            "value": row["ontology_id"],
        })
    return options


def trait_options(ontology_id: Optional[str], limit: int = 500) -> List[Dict[str, str]]:
    """The traits of one crop. The value is the trait's Crop Ontology id.

    An empty list when no crop has been chosen yet — a trait list is meaningless
    without one, since every crop has its own.
    """
    if not ontology_id:
        return []

    with transaction() as cur:
        cur.execute(
            """
            SELECT trait_id, name
            FROM   crop_trait
            WHERE  ontology_id = %s AND name <> ''
            ORDER BY name
            LIMIT  %s
            """,
            (ontology_id, limit),
        )
        rows = cur.fetchall()

    return [{"label": row["name"], "value": row["trait_id"]} for row in rows]


def variable_options(ontology_id: Optional[str], limit: int = 500) -> List[Dict[str, str]]:
    """The measured variables of one crop, labelled by the trait behind them.

    A variable is named `PH_M_cm`, which means nothing on a form, so the trait
    name and the method are what a person reads.
    """
    if not ontology_id:
        return []

    with transaction() as cur:
        cur.execute(
            """
            SELECT v.variable_id, v.name, t.name AS trait_name, m.name AS method_name
            FROM   crop_variable v
            LEFT   JOIN crop_trait t ON t.trait_id = v.trait_id
            LEFT   JOIN crop_method m ON m.method_id = v.method_id
            WHERE  v.ontology_id = %s
            ORDER BY COALESCE(t.name, v.name), v.name
            LIMIT  %s
            """,
            (ontology_id, limit),
        )
        rows = cur.fetchall()

    options = []
    for row in rows:
        label = row["trait_name"] or row["name"]
        if row["method_name"]:
            label = f"{label} — {row['method_name']}"
        options.append({"label": label, "value": row["variable_id"]})
    return options


def options_for(kind: str, depends_on_value: Optional[str] = None) -> List[Dict[str, str]]:
    """The choices for one kind of dynamic field."""
    if kind == CROP:
        return crop_options()
    if kind == TRAIT:
        return trait_options(depends_on_value)
    if kind == VARIABLE:
        return variable_options(depends_on_value)
    return []


def is_valid(kind: str, value: Any, depends_on_value: Optional[str] = None) -> bool:
    """Whether an answer is one this source would have offered.

    Checked against the database rather than against a list carried on the form,
    because that list is never written down — that is the whole point of the
    field being dynamic.
    """
    if value in (None, ""):
        return True

    wanted = str(value)
    if kind == CROP:
        with transaction() as cur:
            cur.execute("SELECT 1 FROM crop_ontology WHERE ontology_id = %s", (wanted,))
            return cur.fetchone() is not None

    if kind == TRAIT:
        with transaction() as cur:
            if depends_on_value:
                cur.execute(
                    "SELECT 1 FROM crop_trait WHERE trait_id = %s AND ontology_id = %s",
                    (wanted, depends_on_value),
                )
            else:
                cur.execute("SELECT 1 FROM crop_trait WHERE trait_id = %s", (wanted,))
            return cur.fetchone() is not None

    if kind == VARIABLE:
        with transaction() as cur:
            if depends_on_value:
                cur.execute(
                    "SELECT 1 FROM crop_variable WHERE variable_id = %s AND ontology_id = %s",
                    (wanted, depends_on_value),
                )
            else:
                cur.execute("SELECT 1 FROM crop_variable WHERE variable_id = %s", (wanted,))
            return cur.fetchone() is not None

    return False


def describe(kind: str, value: Any) -> Optional[Dict[str, Any]]:
    """What a stored answer refers to, for reading a response back.

    A saved answer is an identifier like `CO_322:0000994`; this turns it back
    into the crop, trait, method and scale it stands for.
    """
    if value in (None, ""):
        return None
    wanted = str(value)

    if kind == CROP:
        with transaction() as cur:
            cur.execute(
                "SELECT ontology_id, crop_name, version FROM crop_ontology WHERE ontology_id = %s",
                (wanted,),
            )
            row = cur.fetchone()
        return dict(row) if row else None

    if kind == TRAIT:
        with transaction() as cur:
            cur.execute(
                """
                SELECT t.trait_id, t.name, t.definition, t.entity, t.attribute,
                       t.ontology_id, o.crop_name, o.version
                FROM   crop_trait t
                JOIN   crop_ontology o ON o.ontology_id = t.ontology_id
                WHERE  t.trait_id = %s
                """,
                (wanted,),
            )
            row = cur.fetchone()
        return dict(row) if row else None

    if kind == VARIABLE:
        from app.modules.crop_ontology import variable_service
        try:
            return variable_service.get_variable(wanted)
        except Exception:
            return None

    return None
