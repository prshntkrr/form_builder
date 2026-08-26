"""Attaching standards to a field, without being asked to.

A form drafted from a prompt arrives as plain fields. This layer looks each one
up in whatever standards are installed and attaches what it is confident about:

    field  ->  SEOnt  ->  what this means      (a concept URI)
           ->  ICASA  ->  what this is called  (a variable id, unit, data type)

Both are optional and independent. A field may end up with one, both or neither.

**It attaches nothing it is unsure of.** A wrong standard is worse than no
standard: it is silently wrong in an exported dataset months later, where a
missing one is merely absent. So the matcher is deliberately strict, and where
two variables fit equally well it declines and offers both as candidates for a
person to choose between.

No model is used for matching. The rules below are the whole of it.
"""
import logging
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# How sure the matcher has to be before it writes anything into a form.
# Below this the field is left alone and the near misses are returned as
# candidates instead.
CONFIDENCE_THRESHOLD = 0.8

# What each kind of agreement is worth.
EXACT_NAME = 1.0        # "irrigation_operation" is called exactly that
EXACT_CODE = 0.95       # the field is named after the standard's own code
ALL_WORDS = 0.85        # every word of the field appears, and nothing competes

# Words that carry no meaning when comparing a field to a variable.
#
# Articles and prepositions only. Words like "field", "data" and "value" look
# like filler but are load-bearing in a dictionary of agricultural variables —
# treating "field" as noise made `field_soil_texture` collapse into
# `soil_texture` and score a perfect match against the wrong variable.
NOISE = {"the", "a", "an", "of", "in", "for", "and", "or", "to", "at",
         "please", "enter"}


def _words(text: str) -> List[str]:
    """The meaningful words in a name or label, lowercased."""
    parts = re.split(r"[^a-z0-9]+", str(text or "").lower())
    return [p for p in parts if p and p not in NOISE]


def _key(text: str) -> str:
    return " ".join(_words(text))


def _terms(field: Dict[str, Any]) -> List[str]:
    """What to look this field up by, best first.

    The label is what a person wrote, so it is tried before the slugified name.
    Help text is a last resort — it is prose, and matches from it are weak.
    """
    terms = []
    for source in (field.get("label"), field.get("name"), field.get("help_text")):
        key = _key(source)
        if key and key not in terms:
            terms.append(key)
    return terms


def _score(field_key: str, variable: Dict[str, Any]) -> float:
    """How well one variable fits one field. 0 means no.

    Only agreement on the *name* counts. A variable whose definition happens to
    mention the word is not a match — that is how "crop" would end up attached
    to a hundred unrelated things.
    """
    name_key = _key(variable.get("name"))
    code = str(variable.get("code") or "").strip().lower()

    if field_key == name_key:
        return EXACT_NAME
    if field_key == code:
        return EXACT_CODE

    field_words = set(field_key.split())
    name_words = set(name_key.split())
    if not field_words or not name_words:
        return 0.0

    # Every word of the field has to appear in the variable's name. The reverse
    # need not hold — "soil ph" may legitimately find "soil_pH_in_water" — but
    # each extra word in the variable makes the match less certain.
    if field_words <= name_words:
        extra = len(name_words - field_words)
        return max(0.0, ALL_WORDS - 0.1 * extra)

    return 0.0


def match_variable(field: Dict[str, Any], standard: Optional[str] = None) -> Dict[str, Any]:
    """The best standardised variable for a field, if there is a clear one.

    Returns the match, the confidence, and the candidates that were considered,
    so a person can pick when the matcher would not.
    """
    from app.modules.standards import variable_service

    best: List[Dict[str, Any]] = []
    best_score = 0.0

    for term in _terms(field):
        for variable in variable_service.search(term, standard=standard, limit=40):
            score = _score(term, variable)
            if score <= 0:
                continue
            if score > best_score:
                best, best_score = [variable], score
            elif score == best_score and all(
                v["variable_id"] != variable["variable_id"] for v in best
            ):
                best.append(variable)

        # A term that produced an exact hit needs no fallback to a weaker one.
        if best_score >= EXACT_CODE:
            break

    candidates = [_describe(v) for v in best[:5]]

    if not best or best_score < CONFIDENCE_THRESHOLD:
        return {"match": None, "confidence": best_score, "candidates": candidates}

    if len(best) > 1:
        # Two variables fit equally well. Choosing one would be a coin toss
        # recorded as a fact, so decline and let a person decide.
        logger.debug("Ambiguous standard match for %s: %d equal candidates",
                     field.get("name"), len(best))
        return {"match": None, "confidence": best_score, "candidates": candidates,
                "ambiguous": True}

    return {"match": _describe(best[0]), "confidence": best_score, "candidates": candidates}


def _describe(variable: Dict[str, Any]) -> Dict[str, Any]:
    """What a form records about a standardised variable.

    The standard's own identifier, not the row id: a saved form has to stay
    readable after a re-import, and after the standard itself is versioned.
    """
    return {
        "standard": variable["standard"],
        "standard_version": variable.get("standard_version") or "",
        "variable_id": variable["external_id"],
        "variable_code": variable.get("code") or "",
        "variable_name": variable["name"],
        "unit": variable.get("unit") or "",
        "data_type": variable.get("data_type") or "",
    }


