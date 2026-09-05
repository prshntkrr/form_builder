"""Live form rendering + submission endpoints."""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

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
from app.modules.forms.schemas import (
    IngestRequest, SubmitRequest, TestSubmissionRequest, ViewConfigRequest,
)

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

    forms = [f for f in form_service.list_forms(status="Active", limit=500)
             if f["form_id"] in allowed]

    # Which project each one belongs to, and what that project is called — a
    # list on a phone shows more than a title. One lookup for the page, not one
    # per form, and nothing here widens what is in `allowed`.
    where: Dict[str, Any] = {}
    named: Dict[str, str] = {}
    if access is not None and forms:
        try:
            from app.modules.projects import project_service
            where = {f["form_id"]: project_service.project_of_form(f["form_id"])
                     for f in forms}
            named = {p["project_id"]: p["name"]
                     for p in project_service.list_projects(
                         [p for p in where.values() if p])}
        except Exception:
            logger.exception("Could not name the projects for the fillable list")

    return [
        {
            "form_id": f["form_id"],
            "form_title": f["form_title"],
            "form_description": f["form_description"],
            "field_count": f["field_count"],
            # What a client needs to fetch the right configuration and show a
            # useful list. The version is the one that is live: what somebody
            # opening this form now would be filling in.
            "version": f["version_no"],
            "form_status": f["form_status"],
            "project_id": where.get(f["form_id"]),
            "project_name": named.get(where.get(f["form_id"])),
        }
        for f in forms
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


@router.post("/{form_id}/submissions/start", status_code=201)
def start_submission(form_id: str, user: Dict[str, Any] = Depends(needs(RECORDS_CREATE))):
    """Take the next `survey_id` for this form, so uploads have somewhere to go.

    Called when Submit is pressed, never when the form is opened — opening a
    form and walking away leaves nothing behind. Guarded exactly like sending
    one: the same account, the same form, the same permission.
    """
    form = _load(form_id, user, filling=True)
    try:
        return {"survey_id": submission_service.start(
            form, created_by=auth_service.display_name(user))}
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=409, detail=str(exc))


def _store(form, user, *, data, language=None, location=None,
           parent_survey_id=None, survey_id=None, form_version=None,
           channel="web"):
    """The one way a submission is stored, whatever it arrived on.

    Mobile, WhatsApp, IVR and this application's own form page all end up here:
    the same version check, the same validation, the same survey id sequence,
    the same media and location rules, the same row. A channel that had its own
    copy of any of that would be a second product.
    """
    from app.modules.forms import ingestion, relationships

    try:
        # Collected against a version that is no longer live? Say so, rather
        # than reinterpreting those answers with today's definition.
        ingestion.check_version(form, form_version)

        # Whether this form is a child, and whether the submission named is one
        # this account may attach to. Everything the caller sent is a claim
        # until this returns.
        try:
            parent = relationships.validate_parent(user, form, parent_survey_id)
        except relationships.RelationshipError as exc:
            raise HTTPException(status_code=422,
                                detail={"errors": {"parent_survey_id": str(exc)}})

        stored = submission_service.submit(
            form, data,
            created_by=auth_service.display_name(user),
            language=language,
            parent_survey_id=parent,
            location=location,
            survey_id=survey_id,
        )
    except submission_service.ValidationFailed as exc:
        raise HTTPException(status_code=422, detail={"errors": exc.errors})
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Submission failed for %s", form["form_id"])
        raise HTTPException(status_code=500, detail=f"Could not save submission: {exc}")

    # How it arrived, noted beside it. Metadata: it changed nothing above.
    ingestion.record_channel(form["form_id"], stored["survey_id"], channel)
    return {**stored, "channel": channel}


@router.post("/{form_id}/submissions", status_code=201)
def create_submission(form_id: str, req: SubmitRequest, user: Dict[str, Any] = Depends(needs(RECORDS_CREATE))):
    form = _load(form_id, user, filling=True)
    return _store(form, user, data=req.data, language=req.language,
                  location=req.location, parent_survey_id=req.parent_survey_id,
                  survey_id=req.survey_id, form_version=req.form_version,
                  channel=req.channel or "web")


