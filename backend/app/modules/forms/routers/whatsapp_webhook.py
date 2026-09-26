"""WhatsApp Inbound Webhook & Dynamic Survey Engine for Picky Assist.

Features:
- Two-tier guided onboarding:
    1. First message ("Hi", "Hello", or anything) -> Welcome greeting ("Reply START to begin").
    2. Reply "START" (or "START" directly on 1st message) -> Numbered list of available forms (1, 2, 3...)
       filtered by the receiver WhatsApp number.
    3. Reply with form number or name -> Survey starts at Question 1.
- Whitespace tolerance everywhere: strips accidental spaces in keywords, option choices,
  form names, and numbers.
- In-memory session answer caching (no repetitive DB writes for every question answer).
- 10-minute inactivity auto-expiry: saves partial submission to the form table
  if at least 1 question was answered, then deletes the session.
- Automatic session cleanup via periodic background task and on-message check.
- Strict input validation per field type (re-sends the same question on invalid answer).
"""
import asyncio
import json
import logging
import time
import urllib.parse
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Request, BackgroundTasks
from psycopg2 import sql
from psycopg2.extras import Json
import httpx

from app.core.config import settings
from app.core.database import transaction
from app.modules.forms import (
    form_service,
    submission_service,
    tabular_service,
    table_service,
    ingestion,
)
from app.modules.forms.field_types import coerce_value

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/integrations/whatsapp", tags=["whatsapp-webhook"])

# Picky Assist Push API Config
PUSH_API_URL = "https://app.pickyassist.com/api/v2/push"
PICKY_ASSIST_TOKEN = "2778556211d8a5cdb738b41576a94bd0ee90e2c2"

# Session Inactivity Timeout (10 minutes = 600 seconds)
SESSION_TIMEOUT_SECONDS = 600

# --------------------------------------------------------------------------- #
# Whitespace Normalization Helpers
# --------------------------------------------------------------------------- #
def strip_all_spaces(text: str) -> str:
    """Removes all whitespace characters and converts to lowercase for tolerant comparison."""
    return "".join((text or "").split()).casefold()


def normalize_spaces(text: str) -> str:
    """Strips leading/trailing spaces and collapses multiple internal spaces into a single space."""
    return " ".join((text or "").strip().split())


# --------------------------------------------------------------------------- #
# In-Memory Session Storage
# --------------------------------------------------------------------------- #
# States:
#   "AWAITING_FORM" -> User sent START, bot presented numbered menu (1, 2, 3...)
#   "IN_SURVEY"     -> User picked a form, answering questions sequentially
ACTIVE_SESSIONS: Dict[str, Dict[str, Any]] = {}
_cleanup_task: Optional[asyncio.Task] = None


# --------------------------------------------------------------------------- #
# Push API Helper – sends message via Picky Assist Push API
# --------------------------------------------------------------------------- #
async def send_whatsapp(number: str, message: str, application: int = 121):
    """Send a WhatsApp message via Picky Assist Push API."""
    payload = {
        "token": PICKY_ASSIST_TOKEN,
        "application": application,
        "data": [
            {
                "number": number,
                "message": message,
            }
        ],
    }
    logger.info("Push API Request -> number=%s, app=%s, msg=%s", number, application, message[:100])
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(PUSH_API_URL, json=payload)
            logger.info("Push API Response -> status=%s body=%s", resp.status_code, resp.text)
    except Exception as e:
        logger.exception("Push API call failed: %s", e)


