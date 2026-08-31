"""Walking the standards, one level at a time.

Searching a vocabulary needs you to know what the thing is called. Browsing does
not, and every one of these vocabularies is already a tree — so this endpoint
answers one question, repeatedly:

    given where I am, what can I choose next, and what is here?

    GET /api/standards/browse                          the standards installed
    GET /api/standards/browse?p=icasa:ICASA            its categories
    GET /api/standards/browse?p=icasa:ICASA&p=IRRIGATIONS   and so on

One shape comes back whatever the path, so a screen can render any depth without
knowing which vocabulary it is walking or how deep it goes:

    path    where you are, for a breadcrumb
    level   the next choice — `null` when there is nothing more to choose
    items   what is *here*, if anything

Depth is decided here, from the data, and not by the caller: ICASA has one or
two levels of category depending on the branch, Crop Ontology has crop then
trait, and SEOnt is a graph that goes as deep as the ontology does.

Nothing is written and no schema belongs to this module. It reads the three
vocabularies through their own services and checks each one's own permission, so
a vocabulary an account may not see is not offered and cannot be reached by
typing its path.
"""
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core import auth_service
from app.core.deps import current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/standards/browse", tags=["standards"])

ICASA = "icasa"
SEONT = "seont"
CROP = "crop"

# How ICASA writes a nested category: "IRRIGATIONS / AUTOMATIC_IRRIG". The
# nesting is real and is already in the data — it is just spelled as one string.
NESTED = " / "


def _option(value: str, label: str, hint: str = "", has_children: bool = False):
    return {"value": value, "label": label, "hint": hint, "has_children": has_children}


def _level(label: str, options: List[Dict[str, Any]], placeholder: str = ""):
    return {"label": label, "placeholder": placeholder or f"Select {label.lower()}",
            "options": options}


def _refuse(what: str):
    raise HTTPException(status_code=403, detail=f"Your role cannot read {what}")


# --------------------------------------------------------------------------- #
# what is installed, and may be seen
# --------------------------------------------------------------------------- #
def _icasa(user):
    from app.modules.standards.icasa.permissions import STANDARDS_VIEW
    if not auth_service.may(user, STANDARDS_VIEW):
        return None
    from app.modules.standards.icasa import icasa_importer
    return icasa_importer


def _seont(user):
    from app.modules.standards.seont.permissions import ONTOLOGY_VIEW
    if not auth_service.may(user, ONTOLOGY_VIEW):
        return None
    from app.modules.standards.seont import concept_service
    return concept_service


def _crop(user):
    from app.modules.standards.crop_ontology.permissions import CROP_ONTOLOGY_VIEW
    if not auth_service.may(user, CROP_ONTOLOGY_VIEW):
        return None
    from app.modules.standards.crop_ontology import variable_service
    return variable_service


def _safely(work, fallback=None):
    """A vocabulary whose module is switched off contributes nothing.

    Its tables are not there either, so asking is an error rather than an empty
    answer — and one absent vocabulary must not take the other two with it.
    """
    try:
        return work()
    except Exception:
        logger.debug("A standards vocabulary is unavailable", exc_info=True)
        return fallback


def _roots(user) -> List[Dict[str, Any]]:
    options = []

    if _icasa(user) is not None:
        from app.modules.standards.icasa import icasa_importer
        for standard in _safely(icasa_importer.loaded, []) or []:
            options.append(_option(
                f"{ICASA}:{standard['name']}", standard["name"],
                f"{standard.get('variables', 0)} variables", True))

    if _seont(user) is not None:
        from app.modules.standards.seont import importer
        for ontology in _safely(importer.loaded, []) or []:
            options.append(_option(
                f"{SEONT}:{ontology['ontology_name']}", ontology["ontology_name"],
                f"{ontology.get('concepts', 0)} concepts", True))

    crop = _crop(user)
    if crop is not None:
        crops = _safely(crop.ontologies, []) or []
        if crops:
            options.append(_option(
                CROP, "Crop Ontology", f"{len(crops)} crops", True))

    return options


# --------------------------------------------------------------------------- #
# the endpoint
# --------------------------------------------------------------------------- #
@router.get("")
def browse(
    p: List[str] = Query(default=[], description="The path so far, one segment per level"),
    user: Dict[str, Any] = Depends(current_user),
):
    path = [segment for segment in (p or []) if segment != ""]

    if not path:
        return {
            "path": [],
            "level": _level("Standard", _roots(user), "Select a standard"),
            "items": None,
        }

    head = path[0]

    if head.startswith(f"{ICASA}:"):
        return _walk_icasa(user, head[len(ICASA) + 1:], path)
    if head.startswith(f"{SEONT}:"):
        return _walk_seont(user, head[len(SEONT) + 1:], path)
    if head == CROP:
        return _walk_crop(user, path)

    raise HTTPException(status_code=404, detail=f"No standard '{head}'")