@router.post("/{form_id}/submissions/ingest", status_code=201)
def ingest_submission(form_id: str, req: IngestRequest,
                      user: Dict[str, Any] = Depends(needs(RECORDS_CREATE))):
    """Answers collected on another channel.

    One endpoint for every channel, not one per channel: the adapter for the
    named channel turns whatever it sends into the answers the form asks for,
    and from there this is the ordinary submission path — same permission, same
    project isolation, same validation, same survey id, same table.

        {"channel": "whatsapp", "payload": {"messages": ["Ramesh", "1"]}}
        {"channel": "ivr",      "payload": {"digits":   ["1"]}}
        {"channel": "mobile",   "payload": {"farmer_name": "Ramesh"}}

    An adapter translates shape. It does not decide whether a field is required,
    resolve a condition, check a catalogue or touch a table.
    """
    from app.modules.forms import ingestion, routing
    from app.modules.forms.permissions import MCDC_INTEGRATE

    # Whose submission this is. The platform authenticates as itself and names
    # the person on the other end; that name is worth something only because
    # `channel_identity` maps it to an account, and it is that account's
    # membership, assignment and fill permission that decide — never the
    # platform's, and never the fact that somebody knew a keyword.
    if req.channel_identity:
        if not auth_service.may(user, MCDC_INTEGRATE):
            raise HTTPException(
                status_code=403,
                detail="Sending on somebody else's behalf needs the collection "
                       "platform's permission")
        on_behalf_of = routing.user_for_identity(req.channel, req.channel_identity)
        if on_behalf_of is None:
            raise HTTPException(status_code=404, detail="No such caller")
        user = on_behalf_of

    form = _load(form_id, user, filling=True)

    try:
        answers = ingestion.normalize(req.channel, form["form_json"] or {}, req.payload)
    except ingestion.ChannelError as exc:
        raise HTTPException(status_code=422, detail={"errors": {"_channel": str(exc)}})

    return _store(form, user, data=answers, language=req.language,
                  location=req.location, parent_survey_id=req.parent_survey_id,
                  survey_id=req.survey_id, form_version=req.form_version,
                  channel=ingestion.adapter(req.channel).channel)


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

    # What was uploaded against these records, so the table can show a photo and
    # a filename instead of a media id. Metadata only — the bytes stay in S3 and
    # are reached one at a time through the authorized `media/{id}/url`. Fields
    # this account may not see are dropped here, exactly like their answers.
    from app.modules.forms import media_service
    found = media_service.for_submissions(
        form_id, [r["survey_id"] for r in data["rows"]])

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
                "media": {k: v for k, v in found.get(row["survey_id"], {}).items()
                          if k in keep},
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


# --------------------------------------------------------------------------- #
# one form's submissions hanging off another's
#
# Four reads, and not one of them is a way past anything. Each loads its form
# through `_load`, which applies project isolation exactly as every other route
# here does, and then narrows what it returns by the same submission scope the
# review queue uses. A relationship never widens a permission.
# --------------------------------------------------------------------------- #
@router.get("/{form_id}/relationship")
def relationship(form_id: str, user: Dict[str, Any] = Depends(needs(RECORDS_VIEW))):
    """What this form is attached to, and what is attached to it.

    What the builder and the record screens both need in order to show anything
    about relationships: the parent form, if this is a child, and the child
    forms configured beneath it.
    """
    from app.modules.forms import relationships as rel

    form = _load(form_id, user)
    parent_id = rel.parent_form_id(form["form_json"] or {})

    parent = None
    if parent_id:
        try:
            found = form_service.get_form(parent_id)
            parent = {"form_id": parent_id, "form_title": found["form_title"]}
        except form_service.FormNotFound:
            parent = {"form_id": parent_id, "form_title": "(no longer available)"}

    # Only the children this account can actually reach. A child form in a
    # project they are not in is not theirs to know about.
    children = [
        child for child in rel.child_forms(form_id)
        if _may_reach(user, child["form_id"])
    ]

    return {
        "form_id": form_id,
        "is_child": bool(parent_id),
        "parent_form": parent,
        "child_forms": children,
    }


def _may_reach(user: Dict[str, Any], form_id: str) -> bool:
    """Whether this account may see one form at all — the existing check."""
    try:
        from app.modules.projects import access
    except Exception:
        return True
    return access.may_see_form(user, form_id)


@router.get("/{form_id}/parent-options")
def parent_options(
    form_id: str,
    q: str = Query("", description="Narrow the list"),
    limit: int = Query(50, ge=1, le=200),
    user: Dict[str, Any] = Depends(needs(RECORDS_CREATE)),
):
    """The parent submissions this account may attach a new child to.

    A person filling a child form never types a `parent_survey_id`; they pick
    one from here, and the list is narrowed on this side. Somebody who may only
    read their own submissions is offered only their own.
    """
    from app.modules.forms import relationships as rel

    _load(form_id, user, filling=True)

    try:
        return rel.parents_for(user, form_id, search=q, limit=limit)
    except rel.RelationshipError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/{form_id}/records/{survey_id}/children")
def child_submissions(form_id: str, survey_id: str,
                      user: Dict[str, Any] = Depends(needs(RECORDS_VIEW))):
    """What hangs off one submission, per child form.

    The parent is loaded through the usual guard first; each child form's rows
    are then filtered by that form's own scope, so a parent is not a way to read
    a colleague's answers.
    """
    from app.modules.forms import relationships as rel

    _load(form_id, user)
    return {"survey_id": survey_id,
            "children": rel.children_of(user, form_id, survey_id)}


@router.get("/{form_id}/records/{survey_id}/parent")
def parent_submission(form_id: str, survey_id: str,
                      user: Dict[str, Any] = Depends(needs(RECORDS_VIEW))):
    """Which submission this one belongs to, if any.

    Says what the parent is; opening it goes through the parent form's own
    routes, which authorize it the way they always have. Naming a parent is not
    permission to read it.
    """
    from app.modules.forms import relationships as rel

    _load(form_id, user)
    found = rel.parent_of(form_id, survey_id)
    if found is None:
        return {"parent": None}

    return {"parent": {**found, "may_open": _may_reach(user, found["form_id"])}}


