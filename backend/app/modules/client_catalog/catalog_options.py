"""Choices that come from a client's own catalog, not from a form.

A controlled list the client maintains is theirs. The form names it and reads
it when it is drawn:

    {"name": "rcl_tipo_colaborador_c",
     "options_from": {"source": "client_catalog",
                      "catalog": "Tipo_colaborador_list"}}

    {"name": "rcl_municipio_colaborador_c",
     "options_from": {"source": "client_catalog",
                      "catalog": "Municipios_mx_list",
                      "depends_on": "rcl_estado_colaborador_c"}}

The second depends on the first: a municipality belongs to a state, so only the
values whose `parent_code` is the chosen state are offered — and only those are
accepted back.

The codes are the client's own — `Y`, `N`, `UNK` if that is what their catalog
says — because the answer is stored as the code and must still mean the same
thing in their systems. Nothing here invents a value, and no standard and no
model may replace one; see `client_catalog/schema.sql`.

Everything here reads PostgreSQL.
"""
import logging
from typing import Any, Dict, List, Optional

from app.core.database import transaction

logger = logging.getLogger(__name__)

SOURCE = "client_catalog"

# A catalog is a list, not a table dump. Enough for any real controlled list.
MAX_OPTIONS = 5000

# Values the client has retired. Kept in the table for reading old answers back,
# never offered on a new form.
WITHDRAWN = ("withdrawn", "retired", "deprecated", "inactive", "obsolete")


def _is_offered(status: str) -> bool:
    return (status or "").strip().lower() not in WITHDRAWN


# A value in a dependent catalogue that names no parent cannot be reached: every
# list of districts is drawn for one state, so a district under no state would
# never appear and could never be answered. Such rows still exist — imported, or
# created before this was checked — and stay readable, but they are not offered
# and not accepted. Which parent they belong to is the client's to say.
_REACHABLE = "(c.parent_catalog_id IS NULL OR v.parent_code IS NOT NULL)"


# The language a catalogue reads in when nobody has asked for one.
#
# `client_catalog_value.label` holds whichever language the import happened to
# write — for this client's workbook that is Spanish, because their sheet leads
# with it. That is their data and it stays exactly as it is; which language is
# *shown* is a reading decision, and it is made here.
DEFAULT_LANGUAGE = "en"


def _labelled(row, language: Optional[str]) -> str:
    """The label to show, in the reader's language where the client gave one.

    In order: the language actually asked for, then English, then the value's
    own stored label, then its code. So an explicit choice always wins, English
    is what you get when nobody chose, and a value with neither translation
    still reads as something rather than as an empty choice.

    Nothing here writes: a catalogue imported in Spanish keeps its Spanish
    labels, and adding an English one later changes what this returns without
    anybody migrating anything.
    """
    labels = row.get("labels") or {}

    for wanted in (language, DEFAULT_LANGUAGE):
        if wanted and labels.get(wanted):
            return labels[wanted]

    return row["label"] or row["code"]


def options_for(
    catalog_id: str,
    parent_code: Optional[str] = None,
    limit: int = MAX_OPTIONS,
    language: Optional[str] = None,
    allowed: Optional[List[str]] = None,
) -> List[Dict[str, str]]:
    """The client's values for one catalog, as form options.

    `parent_code` narrows a dependent list to one parent — the municipalities of
    the chosen state. Whether a field is dependent at all is the form's business,
    not the catalog's, so a caller with a dependent field and no parent answer
    yet asks for nothing rather than asking for everything.

    `allowed` narrows to the codes one field offers, for a form that uses part
    of a catalogue rather than all of it. The *labels* still come from here, so
    a wording the client corrects tomorrow reaches every such field on its own —
    the field stores which values, never what they are called.
    """
    if not catalog_id:
        return []

    chosen = [str(code) for code in (allowed or []) if str(code).strip()]

    with transaction() as cur:
        narrowed = " AND code = ANY(%s)" if chosen else ""
        if parent_code:
            cur.execute(
                f"""
                SELECT code, label, labels, status
                FROM   client_catalog_value
                WHERE  catalog_id = %s AND parent_code = %s{narrowed}
                ORDER BY display_order, code
                LIMIT  %s
                """,
                (catalog_id, str(parent_code), *([chosen] if chosen else []), limit),
            )
        else:
            cur.execute(
                f"""
                SELECT v.code, v.label, v.labels, v.status
                FROM   client_catalog_value v
                JOIN   client_catalog c ON c.catalog_id = v.catalog_id
                WHERE  v.catalog_id = %s AND {_REACHABLE}
                       {narrowed.replace("code", "v.code")}
                ORDER BY v.display_order, v.code
                LIMIT  %s
                """,
                (catalog_id, *([chosen] if chosen else []), limit),
            )
        rows = cur.fetchall()

    # The value is the code, in every language. Translating it would make the
    # same answer two different answers.
    return [
        {"label": _labelled(row, language), "value": row["code"]}
        for row in rows
        if _is_offered(row["status"])
    ]


def is_valid(
    catalog_id: str,
    value: Any,
    parent_code: Optional[str] = None,
    allowed: Optional[List[str]] = None,
) -> bool:
    """Whether an answer is one this catalog would have offered.

    Checked against the database rather than a list carried on the form, because
    that list is never written down — that is the point of naming the catalog.

    With a parent, the parent has to match: a municipality of one state is not
    an answer when a different state is selected, even though both codes exist
    in the same catalog.

    With `allowed`, the field offers only part of the catalogue, and both have
    to hold: a code the catalogue has but this field does not offer is refused
    here, whatever a form posted. Being in the catalogue is not the same as
    being on offer.
    """
    if value in (None, ""):
        return True

    if not catalog_id:
        return False

    chosen = [str(code) for code in (allowed or []) if str(code).strip()]
    if chosen and str(value) not in chosen:
        return False

    with transaction() as cur:
        if parent_code:
            cur.execute(
                """
                SELECT status FROM client_catalog_value
                WHERE  catalog_id = %s AND code = %s AND parent_code = %s
                """,
                (catalog_id, str(value), str(parent_code)),
            )
        else:
            cur.execute(
                f"""
                SELECT v.status
                FROM   client_catalog_value v
                JOIN   client_catalog c ON c.catalog_id = v.catalog_id
                WHERE  v.catalog_id = %s AND v.code = %s AND {_REACHABLE}
                """,
                (catalog_id, str(value)),
            )
        row = cur.fetchone()

    return row is not None and _is_offered(row["status"])