# --------------------------------------------------------------------------- #
# Partial Submission Helper
# --------------------------------------------------------------------------- #
def save_partial_submission(form_id: str, answers: Dict[str, Any], phone_number: str):
    """Saves partial responses directly to the form table when a session times out."""
    if not answers:
        return
    try:
        form = form_service.get_form(form_id)
        if not form:
            return
        form_json = form.get("form_json") or {}
        table_name = form_json.get("table_name")
        if not table_name:
            return

        # Coerce answered fields
        clean = {}
        for field in form_json.get("fields") or []:
            fname = field.get("name")
            if fname in answers and answers[fname] is not None:
                try:
                    clean[fname] = coerce_value(field.get("type", "text"), answers[fname])
                except Exception:
                    clean[fname] = answers[fname]

        if not clean:
            return

        version = form.get("version_no") or form_json.get("version") or 1
        created_by = f"whatsapp_bot_partial:{phone_number}"

        with transaction() as cur:
            if not table_service.table_exists(cur, table_name):
                return
            survey_id = table_service.next_survey_id(cur, form["form_id"], table_name)
            submission_service._write(
                cur=cur,
                form=form,
                form_json=form_json,
                table_name=table_name,
                clean=clean,
                version=version,
                created_by=created_by,
                parent_survey_id=None,
                location=None,
                survey_id=survey_id,
                channel="whatsapp",
                client_submission_id=None,
                source_ref=f"partial timeout {phone_number}",
                payload=answers,
            )
        logger.info(
            "Saved partial submission for %s (form: %s, survey_id: %s, answers count: %d)",
            phone_number, form_id, survey_id, len(clean)
        )
    except Exception as exc:
        logger.exception("Failed to save partial submission for %s: %s", phone_number, exc)


# --------------------------------------------------------------------------- #
# Database Session Operations & In-Memory Synchronization
# --------------------------------------------------------------------------- #
def clear_session(phone_number: str):
    """Deletes session from both DB and memory."""
    ACTIVE_SESSIONS.pop(phone_number, None)
    with transaction() as cur:
        cur.execute("DELETE FROM whatsapp_survey_session WHERE phone_number = %s;", (phone_number,))


def expire_session(phone_number: str):
    """Expires a session: saves partial data if answers exist, then deletes it."""
    sess = ACTIVE_SESSIONS.pop(phone_number, None)
    answers = sess.get("answers", {}) if sess else {}
    form_id = sess.get("form_id") if sess else None

    if form_id and answers and len(answers) > 0:
        save_partial_submission(form_id, answers, phone_number)

    clear_session(phone_number)
    logger.info("Session expired and cleaned up for %s", phone_number)


def get_session(phone_number: str) -> Optional[Dict[str, Any]]:
    """Gets session from memory or DB, checking 10-minute timeout."""
    now = time.time()

    # 1. Check in-memory cache
    if phone_number in ACTIVE_SESSIONS:
        sess = ACTIVE_SESSIONS[phone_number]
        if now - sess.get("last_activity", 0) > SESSION_TIMEOUT_SECONDS:
            logger.info("In-memory session expired (> 10m) for %s", phone_number)
            expire_session(phone_number)
            return None
        return sess

    # 2. Check DB fallback (e.g. after server reload)
    with transaction() as cur:
        cur.execute(
            """
            SELECT phone_number, receiver_number, form_id, current_step, answers,
                   EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - updated_at)) AS idle_seconds
            FROM whatsapp_survey_session
            WHERE phone_number = %s;
            """,
            (phone_number,),
        )
        row = cur.fetchone()
        if not row:
            return None

        idle = float(row.get("idle_seconds") or 0)
        form_id = row.get("form_id")
        answers = row.get("answers") or {}

        if idle > SESSION_TIMEOUT_SECONDS:
            logger.info("DB session expired (> 10m) for %s (idle: %.1fs)", phone_number, idle)
            if form_id and answers and len(answers) > 0:
                save_partial_submission(form_id, answers, phone_number)
            clear_session(phone_number)
            return None

        # Re-hydrate in-memory
        state = "IN_SURVEY" if form_id else "AWAITING_FORM"
        sess = {
            "state": state,
            "receiver_number": row.get("receiver_number") or "",
            "form_id": form_id,
            "current_step": row.get("current_step", 0),
            "answers": answers,
            "forms_list": [],
            "last_activity": now - idle,
        }
        ACTIVE_SESSIONS[phone_number] = sess
        return sess


