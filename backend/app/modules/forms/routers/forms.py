"""Form authoring + management endpoints."""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from psycopg2 import IntegrityError

from app.core import auth_service
from app.modules.forms import form_service
from app.modules.forms import llm
from app.modules.forms import standard_library
from app.core.deps import current_user, needs
from app.modules.forms.permissions import (
    FORMS_SYSTEM_VIEW,
    FORMS_CREATE, FORMS_DELETE, FORMS_EDIT, FORMS_VIEW, LIBRARY_MANAGE,
)
from app.modules.forms.config_validation import ConfigValidationError, validate_config
from app.modules.forms.form_schema import FormSchemaError, normalize_form
from app.modules.forms.migration_service import MigrationError
from app.modules.forms import dictionary_service
from app.modules.forms import translations
from app.modules.forms.schemas import (
    CreateFormRequest,
    GenerateRequest,
    RefineRequest,
    RevalidateRequest,
    RollbackRequest,
    StatusRequest,
    TestDefinitionRequest,
    TranslateRequest,
    UpdateFormRequest,
    ValidateRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/forms", tags=["forms"])

def may_build_somewhere(user: Dict[str, Any]) -> bool:
    """Whether this account may build a form anywhere at all.

    Either on the installation, or in some project it belongs to. Used for the
    builder's aids — validating a definition, drafting one, listing the
    languages — which touch no particular form and store nothing.
    """
    if auth_service.may(user, FORMS_CREATE):
        return True

    try:
        from app.modules.projects import access
        from app.modules.projects.permissions import FORMS_MANAGE
    except Exception:
        return False

    return any(access.can(user, FORMS_MANAGE, project_id)
               for project_id in access.projects_for(user))


def needs_on_form(system_permission: str, project_permission: str):
    """A dependency judging one form by the context that form belongs to.

    The form id is in the path, so which context applies is known before the
    handler runs:

        no project    the account permission. A project role never reaches a
                      system form.
        a project     the permission held *in that project*. The account
                      permission does not reach into somebody else's project,
                      and a form belongs to its project rather than to whoever
                      happened to create it — so a Project Manager edits a form
                      an administrator made, and `created_by` is not consulted.

    A project this account cannot reach answers 404, as everywhere else.
    """

    def dependency(
        form_id: str = Path(...),
        user: Dict[str, Any] = Depends(current_user),
    ) -> Dict[str, Any]:
        try:
            from app.modules.projects import access, project_service
        except Exception:
            project_id = None
            access = None
        else:
            project_id = project_service.project_of_form(form_id)

        if project_id and access is not None:
            access.require(user, project_permission, project_id)
            return user

        if auth_service.may(user, system_permission):
            return user

        from app.core import permissions as catalogue
        entry = catalogue.BY_KEY.get(system_permission)
        raise HTTPException(
            status_code=403,
            detail=(
                f"Your role ({user.get('role_label') or user.get('role')}) cannot do "
                f"this — it needs the '{entry.label if entry else system_permission}' "
                f"permission"
            ),
        )

    return dependency


def _could_build_somewhere(user: Dict[str, Any] = Depends(current_user)) -> Dict[str, Any]:
    """Refuse an account that could not build a form anywhere.

    A dependency, so a permission failure is answered as one rather than as a
    complaint about the request body. It cannot decide *which* project — that
    needs the body — so it only rules out the account that has no route to
    creating a form at all: no account permission, and no project membership.
    """
    if may_build_somewhere(user):
        return user

    raise HTTPException(
        status_code=403,
        # Names the permission, not a role: roles are the installation's to
        # define and rename, permissions are the application's.
        detail=(
            f"Your role ({user.get('role_label') or user.get('role')}) cannot do this — "
            f"it needs the 'Create forms' permission, or a project role that allows "
            f"building forms in that project"
        ),
    )


def _may_build_in(project_id, user):
    """Whether this request may create a form, and where.

    The two halves of the system/project split meet here. A System Administrator
    builds forms because their **account** may. A Project Manager builds forms in
    their project because their **membership there** says so — and holds no
    account permission at all. Either is enough; neither is required of the
    other, and "Project manager" therefore never means anything outside the
    project it was granted in.

    Sending somebody else's `project_id` is the obvious way to try to reach into
    another project, so the permission is checked against the project named in
    the request. A project this account cannot reach answers 404, matching every
    other project route.
    """
    if not project_id:
        # No project named: this is a system form, and it takes the account
        # permission, exactly as it always did.
        if not auth_service.may(user, FORMS_CREATE):
            raise HTTPException(
                status_code=403,
                detail=(
                    f"Your role ({user.get('role_label') or user.get('role')}) cannot "
                    f"create forms outside a project"
                ),
            )
        return

    try:
        from app.modules.projects import access
        from app.modules.projects.permissions import FORMS_MANAGE
    except Exception:
        # The projects module is switched off, so there are no projects to
        # build into and naming one is a mistake rather than a way in.
        raise HTTPException(status_code=404, detail=f"No project '{project_id}'")

    # Inside a project the project decides, whatever the account may do
    # elsewhere: being able to build forms on the installation is not being able
    # to build them in somebody else's project. An administrator passes because
    # `projects.view_all` gives them every project's permissions.
    access.require(user, FORMS_MANAGE, project_id)


def _may_read(form_id: str, user):
    """Refuse a form this account has no standing to read, either way.

    A System Administrator reads it because their account may. A project member
    reads it because their membership of *that* project allows it. A form
    belonging to no project takes the account permission, exactly as before.
    """
    if auth_service.may(user, FORMS_VIEW):
        return

    try:
        from app.modules.projects import access, project_service
    except Exception:
        raise HTTPException(status_code=403, detail="Your role cannot read forms")

    project_id = project_service.project_of_form(form_id)

    if not project_id:
        # A system form. It belongs to no project, so no membership has anything
        # to say about it: it takes the system permission or nothing.
        if auth_service.may(user, FORMS_SYSTEM_VIEW):
            return
        raise HTTPException(
            status_code=403,
            detail=(
                f"Your role ({user.get('role_label') or user.get('role')}) cannot do "
                f"this — it needs the 'Use system forms' permission"
            ),
        )

    if not access.permissions_in(user, project_id):
        # A project this account is not in. 404, so it cannot be told from a
        # form that does not exist.
        raise HTTPException(status_code=404, detail=f"No form '{form_id}'")


def _project_guard(form_id: str, user):
    """Refuse a form that belongs to a project this account cannot reach.

    The single choke point for project isolation on the existing form routes.
    A form with no project keeps the system-wide rules it always had, so every
    form built before projects existed behaves exactly as before.

    404 rather than 403, matching `projects/access.py`: to somebody outside a
    project, its forms should be indistinguishable from forms that do not exist.
    """
    try:
        from app.modules.projects import access
    except Exception:
        # The projects module is switched off. Nothing is project-scoped, so
        # there is nothing to refuse.
        return

    if not access.may_see_form(user, form_id):
        raise HTTPException(status_code=404, detail=f"No form '{form_id}'")



def _dynamic_options(form_json: Dict[str, Any]) -> Dict[str, Any]:
    """Point crop and feature fields at the imported ontologies.

    Imported here and defensively: the module can be switched off, and a draft
    must still be generated when it is.
    """
    try:
        from app.modules.standards.crop_ontology import enrichment as crop
    except Exception:
        return {"form_json": form_json, "dynamic": []}

    try:
        return crop.apply_dynamic_options(form_json)
    except Exception:
        logger.exception("Could not wire the crop fields; the draft is unchanged")
        return {"form_json": form_json, "dynamic": []}


def _enrich(form_json: Dict[str, Any], prompt: str = "") -> Dict[str, Any]:
    """Attach standards to a draft, if the standards module is installed.

    Imported here and defensively: the module can be switched off in .env, and a
    form must still be generated when it is.
    """
    try:
        from app.modules.standards.icasa import enrichment
    except Exception:
        return {"form_json": form_json, "attached": []}

    try:
        return enrichment.enrich_form(form_json, prompt)
    except Exception:
        logger.exception("Standard enrichment failed; the draft is unchanged")
        return {"form_json": form_json, "attached": []}


def _constraint_message(exc: IntegrityError) -> str:
    """Turn a database constraint into something a person can act on.

    A raw CheckViolation traceback tells the user nothing; naming the rule that
    was broken tells them what to change.
    """
    name = getattr(getattr(exc, "diag", None), "constraint_name", None) or ""
    known = {
        "forms_form_status_check": "That form status is not allowed by the database.",
        "forms_form_type_check": "Form type must be 'parent' or 'child'.",
        "forms_pkey": "A form with that id already exists.",
    }
    if name in known:
        return known[name]
    if name:
        return f"The database rejected this change ({name})."
    return "The database rejected this change."


# --------------------------------------------------------------------------- #
# authoring (LLM) — nothing here touches the database
# --------------------------------------------------------------------------- #
@router.post("/generate")
def generate(req: GenerateRequest, user: Dict[str, Any] = Depends(_could_build_somewhere)):
    """Prompt -> a complete, normalized form definition (not yet saved)."""
    try:
        raw = llm.generate_form(req.prompt, req.language)

        # Two passes over the draft before anyone sees it, in this order because
        # they answer different questions:
        #
        #   the data dictionary  — how must this field behave?  (type, limits)
        #   standard enrichment  — what is it, and what is it called?
        #
        # Nobody has to ask for either in the prompt.
        result = dictionary_service.apply_to_form(normalize_form(raw))
        # Crop and feature choices are the application's data, not the model's
        # guess. Done before enrichment so a rewired field is matched in its
        # final shape.
        dynamic = _dynamic_options(result["form_json"])
        enriched = _enrich(dynamic["form_json"], req.prompt)

        return {
            "form_json": normalize_form(enriched["form_json"]),
            "dictionary": result["applied"],
            "standards": enriched["attached"],
            # Which crop ontology was used, so the builder can say so rather
            # than leaving the reader to guess why a maize form got maize ids.
            "crop_ontology_id": enriched.get("crop_ontology_id"),
            "dynamic_options": dynamic["dynamic"],
            "prompt": req.prompt,
        }
    except llm.LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except FormSchemaError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/refine")
def refine(req: RefineRequest, user: Dict[str, Any] = Depends(_could_build_somewhere)):
    """Existing definition + instruction -> revised definition (not yet saved)."""
    try:
        raw = llm.refine_form(req.form_json, req.instruction)
        return {"form_json": normalize_form(raw), "prompt": req.instruction}
    except llm.LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except FormSchemaError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/validate")
def validate(req: ValidateRequest, user: Dict[str, Any] = Depends(_could_build_somewhere)):
    """Run the validation pipeline over a config without saving it.

    Returns the normalized definition on success; on failure, the same
    `{valid, errors}` payload the save endpoints return, so a client can show
    which stage rejected it and why.
    """
    try:
        validate_config(req.form_json)
        return {"valid": True, "form_json": normalize_form(req.form_json)}
    except ConfigValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.as_payload())
    except FormSchemaError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/test-definition")
