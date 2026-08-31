"""Looking standardised variables up, and reading their coded values."""
import logging
from typing import Any, Dict, List, Optional

from app.core.database import transaction

logger = logging.getLogger(__name__)


class VariableNotFound(LookupError):
    pass


def search(
    term: str,
    standard: Optional[str] = None,
    limit: int = 25,
) -> List[Dict[str, Any]]:
    """Variables whose name, code or definition mentions `term`.

    Ordered by how well the match holds up: the code exactly, then the name
    exactly, then a name that starts with the term, then everything else. A
    definition-only match comes last, because those are the loosest.
    """
    term = (term or "").strip()
    if not term:
        return []

    # Two things make a plain substring search miss:
    #   ICASA names are underscored (`soil_pH_in_water`) while people type words;
    #   a caller's term has had its stop words dropped, so "soil ph water" would
    #   never be found inside "soil ph in water".
    # So the name is also matched with its underscores flattened, and against a
    # pattern that allows anything between the words.
    like = f"%{term}%"
    spread = "%" + "%".join(term.split()) + "%"

    clauses = [
        "(v.name ILIKE %s"
        " OR replace(v.name, '_', ' ') ILIKE %s"
        " OR replace(v.name, '_', ' ') ILIKE %s"
        " OR v.code ILIKE %s"
        " OR v.definition ILIKE %s)"
    ]
    values: List[Any] = [like, like, spread, like, like]
    if standard:
        clauses.append("s.name = %s")
        values.append(standard)

    with transaction() as cur:
        cur.execute(
            f"""
            SELECT v.variable_id, v.external_id, v.code, v.name, v.label,
                   v.definition, v.data_type, v.unit, v.category, v.metadata,
                   s.name AS standard, s.version AS standard_version,
                   (SELECT COUNT(*) FROM standard_variable_option o
                     WHERE o.variable_id = v.variable_id) AS option_count
            FROM   standard_variable v
            JOIN   data_standard s ON s.standard_id = v.standard_id
            WHERE  {' AND '.join(clauses)}
            ORDER BY
                CASE WHEN lower(v.code) = lower(%s) THEN 0
                     WHEN lower(v.name) = lower(%s) THEN 1
                     WHEN lower(replace(v.name, '_', ' ')) = lower(%s) THEN 2
                     WHEN lower(v.name) LIKE lower(%s) THEN 3
                     WHEN v.name ILIKE %s THEN 4
                     ELSE 5 END,
                length(v.name),
                v.name
            LIMIT %s
            """,
            (*values, term, term, term, f"{term}%", f"%{term}%", limit),
        )
        return [dict(row) for row in cur.fetchall()]


def get(variable_id: int) -> Dict[str, Any]:
    with transaction() as cur:
        cur.execute(
            """
            SELECT v.variable_id, v.external_id, v.code, v.name, v.label,
                   v.definition, v.data_type, v.unit, v.category, v.metadata,
                   s.name AS standard, s.version AS standard_version
            FROM   standard_variable v
            JOIN   data_standard s ON s.standard_id = v.standard_id
            WHERE  v.variable_id = %s
            """,
            (variable_id,),
        )
        row = cur.fetchone()
    if not row:
        raise VariableNotFound(f"No standard variable {variable_id}")
    return dict(row)


def get_by_external_id(external_id: str, standard: str) -> Optional[Dict[str, Any]]:
    """The lookup a saved form needs: it stores the standard's own identifier."""
    with transaction() as cur:
        cur.execute(
            """
            SELECT v.variable_id, v.external_id, v.code, v.name, v.label,
                   v.definition, v.data_type, v.unit, v.category, v.metadata,
                   s.name AS standard, s.version AS standard_version
            FROM   standard_variable v
            JOIN   data_standard s ON s.standard_id = v.standard_id
            WHERE  v.external_id = %s AND s.name = %s
            """,
            (external_id, standard),
        )
        row = cur.fetchone()
    return dict(row) if row else None


def options(variable_id: int) -> List[Dict[str, Any]]:
    """The coded values a variable accepts.

    Empty for most of them — in ICASA only 90 of 1384 variables are code-valued.
    That is a normal answer, not a failure.
    """
    get(variable_id)
    with transaction() as cur:
        cur.execute(
            """
            SELECT code, label, description
            FROM   standard_variable_option
            WHERE  variable_id = %s
            ORDER BY code
            """,
            (variable_id,),
        )
        return [dict(row) for row in cur.fetchall()]


def as_field_options(variable_id: int) -> List[Dict[str, str]]:
    """A variable's coded values, shaped as form field options.

    The standard's own code becomes the stored value — `IR004`, not `sprinkler` —
    because that code is the thing every other system using ICASA will recognise.
    """
    result = []
    for option in options(variable_id):
        result.append({
            "label": option["label"],
            "value": option["code"],
            "standard_code": option["code"],
        })
    return result


def options_by_external_id(external_id: str, standard: str = "ICASA") -> List[Dict[str, str]]:
    """A variable's coded values, found by the standard's own identifier.

    The identifier is what a form stores and what a match reports, and it
    survives a re-import — the row id does not. Returns an empty list both when
    the variable has no codes and when it is not installed, because a caller
    treats those the same: there is nothing standardised to offer.
    """
    variable = get_by_external_id(external_id, standard)
    if not variable:
        return []
    return as_field_options(variable["variable_id"])


# --------------------------------------------------------------------------- #
# browsing rather than searching
#
# Search needs you to know what a variable is called. These two let a screen
# walk the dictionary instead: the categories ICASA already puts its variables
# in, and then the variables in one of them.
# --------------------------------------------------------------------------- #
def categories(standard: str) -> List[Dict[str, Any]]:
    """The categories one standard's variables are filed under, with counts.

    `category` is nullable and plenty of variables have none; those are grouped
    under an empty key rather than dropped, so the counts add up to the whole
    dictionary.
    """
    with transaction() as cur:
        cur.execute(
            """
            SELECT COALESCE(v.category, '') AS category, COUNT(*) AS variables
            FROM   standard_variable v
            JOIN   data_standard s ON s.standard_id = v.standard_id
            WHERE  s.name = %s
            GROUP  BY COALESCE(v.category, '')
            ORDER  BY COALESCE(v.category, '') = '', lower(COALESCE(v.category, ''))
            """,
            (standard,),
        )
        return [dict(row) for row in cur.fetchall()]


def in_category(standard: str, category: str, limit: int = 500) -> List[Dict[str, Any]]:
    """One category's variables, in the same shape `search` returns.

    The same columns on purpose: a screen that can draw a search hit can draw
    one of these without knowing which it was given.
    """
    with transaction() as cur:
        cur.execute(
            """
            SELECT v.variable_id, v.external_id, v.code, v.name, v.label,
                   v.definition, v.data_type, v.unit, v.category, v.metadata,
                   s.name AS standard, s.version AS standard_version,
                   (SELECT COUNT(*) FROM standard_variable_option o
                     WHERE o.variable_id = v.variable_id) AS option_count
            FROM   standard_variable v
            JOIN   data_standard s ON s.standard_id = v.standard_id
            WHERE  s.name = %s AND COALESCE(v.category, '') = %s
            ORDER  BY lower(v.name)
            LIMIT  %s
            """,
            (standard, category or "", limit),
        )
        return [dict(row) for row in cur.fetchall()]
