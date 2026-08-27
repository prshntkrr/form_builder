"""Matching a field to a crop ontology variable.

The provider that plugs into the existing standard enrichment, beside SEOnt and
ICASA. It answers a narrower question than either: *for this crop*, which
measured variable is this field?

Crop is the whole difficulty. "Plant height" exists in maize, rice, wheat and
thirty-odd others, each with its own identifier, and they are not
interchangeable. So this provider will not match anything until it knows which
crop the form is about — and if the form does not say, it declines rather than
picking the first ontology that happens to have the trait.

Matching is deterministic, and reuses the scoring the other providers use so
the three behave alike.
"""
import logging
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Reused so all three providers agree on what "confident" means.
from app.modules.standards.enrichment import (  # noqa: E402
    ALL_WORDS,
    CONFIDENCE_THRESHOLD,
    EXACT_NAME,
    _key,
    _terms,
)


def crop_context(form_json: Dict[str, Any], prompt: str = "") -> Optional[str]:
    """Which crop this form is about, or None.

    Read from the form's own title and description and from the prompt that
    produced it, against the crops actually imported — so "maize phenotyping"
    finds maize only because a maize ontology is loaded.

    Deliberately returns None when more than one crop is named. A form
    mentioning both maize and rice has no single answer, and guessing would
    attach identifiers from the wrong crop.
    """
    from app.modules.crop_ontology import variable_service

    haystack = " ".join([
        str(form_json.get("title") or ""),
        str(form_json.get("description") or ""),
        str(prompt or ""),
    ]).lower()
    if not haystack.strip():
        return None

    found = []
    for ontology in variable_service.ontologies():
        crop = str(ontology.get("crop_name") or "").strip().lower()
        if not crop:
            continue
        # Whole words only: "rice" must not match inside "price".
        if re.search(rf"\b{re.escape(crop)}\b", haystack):
            found.append(ontology["ontology_id"])

    if len(found) == 1:
        return found[0]

    if len(found) > 1:
        logger.debug("Several crops named (%s); declining to choose", ", ".join(found))
    return None


def _score(field_key: str, variable: Dict[str, Any]) -> float:
    """How well a variable fits a field.

    The trait name is what carries meaning — a variable is called `PlantHt_M_cm`
    and its trait is "Plant height". Both are checked, trait first.
    """
    for candidate in (variable.get("trait_name"), variable.get("name")):
        name_key = _key(candidate)
        if not name_key:
            continue
        if field_key == name_key:
            return EXACT_NAME

        field_words = set(field_key.split())
        name_words = set(name_key.split())
        if field_words and name_words and field_words <= name_words:
            return max(0.0, ALL_WORDS - 0.1 * len(name_words - field_words))

    return 0.0


def match_variable(
    field: Dict[str, Any],
    ontology_id: Optional[str] = None,
) -> Dict[str, Any]:
    """The best crop ontology variable for a field, within one crop.

    Without an `ontology_id` this matches nothing at all. That is the point:
    the same trait exists in every crop, so a match outside a known crop context
    would be a coin toss dressed up as a standard.
    """
    from app.modules.crop_ontology import variable_service

    if not ontology_id:
        return {"match": None, "confidence": 0.0, "candidates": [], "no_crop_context": True}

    best: List[Dict[str, Any]] = []
    best_score = 0.0

    for term in _terms(field):
        for variable in variable_service.search_variables(term, ontology_id=ontology_id, limit=40):
            score = _score(term, variable)
            if score <= 0:
                continue
            if score > best_score:
                best, best_score = [variable], score
            elif score == best_score and all(
                v["variable_id"] != variable["variable_id"] for v in best
            ):
                best.append(variable)

        if best_score >= EXACT_NAME:
            break

    candidates = [_describe(v) for v in best[:5]]

    if not best or best_score < CONFIDENCE_THRESHOLD:
        return {"match": None, "confidence": best_score, "candidates": candidates}

    if len(best) > 1:
        # Several variables measure the same trait by different methods. Which
        # one a form means is a real decision, not one to make automatically.
        return {"match": None, "confidence": best_score, "candidates": candidates,
                "ambiguous": True}

    return {"match": _describe(best[0]), "confidence": best_score, "candidates": candidates}


def _describe(variable: Dict[str, Any]) -> Dict[str, Any]:
    """What a form records about a crop ontology variable.

    Crop Ontology's own identifiers throughout — never a database row id. A form
    outlives any particular import, and these identifiers mean something outside
    this application.
    """
    return {
        "standard": "CropOntology",
        "ontology_id": variable["ontology_id"],
        "ontology_version": variable.get("version") or "",
        "crop": variable.get("crop_name") or "",
        "variable_id": variable["variable_id"],
        "variable_name": variable.get("name") or "",
        "trait_id": variable.get("trait_id"),
        "trait_name": variable.get("trait_name") or "",
        "method_id": variable.get("method_id"),
        "method_name": variable.get("method_name") or "",
        "scale_id": variable.get("scale_id"),
        "scale_name": variable.get("scale_name") or "",
        "scale_data_type": variable.get("scale_data_type"),
    }


