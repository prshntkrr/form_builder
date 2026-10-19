"""Indev Consultancy Inbound Voice Survey (IVR) Service.

Connects e-Agrology forms with Indev's telephony IVR platform:
1. Export/Publish form definition to Indev's Survey API (with DID, Hindi TTS, Sarvam STT, DTMF/Voice questions).
2. Store question sequence mapping (`seq_map`) in `form_json.channel_config.ivr.seq_map`.
3. Hierarchical credential resolution: project-level encrypted tokens -> global encrypted tokens -> .env settings.
4. Response syncing via Indev's pull API.
"""
import logging
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import httpx
from psycopg2.extras import Json

from app.core.config import settings
from app.core.database import transaction
from app.modules.forms import channel_settings, form_service, publishing

logger = logging.getLogger(__name__)


class IndevError(RuntimeError):
    """Failure communicating with Indev IVR API."""


def get_indev_api_key(project_id: Optional[str] = None) -> str:
    """Resolve Indev API Key hierarchically: project-level -> global -> any project -> .env."""
    # 1. Project level sealed token
    if project_id:
        tok = channel_settings.token(project_id, channel="indev")
        if tok:
            return tok
        # Fallback to ivr token if stored there
        tok = channel_settings.token(project_id, channel="ivr")
        if tok:
            return tok

    # 2. Global/system sealed token
    tok = channel_settings.token(None, channel="indev")
    if tok:
        return tok
    tok = channel_settings.token(None, channel="ivr")
    if tok:
        return tok

    # 3. Any project-level fallback
    try:
        with transaction() as cur:
            cur.execute(
                "SELECT project_id FROM channel_settings WHERE channel IN ('indev', 'ivr') AND api_token IS NOT NULL ORDER BY updated_on DESC NULLS LAST LIMIT 1"
            )
            row = cur.fetchone()
            if row and row.get("project_id"):
                tok = channel_settings.token(row["project_id"], channel="indev") or channel_settings.token(row["project_id"], channel="ivr")
                if tok:
                    return tok
    except Exception as exc:
        logger.warning("Could not check project fallback for indev api key: %s", exc)

    # 4. Environment setting fallback
    return getattr(settings, "indev_api_key", "")


def get_indev_webhook_secret(project_id: Optional[str] = None) -> str:
    """Resolve Indev Webhook Secret hierarchically: project-level -> global -> any project -> .env."""
    if project_id:
        tok = channel_settings.token(project_id, channel="indev_secret")
        if tok:
            return tok

    tok = channel_settings.token(None, channel="indev_secret")
    if tok:
        return tok

    try:
        with transaction() as cur:
            cur.execute(
                "SELECT project_id FROM channel_settings WHERE channel = 'indev_secret' AND api_token IS NOT NULL ORDER BY updated_on DESC NULLS LAST LIMIT 1"
            )
            row = cur.fetchone()
            if row and row.get("project_id"):
                tok = channel_settings.token(row["project_id"], channel="indev_secret")
                if tok:
                    return tok
    except Exception as exc:
        logger.warning("Could not check project fallback for indev webhook secret: %s", exc)

    return getattr(settings, "indev_webhook_secret", "")


def clean_did(raw: Any) -> str:
    """Extract standard numeric digits for the DID line (e.g. '1205236308')."""
    return re.sub(r"\D", "", str(raw or ""))