def start_form_selection_session(phone_number: str, receiver_number: str, forms_list: List[Dict[str, Any]]):
    """Initializes session waiting for the user to select a form from the menu."""
    ACTIVE_SESSIONS[phone_number] = {
        "state": "AWAITING_FORM",
        "receiver_number": receiver_number,
        "form_id": None,
        "current_step": 0,
        "answers": {},
        "forms_list": forms_list,
        "last_activity": time.time(),
    }
    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO whatsapp_survey_session (phone_number, receiver_number, form_id, current_step, answers, updated_at)
            VALUES (%s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
            ON CONFLICT (phone_number) DO UPDATE
            SET receiver_number = EXCLUDED.receiver_number,
                form_id = EXCLUDED.form_id,
                current_step = EXCLUDED.current_step,
                answers = EXCLUDED.answers,
                updated_at = CURRENT_TIMESTAMP;
            """,
            (phone_number, receiver_number, None, 0, Json({})),
        )


def start_survey_session(phone_number: str, receiver_number: str, form_id: str):
    """Transitions user into the active survey state starting at Question 1."""
    ACTIVE_SESSIONS[phone_number] = {
        "state": "IN_SURVEY",
        "receiver_number": receiver_number,
        "form_id": form_id,
        "current_step": 1,
        "answers": {},
        "forms_list": [],
        "last_activity": time.time(),
    }
    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO whatsapp_survey_session (phone_number, receiver_number, form_id, current_step, answers, updated_at)
            VALUES (%s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
            ON CONFLICT (phone_number) DO UPDATE
            SET receiver_number = EXCLUDED.receiver_number,
                form_id = EXCLUDED.form_id,
                current_step = EXCLUDED.current_step,
                answers = EXCLUDED.answers,
                updated_at = CURRENT_TIMESTAMP;
            """,
            (phone_number, receiver_number, form_id, 1, Json({})),
        )


def update_session_progress(phone_number: str, field_name: str, value: Any, next_step: int):
    """Updates answer and step ONLY in memory (avoids writing to DB on each question)."""
    if phone_number in ACTIVE_SESSIONS:
        ACTIVE_SESSIONS[phone_number]["answers"][field_name] = value
        ACTIVE_SESSIONS[phone_number]["current_step"] = next_step
        ACTIVE_SESSIONS[phone_number]["last_activity"] = time.time()


# --------------------------------------------------------------------------- #
# Periodic Background Task: Clean Expired Sessions
# --------------------------------------------------------------------------- #
def check_and_expire_all_sessions():
    """Scans and clears any active sessions older than 10 minutes."""
    now = time.time()
    # 1. Check in-memory
    expired_numbers = [
        num for num, sess in list(ACTIVE_SESSIONS.items())
        if now - sess.get("last_activity", 0) > SESSION_TIMEOUT_SECONDS
    ]
    for num in expired_numbers:
        logger.info("Expiring in-memory session for %s", num)
        expire_session(num)

    # 2. Check DB entries
    try:
        with transaction() as cur:
            cur.execute(
                """
                SELECT phone_number, form_id, answers
                FROM whatsapp_survey_session
                WHERE updated_at < CURRENT_TIMESTAMP - INTERVAL '10 minutes';
                """
            )
            rows = cur.fetchall() or []
            for r in rows:
                p = r.get("phone_number") if isinstance(r, dict) else r[0]
                fid = r.get("form_id") if isinstance(r, dict) else r[1]
                ans = r.get("answers") if isinstance(r, dict) else r[2]
                ans = ans or {}
                if fid and ans and len(ans) > 0:
                    save_partial_submission(fid, ans, p)
                clear_session(p)
                logger.info("Expiring DB session for %s", p)
    except Exception as exc:
        logger.exception("Error checking expired DB sessions: %s", exc)


async def session_cleanup_loop():
    """Background loop that periodically checks for expired sessions."""
    logger.info("WhatsApp survey session cleanup background loop started.")
    while True:
        try:
            await asyncio.sleep(60)  # Check every 60 seconds
            check_and_expire_all_sessions()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.exception("Error in session cleanup loop: %s", e)


def ensure_cleanup_running():
    """Ensures the background cleanup worker is running."""
    global _cleanup_task
    if _cleanup_task is None or _cleanup_task.done():
        try:
            loop = asyncio.get_running_loop()
            _cleanup_task = loop.create_task(session_cleanup_loop())
        except RuntimeError:
            pass