def test_definition(req: TestDefinitionRequest,
                    user: Dict[str, Any] = Depends(_could_build_somewhere)):
    """Try answers against a definition that has not been saved.

    The same validation and coercion a real submission goes through, and the
    same reply — but there is no form and no table, so nothing can be written.
    This is how an imported workbook is tried before anyone commits to it.
    """
    from app.modules.forms import submission_service

    try:
        definition = normalize_form(req.form_json)
    except FormSchemaError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    return submission_service.test_payload(definition, req.data, req.language)


@router.get("/languages")
def languages(user: Dict[str, Any] = Depends(_could_build_somewhere)):
    """The languages a form can be offered in."""
    result = []
    for code, name in translations.SUPPORTED_LANGUAGES.items():
        result.append({"code": code, "name": name})
    return result


@router.post("/translate")
def translate(req: TranslateRequest, user: Dict[str, Any] = Depends(_could_build_somewhere)):
    """Translate a form's wording with the model, and return the cleaned block.

    Only the words come back — the caller stores them under the language code.
    Field names, section keys and option values are identifiers and are never
    translated, so a stored answer means the same thing in every language.
    """
    if not translations.is_supported(req.language):
        raise HTTPException(status_code=400, detail=f"Unsupported language '{req.language}'")
    if req.language == translations.DEFAULT_LANGUAGE:
        raise HTTPException(
            status_code=400,
            detail="That is the language the form is already written in.",
        )

    language_name = translations.SUPPORTED_LANGUAGES[req.language]
    try:
        raw = llm.translate_form(req.form_json, language_name)
    except llm.LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    cleaned = translations.normalize_translations({req.language: raw})
    if not cleaned:
        raise HTTPException(
            status_code=502,
            detail="The model did not return anything usable. Try again.",
        )

    return {"language": req.language, "translations": cleaned[req.language]}