def detect_form_language(form_json: Dict[str, Any]) -> str:
    """Detect whether form is primarily Hindi ('hi-IN') or English ('en-IN').
    
    Checks explicit setting first, then analyzes character distribution.
    """
    ivr_config = (form_json or {}).get("channel_config", {}).get("ivr", {})
    explicit = (ivr_config.get("language") or "").strip().lower()
    if explicit in ("en", "en-in", "english", "en-us"):
        return "en-IN"
    if explicit in ("hi", "hi-in", "hindi"):
        return "hi-IN"

    # Auto-detect from text
    sample_texts = []
    if ivr_config.get("welcome_message"):
        sample_texts.append(str(ivr_config["welcome_message"]))
    if ivr_config.get("completion_message"):
        sample_texts.append(str(ivr_config["completion_message"]))

    for f in (form_json or {}).get("fields") or []:
        if f.get("label"):
            sample_texts.append(str(f["label"]))
        for opt in f.get("options") or []:
            if isinstance(opt, dict):
                sample_texts.append(str(opt.get("label") or opt.get("value") or ""))
            else:
                sample_texts.append(str(opt))

    combined = " ".join(sample_texts)
    hindi_chars = len(re.findall(r"[\u0900-\u097F]", combined))
    latin_chars = len(re.findall(r"[A-Za-z]", combined))

    if hindi_chars > latin_chars:
        return "hi-IN"
    return "en-IN"