# --------------------------------------------------------------------------- #
# the images, recordings and documents a form collects
#
# Nothing new is decided here. Uploading is part of filling a form in, so it
# asks `_load(..., filling=True)` — the same guard the submission endpoint uses,
# which for a project's form means membership, an assignment and the fill
# permission. Reading one back is part of reading the submission, so it asks
# `_load` — the same guard `/records` uses.
#
# The browser never sees a credential: it is handed a presigned URL good for one
# object, one method, and a few minutes.
# --------------------------------------------------------------------------- #
class UploadUrlRequest(BaseModel):
    field_name: str
    filename: str
    content_type: str
    # What the browser says it is about to send, so an oversized object is
    # refused before it is uploaded rather than after.
    file_size: Optional[int] = None


class UploadDoneRequest(BaseModel):
    file_size: Optional[int] = None


def _project_of(form_id: str) -> Optional[str]:
    """The project a form belongs to, or None for a form outside every project."""
    try:
        from app.modules.projects import project_service
        return project_service.project_of_form(form_id)
    except Exception:
        return None


@router.post("/{form_id}/submissions/{survey_id}/media/upload-url")
def media_upload_url(
    form_id: str, survey_id: str, req: UploadUrlRequest,
    user: Dict[str, Any] = Depends(needs(RECORDS_CREATE)),
):
    """Where to put one upload, and what to call it afterwards."""
    from app.modules.forms import media_service

    form = _load(form_id, user, filling=True)

    try:
        media_type = media_service.check_upload(
            form["form_json"] or {}, req.field_name, req.content_type, req.file_size)
    except media_service.MediaError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    made = media_service.start_upload(
        _project_of(form_id), form_id, survey_id, req.field_name, media_type,
        req.filename, req.content_type,
        created_by=auth_service.display_name(user),
    )

    try:
        upload_url = media_service.presign_upload(made["s3_key"], req.content_type)
    except media_service.StorageUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception:
        # Whatever AWS said, the caller gets something it can act on — never a
        # bucket name, a role or a key.
        logger.exception("Could not sign an upload for %s", form_id)
        raise HTTPException(status_code=502, detail="Could not start the upload.")

    return {**made, "media_type": media_type, "upload_url": upload_url}


@router.post("/{form_id}/submissions/{survey_id}/media/{media_id}/complete")
def media_complete(
    form_id: str, survey_id: str, media_id: str, req: UploadDoneRequest,
    user: Dict[str, Any] = Depends(needs(RECORDS_CREATE)),
):
    """The browser reporting that the object arrived."""
    from app.modules.forms import media_service

    _load(form_id, user, filling=True)
    record = media_service.get(media_id)

    # The id in the path has to belong to the submission in the path — otherwise
    # it is somebody else's upload being marked as this one's.
    if record is None or record["form_id"] != form_id or record["survey_id"] != survey_id:
        raise HTTPException(status_code=404, detail=f"No upload '{media_id}'.")

    done = media_service.finish_upload(media_id, req.file_size)
    return {"media_id": done["media_id"], "s3_key": done["s3_key"],
            "field_name": done["field_name"], "media_type": done["media_type"],
            "original_filename": done["original_filename"],
            "file_size": done["file_size"]}


@router.get("/{form_id}/submissions/{survey_id}/media")
def media_list(form_id: str, survey_id: str,
               user: Dict[str, Any] = Depends(needs(RECORDS_VIEW))):
    """What arrived for one submission. Metadata only — no URLs are signed here."""
    from app.modules.forms import media_service

    _load(form_id, user)
    return {"media": [
        {"media_id": m["media_id"], "field_name": m["field_name"],
         "media_type": m["media_type"], "original_filename": m["original_filename"],
         "content_type": m["content_type"], "file_size": m["file_size"]}
        for m in media_service.for_submission(form_id, survey_id)
    ]}


@router.get("/{form_id}/submissions/{survey_id}/media/{media_id}/url")
def media_download_url(form_id: str, survey_id: str, media_id: str,
                       user: Dict[str, Any] = Depends(needs(RECORDS_VIEW))):
    """A link to read one object, good for a few minutes.

    The object is never public: this is the only way to it, and it is behind the
    same check as the submission it belongs to.
    """
    from app.modules.forms import media_service

    _load(form_id, user)
    record = media_service.get(media_id)

    if (record is None or record["form_id"] != form_id
            or record["survey_id"] != survey_id or record["uploaded_on"] is None):
        raise HTTPException(status_code=404, detail=f"No upload '{media_id}'.")

    try:
        url = media_service.presign_download(record["s3_key"],
                                             record["original_filename"])
    except media_service.StorageUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception:
        logger.exception("Could not sign a download for %s", media_id)
        raise HTTPException(status_code=502, detail="Could not open that file.")

    return {"url": url, "content_type": record["content_type"],
            "original_filename": record["original_filename"]}
