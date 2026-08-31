"""Live form rendering + submission endpoints."""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from app.core import auth_service
from app.modules.forms import form_service
from app.modules.forms import submission_service
from app.modules.forms import translations
from app.modules.forms import view_service
from app.core.deps import needs, viewer
# One dependency, shared with the authoring routes: a form is judged by the
# context it belongs to — the account permission for a system form, the project
# permission for a project's own.
from app.modules.forms.routers.forms import needs_on_form
from app.core import auth_service
from app.modules.forms.permissions import (
    FORMS_SYSTEM_VIEW,
    FORMS_EDIT, RECORDS_CREATE, RECORDS_VIEW, RESPONSES_EXPORT, RESPONSES_VIEW,
    VIEW_CONFIGURE,
)

# The project permissions these routes answer to when the form belongs to one.
# Named as strings rather than imported, so this module still loads with the
# projects module switched off.
PROJECT_FORMS_MANAGE = "project.forms.manage"
PROJECT_SUBMISSIONS_VIEW_ALL = "project.submissions.view_all"
from app.core.database import transaction
from app.modules.forms.schemas import SubmitRequest, TestSubmissionRequest, ViewConfigRequest

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/forms", tags=["submissions"])


def _project_guard(form_id: str, user):
    """Refuse a form belonging to a project this account cannot reach.

    Every submission route loads its form through `_load`, so guarding here
    covers reading records, filling the form in and exporting, in one place.
    A form with no project keeps the rules it always had.
    """
    if user is None:
        return
    try:
        from app.modules.projects import access
    except Exception:
        return

    if not access.may_see_form(user, form_id):
        raise HTTPException(status_code=404, detail=f"No form '{form_id}'")


def _fill_guard(form_id: str, user):
    """Refuse a form this account may read but has not been given to answer.

    Filling is its own permission. Somebody who reviews a project's work sees
    every form in it, and seeing a form is not being asked to fill it in — so
    this asks `may_fill_form`, not `may_see_form`.

    404 rather than 403, matching the rest of the project rules: a form that is
    not this account's to answer should read the same as one that is not there.
    """
    if user is None:
        return
    try:
        from app.modules.projects import access
    except Exception:
        return

    if not access.may_fill_form(user, form_id):
        raise HTTPException(status_code=404, detail=f"No form '{form_id}'")


def _load(form_id: str, user=None, filling: bool = False):
    if filling:
        _fill_guard(form_id, user)
    _project_guard(form_id, user)
    try:
        return form_service.get_form(form_id)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/live/list")
def live_forms(
    project: Optional[str] = Query(
        None, description="One project's forms, or 'none' for the system forms"),
    user: Dict[str, Any] = Depends(needs(RECORDS_VIEW)),
):
    """The forms **this account** may fill in right now.

    Separate from `GET /api/forms` because that one is the builder's view — it
    carries table names, versions and response counts, none of which somebody
    filling a form in needs or should see.

    Narrowed here, never by the caller. Two independent sources, and belonging
    to one does not open the other:

        system forms   forms belonging to no project. An account permission,
                       `forms.system.view`. Being a manager of some project is
                       not a way in.

        project forms  for each project this account is actually a member of:
                       the forms it was assigned — by name, through a group, or
                       to everyone — *and* only if its role there carries
                       `project.forms.fill`. Being able to read every form in a
                       project, which reviewing needs, is not being able to
                       answer them.

    This used to list every Active form on the installation. `records.view` is
    held by every Standard User, so a person added to one project received every
    system form and every other project's forms with it. That is what this
    narrowing fixes.
    """
    allowed: set = set()

    # The context asked about, if any. The application works in one context at a
    # time and a list must not mix them, so `project=none` is the system forms
    # and `project=PRJ1` is that project's.
    wants_system = project in (None, "none")

    if wants_system and auth_service.may(user, FORMS_SYSTEM_VIEW):
        allowed.update(
            f["form_id"] for f in form_service.list_forms(
                status="Active", project="none", limit=500)
        )

    try:
        from app.modules.projects import access
    except Exception:
        # The projects module is switched off, so there are no project forms and
        # the system half above is the whole answer.
        access = None

    if access is not None and project != "none":
        if project:
            # A project this account is not in reads as one that is not there,
            # the same as everywhere else in this module.
            if not access.permissions_in(user, project):
                raise HTTPException(status_code=404, detail=f"No project '{project}'")
            reachable = [project]
        else:
            reachable = access.projects_for(user)

        for project_id in reachable:
            fillable = access.fillable_form_ids(user, project_id)
            if fillable is None:
                # This account may fill any of that project's forms.
                allowed.update(
                    f["form_id"] for f in form_service.list_forms(
                        status="Active", project=project_id, limit=500)
                )
            else:
                allowed.update(fillable)

    if not allowed:
        return []

    return [
        {
            "form_id": f["form_id"],
            "form_title": f["form_title"],
            "form_description": f["form_description"],
            "field_count": f["field_count"],
        }
        for f in form_service.list_forms(status="Active", limit=500)
        if f["form_id"] in allowed
    ]


