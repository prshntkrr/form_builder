"""The published configuration of a form: what leaves this application.

The Form Builder is the source of truth for what a form *is* — its fields, its
rules, its catalogue and standards references, whether it collects a position.
Anything collecting answers elsewhere is working from a copy, and this is where
that copy comes from.

    Draft ──edit──> Draft ──publish──> Active
                                         │
                                    version 3, frozen
                                         │
                                     exported

What is handed out is the row in `form_version` for the version that is live —
not `forms.form_json`, which the next edit rewrites. A version row is written
once and never updated, so a configuration that has been exported cannot change
underneath whoever received it. Editing the form makes version 4; version 3 is
still exactly what it was.

A draft has no published configuration. It has version rows — every save makes
one — but nothing is collecting answers against it, and handing a draft out is
the one thing this must never do.
"""
import logging
from typing import Any, Dict, Optional

from app.core.database import transaction
from app.modules.forms.constants import DRAFT

logger = logging.getLogger(__name__)


class NotPublished(Exception):
    """This form has no published configuration to give out."""


def published_version(form: Dict[str, Any]) -> int:
    """The version number that is live for this form.

    After a rollback the live version is not the highest one, which is why this
    reads the form rather than `MAX(version_no)`.
    """
    return int((form.get("form_json") or {}).get("version")
               or form.get("version_no") or 1)


def config_of(form: Dict[str, Any], version_no: Optional[int] = None) -> Dict[str, Any]:
    """The frozen definition of one version, straight out of `form_version`.

    The canonical form JSON exactly as it was saved — the same shape the builder
    writes, the renderer reads and the submission service validates against.
    There is deliberately no second format: a field is a field, a rule is a
    rule, and a catalogue reference stays a reference rather than being flattened
    into the values it points at.
    """
    wanted = version_no or published_version(form)

    with transaction() as cur:
        cur.execute(
            "SELECT form_json FROM form_version WHERE form_id = %s AND version_no = %s",
            (form["form_id"], wanted),
        )
        row = cur.fetchone()

    if row is None or not row["form_json"]:
        raise NotPublished(
            f"Version {wanted} of {form['form_id']} was never saved, so there is "
            "nothing to publish from it."
        )
    return dict(row["form_json"])


def published(form: Dict[str, Any], project_id: Optional[str] = None) -> Dict[str, Any]:
    """One form's published configuration, or a refusal if it has none.

    The envelope says which form and which version this is, so whatever receives
    it can tell one delivery from the next. `config` is the canonical definition
    and nothing else: no credentials, no bucket, no connector settings, no
    collected answers — a configuration describes what to collect, never what
    was collected or how to reach anything.
    """
    if form.get("form_status") == DRAFT:
        raise NotPublished(
            f"{form['form_id']} is still a draft. Publish it before exporting it."
        )
    if form.get("form_status") != "Active":
        raise NotPublished(
            f"{form['form_id']} is not live, so it has no published configuration."
        )

    version_no = published_version(form)
    # An ISO string, not a datetime: this payload is posted to another system as
    # JSON, and a datetime has no representation there. FastAPI would have
    # converted it on the way out of an endpoint; a connector posting the same
    # dict directly would have failed on it.
    published_at = form.get("updated_on")

    return {
        "form_id": form["form_id"],
        "version": version_no,
        "status": "published",
        "form_title": form["form_title"],
        "form_description": form.get("form_description"),
        "form_type": form.get("form_type"),
        "parent_id": form.get("parent_id"),
        "project_id": project_id,
        "published_at": published_at.isoformat() if hasattr(published_at, "isoformat")
                        else published_at,
        "config": config_of(form, version_no),
    }