# --------------------------------------------------------------------------- #
# persistence
# --------------------------------------------------------------------------- #
@router.post("", status_code=201)
def create(req: CreateFormRequest, user: Dict[str, Any] = Depends(_could_build_somewhere)):
    """Save the form, open version 1, and create its Postgres table.

    With `project_id`, the form is created inside that project — which takes a
    project role that may build forms there, not merely an account that may
    build forms at all. Without it, the form belongs to no project and behaves
    exactly as forms did before projects existed.
    """
    _may_build_in(req.project_id, user)

    try:
        made = form_service.create_form(
            req.form_json,
            created_by=auth_service.display_name(user),
            form_type=req.form_type,
            parent_id=req.parent_id,
            status=req.form_status,
        )
    except ConfigValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.as_payload())
    except FormSchemaError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except form_service.FormServiceError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail=_constraint_message(exc))
    except Exception as exc:
        logger.exception("Form creation failed")
        raise HTTPException(status_code=500, detail=f"Could not save form: {exc}")

    if req.project_id:
        from app.modules.projects import project_service
        project_service.set_form_project(made["form_id"], req.project_id)
        made["project_id"] = req.project_id

    return made


@router.get("")
def index(
    status: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    project: Optional[str] = Query(
        None, description="'none' for forms outside every project, or a project id"),
    user: Dict[str, Any] = Depends(needs(FORMS_VIEW)),
):
    """The forms this account may build.

    `project=none` is the system context — forms belonging to no project, which
    behave exactly as every form did before projects existed. A project's own
    forms are better read from `/api/projects/{id}/forms`, which also applies
    who each one was assigned to.
    """
    if project == "none" and not auth_service.may(user, FORMS_SYSTEM_VIEW):
        raise HTTPException(
            status_code=403,
            detail=(
                f"Your role ({user.get('role_label') or user.get('role')}) cannot do "
                f"this — it needs the 'Use system forms' permission"
            ),
        )

    found = form_service.list_forms(
        status=status, search=search, limit=limit, offset=offset, project=project)

    if not auth_service.may(user, FORMS_SYSTEM_VIEW):
        # The unnarrowed list still has to keep the two contexts apart: a form
        # belonging to no project is not something a project membership opens.
        found = [f for f in found if f.get("project_id")]

    return found


