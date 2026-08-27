"""OpenAI-backed form authoring.

Two jobs: turn a prompt into a form definition, and revise an existing definition
from a follow-up prompt. Both return raw JSON — `form_schema.normalize_form` is
what makes it trustworthy.
"""
import json
import logging
from typing import Any, Dict, Optional

from openai import OpenAI, OpenAIError

from app.core.config import settings
from app.modules.forms.field_types import SUPPORTED_TYPES

logger = logging.getLogger(__name__)

_client: Optional[OpenAI] = None


class LLMError(RuntimeError):
    pass


def get_client() -> OpenAI:
    global _client
    if not settings.openai_api_key:
        raise LLMError(
            "OPENAI_API_KEY is not set. Add it to backend/.env and restart the server."
        )
    if _client is None:
        _client = OpenAI(api_key=settings.openai_api_key, timeout=settings.openai_timeout)
    return _client


SYSTEM_PROMPT = f"""You are a senior form designer for e-Agrology, an agriculture data-collection platform.
You turn a plain-language description into a complete, production-ready form definition.

Return ONLY a JSON object with exactly this shape:

{{
  "title": "string, max 200 chars",
  "description": "one or two sentences explaining the form's purpose",
  "table_name": "snake_case Postgres table name derived from the title",
  "submit_label": "button text, e.g. Submit",
  "success_message": "message shown after a successful submission",
  "created_by": "who the request says is creating/owning this form, or null",
  "sections": [
    {{"key": "snake_case_key", "title": "Section heading", "description": "optional"}}
  ],
  "fields": [
    {{
      "name": "snake_case_column_name",
      "label": "Human readable label",
      "type": "one of the supported types",
      "required": true,
      "placeholder": "optional",
      "help_text": "optional short hint",
      "default": null,
      "section": "key of the section this field belongs to",
      "options": [{{"label": "Display", "value": "stored_value"}}],
      "validation": {{"min": null, "max": null, "min_length": null,
                     "max_length": null, "pattern": null, "step": null}}
    }}
  ]
}}

Supported "type" values (use nothing else): {", ".join(SUPPORTED_TYPES)}

Rules:
- "name" must be unique, lowercase snake_case and start with a letter. It becomes the key
  the answer is stored under inside the form_data JSONB column, so never use the envelope
  names: survey_id, form_id, form_data, created_on, form_version, created_by.
- Provide "options" for every select, radio and multiselect field. Never leave them empty.
- Use "decimal" for quantities/areas/prices, "number" only for whole counts.
- For fixed-width identifiers (National ID, Aadhaar, account number) set min_length and
  max_length. On a number field those count digits; on a text field, characters.
- Use "location" for GPS coordinates, "file" for photos or documents.
- Group related fields into 2-4 sections when the form has more than 6 fields;
  every field's "section" must match a declared section key.
- Include the fields a domain expert would expect even if the prompt did not spell them out,
  but stay on topic and keep the form under 30 fields.
- Set "required": true only for fields genuinely needed for the record to be useful.
- Write labels in the language of the user's prompt.
- "created_by" is metadata about the form's author, not a field. If the request names one
  ("this form is created by admin", "owner: field_officer"), put just that name there and do
  NOT add a field for it. If no author is named, use null.
- Never invent a list of crops, crop varieties, crop traits or crop features.
  Those come from the ontologies this installation has imported, not from you.
  Give the field an empty "options" list and let the application fill it.
- Never write placeholder choices such as "Feature 1", "Option 2" or "Item 3".
  A choice nobody can act on is worse than none: leave options empty instead.
- Output raw JSON only. No markdown fences, no commentary."""

REFINE_PROMPT = """You are editing an EXISTING form definition. Apply the requested change and
return the COMPLETE updated form JSON in the same schema — not a diff, not a fragment.

Preserve the "name" of every field you keep, exactly as it is: those names are the keys existing
submissions are already stored under, and renaming one orphans that data. Keep untouched fields
byte-for-byte identical. Only add, remove, reorder, or edit what the request actually asks for."""


def _chat(messages: list, temperature: float = 0.3) -> Dict[str, Any]:
    client = get_client()
    try:
        response = client.chat.completions.create(
            model=settings.openai_model,
            messages=messages,
            temperature=temperature,
            response_format={"type": "json_object"},
        )
    except OpenAIError as exc:
        logger.exception("OpenAI request failed")
        raise LLMError(f"OpenAI request failed: {exc}") from exc

    content = (response.choices[0].message.content or "").strip()
    if not content:
        raise LLMError("The model returned an empty response. Try rephrasing the prompt.")

    # Belt and braces: strip fences if the model ignores response_format.
    if content.startswith("```"):
        content = content.strip("`")
        content = content.split("\n", 1)[1] if "\n" in content else content

    try:
        return json.loads(content)
    except json.JSONDecodeError as exc:
        logger.error("Unparseable model output: %s", content[:500])
        raise LLMError("The model did not return valid JSON. Try again.") from exc


def generate_form(prompt: str, language: Optional[str] = None) -> Dict[str, Any]:
    """Prompt -> raw form definition."""
    if not prompt or not prompt.strip():
        raise LLMError("Describe the form you want before generating.")

    user_content = f"Build a form for this request:\n\n{prompt.strip()}"
    if language:
        user_content += f"\n\nWrite all labels and help text in: {language}"

    return _chat(
        [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ]
    )


def refine_form(current_form: Dict[str, Any], instruction: str) -> Dict[str, Any]:
    """Existing definition + instruction -> revised definition."""
    if not instruction or not instruction.strip():
        raise LLMError("Describe the change you want.")

    return _chat(
        [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "system", "content": REFINE_PROMPT},
            {
                "role": "user",
                "content": (
                    f"Current form JSON:\n{json.dumps(current_form, ensure_ascii=False)}\n\n"
                    f"Requested change:\n{instruction.strip()}"
                ),
            },
        ],
        temperature=0.2,
    )


TRANSLATE_PROMPT = """You translate the wording of a data-collection form.

You are given the form's English strings and a target language. Return ONLY the
translated strings, as JSON, in exactly this shape:

{
  "title": "...",
  "description": "...",
  "submit_label": "...",
  "success_message": "...",
  "sections": {"<section key>": {"title": "...", "description": "..."}},
  "fields": {
    "<field name>": {
      "label": "...",
      "help_text": "...",
      "placeholder": "...",
      "options": {"<option value>": "<translated option label>"}
    }
  }
}

Rules:
- Keep every key exactly as given. Field names, section keys and option values
  are identifiers, not words — never translate them, never invent new ones.
- Translate only the values.
- Leave out any string that was empty or missing.
- Use the wording a farmer would use, not a literal word-for-word translation.
- Output raw JSON only. No markdown fences, no commentary."""


def translate_form(form_json: Dict[str, Any], language_name: str) -> Dict[str, Any]:
    """Form definition + language -> that language's block of translated words.

    Returns just the translations, not a whole form, so a bad reply can never
    damage the definition — the caller cleans it and stores it under the
    language code.
    """
    if not language_name:
        raise LLMError("Say which language to translate into.")

    return _chat(
        [
            {"role": "system", "content": TRANSLATE_PROMPT},
            {
                "role": "user",
                "content": (
                    f"Target language: {language_name}\n\n"
                    f"Form JSON:\n{json.dumps(form_json, ensure_ascii=False)}"
                ),
            },
        ],
        temperature=0.2,
    )
