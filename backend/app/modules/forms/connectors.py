"""Sending a published configuration somewhere else.

    published form ──> connector ──> MCDC
                                ──> anything else, later

The Form Builder knows nothing about MCDC beyond the name of a connector. A
second platform is another subclass and a line in `CONNECTORS`; nothing in
publishing, versioning or submission changes to add one.

An export is recorded against `form_id + version + connector`, which is the
identity of the thing being delivered. Exporting the same version twice is the
same delivery, so the second call returns what the first one did rather than
sending it again — a retry after a dropped connection cannot leave a platform
holding two copies of one configuration.
"""
import hashlib
import json
import logging
from typing import Any, Dict, Optional

from psycopg2.extras import Json

from app.core.config import settings
from app.core.database import transaction

logger = logging.getLogger(__name__)


class ExportError(Exception):
    """The configuration could not be delivered. The message is safe to show."""


class UnknownConnector(ExportError):
    """No connector by that name."""


class ConfigurationRejected(ExportError):
    """The published configuration is not fit to be sent anywhere."""


PENDING, EXPORTED, FAILED = "PENDING", "EXPORTED", "FAILED"


class ExportConnector:
    """Somewhere a published configuration can be sent.

    One method. Anything a connector needs beyond the configuration — a base
    URL, a key — comes from settings, never from the configuration itself and
    never from the caller.
    """

    name = ""
    label = ""

    def export(self, published: Dict[str, Any]) -> Dict[str, Any]:
        """Deliver one published configuration. Returns what to record."""
        raise NotImplementedError

    def configured(self) -> bool:
        """Whether this installation can actually reach the other end."""
        return True


class MCDCConnector(ExportConnector):
    """The multi-channel collection layer: mobile, WhatsApp and IVR.

    MCDC is given the configuration and collects against it; the answers come
    back through the ordinary submission service, not through here. This is the
    configuration half of the integration and nothing else.

    Without `MCDC_BASE_URL` an installation has nowhere to send anything, and
    says so rather than inventing an address. The key is sent as a header and
    never appears in a log, a response or the configuration.
    """

    name = "mcdc"
    label = "MCDC (multi-channel collection)"

    def configured(self) -> bool:
        return bool(settings.mcdc_base_url)

    def export(self, published: Dict[str, Any]) -> Dict[str, Any]:
        if not self.configured():
            raise ExportError(
                "No MCDC endpoint is configured for this installation. "
                "Set MCDC_BASE_URL (and MCDC_API_KEY) to export to it."
            )

        import httpx

        url = f"{settings.mcdc_base_url.rstrip('/')}/forms"
        headers = {
            "Content-Type": "application/json",
            # The identity of this delivery, on the wire. This end already
            # refuses to send a version twice; saying so lets the far end refuse
            # as well, which is what makes a retry across a dropped connection
            # safe in both directions. Harmless if MCDC ignores it — whether it
            # honours it, and under what header name, is one of the open
            # questions in EXPORT_API.md.
            "Idempotency-Key": idempotency_key(
                published["form_id"], published["version"], self.name),
        }
        if settings.mcdc_api_key:
            headers["Authorization"] = f"Bearer {settings.mcdc_api_key}"

        try:
            answer = httpx.post(url, json=published, headers=headers,
                                timeout=settings.mcdc_timeout)
        except httpx.TimeoutException as exc:
            logger.warning("MCDC timed out after %ss for %s",
                           settings.mcdc_timeout, published.get("form_id"))
            raise ExportError(
                f"MCDC did not answer within {settings.mcdc_timeout}s. The "
                "export was not completed; try it again.") from exc
        except Exception as exc:                    # network, DNS, TLS
            logger.exception("MCDC export failed for %s", published.get("form_id"))
            raise ExportError(
                f"MCDC could not be reached: {type(exc).__name__}.") from exc

        if answer.status_code in (401, 403):
            # Never the key, never their body — only which end refused.
            raise ExportError("MCDC refused the credentials this installation is using.")
        if 400 <= answer.status_code < 500:
            logger.error("MCDC answered %s for %s", answer.status_code,
                         published.get("form_id"))
            raise ExportError(
                f"MCDC refused the configuration ({answer.status_code}). It was "
                "sent but not accepted.")
        if answer.status_code >= 500:
            logger.error("MCDC answered %s for %s", answer.status_code,
                         published.get("form_id"))
            raise ExportError(
                f"MCDC is having trouble ({answer.status_code}). Try again shortly.")

        try:
            body = answer.json()
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}

        return {"remote_id": str(body.get("id") or body.get("form_id") or ""),
                "detail": {"http_status": answer.status_code}}