# --------------------------------------------------------------------------- #
# crop and feature fields, wired to the local data rather than to a guess
# --------------------------------------------------------------------------- #
# Recognising the two fields whose choices belong to the ontology.
#
# Matching on whole names ("crop", "selected_crop", "crop_feature", …) meant
# every new phrasing a model invented slipped through — `selected_feature` did
# exactly that. So the name is reduced to the words that carry meaning and the
# head noun is what decides.

# Words that qualify a field without changing what it is. "selected_crop",
# "crop_type" and "which_trait" all describe the same two fields.
QUALIFIERS = {
    "selected", "select", "chosen", "choose", "choice", "which", "the", "a",
    "name", "names", "type", "id", "code", "list", "dropdown", "field",
}

# A field holding the *reading* rather than naming what was read. "feature_value"
# records the measurement and must stay whatever type it was given.
MEASUREMENT_WORDS = {
    "value", "values", "reading", "readings", "measurement", "measured",
    "amount", "score", "result", "results", "unit", "units", "quantity",
    "observation", "note", "notes", "remark", "remarks", "comment", "comments",
    "date", "count", "number",
}

CROP_HEAD = {"crop", "crops"}
FEATURE_HEAD = {
    "feature", "features", "trait", "traits",
    "characteristic", "characteristics", "attribute", "attributes",
}


def _significant(field: Dict[str, Any]) -> List[set]:
    """The meaningful words of a field's key and label, qualifiers removed."""
    found = []
    for source in (field.get("name"), field.get("label")):
        words = set(_key(source).split())
        if not words:
            continue
        found.append((words, words - QUALIFIERS))
    return found


def _selects_crop(field: Dict[str, Any]) -> bool:
    """Whether this field asks which crop — not merely mentions one.

    `crop_area` and `crop_variety` keep a second meaningful word, so they are
    ordinary fields and are left alone.
    """
    for words, core in _significant(field):
        if words & MEASUREMENT_WORDS:
            continue
        if core and core <= CROP_HEAD:
            return True
    return False


def _selects_feature(field: Dict[str, Any]) -> bool:
    """Whether this field asks which feature of the crop is being recorded."""
    for words, core in _significant(field):
        if words & MEASUREMENT_WORDS:
            continue
        if core & FEATURE_HEAD and core <= (FEATURE_HEAD | CROP_HEAD):
            return True
    return False


def apply_dynamic_options(form_json: Dict[str, Any]) -> Dict[str, Any]:
    """Point crop and feature fields at the imported ontologies.

    A model asked for "a crop selector and its features" will write a list of
    crops it happens to know and invent features to go with them — "Feature 1",
    "Feature 2". Both are wrong: the crops are whichever ontologies this
    installation imported, and the features are that crop's traits. Neither is
    the model's to decide.

    So the model only has to produce the two fields. Their choices are replaced
    here with a reference to the local data, and the invented options are
    dropped.

    The feature field is left alone when the form has no crop field: a trait
    list is meaningless without a crop, and guessing one would be the same
    mistake in a different place.
    """
    fields = list(form_json.get("fields") or [])

    crop_field = None
    for field in fields:
        if (isinstance(field, dict)
                and not (field.get("source") or {}).get("catalog_is_client_controlled")
                and _selects_crop(field)):
            crop_field = field
            break

    rewritten = []
    changed = []

    for field in fields:
        if not isinstance(field, dict):
            rewritten.append(field)
            continue

        updated = dict(field)

        # A field answered from the client's own catalog keeps that catalog. The
        # workbook is the authority on its permitted values; the ontology is not.
        if ((field.get("source") or {}).get("catalog_is_client_controlled")
                or (field.get("options_from") or {}).get("source") == "client_catalog"):
            rewritten.append(updated)
            continue

        if field is crop_field:
            updated["type"] = "select"
            updated["options"] = []
            updated["options_from"] = {"source": "crop_ontology", "kind": "crop"}
            changed.append({"field": updated.get("name"), "source": "imported crops"})

        elif crop_field is not None and _selects_feature(field):
            updated["type"] = "select"
            updated["options"] = []
            updated["options_from"] = {
                "source": "crop_ontology",
                "kind": "trait",
                "depends_on": crop_field.get("name"),
            }
            changed.append({
                "field": updated.get("name"),
                "source": f"traits of the crop chosen in '{crop_field.get('name')}'",
            })

        rewritten.append(updated)

    return {"form_json": {**form_json, "fields": rewritten}, "dynamic": changed}
