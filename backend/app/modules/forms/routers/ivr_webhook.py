"""Provider-agnostic IVR webhook.

A telephony provider posts here when a call arrives or a caller presses
digits. This adapter normalises the payload into (identity, dtmf, voice_url)
and hands it to `ivr_runtime.reply()`, then formats the TTS response back
into whatever the provider expects.

Provider-specific formatting lives here; conversation logic does not.
"""
import json
import logging
import re
import time
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.responses import JSONResponse

from app.modules.forms import (
    channel_settings, form_service, indev_service,
    ivr_runtime, media_service, routing, submission_service,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/integrations/ivr", tags=["ivr-webhook"])

SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text"


async def _transcribe(audio_url: str, project_id: str | None) -> str:
    """Send audio to Sarvam AI for speech-to-text."""
    token = channel_settings.token(project_id, channel="sarvam")
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


@router.get("/health")
def ivr_health():
    """Health check for IVR integration."""
    return {"status": "ok", "service": "e-agrology-ivr"}


SYNONYMS = {
    "wheat": ["गेहूँ", "गेहूं", "वीट", "कनक", "गंदुम", "wheat"],
    "rice": ["धान", "चावल", "राइस", "भात", "paddy", "rice"],
    "maize": ["मक्का", "मकई", "भुट्टा", "कॉर्न", "corn", "maize"],
    "cotton": ["कपास", "रुई", "cotton"],
    "sugarcane": ["गन्ना", "ईख", "कमन्द", "sugarcane"],
    "mustard": ["सरसों", "राई", "तोरिया", "mustard"],
    "gram": ["चना", "छोला", "gram", "chana"],
    "soybean": ["सोयाबीन", "soybean"],
    "yes": ["हाँ", "हां", "सही", "yes", "y", "haan", "sahi"],
    "no": ["नहीं", "ना", "गलत", "no", "n", "nahi", "galat"],
}

HINDI_DIGITS = {
    "एक": 1, "पहला": 1,
    "दो": 2, "दूसरा": 2,
    "तीन": 3, "तीसरा": 3,
    "चार": 4, "चौथा": 4,
    "पाँच": 5, "पांच": 5, "पांचवा": 5,
    "छह": 6, "छठा": 6,
    "सात": 7, "सातवा": 7,
    "आठ": 8, "आठवा": 8,
    "नौ": 9, "नौवा": 9,
    "शून्य": 0, "ज़ीरो": 0, "जीरो": 0,
    "दस": 10, "ग्यारह": 11, "बारह": 12, "तेरह": 13, "चौदह": 14,
    "पंद्रह": 15, "सोलह": 16, "सत्रह": 17, "अठारह": 18, "उन्नीस": 19,
    "बीस": 20, "पच्चीस": 25, "तीस": 30, "चालीस": 40, "पचास": 50, "सौ": 100,
}

PUNCT_CHARS = " \t\r\n.,;:!?\"'|।/\\()[]{}-_=+`~@#$%^&*<>"


def _clean_str(s: Any) -> str:
    res = str(s or "").strip().lower()
    for ch in PUNCT_CHARS:
        res = res.replace(ch, " ")
    return " ".join(res.split())


def _normalize_ivr_answer(val: Any, field_def: Dict[str, Any]) -> Any:
    if val is None:
        return None
    val_str = str(val).strip(" \t\r\n।.,!?\"'")
    if not val_str:
        return None

    ftype = (field_def.get("type") or "text").lower()

    if ftype in ("select", "select_one", "choice", "radio", "dropdown"):
        opts = field_def.get("options") or []
        if not opts:
            return val_str

        allowed_vals = [str(o.get("value")) for o in opts if o.get("value") is not None]
        if val_str in allowed_vals:
            return val_str

        # 1. Digit match (e.g. "1", "1.", DTMF keypad)
        digits = re.findall(r"\d+", val_str)
        if digits and len(digits) == 1:
            idx = int(digits[0]) - 1
            if 0 <= idx < len(opts):
                return opts[idx].get("value")

        # 2. Hindi digit word
        for hw, d in HINDI_DIGITS.items():
            if hw == val_str or hw in val_str.split():
                idx = d - 1
                if 0 <= idx < len(opts):
                    return opts[idx].get("value")

        # 3. Label exact / substring match
        c_val = _clean_str(val_str)
        for opt in opts:
            if _clean_str(opt.get("label")) == c_val:
                return opt.get("value")

        for opt in opts:
            c_lbl = _clean_str(opt.get("label"))
            if c_lbl and (c_lbl in c_val or c_val in c_lbl):
                return opt.get("value")

        # 4. Synonym match
        for group, words in SYNONYMS.items():
            if any(w in c_val for w in words):
                for opt in opts:
                    c_lbl = _clean_str(opt.get("label"))
                    c_oval = _clean_str(opt.get("value"))
                    if any(w in c_lbl or w in c_oval for w in words):
                        return opt.get("value")

        # 5. Fallback to "other" / "अन्य"
        for opt in opts:
            c_lbl = _clean_str(opt.get("label"))
            c_oval = _clean_str(opt.get("value"))
            if "अन्य" in c_lbl or "other" in c_lbl or "other" in c_oval:
                return opt.get("value")

        # If still unmapped, return None so it doesn't fail strict validation
        return None

    if ftype in ("number", "integer", "numeric", "decimal"):
        digits = re.findall(r"[-+]?\d*\.?\d+", val_str)
        if digits:
            try:
                return float(digits[0]) if "." in digits[0] else int(digits[0])
            except ValueError:
                pass
        for hw, d in HINDI_DIGITS.items():
            if hw in val_str:
                return d
        return None

    if ftype == "boolean":
        c_val = _clean_str(val_str)
        if c_val in ("1", "yes", "true", "हाँ", "हां", "sahi", "haan"):
            return True
        if c_val in ("2", "no", "false", "नहीं", "ना", "galat", "nahi"):
            return False
        return None

    return val_str


@router.post("/indev")
async def indev_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
):
    """Receive completed survey call from Indev Consultancy IVR.

    Indev calls this webhook once a caller completes (or ends) the survey call.
    Payload contains:
        call_id: unique call identifier
        caller: caller phone number
        did: the phone number dialed (matches receiver_number in channel_form_route)
        recording_url: signed URL to full call .wav recording
        answers: list of [{seq, question, type, answer_text, audio_url}]

    Processing pipeline:
    1. Authenticate X-Webhook-Secret header.
    2. Resolve target form by matching `did` with `channel_form_route.receiver_number`.
    3. Map seq responses to form fields using stored `seq_map`.
    4. Ingest answers into Postgres data table via MCDC `submission_service.submit()`.
    5. Enqueue background task to download and archive audio recordings into AWS S3 (form_media).
    6. Return HTTP 200 immediately in < 50ms.
    """
    try:
        body = await request.json()
    except Exception:
        logger.warning("Indev webhook received non-JSON or invalid body")
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)

    call_id = str(body.get("call_id") or "").strip()
    caller = str(body.get("caller") or body.get("phone") or body.get("from") or "").strip()
    did = str(body.get("did") or body.get("receiver_number") or body.get("to") or "").strip()
    survey_name = str(body.get("survey") or body.get("survey_name") or body.get("form_title") or body.get("form_id") or "").strip()
    recording_url = body.get("recording_url")
    answers: List[Dict[str, Any]] = body.get("answers") or []

    logger.info("Indev IVR webhook received: call_id=%s, caller=%s, did=%s, survey=%s, answers_count=%d",
                call_id, caller, did, survey_name, len(answers))

    # Guard: If caller hung up immediately with zero answers, skip creating an empty submission
    has_any_answer = any(
        bool(str(item.get("answer_text") or item.get("text") or item.get("dtmf") or "").strip())
        for item in answers
    )
    if not has_any_answer:
        logger.info("Indev call %s ended with 0 answers (abandoned/hung up immediately). Skipping empty submission.",
                    call_id)
        return JSONResponse({
            "status": "ignored",
            "message": "Call had no answers, skipped creating empty submission",
            "call_id": call_id,
        })

    # Resolve matching route for this call
    all_ivr_routes = routing.list_routes(channel="ivr")
    enabled_routes = [r for r in all_ivr_routes if r.get("enabled")]

    matched_route = None

    # Step 1: If webhook specifies survey name or form_title, match among enabled routes
    if survey_name:
        s_norm = survey_name.lower().replace("_", " ").strip()
        for r in enabled_routes:
            f_id = r.get("form_id")
            try:
                f_meta = form_service.get_form(f_id)
                f_title = (f_meta.get("form_title") or "").lower().replace("_", " ").strip()
                if s_norm == f_title or s_norm in f_title or f_title in s_norm or s_norm == f_id.lower():
                    # If this route also matches the DID, it's a perfect match
                    rec = r.get("receiver_number") or ""
                    if did and rec and routing.same_number(rec, did):
                        matched_route = r
                        break
                    if not matched_route:
                        matched_route = r
            except Exception:
                pass

    # Step 2: Fallback to matching route by DID
    if not matched_route and did:
        for r in enabled_routes:
            rec = r.get("receiver_number") or ""
            if rec and routing.same_number(rec, did):
                matched_route = r
                break

    # Step 3: Fallback to wildcard or first enabled route
    if not matched_route and enabled_routes:
        wildcards = [r for r in enabled_routes if not (r.get("receiver_number") or "").strip()]
        matched_route = wildcards[0] if wildcards else enabled_routes[0]

    if not matched_route:
        logger.warning("No active IVR route found for survey '%s', DID '%s'", survey_name, did)
        return JSONResponse(
            {"status": "no_route", "message": f"No active IVR form route configured for survey '{survey_name}' (DID {did})"},
            status_code=200,
        )

    project_id = matched_route.get("project_id")
    form_id = matched_route["form_id"]

    # Validate webhook secret
    expected_secret = indev_service.get_indev_webhook_secret(project_id)
    if expected_secret:
        header_secret = (request.headers.get("X-Webhook-Secret")
                         or request.headers.get("x-webhook-secret")
                         or "")
        if header_secret != expected_secret:
            logger.warning("Indev IVR webhook unauthorized: invalid secret for form %s (did %s)",
                           form_id, did)
            return JSONResponse({"error": "Unauthorized: invalid X-Webhook-Secret"}, status_code=401)

    # Fetch form definition
    try:
        form = form_service.get_form(form_id)
    except Exception as exc:
        logger.error("Could not load form %s for IVR route: %s", form_id, exc)
        return JSONResponse({"error": f"Form '{form_id}' not found"}, status_code=404)

    form_json = form.get("form_json") or {}
    fields = form_json.get("fields") or []
    fields_by_name = {f.get("name"): f for f in fields if f.get("name")}
    seq_map = (form_json.get("channel_config", {}).get("ivr", {}).get("seq_map")
               or indev_service.build_indev_questions(form_json)[1])

    # Map answers to form fields
    payload: Dict[str, Any] = {}
    for item in answers:
        seq = str(item.get("seq", ""))
        val = item.get("answer_text")
        if val is None:
            val = item.get("text") or item.get("dtmf") or ""

        field_name = seq_map.get(seq)
        if not field_name:
            # Fallback by matching question prompt or field name
            q_text = str(item.get("question") or "").strip().lower()
            for f in fields:
                if (str(f.get("label") or "").strip().lower() == q_text
                        or f.get("name", "").lower() == q_text):
                    field_name = f.get("name")
                    break

        if field_name:
            fdef = fields_by_name.get(field_name, {})
            norm_val = _normalize_ivr_answer(val, fdef)
            if norm_val is not None:
                payload[field_name] = norm_val

    # Auto-fill caller phone number into phone field if blank
    for f in fields:
        fname = f.get("name")
        ftype = (f.get("type") or "").lower()
        if (ftype == "phone" or "phone" in fname.lower() or "mobile" in fname.lower() or "contact" in fname.lower()):
            if not payload.get(fname) and caller:
                payload[fname] = caller

    # Ingest answers into Postgres via MCDC submission service
    client_sub_id = call_id or f"indev_{caller}_{int(time.time())}"
    # Sanitize client submission id
    client_sub_id = re.sub(r"[^A-Za-z0-9._:-]", "_", client_sub_id)[:64]

    try:
        sub_result = submission_service.submit(
            form=form,
            payload=payload,
            created_by=f"ivr:{caller}" if caller else "ivr:indev",
            channel="ivr",
            client_submission_id=client_sub_id,
            source_ref=call_id,
        )
        survey_id = sub_result["survey_id"]
    except submission_service.SubmissionConflict as exc:
        logger.info("Indev IVR submission already recorded (idempotent replay): %s", exc)
        return JSONResponse({
            "status": "success",
            "message": "Submission already processed (replayed)",
            "call_id": call_id,
            "replayed": True,
        })
    except submission_service.ValidationFailed as val_err:
        logger.warning("Indev IVR submission validation error: %s. Cleaning failing fields and re-submitting.", val_err)
        for bad_field in (getattr(val_err, "errors", None) or {}).keys():
            payload.pop(bad_field, None)
        sub_result = submission_service.submit(
            form=form,
            payload=payload,
            created_by=f"ivr:{caller}" if caller else "ivr:indev",
            channel="ivr",
            client_submission_id=client_sub_id,
            source_ref=call_id,
        )
        survey_id = sub_result["survey_id"]
    except Exception as exc:
        logger.exception("Indev IVR submission_service.submit failed: %s", exc)
        return JSONResponse({"status": "error", "detail": str(exc)}, status_code=400)

    # Enqueue background task to download & archive audio files into AWS S3
    background_tasks.add_task(
        media_service.archive_indev_audio,
        project_id=project_id,
        form_id=form_id,
        survey_id=survey_id,
        recording_url=recording_url,
        answers=answers,
        seq_map=seq_map,
    )

    logger.info("Indev IVR submission committed: survey_id=%s, form=%s, table=%s",
                survey_id, form_id, sub_result.get("table_name"))

    return JSONResponse({
        "status": "success",
        "survey_id": survey_id,
        "call_id": call_id,
        "replayed": sub_result.get("replayed", False),
    })