class EchoConnector(ExportConnector):
    """A connector that accepts everything and sends it nowhere.

    For trying the flow, and for tests, on an installation with no external
    platform to talk to. It records the export exactly as a real connector does,
    which is what makes it useful: everything but the last hop is the same code.
    """

    name = "echo"
    label = "Echo (records the export, sends nothing)"

    def export(self, published: Dict[str, Any]) -> Dict[str, Any]:
        return {"remote_id": "",
                "detail": {"echoed": True,
                           "fields": len((published.get("config") or {}).get("fields") or [])}}


CONNECTORS: Dict[str, ExportConnector] = {
    c.name: c for c in (MCDCConnector(), EchoConnector())
}


def get(name: str) -> ExportConnector:
    connector = CONNECTORS.get((name or "").strip().lower())
    if connector is None:
        raise UnknownConnector(
            f"There is no '{name}' connector. Known: {', '.join(sorted(CONNECTORS))}.")
    return connector


def available() -> list:
    return [{"connector": c.name, "label": c.label, "configured": c.configured()}
            for c in CONNECTORS.values()]


# --------------------------------------------------------------------------- #
# what has been sent where, and how it went
# --------------------------------------------------------------------------- #
def idempotency_key(form_id: str, version_no: int, connector: str) -> str:
    """The identity of one delivery. Form, version, connector — nothing else."""
    return f"{form_id}:{int(version_no)}:{connector}"