def build_indev_questions(form_json: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    """Convert form questions to Indev's question format.

    Returns:
        questions: list of question dictionaries for Indev payload
        seq_map: dictionary mapping string sequence number ('1', '2', ...) to form field name
    """
    fields = (form_json or {}).get("fields") or []
    ivr_config = (form_json or {}).get("channel_config", {}).get("ivr", {})
    lang = detect_form_language(form_json)
    is_english = lang.startswith("en")

    questions: List[Dict[str, Any]] = []
    seq_map: Dict[str, str] = {}
    current_seq = 1

    # Optional intro message (type: info)
    default_welcome = (
        f"Welcome to {(form_json or {}).get('title', 'our survey')}."
        if is_english
        else f"नमस्ते, {(form_json or {}).get('title', 'सर्वेक्षण')} में आपका स्वागत है।"
    )
    welcome_text = (
        ivr_config.get("welcome_message")
        or ivr_config.get("welcome")
        or (form_json or {}).get("description")
        or default_welcome
    )
    if welcome_text and str(welcome_text).strip():
        questions.append({
            "seq": current_seq,
            "type": "info",
            "text": str(welcome_text).strip(),
        })
        current_seq += 1

    # Add each field as a question
    for field in fields:
        name = field.get("name")
        if not name:
            continue

        field_ivr = (ivr_config.get("fields") or {}).get(name, {})
        prompt = field_ivr.get("prompt") or field.get("label") or name
        field_type = (field.get("type") or "text").lower()

        # Decide question type: dtmf or voice
        # Numeric / Rating / Choice can be answered by keypad digits (DTMF)
        if field_type in ("rating", "scale", "nps"):
            q_type = "dtmf"
            max_digits = 1
            if "दबाएँ" not in prompt and "दबाएं" not in prompt and "press" not in prompt.lower():
                prompt = (
                    f"{prompt}. Press 1 to 5 on your keypad."
                    if is_english
                    else f"{prompt}। एक से पाँच तक दबाएँ।"
                )
        elif field_type == "boolean":
            q_type = "dtmf"
            max_digits = 1
            if "दबाएँ" not in prompt and "दबाएं" not in prompt and "press" not in prompt.lower():
                prompt = (
                    f"{prompt}. Press 1 for Yes, Press 2 for No."
                    if is_english
                    else f"{prompt}। हाँ के लिए एक और नहीं के लिए दो दबाएँ।"
                )
        elif field_type in ("select", "select_one", "choice", "radio", "dropdown"):
            options = field.get("options") or []
            if 0 < len(options) <= 9:
                q_type = "dtmf"
                max_digits = 1
                if "दबाएँ" not in prompt and "दबाएं" not in prompt and "press" not in prompt.lower():
                    if is_english:
                        opts_text = ", ".join([
                            f"Press {i + 1} for {opt if isinstance(opt, str) else (opt.get('label') or opt.get('value'))}"
                            for i, opt in enumerate(options)
                        ])
                        prompt = f"{prompt}. {opts_text}."
                    else:
                        opts_text = " ".join([
                            f"{opt if isinstance(opt, str) else (opt.get('label') or opt.get('value'))} के लिए {i + 1}"
                            for i, opt in enumerate(options)
                        ])
                        prompt = f"{prompt}। {opts_text} दबाएँ।"
            else:
                q_type = "voice"
                max_digits = None
        elif field_type in ("integer", "number", "numeric", "decimal"):
            q_type = "voice"
            max_digits = None
        else:
            q_type = "voice"
            max_digits = None

        q_dict: Dict[str, Any] = {
            "seq": current_seq,
            "type": q_type,
            "text": str(prompt).strip(),
        }

        if q_type == "voice":
            q_dict["validate"] = "Y"  # Instructs Indev to run STT transcription
        elif q_type == "dtmf":
            q_dict["maxdigits"] = max_digits or 1

        questions.append(q_dict)
        seq_map[str(current_seq)] = name
        current_seq += 1

    # Add optional completion message as final question (type: info)
    # Indev's Asterisk PBX dialplan macro plays every item in questions[], but
    # skips root 'end_text' before executing its hardcoded hangup audio. By
    # placing the completion message as an 'info' question at the end of the
    # sequence, Indev speaks the custom completion message reliably right after
    # the last survey answer.
    completion_text = (
        ivr_config.get("completion_message")
        or ivr_config.get("thank_you")
    )
    if completion_text and str(completion_text).strip():
        questions.append({
            "seq": current_seq,
            "type": "info",
            "text": str(completion_text).strip(),
        })
        current_seq += 1

    return questions, seq_map


def publish_to_indev(
    form_id: str,
    did: str,
    project_id: Optional[str] = None,
    base_url: str = "",
) -> Dict[str, Any]:
    """Publish the form survey configuration to Indev's Inbound Voice Survey API.

    1. Checks form publication status.
    2. Maps questions into Indev voice/dtmf structure.
    3. Saves `seq_map` and assigned `did` into `form_json.channel_config.ivr`.
    4. Sends payload to Indev Survey API.
    """
    did_clean = clean_did(did)
    if not did_clean:
        raise IndevError("A valid numeric DID (phone number) is required.")

    form = form_service.get_form(form_id)
    if not form:
        raise IndevError(f"Form '{form_id}' not found.")

    try:
        publishing.published(form)
    except publishing.NotPublished as exc:
        raise IndevError(f"Cannot publish unpublished form: {exc}")

    form_json = dict(form.get("form_json") or {})
    lang = detect_form_language(form_json)
    questions, seq_map = build_indev_questions(form_json)

    # Persist the seq_map into form_json channel_config so webhook can map answers back
    channel_config = form_json.setdefault("channel_config", {})
    ivr_config = channel_config.setdefault("ivr", {})
    ivr_config["seq_map"] = seq_map
    ivr_config["did"] = did_clean
    ivr_config["language"] = ivr_config.get("language") or lang
    ivr_config["last_published_to_indev"] = datetime.utcnow().isoformat()

    with transaction() as cur:
        cur.execute(
            """
            UPDATE forms
               SET form_json = %s, updated_on = CURRENT_TIMESTAMP
             WHERE form_id = %s
            """,
            (Json(form_json), form_id),
        )
        # Ensure any other forms using this DID are disabled so only this survey answers
        cur.execute(
            """
            UPDATE channel_form_route
               SET enabled = FALSE, updated_on = CURRENT_TIMESTAMP
             WHERE channel = 'ivr'
               AND receiver_number = %s
               AND form_id <> %s
               AND enabled
            """,
            (did_clean, form_id),
        )

    # Ensure route in channel_form_route is created/updated for this DID
    try:
        from app.modules.forms import routing
        routes = routing.list_routes(channel="ivr", project_id=project_id)
        existing = next((r for r in routes if r.get("form_id") == form_id), None)
        if existing:
            routing.update_route(existing["route_id"], receiver_number=did_clean, enabled=True)
        else:
            routing.create_route(
                channel="ivr",
                route_key="1",
                form_id=form_id,
                project_id=project_id,
                receiver_number=did_clean,
                enabled=True,
                created_by="system",
            )
    except Exception as exc:
        logger.warning("Could not auto-sync channel_form_route for form %s: %s", form_id, exc)

    # Resolve webhook URL
    if not base_url:
        base_url = (getattr(settings, "public_url", "")
                    or getattr(settings, "app_url", "")
                    or "http://localhost:8000")
    webhook_url = f"{base_url.rstrip('/')}/api/integrations/ivr/indev"

    api_key = get_indev_api_key(project_id)
    webhook_secret = get_indev_webhook_secret(project_id)

    custom_completion = str(ivr_config.get("completion_message") or ivr_config.get("thank_you") or "").strip()
    is_english = lang.startswith("en")

    payload = {
        "did": did_clean,
        "name": form.get("form_title") or f"Survey_{form_id}",
        "language": lang,
        "webhook_url": webhook_url,
        "webhook_secret": webhook_secret,
        "questions": questions,
        "closed_text": "This survey is currently closed. Thank you for calling." if is_english else "यह सर्वेक्षण अभी बंद है। धन्यवाद।",
        "end_text": "",
    }

    # Call Indev API
    endpoint = f"{getattr(settings, 'indev_base_url', 'https://ivrs2.indevconsultancy.in/survey/api').rstrip('/')}/survey_api.php"
    headers = {
        "Content-Type": "application/json",
    }
    if api_key:
        headers["X-Api-Key"] = api_key

    logger.info("Publishing form %s to Indev DID %s (endpoint: %s)", form_id, did_clean, endpoint)

    # If no API key configured, return dry-run/preview info with warning
    if not api_key:
        logger.warning("No Indev API key configured. Saved seq_map locally; skipped live Indev call.")
        return {
            "status": "configured_locally",
            "message": f"Survey successfully bound to DID {did_clean}! You can test it via the in-app Call Simulator.",
            "did": did_clean,
            "webhook_url": webhook_url,
            "questions_count": len(questions),
            "seq_map": seq_map,
        }

    timeout = getattr(settings, "indev_timeout", 90)
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(endpoint, json=payload, headers=headers)
            if resp.status_code in (401, 403):
                logger.warning("Indev API returned %s: %s. Saved DID mapping locally for sandbox testing.", resp.status_code, resp.text)
                return {
                    "status": "configured_locally",
                    "message": f"Survey bound to DID {did_clean}! (Remote Indev reported {resp.status_code} unauthorized key; active in local/sandbox mode for testing).",
                    "did": did_clean,
                    "webhook_url": webhook_url,
                    "questions_count": len(questions),
                    "seq_map": seq_map,
                }
            elif resp.status_code >= 400:
                logger.error("Indev API returned HTTP %s: %s", resp.status_code, resp.text)
                raise IndevError(f"Indev API error ({resp.status_code}): {resp.text}")

            resp_json = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            if resp_json.get("status") == "fail":
                raise IndevError(f"Indev rejected survey: {resp_json.get('reason', 'unknown reason')}")

            saved = resp_json.get("questions_saved", len(questions))
            audio = resp_json.get("audio_generated", len(questions))
            return {
                "status": "published",
                "message": f"Successfully published to Indev line {did_clean}! ({saved} questions saved, {audio} audio prompts generated).",
                "did": did_clean,
                "webhook_url": webhook_url,
                "questions_count": len(questions),
                "indev_response": resp_json or resp.text,
                "seq_map": seq_map,
            }
    except httpx.RequestError as exc:
        logger.exception("Connection failed while publishing to Indev")
        raise IndevError(f"Could not reach Indev IVR service: {exc}")


def sync_indev_responses(
    did: str,
    number: Optional[str] = None,
    project_id: Optional[str] = None,
    auto_ingest: bool = True,
) -> Dict[str, Any]:
    """Pull responses from Indev's backup responses API and ingest into Postgres."""
    did_clean = clean_did(did)
    if not did_clean:
        raise IndevError("A valid numeric DID is required.")

    api_key = get_indev_api_key(project_id)
    if not api_key:
        raise IndevError("Indev API Key is required to fetch responses.")

    endpoint = f"{getattr(settings, 'indev_base_url', 'https://ivrs2.indevconsultancy.in/survey/api').rstrip('/')}/responses.php"
    params = {"did": did_clean}
    if number:
        params["number"] = clean_did(number)

    headers = {"X-Api-Key": api_key}
    timeout = getattr(settings, "indev_timeout", 30)

    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.get(endpoint, params=params, headers=headers)
            resp.raise_for_status()
            data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            if not isinstance(data, dict):
                return {"text": resp.text}

            calls = data.get("calls", [])
            imported = 0
            replayed = 0
            from app.modules.forms.routers.ivr_webhook import process_indev_call_record
            for call in calls:
                if not isinstance(call, dict):
                    continue
                if not call.get("did"):
                    call["did"] = did_clean
                res = process_indev_call_record(call)
                if res.get("status") == "success":
                    if res.get("replayed"):
                        replayed += 1
                    else:
                        imported += 1

            return {
                "status": "success",
                "did": did_clean,
                "total_calls": len(calls),
                "newly_imported": imported,
                "already_synced": replayed,
                "calls": calls,
            }
    except httpx.RequestError as exc:
        logger.exception("Failed to pull Indev responses")
        raise IndevError(f"Failed to fetch responses from Indev: {exc}")


ALLOTTED_DIDS = [
    "1205236308",
    "1205236334",
    "1205236335",
    "1205236336",
    "1205236337",
    "1205236338",
    "1205236339",
]


def set_survey_status(
    did: str,
    active: bool,
    project_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Toggle survey ON or OFF on Indev DID line via survey_status.php.

    - active=False -> callers hear closed_text and hang up (zero questions asked).
    - active=True -> survey goes live immediately.
    """
    did_clean = clean_did(did)
    if not did_clean:
        raise IndevError("A valid numeric DID is required.")

    api_key = get_indev_api_key(project_id)
    if not api_key:
        logger.warning("No Indev API key configured. Skipped remote status call.")
        return {"status": "configured_locally", "did": did_clean, "active": active}

    status_endpoint = f"{getattr(settings, 'indev_base_url', 'https://ivrs2.indevconsultancy.in/survey/api').rstrip('/')}/survey_status.php"
    headers = {
        "Content-Type": "application/json",
        "X-Api-Key": api_key,
    }
    payload = {
        "did": did_clean,
        "active": active,
    }

    timeout = getattr(settings, "indev_timeout", 30)
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(status_endpoint, json=payload, headers=headers)
            if resp.status_code == 200:
                data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                logger.info("Indev survey_status.php updated for DID %s to active=%s: %s", did_clean, active, data)
                return data or {"status": "success", "did": did_clean, "active": active}

            # If survey_status.php is 404 (not yet placed on webroot by Indev server team):
            if resp.status_code == 404:
                logger.warning("Indev survey_status.php returned 404. Using fallback to toggle line.")
                survey_endpoint = f"{getattr(settings, 'indev_base_url', 'https://ivrs2.indevconsultancy.in/survey/api').rstrip('/')}/survey_api.php"
                if not active:
                    # When turned OFF: replace line with a 1-sentence closed notice that hangs up immediately
                    closed_payload = {
                        "did": did_clean,
                        "name": "Survey Closed",
                        "language": "en-IN",
                        "closed_text": "This survey is currently closed. Thank you for calling.",
                        "end_text": "",
                        "questions": [
                            {
                                "seq": 1,
                                "type": "info",
                                "text": "This survey is currently closed. Thank you for calling.",
                            }
                        ],
                    }
                    client.post(survey_endpoint, json=closed_payload, headers=headers)
                return {"status": "success", "did": did_clean, "active": active, "fallback": True}

            if resp.status_code >= 400:
                logger.error("Indev survey_status.php error %s: %s", resp.status_code, resp.text)
                raise IndevError(f"Indev survey_status error ({resp.status_code}): {resp.text}")

            return {"status": "success", "did": did_clean, "active": active}
    except httpx.RequestError as exc:
        logger.exception("Connection failed while updating status to Indev")
        raise IndevError(f"Could not reach Indev IVR status service: {exc}")
