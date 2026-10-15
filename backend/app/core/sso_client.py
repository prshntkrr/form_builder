"""Client adapter for communicating with the Central SSO service."""
import logging
from typing import Any, Dict, List, Optional, Tuple

import httpx
from app.core.config import settings

logger = logging.getLogger(__name__)


def is_sso_enabled() -> bool:
    return bool(settings.sso_enabled and settings.sso_api_url)


def login(identifier: str, password: str) -> Tuple[bool, Optional[Dict[str, Any]], str]:
    """Authenticate credentials against the central SSO service.

    Returns:
        (success, user_dict_or_none, error_message)
    """
    if not is_sso_enabled():
        return False, None, "SSO integration is disabled"

    url = f"{settings.sso_api_url.rstrip('/')}/api/sso/auth/login"
    try:
        with httpx.Client(timeout=8.0) as client:
            resp = client.post(
                url,
                json={
                    "identifier": identifier,
                    "password": password,
                    "app_id": getattr(settings, "sso_app_id", "eagrology"),
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                return True, data, ""
            elif resp.status_code == 401:
                detail = resp.json().get("detail", "Invalid credentials")
                return False, None, detail
            elif resp.status_code == 403:
                detail = resp.json().get("detail", "Account is deactivated")
                return False, None, detail
            else:
                detail = resp.json().get("detail", f"SSO returned HTTP {resp.status_code}")
                return False, None, detail
    except httpx.RequestError as exc:
        logger.warning("Failed to reach SSO service at %s: %s", url, exc)
        return False, None, "Central SSO service is currently unreachable"


def verify_token(token: str) -> Optional[Dict[str, Any]]:
    """Validate a token directly with SSO."""
    if not is_sso_enabled():
        return None

    url = f"{settings.sso_api_url.rstrip('/')}/api/sso/auth/verify"
    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.post(url, json={"token": token})
            if resp.status_code == 200:
                return resp.json().get("user")
    except Exception as exc:
        logger.warning("SSO verify failed: %s", exc)
    return None


def fetch_sso_users() -> List[Dict[str, Any]]:
    """Fetch all users directly from SSO directory."""
    if not is_sso_enabled():
        return []

    url = f"{settings.sso_api_url.rstrip('/')}/api/sso/users"
    headers = {"X-SSO-Api-Key": settings.sso_api_key}
    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(url, headers=headers)
            if resp.status_code == 200:
                return resp.json().get("users", [])
    except Exception as exc:
        logger.warning("SSO fetch users failed: %s", exc)
    return []