def request_hash(published: Dict[str, Any]) -> str:
    """A digest of exactly what was sent.

    So that "is what they hold what we published?" has an answer that does not
    depend on asking them. Sorted keys, so the same configuration hashes the
    same way whichever order it came out of Postgres in.
    """
    return hashlib.sha256(
        json.dumps(published, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def _shown(row: Dict[str, Any]) -> Dict[str, Any]:
    """One export record, as an API answer. No credential, ever."""
    return {
        "export_id": row["export_id"],
        "form_id": row["form_id"],
        "version": row["form_version"],
        "connector": row["connector"],
        "status": row["status"],
        "external_id": row["external_id"] or "",
        "request_hash": row["request_hash"] or "",
        "response_metadata": row["response_metadata"] or {},
        "error_message": row["error_message"] or "",
        "exported_by": row["exported_by"] or "",
        "created_on": row["created_on"],
        "updated_on": row["updated_on"],
    }


def record_of(form_id: str, version_no: int, connector: str) -> Optional[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute("SELECT * FROM form_export WHERE idempotency_key = %s",
                    (idempotency_key(form_id, version_no, connector),))
        row = cur.fetchone()
    return _shown(dict(row)) if row else None


def history(form_id: str) -> list:
    with transaction() as cur:
        cur.execute("SELECT * FROM form_export WHERE form_id = %s "
                    "ORDER BY created_on DESC", (form_id,))
        return [_shown(dict(r)) for r in cur.fetchall()]


def _claim(published: Dict[str, Any], connector: str,
           exported_by: str) -> Dict[str, Any]:
    """Take, or take over, the row for this delivery.

    Written before the attempt, so a process that dies mid-flight leaves a
    PENDING record rather than silence — somebody can see that a delivery was
    tried. A FAILED row is retried in place: same key, same row, a new attempt.

    An EXPORTED row comes back untouched, which is what makes exporting the same
    version twice safe.
    """
    key = idempotency_key(published["form_id"], published["version"], connector)
    digest = request_hash(published)

    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO form_export
                (form_id, form_version, connector, idempotency_key, status,
                 request_hash, exported_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (idempotency_key) DO UPDATE
               SET status        = CASE WHEN form_export.status = %s
                                        THEN form_export.status ELSE %s END,
                   request_hash  = CASE WHEN form_export.status = %s
                                        THEN form_export.request_hash ELSE %s END,
                   error_message = CASE WHEN form_export.status = %s
                                        THEN form_export.error_message ELSE '' END,
                   exported_by   = CASE WHEN form_export.status = %s
                                        THEN form_export.exported_by ELSE %s END,
                   updated_on    = CURRENT_TIMESTAMP
            RETURNING *
            """,
            (published["form_id"], published["version"], connector, key, PENDING,
             digest, exported_by,
             EXPORTED, PENDING,
             EXPORTED, digest,
             EXPORTED,
             EXPORTED, exported_by),
        )
        return dict(cur.fetchone())


def _finish(export_id: int, status: str, external_id: str = "",
            metadata: Optional[Dict[str, Any]] = None,
            error: str = "") -> Dict[str, Any]:
    with transaction() as cur:
        cur.execute(
            """
            UPDATE form_export
               SET status = %s, external_id = %s, response_metadata = %s,
                   error_message = %s, updated_on = CURRENT_TIMESTAMP
             WHERE export_id = %s
             RETURNING *
            """,
            (status, external_id or "", Json(metadata or {}), error or "", export_id),
        )
        return _shown(dict(cur.fetchone()))


def check_exportable(published: Dict[str, Any]) -> None:
    """Whether this configuration is fit to leave.

    The same structural validation the builder runs, against the frozen version
    rather than against what is on somebody's screen — a definition saved by an
    older version of this application, or edited by hand in the database, is
    caught here rather than by the platform receiving it.
    """
    from app.modules.forms.config_validation import (
        ConfigValidationError, validate_structure,
    )

    config = published.get("config")
    if not isinstance(config, dict) or not config.get("fields"):
        raise ConfigurationRejected(
            f"Version {published.get('version')} of {published.get('form_id')} has "
            "no questions, so there is nothing to collect against.")

    try:
        validate_structure(config)
    except ConfigValidationError as exc:
        raise ConfigurationRejected(
            f"That published configuration is not valid: {exc}") from exc


def send(published: Dict[str, Any], connector_name: str,
         exported_by: str = "") -> Dict[str, Any]:
    """Deliver a published configuration, once.

    Idempotent on form + version + connector. A version already delivered is not
    sent again and the answer says so; a version whose last attempt failed is
    tried again in the same row. Publishing an edit makes a new version, which
    is a new delivery.

    What is delivered is the configuration and nothing else — no answers, no
    submissions, no credential. Collected data travels the other way, through
    the submission service, and never through here.
    """
    connector = get(connector_name)
    check_exportable(published)

    claimed = _claim(published, connector.name, exported_by)
    if claimed["status"] == EXPORTED:
        return {**_shown(claimed), "already_exported": True}

    try:
        result = connector.export(published)
    except ExportError as exc:
        # Recorded, not swallowed: the row says somebody tried and what went
        # wrong, and the same call will try again.
        _finish(claimed["export_id"], FAILED, error=str(exc))
        raise

    logger.info("Exported %s v%s to %s", published["form_id"],
                published["version"], connector.name)
    return {
        **_finish(claimed["export_id"], EXPORTED,
                  external_id=result.get("remote_id") or result.get("external_id") or "",
                  metadata=result.get("detail") or {}),
        "already_exported": False,
    }