# --------------------------------------------------------------------------- #
# Routing & Form Helpers
# --------------------------------------------------------------------------- #
def get_routes(receiver_number: Optional[str] = None) -> List[Dict[str, Any]]:
    """Find all active forms mapped in channel_form_route, optionally filtered by receiver number."""
    with transaction() as cur:
        cur.execute(
            """
            SELECT r.route_key, r.form_id, f.form_title, r.metadata
            FROM channel_form_route r
            JOIN forms f ON r.form_id = f.form_id
            WHERE r.channel = 'whatsapp' AND r.enabled = TRUE;
            """
        )
        rows = cur.fetchall() or []

    results = []
    seen_forms = set()

    for r in rows:
        fid = r.get("form_id") if isinstance(r, dict) else r[1]
        title = r.get("form_title") if isinstance(r, dict) else r[2]
        key = r.get("route_key") if isinstance(r, dict) else r[0]
        meta = r.get("metadata") if isinstance(r, dict) else r[3]
        meta = meta or {}

        # If a specific receiver_number is configured in metadata, enforce it
        target_receiver = meta.get("receiver_number") or meta.get("phone_number")
        if target_receiver and receiver_number:
            if strip_all_spaces(str(target_receiver)) != strip_all_spaces(str(receiver_number)):
                continue

        if fid not in seen_forms:
            seen_forms.add(fid)
            results.append({
                "form_id": fid,
                "form_title": title,
                "route_key": key,
            })

    return results


def format_question(field: dict) -> str:
    """Formats question text nicely for WhatsApp."""
    label = field.get("label") or field.get("name")
    field_type = field.get("type", "text")
    options = field.get("options") or []

    if field_type in ("select", "radio") and options:
        opt_lines = "\n".join([f"{i+1}. {opt.get('label', opt.get('value'))}" for i, opt in enumerate(options)])
        return f"*{label}*\n\n{opt_lines}\n\n_(Reply with the number or option name)_"
    elif field_type in ("number", "integer", "int", "rating"):
        return f"*{label}*\n\n_(Please reply with a number)_"
    elif field_type in ("decimal", "float", "double", "currency"):
        return f"*{label}*\n\n_(Please reply with a decimal or number)_"
    elif field_type == "email":
        return f"*{label}*\n\n_(Please reply with your email address)_"
    elif field_type == "date":
        return f"*{label}*\n\n_(Please reply in YYYY-MM-DD format)_"
    else:
        return f"*{label}*"


# --------------------------------------------------------------------------- #
# Main Webhook Endpoint
# --------------------------------------------------------------------------- #
@router.post("/webhook")
async def whatsapp_webhook(request: Request, background_tasks: BackgroundTasks):
    ensure_cleanup_running()

    try:
        body = await request.json()
    except Exception:
        body = {}

    logger.info("WhatsApp Inbound Payload: %s", body)

    sender = str(body.get("number") or body.get("sender") or "").strip()
    receiver = str(body.get("receiver") or body.get("to") or "").strip()
    app_id = body.get("application") or 121
    raw_msg = str(body.get("message-in") or body.get("text") or body.get("message") or "").strip()

    # URL-decode incoming text
    user_msg = urllib.parse.unquote_plus(raw_msg)

    if not sender or not user_msg:
        return {"status": "ok"}

    # Build the reply text, then send via Push API in background
    reply_text = await build_reply(sender, receiver, user_msg, app_id)

    if reply_text:
        background_tasks.add_task(send_whatsapp, sender, reply_text, app_id)

    # Return 200 OK immediately to Picky Assist
    return {"status": "ok"}


