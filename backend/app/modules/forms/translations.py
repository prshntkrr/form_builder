"""Showing one form in more than one language.

A form keeps ONE definition and ONE data table. The words people read are
translated; the field `name` never is, because that name is the key inside
`form_data` and the column in the tabular mirror. So a Hindi answer and an
English answer land in the same column and can be counted together.

Translations live in a single block on the form definition:

    {
      "languages": ["en", "hi"],
      "default_language": "en",
      "translations": {
        "hi": {
          "title": "किसान पंजीकरण",
          "description": "...",
          "submit_label": "जमा करें",
          "success_message": "...",
          "sections": {"basics": {"title": "...", "description": "..."}},
          "fields": {
            "farmer_name": {"label": "किसान का नाम", "help_text": "..."},
            "irrigation": {"label": "सिंचाई", "options": {"canal": "नहर"}}
          }
        }
      }
    }

Only the strings that differ are listed. Anything missing falls back to the
default language, so a half-finished translation still produces a usable form.

Kept in one block rather than a `label_hi` beside every `label` so that adding a
language touches one place, and so the rest of the pipeline keeps seeing the
ordinary field spec it already understands.
"""
from typing import Any, Dict, List, Optional

# The languages an installation can offer. Add a line to support another one —
# nothing else in the code needs to change.
SUPPORTED_LANGUAGES = {
    "en": "English",
    "hi": "हिन्दी",
    "mr": "मराठी",
    "bn": "বাংলা",
    "te": "తెలుగు",
    "ta": "தமிழ்",
    "gu": "ગુજરાતી",
    "kn": "ಕನ್ನಡ",
    "pa": "ਪੰਜਾਬੀ",
    "or": "ଓଡ଼ିଆ",
}

DEFAULT_LANGUAGE = "en"

# What a validation failure says, per language. The field label comes from the
# translation block, so only these fixed words need listing here.
#
# A language with no entry falls back to English: a missing translation should
# never stop somebody submitting a form.
MESSAGES = {
    "en": {
        "required": "{label} is required",
        "not_an_option": "{label}: '{value}' is not an available option",
        "min": "{label} must be at least {limit}",
        "max": "{label} must be at most {limit}",
        "min_length": "{label} must be at least {limit} {unit}",
        "max_length": "{label} must be at most {limit} {unit}",
        "pattern": "{label} is not in the expected format",
        "characters": "characters",
        "digits": "digits",
    },
    "hi": {
        "required": "{label} आवश्यक है",
        "not_an_option": "{label}: '{value}' उपलब्ध विकल्पों में नहीं है",
        "min": "{label} कम से कम {limit} होना चाहिए",
        "max": "{label} अधिक से अधिक {limit} होना चाहिए",
        "min_length": "{label} में कम से कम {limit} {unit} होने चाहिए",
        "max_length": "{label} में अधिक से अधिक {limit} {unit} होने चाहिए",
        "pattern": "{label} अपेक्षित प्रारूप में नहीं है",
        "characters": "अक्षर",
        "digits": "अंक",
    },
}


def is_supported(language: Optional[str]) -> bool:
    return bool(language) and language in SUPPORTED_LANGUAGES


def form_languages(form_json: Dict[str, Any]) -> List[str]:
    """The languages this form offers, default first."""
    default = default_language(form_json)
    languages = [default]

    for code in form_json.get("languages") or []:
        if is_supported(code) and code not in languages:
            languages.append(code)

    # A translation somebody added without listing the language still counts.
    for code in (form_json.get("translations") or {}):
        if is_supported(code) and code not in languages:
            languages.append(code)

    return languages


def default_language(form_json: Dict[str, Any]) -> str:
    declared = form_json.get("default_language")
    if is_supported(declared):
        return declared
    return DEFAULT_LANGUAGE


def message(language: Optional[str], key: str, **values: Any) -> str:
    """One validation message, in the caller's language.

    Falls back to English for a language we have no wording for, so a form can
    be translated before its messages are.
    """
    wording = MESSAGES.get(language) or MESSAGES["en"]
    template = wording.get(key) or MESSAGES["en"][key]
    return template.format(**values)


def word(language: Optional[str], key: str) -> str:
    """A single word used inside a message, such as 'characters'."""
    return message(language, key)


