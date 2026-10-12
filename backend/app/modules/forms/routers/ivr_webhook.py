"""Provider-agnostic IVR webhook.

A telephony provider posts here when a call arrives or a caller presses
digits. This adapter normalises the payload into (identity, dtmf, voice_url)
and hands it to `ivr_runtime.reply()`, then formats the TTS response back
into whatever the provider expects.

Provider-specific formatting lives here; conversation logic does not.
"""
import logging

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.modules.forms import channel_settings, ivr_runtime

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/integrations/ivr", tags=["ivr-webhook"])

SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text"


async def _transcribe(audio_url: str, project_id: str | None) -> str:
    """Send audio to Sarvam AI for speech-to-text."""
    token = channel_settings.token("sarvam", project_id)
    if not token:
        logger.warning("No Sarvam API key configured — cannot transcribe")
        return ""

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                SARVAM_STT_URL,
                json={"url": audio_url, "language_code": "hi-IN"},
                headers={"api-subscription-key": token},
            )
            resp.raise_for_status()
            return (resp.json().get("transcript") or "").strip()
    except Exception:
        logger.exception("Sarvam transcription failed")
        return ""


def _extract(body: dict) -> dict:
    """Normalise a provider payload into our fields.

    Supports a generic shape; real providers will need specific parsing
    added here as they are integrated.
    """
    return {
        "identity": (body.get("caller_id") or body.get("from")
                      or body.get("phone") or ""),
        "dtmf": body.get("dtmf") or body.get("digits") or "",
        "voice_url": body.get("recording_url") or body.get("audio_url") or "",
        "menu_key": body.get("keyword") or body.get("menu_key") or "",
        "project_id": body.get("project_id") or None,
    }


@router.post("/webhook")
async def ivr_incoming(request: Request):
    body = await request.json()
    parsed = _extract(body)

    identity = parsed["identity"]
    if not identity:
        return JSONResponse({"error": "no caller identity"}, status_code=400)

    voice_text = ""
    if parsed["voice_url"]:
        voice_text = await _transcribe(parsed["voice_url"], parsed["project_id"])

    result = ivr_runtime.reply(
        identity=identity,
        dtmf=parsed["dtmf"],
        voice_text=voice_text,
        menu_key=parsed["menu_key"],
    )

    if result is None:
        return JSONResponse({"action": "hangup"})

    return JSONResponse({
        "action": "respond",
        "tts": result.get("text", ""),
        "collect": result.get("collect", "none"),
        "max_digits": result.get("max_digits", 1),
        "timeout": result.get("timeout", 10),
    })