@router.get("/{form_id}/render")
def render(
    form_id: str,
    language: Optional[str] = Query(None, description="Language code, e.g. 'hi'"),
    user: Dict[str, Any] = Depends(needs(RECORDS_CREATE)),
):
    """Everything a client needs to draw the live form.

    `language` returns the definition with its words already swapped, so the
    page that draws the form needs no translation logic of its own. Field names
    are untouched, so the answers still land in the same columns.
    """
    form = _load(form_id, user, filling=True)
    if form["form_status"] != "Active":
        raise HTTPException(
            status_code=403,
            detail="This form is paused and is not accepting responses."
            if form["form_status"] == "Inactive"
            else "This form is no longer available.",
        )
    form_json = form["form_json"] or {}
    languages = translations.form_languages(form_json)
    chosen = language if language in languages else translations.default_language(form_json)

    return {
        "form_id": form["form_id"],
        "form_status": form["form_status"],
        "version_no": form["version_no"],
        "form_json": translations.translate_form(form_json, chosen),
        "language": chosen,
        "languages": [
            {"code": code, "name": translations.SUPPORTED_LANGUAGES[code]}
            for code in languages
        ],
    }


@router.post("/{form_id}/submissions", status_code=201)
def create_submission(form_id: str, req: SubmitRequest, user: Dict[str, Any] = Depends(needs(RECORDS_CREATE))):
    form = _load(form_id, user, filling=True)
    try:
        return submission_service.submit(
            form, req.data,
            created_by=auth_service.display_name(user),
            language=req.language,
        )
    except submission_service.ValidationFailed as exc:
        raise HTTPException(status_code=422, detail={"errors": exc.errors})
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        logger.exception("Submission failed for %s", form_id)
        raise HTTPException(status_code=500, detail=f"Could not save submission: {exc}")


@router.post("/{form_id}/test-submission")
def test_submission(
    form_id: str,
    req: TestSubmissionRequest,
    user: Dict[str, Any] = Depends(needs_on_form(FORMS_EDIT, PROJECT_FORMS_MANAGE)),
):
    """Run a submission through validation and write nothing.

    How a draft is tested before anyone publishes it: the answers go through the
    same coercion a real submission would, and the reply is the exact `form_data`
    that would be stored. Because nothing is written, a test leaves no row to
    explain later and works on a form that is not accepting answers yet.

    Pass `form_json` to test what is on screen rather than what is saved, so the
    builder can try a change before committing to it.
    """
    form = _load(form_id, user)
    definition = req.form_json or form["form_json"] or {}
    result = submission_service.test_payload(definition, req.data, req.language)
    return {**result, "form_id": form_id, "form_status": form["form_status"]}


@router.get("/{form_id}/records")
def records(
    form_id: str,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: Dict[str, Any] = Depends(needs(RECORDS_VIEW)),
):
    """The records of this form, as whoever is asking is allowed to see them.

    An editor gets every column. Anyone else gets the ones an admin chose, and
    the hidden answers are stripped here rather than in the browser.
    """
    form = _load(form_id, user)
    form_json = form["form_json"] or {}
    data = submission_service.list_submissions(form, limit=limit, offset=offset)

    if auth_service.may(user, RESPONSES_VIEW):
        allowed = [c["name"] for c in data["columns"]]
    else:
        with transaction() as cur:
            allowed = view_service.visible_fields(cur, form_id, form_json)

    keep = set(allowed)
    return {
        "form_id": form_id,
        "form_title": form["form_title"],
        "form_status": form["form_status"],
        "total": data["total"],
        "limit": data["limit"],
        "offset": data["offset"],
        "columns": [c for c in data["columns"] if c["name"] in keep],
        "rows": [
            {
                "survey_id": row["survey_id"],
                "created_on": row["created_on"],
                "created_by": row["created_by"],
                "form_data": {k: v for k, v in (row["form_data"] or {}).items() if k in keep},
            }
            for row in data["rows"]
        ],
    }


@router.get("/{form_id}/view-config")
def get_view_config(
    form_id: str,
    user: Dict[str, Any] = Depends(needs_on_form(RESPONSES_VIEW, PROJECT_FORMS_MANAGE)),
):
    """Every question, and whether it shows to people who cannot edit."""
    form = _load(form_id, user)
    return view_service.describe(form_id, form["form_json"] or {})


@router.put("/{form_id}/view-config")
def set_view_config(
    form_id: str, req: ViewConfigRequest,
    user: Dict[str, Any] = Depends(needs_on_form(VIEW_CONFIGURE, PROJECT_FORMS_MANAGE)),
):
    """Choose which columns everyone else sees.

    For a system form that is an administrator's call; for a project's own form
    it belongs to whoever builds that project's forms.
    """
    form = _load(form_id, user)
    form_json = form["form_json"] or {}

    if req.show_all:
        view_service.reset_config(form_id)
    else:
        view_service.set_visible_fields(
            form_id, req.visible_fields, form_json,
            updated_by=auth_service.display_name(user),
        )
    return view_service.describe(form_id, form_json)


@router.get("/{form_id}/submissions")
def list_submissions(
    form_id: str,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: Dict[str, Any] = Depends(
        needs_on_form(RESPONSES_VIEW, PROJECT_SUBMISSIONS_VIEW_ALL)),
):
    """Every answer to this form, in full.

    Reading other people's answers, so a project's own form asks the project
    permission for exactly that — `project.submissions.view_all`, which a
    manager and a reviewer hold and a surveyor does not. `/records` is the
    narrower cousin: the columns an admin left visible.
    """
    form = _load(form_id, user)
    return submission_service.list_submissions(form, limit=limit, offset=offset)


@router.get("/{form_id}/submissions/export")
def export(
    form_id: str,
    user: Dict[str, Any] = Depends(
        needs_on_form(RESPONSES_EXPORT, PROJECT_SUBMISSIONS_VIEW_ALL)),
):
    form = _load(form_id, user)
    csv_text = submission_service.export_csv(form)
    table = (form["form_json"] or {}).get("table_name") or form_id
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{table}.csv"'},
    )
