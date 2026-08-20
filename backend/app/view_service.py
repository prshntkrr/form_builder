"""What a form's records look like to someone who cannot edit the form.

An editor sees every answer. Everyone else sees the columns an admin chose —
so a form can collect a farmer's bank details while the field officers who fill
it in only ever see a name and a village.

The choice is stored per form in `form_view`, and applied **server-side**: the
records endpoint never sends a hidden answer and then asks the browser not to
draw it.
"""
import logging
from typing import Any, Dict, List, Optional, Sequence

from psycopg2.extras import Json

from .database import transaction

logger = logging.getLogger(__name__)


def field_names(form_json: Dict[str, Any]) -> List[str]:
    return [f["name"] for f in (form_json.get("fields") or [])]


def get_config(cur, form_id: str) -> Dict[str, Any]:
    cur.execute(
        "SELECT visible_fields, configured, updated_on, updated_by "
        "FROM form_view WHERE form_id = %s",
        (form_id,),
    )
    row = cur.fetchone()
    if not row:
        return {"visible_fields": [], "configured": False, "updated_on": None, "updated_by": None}

    data = dict(row)
    fields = data.get("visible_fields")
    data["visible_fields"] = [str(f) for f in fields] if isinstance(fields, list) else []
    return data


def visible_fields(cur, form_id: str, form_json: Dict[str, Any]) -> List[str]:
    """The columns a non-editor may see, in the order the form asks them.

    Until somebody chooses, everything is visible — a form that showed nothing
    by default would look broken rather than careful. Names that no longer exist
    in the form are dropped, so deleting a question cannot leave a dangling
    column behind.
    """
    everything = field_names(form_json)
    config = get_config(cur, form_id)
    if not config["configured"]:
        return everything

    chosen = set(config["visible_fields"])
    return [name for name in everything if name in chosen]


def set_visible_fields(
    form_id: str,
    names: Sequence[str],
    form_json: Dict[str, Any],
    updated_by: Optional[str] = None,
) -> Dict[str, Any]:
    """Choose the columns. Unknown names are ignored rather than stored."""
    known = set(field_names(form_json))
    chosen = [str(n) for n in names if str(n) in known]

    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO form_view (form_id, visible_fields, configured, updated_by)
            VALUES (%s, %s, TRUE, %s)
            ON CONFLICT (form_id) DO UPDATE SET
                  visible_fields = EXCLUDED.visible_fields,
                  configured     = TRUE,
                  updated_by     = EXCLUDED.updated_by,
                  updated_on     = CURRENT_TIMESTAMP
            RETURNING visible_fields, configured, updated_on, updated_by
            """,
            (form_id, Json(chosen), updated_by),
        )
        stored = dict(cur.fetchone())

    logger.info("Form %s now shows %d of %d columns", form_id, len(chosen), len(known))
    return {
        "visible_fields": chosen,
        "configured": True,
        "updated_on": stored["updated_on"],
        "updated_by": stored["updated_by"],
    }


def reset_config(form_id: str) -> None:
    """Back to showing everything."""
    with transaction() as cur:
        cur.execute("DELETE FROM form_view WHERE form_id = %s", (form_id,))


def describe(form_id: str, form_json: Dict[str, Any]) -> Dict[str, Any]:
    """The whole picture for the admin screen: every question, and which show."""
    with transaction() as cur:
        config = get_config(cur, form_id)
        shown = set(visible_fields(cur, form_id, form_json))

    return {
        "configured": config["configured"],
        "updated_on": config["updated_on"],
        "updated_by": config["updated_by"],
        "fields": [
            {
                "name": f["name"],
                "label": f.get("label") or f["name"],
                "type": f.get("type"),
                "visible": f["name"] in shown,
            }
            for f in (form_json.get("fields") or [])
        ],
    }
