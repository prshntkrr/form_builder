"""The complete form package a mobile app downloads, keeps, and renders itself.

    GET /api/forms/{form_id}/package?language=es

    published config  the frozen version from `form_version` (`publishing`),
                      never the form's current JSON — so what a phone holds
                      cannot change under it; a draft has no package at all
    words             the version's own translations, the chosen language
                      applied (`translations.translate_form`) and every other
                      language kept, so the app can switch without a round trip
    option sets       the values behind every catalogue, crop-ontology and
                      data-standard question, resolved by the same functions
                      the web form and the validator use
    package_hash      SHA-256 of all of the above, and the ETag

Everything here is assembled from what already exists; nothing is a second
definition. The server still validates every submission against the live
version, whatever a phone holds.

What is deliberately left out: the data table name, who created the form,
import provenance, the derived per-channel profile, and any other channel's
configuration (WhatsApp's). A package describes what to ask — never where
answers are stored or how anything is reached.
"""
import hashlib
import json
import logging
from typing import Any, Dict, List, Optional

from app.modules.forms import publishing, translations
from app.modules.forms.form_schema import field_name

logger = logging.getLogger(__name__)

#: The shape of this document. Bumped only when a key changes meaning, so an
#: app can refuse a package it was not built for.
PACKAGE_VERSION = 1

#: The parts of a frozen definition a renderer needs. Anything else stays home.
CONFIG_KEYS = (
    "title", "description", "version", "channel",
    "default_language", "languages", "translations",
    "sections", "fields", "rules", "layout",
    "location", "geofence", "relationship",
    "submit_label", "success_message",
)

#: A dependent ontology list is resolved once per parent value; this bounds how
#: many parent values that is, so one enormous parent list cannot make a
#: package unbounded.
MAX_PARENT_VALUES = 200


def _option_set(field: Dict[str, Any], resolved: Dict[str, Dict[str, Any]],
                by_name: Dict[str, Dict[str, Any]], language: str) -> Optional[Dict[str, Any]]:
    """The values behind one question whose choices are not written on it.

    `options` is the whole list. A dependent list carries each value's parent —
    `parent_code` for a catalogue, `by_parent` for the crop ontology — so the app
    narrows it locally exactly as the server narrows it on submission.
    """
    source = field.get("options_from") or {}
    kind = source.get("source")
    described = {k: v for k, v in source.items() if isinstance(v, (str, int, float, bool, list))}

    try:
        if kind == "client_catalog":
            from app.modules.client_catalog import catalog_options

            return {**described, "options": catalog_options.options_for(
                source.get("catalog"), language=language,
                allowed=source.get("allowed_values"), include_parent=True)}

        if kind == "crop_ontology":
            from app.modules.standards.crop_ontology import dynamic_options

            parent = source.get("depends_on")
            if not parent:
                return {**described, "options": dynamic_options.options_for(source.get("kind"))}

            parent_values = [o["value"] for o in _choices(by_name.get(parent), resolved)]
            return {**described, "by_parent": {
                str(value): dynamic_options.options_for(source.get("kind"), value)
                for value in parent_values[:MAX_PARENT_VALUES]}}

        if kind == "data_standard" and source.get("standard") == "ISO_3166_1":
            from app.modules.standards.iso3166 import service as iso3166

            return {**described, "options": iso3166.options(source.get("code_type") or "alpha_2")}
    except Exception:
        # A switched-off module or an unreachable source: say so rather than
        # ship a list that looks complete. The server still validates on arrival.
        logger.exception("Could not resolve the options for %s", field_name(field))
        return {**described, "unavailable": True, "options": []}

    return None


def _choices(field: Optional[Dict[str, Any]], resolved: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """A question's choices: resolved from its source, or written on it."""
    if not field:
        return []
    if field_name(field) in resolved:
        found = resolved[field_name(field)]
        if "by_parent" in found:
            # A list that is itself dependent (a trait, per crop): every value
            # it can take, once each, for the level below it (its variables).
            seen, flat = set(), []
            for options in found["by_parent"].values():
                for option in options:
                    if option["value"] not in seen:
                        seen.add(option["value"])
                        flat.append(option)
            return flat
        return found.get("options") or []
    return [o if isinstance(o, dict) else {"value": o, "label": o}
            for o in field.get("options") or []]


def package_hash(package: Dict[str, Any]) -> str:
    """SHA-256 of everything a renderer reads — and nothing that moves on its own.

    `published_at` is left out: it changes when a form is paused and resumed,
    which changes nothing a phone would draw. Keys are sorted so the same content
    always hashes the same, whatever order it was assembled in.
    """
    content = {k: v for k, v in package.items() if k not in ("package_hash", "published_at")}
    text = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def build(form: Dict[str, Any], language: Optional[str] = None,
          project_id: Optional[str] = None) -> Dict[str, Any]:
    """The package for one form's published version. Raises `publishing.NotPublished`."""
    published = publishing.published(form, project_id=project_id)
    frozen = published["config"]

    languages = translations.form_languages(frozen)
    chosen = language if language in languages else translations.default_language(frozen)
    config = {k: v for k, v in translations.translate_form(frozen, chosen).items()
              if k in CONFIG_KEYS}
    # Always named, even on a form that never chose: a legacy form is Web / Mobile.
    from app.modules.forms.channels import form_channel
    config["channel"] = form_channel(frozen)

    fields = [f for f in config.get("fields") or [] if isinstance(f, dict)]
    by_name = {field_name(f): f for f in fields if field_name(f)}
    option_sets: Dict[str, Dict[str, Any]] = {}
    for field in fields:
        if field.get("options_from"):
            found = _option_set(field, option_sets, by_name, chosen)
            if found is not None:
                option_sets[field_name(field)] = found

    package = {
        "package_version": PACKAGE_VERSION,
        "form_id": published["form_id"],
        "form_title": published["form_title"],
        "form_description": published.get("form_description"),
        "version": published["version"],
        "status": published["status"],
        "channel": config["channel"],
        "project_id": published.get("project_id"),
        "language": chosen,
        "languages": [{"code": c, "name": translations.SUPPORTED_LANGUAGES[c]} for c in languages],
        "published_at": published.get("published_at"),
        "config": config,
        "option_sets": option_sets,
    }
    package["package_hash"] = package_hash(package)
    return package
