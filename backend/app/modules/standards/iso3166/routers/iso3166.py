"""ISO 3166-1 over HTTP, in the standards module's own pattern.

    GET /api/standards/iso3166                     what is loaded
    GET /api/standards/iso3166/countries           all of them, or ?q=
    GET /api/standards/iso3166/countries/{code}    one, by any of its codes
    GET /api/standards/iso3166/options             the shape a form field wants

Read-only. The list is imported from a dataset in the repository at startup;
there is nothing here to write, and no endpoint that could change what a
country's code is.
"""
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.deps import needs_any
from app.modules.standards.iso3166 import service
from app.modules.standards.iso3166.dataset import STANDARD_NAME

router = APIRouter(prefix="/api/standards/iso3166", tags=["standards"])

# The standards permission, plus the one that says an account fills forms in: a
# country question is unanswerable without its list of countries, and a Surveyor
# who could not read one would meet an empty select with no explanation.
READ = needs_any("standards.view", "records.create")


@router.get("")
def loaded(user: Dict[str, Any] = Depends(READ)):
    """Whether ISO 3166-1 is loaded, which edition, and how many countries.

    ISO 3166-1 only — country codes. Subdivisions (ISO 3166-2) and formerly
    used codes (ISO 3166-3) are not implemented.
    """
    return service.summary()


@router.get("/countries")
def countries(
    q: str = Query("", description="Part of a country's name, or any of its codes"),
    limit: Optional[int] = Query(None, ge=1, le=300),
    user: Dict[str, Any] = Depends(READ),
):
    """The countries of ISO 3166-1, each with all three of its codes.

    `?q=` matches the name and every code, case-insensitively, in the database:
    `mexico`, `MX`, `mex` and `484` all find Mexico.
    """
    found = service.countries(q, limit=limit)
    return {"standard": STANDARD_NAME, **service.summary(),
            "count": len(found), "items": found}


@router.get("/countries/{code}")
def country(code: str, user: Dict[str, Any] = Depends(READ)):
    """One country, by its alpha-2, alpha-3 or numeric-3 code.

    `MX`, `mx`, `MEX` and `484` all reach Mexico.
    """
    found = service.lookup(code)
    if found is None:
        raise HTTPException(status_code=404,
                            detail=f"'{code}' is not an ISO 3166-1 country code")
    return found


@router.get("/options")
def options(
    code_type: str = Query(service.DEFAULT_CODE_TYPE,
                           description="alpha_2, alpha_3 or numeric"),
    q: str = Query(""),
    user: Dict[str, Any] = Depends(READ),
):
    """The choices for a field, as `{value, label}` — what the renderer draws.

    The value is the code of the type asked for and the label is the country's
    name, so a form storing alpha-2 shows "Mexico" and stores "MX".
    """
    if code_type not in service.CODE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"'{code_type}' is not an ISO 3166-1 code type. Use one of: "
                   f"{', '.join(service.CODE_TYPES)}.")
    return service.options(code_type, q)