def match_concept(field: Dict[str, Any]) -> Dict[str, Any]:
    """The best ontology concept for a field, if there is a clear one.

    Imported lazily and defensively: the ontology module can be switched off,
    and enrichment must still work with whatever standards remain.
    """
    try:
        from app.modules.ontology import concept_service
    except Exception:
        return {"match": None, "confidence": 0.0, "candidates": []}

    best = None
    best_score = 0.0
    candidates: List[Dict[str, Any]] = []

    for term in _terms(field):
        try:
            hits = concept_service.search(term, limit=25)
        except Exception:
            return {"match": None, "confidence": 0.0, "candidates": []}

        for concept in hits:
            label_key = _key(concept.get("label"))
            if term == label_key:
                score = EXACT_NAME
            elif set(term.split()) <= set(label_key.split()):
                score = max(0.0, ALL_WORDS - 0.1 * len(set(label_key.split()) - set(term.split())))
            else:
                continue

            if score > best_score:
                best, best_score = concept, score
            if len(candidates) < 5:
                candidates.append(_describe_concept(concept))

        if best_score >= EXACT_NAME:
            break

    if not best or best_score < CONFIDENCE_THRESHOLD:
        return {"match": None, "confidence": best_score, "candidates": candidates}

    return {"match": _describe_concept(best), "confidence": best_score,
            "candidates": candidates}


def _describe_concept(concept: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "standard": concept.get("ontology_name") or "SEOnt",
        "uri": concept["concept_uri"],
        "label": concept["label"],
    }


def enrich_field(field: Dict[str, Any]) -> Dict[str, Any]:
    """Everything the standards can say about one field.

    The field itself is not modified — the caller decides what to keep.
    """
    concept = match_concept(field)
    variable = match_variable(field)

    return {
        "semantic_concept": concept["match"],
        "data_standard": variable["match"],
        "confidence": max(concept["confidence"], variable["confidence"]),
        "concept_candidates": concept.get("candidates") or [],
        "variable_candidates": variable.get("candidates") or [],
    }


# A free-text field is what an LLM produces when it has no list to offer. Once
# a standard supplies one, the field should be a choice — but only from these
# types. Anything else was a deliberate decision and is left alone.
CONVERTIBLE = {"text", "textarea"}


def _apply_standard_options(field: Dict[str, Any]) -> Optional[str]:
    """Load a mapped variable's coded values onto the field, in place.

    Returns a note of what happened, or None if there was nothing to do.

    Three things it will not do. It will not invent options for a variable that
    has none — most ICASA variables are not coded. It will not overwrite options
    the field already carries, because those were somebody's decision. And it
    will not retype a field that is already a date or a number, only one still
    sitting as free text.
    """
    from app.modules.standards import variable_service

    standard = field.get("data_standard") or {}
    variable_id = standard.get("variable_id")
    if not variable_id:
        return None

    if field.get("options"):
        # Already has choices. The editor's "Load values" button replaces them
        # on request; enrichment does not do it behind anyone's back.
        return None

    options = variable_service.options_by_external_id(
        variable_id, standard.get("standard") or "ICASA"
    )
    if not options:
        return None

    field["options"] = options
    field["option_source"] = "standard"

    was = field.get("type")
    if was in CONVERTIBLE:
        field["type"] = "select"
        return f"{len(options)} coded values, {was} -> select"

    return f"{len(options)} coded values"


def enrich_form(form_json: Dict[str, Any]) -> Dict[str, Any]:
    """Attach standards to every field of a draft that has a confident match.

    What is already there wins: a person who chose a concept by hand is not
    overruled by the matcher. Returns the form and a note of what was attached.
    """
    fields = []
    attached = []

    for field in form_json.get("fields") or []:
        if not isinstance(field, dict):
            fields.append(field)
            continue

        updated = dict(field)
        found = enrich_field(field)
        notes = []

        if found["semantic_concept"] and not updated.get("semantic_concept"):
            updated["semantic_concept"] = found["semantic_concept"]
            notes.append(f"SEOnt: {found['semantic_concept']['label']}")

        if found["data_standard"] and not updated.get("data_standard"):
            updated["data_standard"] = found["data_standard"]
            notes.append(
                f"ICASA: {found['data_standard']['variable_name']}"
                f" ({found['data_standard']['variable_code']})"
            )

        # A mapping alone leaves the field free text. If the variable publishes
        # coded values, those are the point of the standard — pull them in.
        if updated.get("data_standard"):
            loaded = _apply_standard_options(updated)
            if loaded:
                notes.append(loaded)

        fields.append(updated)
        if notes:
            attached.append({
                "field": updated.get("name"),
                "confidence": round(found["confidence"], 2),
                "attached": notes,
            })

    return {"form_json": {**form_json, "fields": fields}, "attached": attached}
