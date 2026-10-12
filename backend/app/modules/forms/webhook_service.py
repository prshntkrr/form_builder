"""Managing webhook endpoints for WhatsApp (and later IVR).

Each webhook is its own URL that a provider posts to:

    /api/integrations/whatsapp/webhook/<webhook_id>

Multiple webhooks let one installation receive messages from several
WhatsApp numbers or Picky Assist accounts. Each webhook can be scoped to
a project so the right token is used to reply.

The token stored here is the Picky Assist credential for *this* webhook's
replies. It is sealed the same way `channel_settings` seals its token.
"""
import logging
import secrets as stdlib_secrets
from typing import Any, Dict, List, Optional

from app.core import secrets
from app.core.database import transaction

logger = logging.getLogger(__name__)


class WebhookError(ValueError):
    """The webhook cannot be created or updated as asked."""


def _generate_id() -> str:
    return stdlib_secrets.token_hex(12)


def _aad(webhook_id: str) -> str:
    return f"webhook_config:{webhook_id}"


def _row_to_dict(row) -> Dict[str, Any]:
    if row is None:
        return {}
    return dict(row)


def _shown(row: Dict[str, Any], base_url: str = "") -> Dict[str, Any]:
    """What an API may return — everything except the sealed token."""
    return {
        "webhook_id": row["webhook_id"],
        "label": row.get("label") or "",
        "channel": row.get("channel") or "whatsapp",
        "project_id": row.get("project_id"),
        "enabled": row.get("enabled", True),
        "token_set": bool(row.get("api_token")),
        "token_hint": row.get("token_hint") or "",
        "webhook_url": f"{base_url}/api/integrations/whatsapp/webhook/{row['webhook_id']}",
        "created_by": row.get("created_by") or "",
        "created_on": row.get("created_on"),
        "updated_on": row.get("updated_on"),
    }


def list_webhooks(project_id: Optional[str] = None,
                  base_url: str = "") -> List[Dict[str, Any]]:
    with transaction() as cur:
        if project_id:
            cur.execute(
                "SELECT * FROM webhook_config "
                "WHERE project_id = %s OR project_id IS NULL "
                "ORDER BY created_on DESC",
                (project_id,),
            )
        else:
            cur.execute("SELECT * FROM webhook_config ORDER BY created_on DESC")
        return [_shown(_row_to_dict(r), base_url) for r in cur.fetchall()]


def get_webhook(webhook_id: str, base_url: str = "") -> Optional[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute("SELECT * FROM webhook_config WHERE webhook_id = %s",
                    (webhook_id,))
        row = cur.fetchone()
    if not row:
        return None
    return _shown(_row_to_dict(row), base_url)


def create_webhook(*, label: str, channel: str = "whatsapp",
                   project_id: Optional[str] = None,
                   api_token: str = "",
                   created_by: str = "",
                   base_url: str = "") -> Dict[str, Any]:
    label = (label or "").strip()
    if not label:
        raise WebhookError("A webhook needs a label.")

    webhook_id = _generate_id()

    sealed_token = ""
    token_hint = ""
    if api_token:
        text = api_token.strip()
        if not secrets.available():
            raise WebhookError(
                "This installation has no SECRET_KEY, so a token cannot be "
                "stored. Set SECRET_KEY (at least 32 characters) and restart.")
        sealed_token = secrets.seal(text, _aad(webhook_id))
        token_hint = text[-4:]

    with transaction() as cur:
        cur.execute(
            "INSERT INTO webhook_config "
            "(webhook_id, label, channel, project_id, api_token, token_hint, created_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING *",
            (webhook_id, label, channel, project_id,
             sealed_token, token_hint, created_by),
        )
        row = _row_to_dict(cur.fetchone())

    logger.info("Created webhook %s (%s) for %s by %s",
                webhook_id, label, project_id or "system", created_by)
    return _shown(row, base_url)


def update_webhook(webhook_id: str, *,
                   label: Optional[str] = None,
                   enabled: Optional[bool] = None,
                   api_token: Optional[str] = None,
                   base_url: str = "") -> Dict[str, Any]:
    assignments = ["updated_on = CURRENT_TIMESTAMP"]
    values: list = []

    if label is not None:
        label = label.strip()
        if not label:
            raise WebhookError("A webhook needs a label.")
        assignments.append("label = %s")
        values.append(label)

    if enabled is not None:
        assignments.append("enabled = %s")
        values.append(enabled)

    if api_token is not None:
        text = api_token.strip()
        if text and not secrets.available():
            raise WebhookError(
                "This installation has no SECRET_KEY, so a token cannot be stored.")
        assignments += ["api_token = %s", "token_hint = %s"]
        values += [
            secrets.seal(text, _aad(webhook_id)) if text else "",
            text[-4:] if text else "",
        ]

    with transaction() as cur:
        cur.execute(
            f"UPDATE webhook_config SET {', '.join(assignments)} "
            "WHERE webhook_id = %s RETURNING *",
            [*values, webhook_id],
        )
        row = cur.fetchone()

    if not row:
        raise WebhookError("That webhook does not exist.")
    return _shown(_row_to_dict(row), base_url)


def delete_webhook(webhook_id: str) -> bool:
    with transaction() as cur:
        cur.execute("DELETE FROM webhook_config WHERE webhook_id = %s", (webhook_id,))
        deleted = cur.rowcount > 0
    if deleted:
        logger.info("Deleted webhook %s", webhook_id)
    return deleted


def token_for(webhook_id: str) -> str:
    """The plaintext credential for this webhook's outbound replies.

    Falls back to the project's or system's channel_settings token if this
    webhook has none of its own.
    """
    with transaction() as cur:
        cur.execute(
            "SELECT api_token, project_id FROM webhook_config WHERE webhook_id = %s",
            (webhook_id,),
        )
        row = cur.fetchone()

    if not row:
        return ""

    sealed = row["api_token"] if row else ""
    if sealed:
        try:
            return secrets.unseal(sealed, _aad(webhook_id))
        except (secrets.SecretUnavailable, secrets.SecretTampered) as exc:
            logger.error("Webhook %s token could not be read: %s", webhook_id, exc)

    # Fall back to channel_settings for this project
    from app.modules.forms import channel_settings
    return channel_settings.token(row["project_id"] if row else None)


def project_for(webhook_id: str) -> Optional[str]:
    """Which project this webhook belongs to."""
    with transaction() as cur:
        cur.execute(
            "SELECT project_id FROM webhook_config WHERE webhook_id = %s",
            (webhook_id,),
        )
        row = cur.fetchone()
    return row["project_id"] if row else None