@router.get("/{form_id}")
def detail(form_id: str, user: Dict[str, Any] = Depends(current_user)):
    """One form, as this account may see it.

    Reachable two ways, and the guard is the same either way: an account that
    may read forms at all, or standing in the project this one belongs to.
    """
    _may_read(form_id, user)
    _project_guard(form_id, user)
    try:
        return form_service.get_form(form_id)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.put("/{form_id}")
def update(form_id: str, req: UpdateFormRequest,
           user: Dict[str, Any] = Depends(needs_on_form(FORMS_EDIT, "project.forms.manage"))):
    """Save a revision, moving stored answers for any renamed field."""
    try:
        return form_service.update_form(
            form_id,
            req.form_json,
            updated_by=auth_service.display_name(user),
            status=req.form_status,
            renames=req.renames,
        )
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ConfigValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.as_payload())
    except (FormSchemaError, MigrationError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.exception("Form update failed")
        raise HTTPException(status_code=500, detail=f"Could not update form: {exc}")


@router.post("/{form_id}/revalidate")
def revalidate(form_id: str, req: RevalidateRequest,
               user: Dict[str, Any] = Depends(needs_on_form(FORMS_EDIT, "project.forms.manage"))):
    """Check stored responses against the current definition after a hand edit.

    `fix: false` reports only; `fix: true` also re-coerces the values it can.
    """
    try:
        return form_service.check_submissions(form_id, fix=req.fix)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.exception("Revalidation failed")
        raise HTTPException(status_code=500, detail=f"Could not check responses: {exc}")


@router.patch("/{form_id}/status")
def change_status(form_id: str, req: StatusRequest,
                  user: Dict[str, Any] = Depends(needs_on_form(FORMS_EDIT, "project.forms.manage"))):
    try:
        return form_service.set_status(form_id, req.form_status)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except form_service.FormServiceError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail=_constraint_message(exc))