# --------------------------------------------------------------------------- #
# ICASA: standard -> category -> subcategory -> variables
# --------------------------------------------------------------------------- #
def _walk_icasa(user, standard: str, path: List[str]):
    if _icasa(user) is None:
        _refuse("data standards")

    from app.modules.standards.icasa import variable_service

    known = variable_service.categories(standard)
    chosen = path[1:]

    # "IRRIGATIONS / AUTOMATIC_IRRIG" is a parent and a child written as one
    # string. Split it and the two levels are already there.
    split = [(c["category"].split(NESTED), c["variables"]) for c in known]

    crumbs = [{"value": path[0], "label": standard}]

    if not chosen:
        heads = {}
        for parts, count in split:
            top = parts[0] or "Uncategorised"
            entry = heads.setdefault(top, {"count": 0, "children": 0})
            entry["count"] += count
            if len(parts) > 1:
                entry["children"] += 1

        options = [
            _option(top, _pretty(top), f"{entry['count']} variables",
                    entry["children"] > 0)
            for top, entry in sorted(heads.items(), key=lambda kv: kv[0].lower())
        ]
        return {"path": crumbs,
                "level": _level("Category", options, "Select a category"),
                "items": None}

    top = chosen[0]
    crumbs.append({"value": top, "label": _pretty(top)})
    stored_top = "" if top == "Uncategorised" else top

    if len(chosen) == 1:
        children = [
            _option(parts[1], _pretty(parts[1]), f"{count} variables", False)
            for parts, count in split
            if len(parts) > 1 and parts[0] == stored_top
        ]
        rows = variable_service.in_category(standard, stored_top)
        return {
            "path": crumbs,
            # A category with nothing under it is the end of the road; one with
            # subcategories offers them *and* still shows its own variables.
            "level": (_level("Subcategory", sorted(children, key=lambda o: o["label"]),
                             "Select a subcategory") if children else None),
            "items": {"kind": ICASA, "rows": rows},
        }

    sub = chosen[1]
    crumbs.append({"value": sub, "label": _pretty(sub)})
    rows = variable_service.in_category(standard, f"{stored_top}{NESTED}{sub}")
    return {"path": crumbs, "level": None, "items": {"kind": ICASA, "rows": rows}}


def _pretty(category: str) -> str:
    """ICASA files things under SHOUTING_SNAKE_CASE. Nobody reads that."""
    if not category:
        return "Uncategorised"
    words = category.replace("_", " ").strip().lower()
    return words[:1].upper() + words[1:]


# --------------------------------------------------------------------------- #
# SEOnt: ontology -> concept -> child concept -> ... as deep as it goes
# --------------------------------------------------------------------------- #
def _walk_seont(user, ontology: str, path: List[str]):
    if _seont(user) is None:
        _refuse("ontologies")

    from app.modules.standards.seont import concept_service

    crumbs = [{"value": path[0], "label": ontology}]
    chosen = path[1:]

    if not chosen:
        roots = concept_service.roots(ontology)
        options = [
            _option(str(c["concept_id"]), c["label"],
                    f"{c['child_count']} below" if c["child_count"] else "",
                    bool(c["child_count"]))
            for c in roots
        ]
        return {"path": crumbs,
                "level": _level("Concept", options, "Select a concept"),
                "items": None}

    # Every segment after the ontology is a concept id, so the path reads back
    # as the branch that was walked — however deep that went.
    concept = None
    for segment in chosen:
        try:
            concept = concept_service.get(int(segment))
        except (ValueError, concept_service.ConceptNotFound):
            raise HTTPException(status_code=404, detail=f"No concept '{segment}'")
        crumbs.append({"value": segment, "label": concept["label"]})

    children = concept_service.children(concept["concept_id"])
    counts = concept_service.child_counts([c["concept_id"] for c in children])

    options = [
        _option(str(c["concept_id"]), c["label"],
                f"{counts.get(c['concept_id'], 0)} below"
                if counts.get(c["concept_id"]) else "",
                bool(counts.get(c["concept_id"])))
        for c in children
    ]

    return {
        "path": crumbs,
        "level": _level("Sub-concept", options, "Select a concept") if options else None,
        "items": {"kind": SEONT, "concept": concept, "rows": children},
    }