# --------------------------------------------------------------------------- #
# cleaning what arrives
# --------------------------------------------------------------------------- #
def normalize_translations(raw: Any) -> Dict[str, Any]:
    """Keep only translations we can actually use.

    Called from `normalize_form`, so a model or a hand-edited row cannot store a
    shape the renderer would choke on. Anything unrecognised is dropped rather
    than rejected — a bad translation must never stop a form being saved.
    """
    if not isinstance(raw, dict):
        return {}

    cleaned = {}
    for language, block in raw.items():
        if not is_supported(language) or language == DEFAULT_LANGUAGE:
            continue
        if not isinstance(block, dict):
            continue

        cleaned_block = _clean_block(block)
        if cleaned_block:
            cleaned[language] = cleaned_block

    return cleaned


def _clean_block(block: Dict[str, Any]) -> Dict[str, Any]:
    """One language's translations, with the empty parts left out."""
    cleaned = {}

    for key in ("title", "description", "submit_label", "success_message"):
        text = _text(block.get(key))
        if text:
            cleaned[key] = text

    sections = _clean_sections(block.get("sections"))
    if sections:
        cleaned["sections"] = sections

    fields = _clean_fields(block.get("fields"))
    if fields:
        cleaned["fields"] = fields

    return cleaned


def _clean_sections(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        return {}

    sections = {}
    for key, value in raw.items():
        if not isinstance(value, dict):
            continue

        section = {}
        for name in ("title", "description"):
            text = _text(value.get(name))
            if text:
                section[name] = text

        if section:
            sections[str(key)] = section

    return sections


def _clean_fields(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        return {}

    fields = {}
    for name, value in raw.items():
        if not isinstance(value, dict):
            continue

        field = {}
        for key in ("label", "help_text", "placeholder"):
            text = _text(value.get(key))
            if text:
                field[key] = text

        options = _clean_options(value.get("options"))
        if options:
            field["options"] = options

        if field:
            fields[str(name)] = field

    return fields


def _clean_options(raw: Any) -> Dict[str, str]:
    """Option labels only. The value is what gets stored, so it is never
    translated — otherwise the same answer would be two different values."""
    if not isinstance(raw, dict):
        return {}

    options = {}
    for value, label in raw.items():
        text = _text(label)
        if text:
            options[str(value)] = text

    return options


def _text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


# --------------------------------------------------------------------------- #
# showing a form in one language
# --------------------------------------------------------------------------- #
def translate_form(form_json: Dict[str, Any], language: Optional[str]) -> Dict[str, Any]:
    """A copy of the form with its words in `language`.

    The result is an ordinary form definition — same keys, same field names — so
    everything downstream (the renderer, validation, storage) works on it without
    knowing translation exists. Anything with no translation keeps the default
    wording.
    """
    translations = form_json.get("translations") or {}
    block = translations.get(language)
    if not block:
        return form_json

    translated = dict(form_json)

    for key in ("title", "description", "submit_label", "success_message"):
        if block.get(key):
            translated[key] = block[key]

    translated["sections"] = _translate_sections(
        form_json.get("sections") or [], block.get("sections") or {}
    )
    translated["fields"] = _translate_fields(
        form_json.get("fields") or [], block.get("fields") or {}
    )
    translated["language"] = language

    return translated


def _translate_sections(sections: List[Any], block: Dict[str, Any]) -> List[Any]:
    result = []
    for section in sections:
        if not isinstance(section, dict):
            result.append(section)
            continue

        words = block.get(section.get("key"))
        if not words:
            result.append(section)
            continue

        translated = dict(section)
        for key in ("title", "description"):
            if words.get(key):
                translated[key] = words[key]
        result.append(translated)

    return result


def _translate_fields(fields: List[Any], block: Dict[str, Any]) -> List[Any]:
    result = []
    for field in fields:
        if not isinstance(field, dict):
            result.append(field)
            continue

        words = block.get(field.get("name"))
        if not words:
            result.append(field)
            continue

        translated = dict(field)
        for key in ("label", "help_text", "placeholder"):
            if words.get(key):
                translated[key] = words[key]

        if words.get("options"):
            translated["options"] = _translate_options(
                field.get("options") or [], words["options"]
            )

        result.append(translated)

    return result


def _translate_options(options: List[Any], words: Dict[str, str]) -> List[Any]:
    result = []
    for option in options:
        if not isinstance(option, dict):
            result.append(option)
            continue

        label = words.get(str(option.get("value")))
        if not label:
            result.append(option)
            continue

        translated = dict(option)
        translated["label"] = label
        result.append(translated)

    return result