@router.delete("/{form_id}")
def soft_delete(form_id: str,
                user: Dict[str, Any] = Depends(needs_on_form(FORMS_DELETE, "project.forms.manage"))):
    """Marks the form Deleted. The data table and its rows are left untouched."""
    try:
        return form_service.set_status(form_id, "Deleted")
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail=_constraint_message(exc))


@router.post("/{form_id}/rollback")
def rollback(form_id: str, req: RollbackRequest,
             user: Dict[str, Any] = Depends(needs_on_form(FORMS_EDIT, "project.forms.manage"))):
    """Make an existing version the live one.

    No new version is written — the form simply points at that version's stored
    definition. The history is untouched, so rolling anywhere else undoes it.
    """
    try:
        return form_service.rollback(
            form_id, req.version_no, updated_by=auth_service.display_name(user))
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except form_service.FormServiceError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except MigrationError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.exception("Rollback failed")
        raise HTTPException(status_code=500, detail=f"Could not roll back: {exc}")


@router.get("/{form_id}/standard-diff")
def standard_diff(form_id: str,
                  user: Dict[str, Any] = Depends(needs_on_form(FORMS_VIEW, "project.forms.view_all"))):
    """How far this form has drifted from the standard it started from.

    404 if it did not come from one — the same shape as a version diff, so a
    client can render it with the same component.
    """
    try:
        form = form_service.get_form(form_id)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    result = standard_library.diff_against_standard(form["form_json"] or {})
    if result is None:
        raise HTTPException(
            status_code=404, detail="This form did not start from a standard form"
        )
    return result


@router.post("/{form_id}/rebuild-tabular")
def rebuild_tabular(form_id: str,
                    user: Dict[str, Any] = Depends(needs_on_form(FORMS_EDIT, "project.forms.manage"))):
    """Rebuild the flat `<form>_tabular` mirror from the JSONB table.

    Happens automatically whenever columns change; call this for a form whose
    responses were collected before the mirror existed.
    """
    try:
        return form_service.rebuild_tabular(form_id)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.exception("Tabular rebuild failed")
        raise HTTPException(status_code=500, detail=f"Could not rebuild: {exc}")


@router.get("/{form_id}/versions")
def versions(form_id: str, include_json: bool = False,
             user: Dict[str, Any] = Depends(needs_on_form(FORMS_VIEW, "project.forms.view_all"))):
    try:
        form_service.get_form(form_id)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return form_service.get_versions(form_id, include_json=include_json)


@router.get("/{form_id}/diff")
def diff(
    form_id: str,
    from_version: Optional[int] = Query(None, alias="from"),
    to_version: Optional[int] = Query(None, alias="to"),
    user: Dict[str, Any] = Depends(needs_on_form(FORMS_VIEW, "project.forms.view_all")),
):
    """What changed between two saved versions.

    Defaults to the newest version against the one before it. Fields renamed
    along the way are followed, so a rename reads as a change rather than as one
    field removed and another added.

    The same gate as `/versions`, and for the same reason: this is the History
    tab reading its own form. Asking for the account permission here while
    `/versions` asked the project's left the tab half open — the list of
    versions arrived and comparing two of them was refused.
    """
    try:
        return form_service.diff_versions(form_id, from_version, to_version)
    except form_service.FormNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