# --------------------------------------------------------------------------- #
# Crop Ontology: crop -> trait -> variables
# --------------------------------------------------------------------------- #
def _walk_crop(user, path: List[str]):
    crop = _crop(user)
    if crop is None:
        _refuse("the crop ontology")

    crumbs = [{"value": CROP, "label": "Crop Ontology"}]
    chosen = path[1:]

    if not chosen:
        options = [
            _option(o["ontology_id"], o["crop_name"] or o["ontology_id"],
                    o["ontology_id"], True)
            for o in crop.ontologies()
        ]
        return {"path": crumbs,
                "level": _level("Crop", options, "Select a crop"),
                "items": None}

    ontology_id = chosen[0]
    known = {o["ontology_id"]: o for o in crop.ontologies()}
    if ontology_id not in known:
        raise HTTPException(status_code=404, detail=f"No crop ontology '{ontology_id}'")
    crumbs.append({"value": ontology_id,
                   "label": known[ontology_id]["crop_name"] or ontology_id})

    traits = crop.traits_in(ontology_id)

    if len(chosen) == 1:
        options = [
            _option(t["trait_id"], t["name"], f"{t['variables']} variables", False)
            for t in traits
        ]
        return {"path": crumbs,
                "level": _level("Trait", options, "Select a trait"),
                "items": None}

    trait_id = chosen[1]
    trait = next((t for t in traits if t["trait_id"] == trait_id), None)
    if trait is None:
        raise HTTPException(status_code=404, detail=f"No trait '{trait_id}'")
    crumbs.append({"value": trait_id, "label": trait["name"]})

    return {"path": crumbs, "level": None,
            "items": {"kind": CROP, "trait": trait,
                      "rows": crop.variables_of_trait(trait_id)}}


# --------------------------------------------------------------------------- #
# finding a saved mapping again
# --------------------------------------------------------------------------- #
@router.get("/locate")
def locate(
    kind: str = Query(..., description="icasa, seont or crop"),
    id: Optional[str] = Query(None, description="ICASA external id, or a crop trait id"),
    standard: Optional[str] = Query(None, description="Which ICASA standard"),
    uri: Optional[str] = Query(None, description="A SEOnt concept URI"),
    ontology: Optional[str] = Query(None, description="A crop ontology id"),
    user: Dict[str, Any] = Depends(current_user),
):
    """Where in the tree a mapping already saved on a field lives.

    A field stores what a standard *is* — an ICASA external id, a concept URI, a
    Crop Ontology variable — and never where it sat in somebody's navigation.
    That is the right way round: the mapping has to survive a reimport that
    files the same variable somewhere else. So the path is worked out from the
    identifier when a screen needs to show it, rather than stored beside it.

    404 when the thing is no longer in the imported vocabulary. The mapping on
    the field is untouched by that — it is still a true statement about what the
    question means, and only its position here is unknown.
    """
    if kind == ICASA:
        if _icasa(user) is None:
            _refuse("data standards")
        from app.modules.standards.icasa import variable_service

        found = variable_service.get_by_external_id(id or "", standard or "ICASA")
        if not found:
            raise HTTPException(status_code=404, detail=f"No variable '{id}'")

        parts = (found.get("category") or "").split(NESTED)
        path = [f"{ICASA}:{standard or 'ICASA'}"]
        path.append(parts[0] or "Uncategorised")
        if len(parts) > 1 and parts[1]:
            path.append(parts[1])
        return {"path": path}

    if kind == SEONT:
        if _seont(user) is None:
            _refuse("ontologies")
        from app.modules.standards.seont import concept_service

        concept = concept_service.get_by_uri(uri or "")
        if not concept:
            raise HTTPException(status_code=404, detail=f"No concept '{uri}'")

        chain = concept_service.ancestry(concept["concept_id"])
        return {"path": [f"{SEONT}:{concept['ontology_name']}"]
                        + [str(c["concept_id"]) for c in chain]}

    if kind == CROP:
        if _crop(user) is None:
            _refuse("the crop ontology")
        if not ontology or not id:
            raise HTTPException(status_code=404, detail="A crop and a trait are needed")
        # Both are already on the field, so this one needs no lookup at all.
        return {"path": [CROP, ontology, id]}

    raise HTTPException(status_code=404, detail=f"No standard '{kind}'")