async def build_reply(sender: str, receiver: str, user_msg: str, app_id: int) -> Optional[str]:
    """Determine the reply text based on user message, session state, and whitespace normalization."""

    # 1. Fetch current session (automatically expires if > 10m idle)
    session = get_session(sender)

    # Whitespace-tolerant comparisons
    raw_stripped = user_msg.strip()
    zero_spaces = strip_all_spaces(user_msg)
    normalized = normalize_spaces(user_msg)

    # 2. Global Reset commands (RESET, CANCEL, STOP)
    if zero_spaces in ["reset", "cancel", "stop"]:
        clear_session(sender)
        return "Survey cancelled. Type 'HI' anytime to start again."

    # ----------------------------------------------------------------------- #
    # CASE 1: No active session (User is new or expired)
    # ----------------------------------------------------------------------- #
    if not session:
        # Check if user sent "START" (or "start", "s t a r t") directly
        if zero_spaces == "start":
            routes = get_routes(receiver)
            if not routes:
                return "👋 *Welcome to e-Agrology!*\n\nCurrently, no surveys are open."

            start_form_selection_session(sender, receiver, routes)
            menu_lines = [f"{i}. {r['form_title']}" for i, r in enumerate(routes, 1)]
            return (
                "📋 *Available Surveys*\n\n"
                "Please select a survey to begin:\n\n"
                + "\n".join(menu_lines)
                + "\n\n_(Reply with the number e.g. *1*, or type the survey name)_"
            )

        # User sent "Hi", "Hello", or anything else -> Send First Welcome Message
        return (
            "👋 *Welcome to e-Agrology Surveys!*\n\n"
            "We collect agricultural and field data to support our farmers and projects.\n\n"
            "👉 Reply *START* to view available surveys."
        )

    # ----------------------------------------------------------------------- #
    # CASE 2: User is in "AWAITING_FORM" (Viewing Numbered Form Menu)
    # ----------------------------------------------------------------------- #
    current_state = session.get("state")

    if current_state == "AWAITING_FORM":
        routes = session.get("forms_list") or get_routes(receiver)
        if not routes:
            clear_session(sender)
            return "👋 *Welcome to e-Agrology!*\n\nCurrently, no surveys are open."

        # If user sends "START" again or "MENU", re-display the menu
        if zero_spaces in ["start", "menu"]:
            start_form_selection_session(sender, receiver, routes)
            menu_lines = [f"{i}. {r['form_title']}" for i, r in enumerate(routes, 1)]
            return (
                "📋 *Available Surveys*\n\n"
                "Please select a survey to begin:\n\n"
                + "\n".join(menu_lines)
                + "\n\n_(Reply with the number e.g. *1*, or type the survey name)_"
            )

        # Match Form Selection by Number (e.g. " 1 ", "1.", "2")
        chosen_form = None
        num_clean = zero_spaces.rstrip(".")
        if num_clean.isdigit():
            idx = int(num_clean) - 1
            if 0 <= idx < len(routes):
                chosen_form = routes[idx]

        # Match Form Selection by Name or Route Key
        if not chosen_form:
            for r in routes:
                title_clean = strip_all_spaces(r["form_title"])
                key_clean = strip_all_spaces(r.get("route_key", ""))
                if zero_spaces in (title_clean, key_clean):
                    chosen_form = r
                    break

        if not chosen_form:
            menu_lines = [f"{i}. {r['form_title']}" for i, r in enumerate(routes, 1)]
            return (
                f"⚠️ Invalid choice. Please reply with a number (1 to {len(routes)}) or type the survey name.\n\n"
                "📋 *Available Surveys*\n\n"
                + "\n".join(menu_lines)
            )

        # Form selected! Transition to IN_SURVEY and ask Question 1
        form_id = chosen_form["form_id"]
        form = form_service.get_form(form_id)
        fields = (form.get("form_json") or {}).get("fields", [])
        if not fields:
            clear_session(sender)
            return f"Survey *{chosen_form['form_title']}* currently has no questions."

        start_survey_session(sender, receiver, form_id)
        q1_text = f"📋 *Starting: {chosen_form['form_title']}*\n\n" + format_question(fields[0])
        return q1_text

    # ----------------------------------------------------------------------- #
    # CASE 3: User is in "IN_SURVEY" (Answering Form Questions)
    # ----------------------------------------------------------------------- #
    form_id = session.get("form_id")
    current_step = session.get("current_step", 1)
    answers = session.get("answers", {})

    # If user types "MENU" or "HI" mid-survey, give them the option to reset or continue
    if zero_spaces in ["hi", "hello", "menu"]:
        form = form_service.get_form(form_id)
        fields = (form.get("form_json") or {}).get("fields", [])
        q_text = format_question(fields[current_step - 1]) if 0 < current_step <= len(fields) else ""
        return (
            f"ℹ️ You are currently filling *{form.get('form_title')}*.\n\n"
            f"Please answer the question below, or reply *CANCEL* to return to the main menu.\n\n"
            f"{q_text}"
        )

    form = form_service.get_form(form_id)
    fields = (form.get("form_json") or {}).get("fields", [])

    if current_step > len(fields):
        clear_session(sender)
        return "Survey is already complete! Type 'HI' to start a new one."

    current_field = fields[current_step - 1]
    field_name = current_field.get("name")
    field_type = current_field.get("type", "text")
    options = current_field.get("options") or []

    # ----------------------------------------------------------------------- #
    # Strict Input Validation with Whitespace Tolerance
    # ----------------------------------------------------------------------- #
    cleaned_val = normalized

    # 1. Select / Radio options
    if field_type in ("select", "radio") and options:
        matched_opt = None
        num_clean = zero_spaces.rstrip(".")
        if num_clean.isdigit():
            idx = int(num_clean) - 1
            if 0 <= idx < len(options):
                matched_opt = options[idx]

        if not matched_opt:
            for opt in options:
                val_clean = strip_all_spaces(str(opt.get("value", "")))
                lbl_clean = strip_all_spaces(str(opt.get("label", "")))
                if zero_spaces in (val_clean, lbl_clean):
                    matched_opt = opt
                    break

        if not matched_opt:
            return (
                f"⚠️ Invalid choice. Please reply with a number (1 to {len(options)}) "
                f"or type one of the options.\n\n"
                f"{format_question(current_field)}"
            )
        cleaned_val = matched_opt.get("value")

    # 2. Number / Integer
    elif field_type in ("number", "integer", "int", "rating"):
        try:
            int(zero_spaces)
            cleaned_val = zero_spaces
        except ValueError:
            return (
                f"⚠️ Invalid number. Please reply with a whole number.\n\n"
                f"{format_question(current_field)}"
            )

    # 3. Decimal / Float / Currency
    elif field_type in ("decimal", "float", "double", "currency"):
        try:
            float(zero_spaces)
            cleaned_val = zero_spaces
        except ValueError:
            return (
                f"⚠️ Invalid number. Please reply with a valid number.\n\n"
                f"{format_question(current_field)}"
            )

    # 4. Email
    elif field_type == "email":
        if "@" not in zero_spaces or "." not in zero_spaces.split("@")[-1]:
            return (
                f"⚠️ Invalid email. Please reply with a valid email address.\n\n"
                f"{format_question(current_field)}"
            )
        cleaned_val = zero_spaces

    # 5. Date
    elif field_type == "date":
        import re
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", zero_spaces):
            return (
                f"⚠️ Invalid date format. Please reply in YYYY-MM-DD format (e.g. 2026-05-15).\n\n"
                f"{format_question(current_field)}"
            )
        cleaned_val = zero_spaces

    # ----------------------------------------------------------------------- #
    # Record answer in memory ONLY (no DB write per question)
    # ----------------------------------------------------------------------- #
    answers[field_name] = cleaned_val

    # More questions remain?
    if current_step < len(fields):
        next_step = current_step + 1
        update_session_progress(sender, field_name, cleaned_val, next_step)
        return format_question(fields[next_step - 1])
    else:
        # Final Question answered -> Ingest complete submission into database
        try:
            submission_service.submit(
                form,
                answers,
                created_by="whatsapp_bot",
                channel="whatsapp",
            )
            clear_session(sender)
            return f"✅ *Thank you!*\nYour responses for *{form.get('form_title')}* have been successfully recorded."
        except Exception as e:
            logger.exception("Submission failed: %s", e)
            clear_session(sender)
            return "⚠️ An error occurred while saving your responses. Please type 'HI' to try again."