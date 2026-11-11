"""Translate a form's wording with the Google Cloud Translation API (v2).

An alternative provider to `llm.translate_form`, built to the same contract: in
comes a form definition and a target language, out comes just that language's
block of translated words — never a whole form, so a bad reply can never damage
the definition. The caller cleans the block (`translations.normalize_translations`)
and stores it under the language code, exactly as it does for the model.

The difference from the model is what has to be done here by hand. The model is
handed the whole form and told to leave identifiers alone; Google translates
whatever strings it is given and nothing else. So this module does the knowing:

  * it pulls out only the words a form shows a person — titles, labels, help,
    placeholders, option captions, the WhatsApp messages;
  * it never sends a field name, section key or option *value*, because those
    are identifiers and an answer must mean the same thing in every language;
  * it puts each translation back exactly where it came from.

Pure except for the one HTTP call. `_collect` and `_rebuild` take no network and
are tested on their own.
"""
import logging
from typing import Any, Dict, List, Optional, Tuple

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

ENDPOINT = "https://translation.googleapis.com/language/translate/v2"

# How many strings to send in one request. The API takes many; this keeps a
# single form well within request-size limits without a second round trip.
_BATCH = 100


class TranslateError(Exception):
    """Google could not translate, or is not configured."""


# A path names where a translated string belongs in the block. Its shape mirrors
# `translations._clean_block`, so what is rebuilt here passes that cleaner whole.
Path = Tuple[str, ...]


def _texts_of_field(field: Dict[str, Any], name: str) -> List[Tuple[Path, str]]:
    out: List[Tuple[Path, str]] = []
    for key in ("label", "help_text", "placeholder"):
        text = field.get(key)
        if isinstance(text, str) and text.strip():
            out.append((("fields", name, key), text))
    for option in field.get("options") or []:
        if not isinstance(option, dict):
            continue
        value, label = option.get("value"), option.get("label")
        if value is not None and isinstance(label, str) and label.strip():
            out.append((("fields", name, "options", str(value)), label))
    return out


def _collect(form_json: Dict[str, Any]) -> List[Tuple[Path, str]]:
    """Every translatable string in a form, each with where it belongs.

    Identifiers — field `name`, section `key`, option `value` — are never
    collected, so they are never sent and never translated.
    """
    items: List[Tuple[Path, str]] = []

    for key in ("title", "description", "submit_label", "success_message"):
        text = form_json.get(key)
        if isinstance(text, str) and text.strip():
            items.append(((key,), text))

    for section in form_json.get("sections") or []:
        if not isinstance(section, dict):
            continue
        key = section.get("key")
        if not key:
            continue
        for attr in ("title", "description"):
            text = section.get(attr)
            if isinstance(text, str) and text.strip():
                items.append((("sections", str(key), attr), text))

    for field in form_json.get("fields") or []:
        if isinstance(field, dict) and field.get("name"):
            items.extend(_texts_of_field(field, str(field["name"])))

    whatsapp = ((form_json.get("channel_config") or {}).get("whatsapp")) or {}
    if isinstance(whatsapp, dict):
        from app.modules.forms.channel_config import MESSAGES
        for key in MESSAGES:
            text = whatsapp.get(key)
            if isinstance(text, str) and text.strip():
                items.append((("whatsapp", key), text))

    return items


def _rebuild(paths: List[Path], translated: List[str]) -> Dict[str, Any]:
    """Put each translated string back at its path, as a translation block."""
    block: Dict[str, Any] = {}
    for path, text in zip(paths, translated):
        node = block
        for step in path[:-1]:
            node = node.setdefault(step, {})
        node[path[-1]] = text
    return block


def _translate_batch(texts: List[str], target: str) -> List[str]:
    """Google's translations of `texts`, in the same order. One HTTP call per
    batch; the API preserves order within a request."""
    out: List[str] = []
    with httpx.Client(timeout=settings.google_translate_timeout) as client:
        for start in range(0, len(texts), _BATCH):
            chunk = texts[start:start + _BATCH]
            try:
                resp = client.post(
                    ENDPOINT,
                    params={"key": settings.google_translate_api_key},
                    json={"q": chunk, "target": target, "format": "text"},
                )
            except httpx.HTTPError as exc:
                raise TranslateError(f"Could not reach Google Translate: {exc}")

            if resp.status_code != 200:
                # The key and the request are never echoed back to the caller.
                logger.warning("Google Translate returned %s", resp.status_code)
                raise TranslateError(
                    "Google Translate refused the request. Check the API key and "
                    "that the Translation API is enabled."
                )

            data = (resp.json().get("data") or {}).get("translations") or []
            if len(data) != len(chunk):
                raise TranslateError("Google Translate returned a short reply.")
            out.extend(t.get("translatedText", "") for t in data)

    return out


def translate_form(form_json: Dict[str, Any], target_code: str) -> Dict[str, Any]:
    """Build the translation block for `target_code`. Mirrors `llm.translate_form`.

    `target_code` is an ISO 639-1 code (hi, es, bn, …), which is what Google's
    v2 API expects — the same codes this app already uses for its languages.
    """
    if not settings.google_translate_api_key:
        raise TranslateError("Google Translate is not configured on this server.")
    if not target_code:
        raise TranslateError("Say which language to translate into.")

    items = _collect(form_json)
    if not items:
        return {}

    paths = [path for path, _ in items]
    # Translate each distinct string once, however many places it appears — a
    # form with ten "Yes/No" questions pays for one "Yes", not ten.
    unique: Dict[str, None] = {}
    for _, text in items:
        unique.setdefault(text, None)
    sources = list(unique.keys())

    translated = _translate_batch(sources, target_code)
    by_source = dict(zip(sources, translated))

    return _rebuild(paths, [by_source[text] for _, text in items])
