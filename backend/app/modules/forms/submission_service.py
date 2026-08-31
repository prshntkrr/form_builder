"""Reading and writing submissions in a form's own table.

A submission is one row: the whole validated answer set goes into the `form_data`
JSONB column, alongside the survey/form/version/author envelope.
"""
import csv
import io
import logging
import re
from typing import Any, Dict, Optional, Tuple

from psycopg2 import sql
from psycopg2.extras import Json

from app.core.config import settings
from app.core.database import transaction
from app.modules.forms.field_types import FieldValueError, coerce_value, get_type, json_safe
from app.modules.forms.form_schema import field_name
from app.modules.forms import conditions
from app.modules.forms import standardization
from app.modules.forms import translations
from app.modules.forms.form_service import FormNotFound
from app.modules.forms.table_service import next_survey_id, table_exists
from app.modules.forms import tabular_service

logger = logging.getLogger(__name__)


class ValidationFailed(ValueError):
    def __init__(self, errors: Dict[str, str]):
        self.errors = errors
        super().__init__("; ".join(f"{k}: {v}" for k, v in errors.items()))


# --------------------------------------------------------------------------- #
# validation
# --------------------------------------------------------------------------- #
def _is_empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _measure(spec, raw: Any, value: Any) -> Tuple[Optional[str], str]:
    """What the length rules count.

    Digits for a number or phone, so spaces, dashes and brackets don't eat into
    the limit: `98765 43210` counts as 10. A country code does count, so a form
    that accepts `+91…` needs the limit set accordingly. Characters otherwise.
    """
    if spec.counts_digits:
        return (re.sub(r"\D", "", str(value)) if value is not None else None), "digits"
    if isinstance(raw, str):
        return raw.strip(), "characters"
    return None, ""


def _not_offered(field: Dict[str, Any], selected: Any, payload: Dict[str, Any]) -> list:
    """Which of these answers the field's source would not have offered.

    Nothing is rejected when the source is unreachable — a switched-off module
    must not make an existing form unanswerable.

    A dependent field is checked against its parent's answer, not just against
    the list as a whole: a municipality of one state is not an answer when a
    different state is selected, and with no state selected there is no answer
    at all yet.
    """
    source = field.get("options_from") or {}
    kind_of_source = source.get("source")

    depends_on = source.get("depends_on")
    depends_on_value = payload.get(depends_on) if depends_on else None

    if depends_on and depends_on_value in (None, "", [], {}):
        # The list this one narrows has not been answered, so nothing on it has
        # been offered. Accepting anything here would let a stale value through.
        return [str(value) for value in selected]

    if kind_of_source == "crop_ontology":
        try:
            from app.modules.standards.crop_ontology import dynamic_options
        except Exception:
            return []

        check = lambda value: dynamic_options.is_valid(  # noqa: E731
            source.get("kind"), value, depends_on_value)

    elif kind_of_source == "client_catalog":
        try:
            from app.modules.client_catalog import catalog_options
        except Exception:
            return []

        check = lambda value: catalog_options.is_valid(  # noqa: E731
            source.get("catalog"), value, depends_on_value)

    else:
        return []

    try:
        return [str(value) for value in selected if not check(value)]
    except Exception:
        logger.exception("Could not check %s against its source", field.get("name"))
        return []


def validate_payload(
    form_json: Dict[str, Any],
    payload: Dict[str, Any],
    language: Optional[str] = None,
) -> Dict[str, Any]:
    """Check the answers against the form definition.

    `language` decides the wording of any error. The rules themselves are the
    same in every language, and so are the keys in the result — only what the
    person reads changes.

    Returns the normalized answer set destined for the `form_data` JSONB column:
    numbers as numbers, booleans as booleans, dates as ISO strings, multi-selects
    as arrays. Keys not defined by the form are dropped.
    """
    errors: Dict[str, str] = {}
    clean: Dict[str, Any] = {}

    # Translate first, so every label quoted back in an error is in the language
    # the person filled the form in.
    form_json = translations.translate_form(form_json, language)

    # Which questions this answer set does not apply to. Worked out here rather
    # than trusted from the client, because a request can be sent without ever
    # opening the form — the same rules the renderer used, evaluated again on
    # arrival. Reading the payload, not `clean`: a condition is about what the
    # person answered, and every answer arrives together.
    not_applicable = set(conditions.hidden(form_json, payload)["fields"])

    for field in form_json.get("fields") or []:
        name = field_name(field)
        if not name:
            continue
        label = field.get("label") or name
        spec = get_type(field.get("type") or "text")
        raw = payload.get(name)

        if name in not_applicable:
            # The form did not ask this. An answer to it is refused rather than
            # quietly dropped: silently discarding it would leave the sender
            # believing it had been recorded, and a required question that does
            # not apply is not a missing answer.
            if not _is_empty(raw):
                errors[name] = translations.message(
                    language, "not_applicable", label=label)
            clean[name] = None
            continue

        if _is_empty(raw):
            if field.get("required"):
                errors[name] = translations.message(language, "required", label=label)
            clean[name] = None
            continue

        # option membership
        if spec.has_options:
            selected = raw if isinstance(raw, list) else [raw]

            if field.get("options_from"):
                # The choices were never written onto the form — they are read
                # when it is drawn — so the answer is checked against the source
                # itself, and against whatever the field it depends on says.
                invalid = _not_offered(field, selected, payload)
            else:
                allowed = {o["value"] for o in field.get("options") or []}
                invalid = [str(v) for v in selected if str(v) not in allowed]

            if invalid:
                errors[name] = translations.message(
                    language, "not_an_option", label=label, value=invalid[0])
                continue
            if not spec.multi and isinstance(raw, list):
                raw = raw[0] if raw else None

        try:
            value = coerce_value(field["type"], raw)
        except FieldValueError as exc:
            errors[name] = f"{label}: {exc}"
            continue

        rules = field.get("validation") or {}
        numeric = spec.json_type == "number"

        if numeric and value is not None:
            if rules.get("min") is not None and float(value) < float(rules["min"]):
                errors[name] = translations.message(
                    language, "min", label=label, limit=rules["min"])
            if rules.get("max") is not None and float(value) > float(rules["max"]):
                errors[name] = translations.message(
                    language, "max", label=label, limit=rules["max"])

        measured, unit = _measure(spec, raw, value)
        if measured is not None:
            if rules.get("min_length") and len(measured) < int(rules["min_length"]):
                errors[name] = translations.message(
                    language, "min_length", label=label,
                    limit=rules["min_length"], unit=translations.word(language, unit))
            if rules.get("max_length") and len(measured) > int(rules["max_length"]):
                errors[name] = translations.message(
                    language, "max_length", label=label,
                    limit=rules["max_length"], unit=translations.word(language, unit))

        if rules.get("pattern") and isinstance(raw, str):
            try:
                if not re.match(rules["pattern"], raw.strip()):
                    errors[name] = translations.message(language, "pattern", label=label)
            except re.error:
                pass  # a bad pattern from the model must not block a submission

        clean[name] = json_safe(value)

    # Last, because it works on the coerced answers, and after the form's own
    # min/max rules because those are the client's rules in the client's unit.
    # A figure collected in centimetres is stored in the metres its standard
    # uses; a field with no standard is returned exactly as it always was.
    clean, unit_errors = standardization.standardize(form_json, clean)
    errors.update(unit_errors)

    if errors:
        raise ValidationFailed(errors)
    return clean


def test_payload(
    form_json: Dict[str, Any],
    payload: Dict[str, Any],
    language: Optional[str] = None,
) -> Dict[str, Any]:
    """Answer what a submission *would* do, and write nothing.

    The same validation and coercion a real submission goes through, so a draft
    can be tested against its own rules before anyone publishes it — and the
    caller sees the exact `form_data` that would land in Postgres, not a guess.

    Nothing is stored, so a test needs no cleaning up and cannot be mistaken for
    a real answer later.
    """
    try:
        clean = validate_payload(form_json, payload, language)
    except ValidationFailed as failed:
        return {"valid": False, "errors": failed.errors, "form_data": None}

    return {
        "valid": True,
        "errors": {},
        "form_data": clean,
        # What the row would look like. `survey_id` is only allocated on a real
        # submission, so it is deliberately absent rather than invented.
        "columns": sorted(clean),
        "table_name": form_json.get("table_name"),
    }


# --------------------------------------------------------------------------- #
# writes
# --------------------------------------------------------------------------- #
def submit(
    form: Dict[str, Any],
    payload: Dict[str, Any],
    created_by: Optional[str] = None,
    language: Optional[str] = None,
) -> Dict[str, Any]:
    form_json = form["form_json"] or {}
    table_name = form_json.get("table_name")
    if not table_name:
        raise FormNotFound(f"Form {form['form_id']} has no data table")
    if form.get("form_status") == "Draft":
        raise ValidationFailed(
            {"_form": "This form is still a draft. Publish it before collecting answers — "
                      "until then, use Preview to test it."}
        )
    if form.get("form_status") != "Active":
        raise ValidationFailed({"_form": "This form is not accepting responses"})

    clean = validate_payload(form_json, payload, language)
    version = form.get("version_no") or form_json.get("version") or 1

    with transaction() as cur:
        if not table_exists(cur, table_name):
            raise FormNotFound(f"Data table '{table_name}' does not exist")

        survey_id = next_survey_id(cur, form["form_id"], table_name)

        cur.execute(
            sql.SQL(
                """
                INSERT INTO {}.{} (survey_id, form_id, form_data, form_version, created_by)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING survey_id, created_on
                """
            ).format(sql.Identifier(settings.db_schema), sql.Identifier(table_name)),
            (
                survey_id,
                form["form_id"],
                Json(clean),
                version,
                created_by or settings.default_user,
            ),
        )
        row = dict(cur.fetchone())

        # Same transaction: the flat mirror can never be missing a response the
        # JSONB table has.
        tabular_service.insert(
            cur,
            form_json,
            survey_id,
            form["form_id"],
            version,
            created_by or settings.default_user,
            clean,
        )

    # Where this submission has got to, recorded beside it. Defensive: the
    # projects module can be switched off, and a response must still be stored.
    try:
        from app.modules.projects import submission_workflow
        submission_workflow.record_submission(
            form["form_id"], survey_id, created_by or settings.default_user)
    except Exception:
        logger.exception("Could not record the review state for %s", survey_id)

    logger.info("Stored submission %s in %s", survey_id, table_name)
    return {
        "survey_id": row["survey_id"],
        "created_on": row["created_on"],
        "form_id": form["form_id"],
        "form_version": version,
        "table_name": table_name,
    }


# --------------------------------------------------------------------------- #
# reads
# --------------------------------------------------------------------------- #
def list_submissions(
    form: Dict[str, Any], limit: int = 50, offset: int = 0
) -> Dict[str, Any]:
    form_json = form["form_json"] or {}
    table_name = form_json.get("table_name")
    columns = [
        {
            "name": field_name(f),
            "label": f.get("label") or field_name(f),
            "type": f.get("type") or "text",
        }
        for f in form_json.get("fields") or []
        if field_name(f)
    ]

    with transaction() as cur:
        if not table_name or not table_exists(cur, table_name):
            # A form whose table was never created — seeded straight into
            # `forms`, or created while the database was unreachable. The same
            # keys as the normal path, so callers need no second shape.
            return {
                "table_name": table_name,
                "tabular_name": tabular_service.tabular_name(table_name) if table_name else None,
                "columns": columns,
                "total": 0,
                "limit": limit,
                "offset": offset,
                "rows": [],
            }

        qualified = sql.SQL("{}.{}").format(
            sql.Identifier(settings.db_schema), sql.Identifier(table_name)
        )
        cur.execute(
            sql.SQL("SELECT COUNT(*) AS n FROM {} WHERE form_id = %s").format(qualified),
            (form["form_id"],),
        )
        total = int(cur.fetchone()["n"])

        cur.execute(
            sql.SQL(
                """
                SELECT survey_id, form_data, created_on, form_version, created_by
                FROM {} WHERE form_id = %s
                ORDER BY created_on DESC, survey_id DESC
                LIMIT %s OFFSET %s
                """
            ).format(qualified),
            (form["form_id"], limit, offset),
        )
        rows = [dict(r) for r in cur.fetchall()]

    return {
        "table_name": table_name,
        "tabular_name": tabular_service.tabular_name(table_name) if table_name else None,
        "columns": columns,
        "total": total,
        "limit": limit,
        "offset": offset,
        "rows": rows,
    }



def one_submission(form: Dict[str, Any], survey_id: str) -> Optional[Dict[str, Any]]:
    """One stored response, or None if this form has no such row.

    The single-row twin of `list_submissions`, for a screen that is reading one
    answer set rather than a page of them — reviewing one submission should not
    mean fetching fifty.
    """
    form_json = form["form_json"] or {}
    table_name = form_json.get("table_name")
    if not table_name:
        return None

    with transaction() as cur:
        if not table_exists(cur, table_name):
            return None

        cur.execute(
            sql.SQL(
                """
                SELECT survey_id, form_data, created_on, form_version, created_by
                FROM {}.{} WHERE form_id = %s AND survey_id = %s
                """
            ).format(sql.Identifier(settings.db_schema), sql.Identifier(table_name)),
            (form["form_id"], survey_id),
        )
        row = cur.fetchone()

    return dict(row) if row else None


def answers_for(form_json: Dict[str, Any], form_data: Dict[str, Any]) -> list:
    """The answer set as questions and answers, in the order they were asked.

    For reading, not for editing: a label, a type and the stored value, and no
    validation rules, conditions or option lists. A screen showing somebody's
    answers has no business receiving the machinery that collected them.

    Every question the form asks is here, including the ones this person was
    never shown. `answered` is False for those, so a reviewer can tell a
    question skipped by a condition from one that was asked and left blank —
    a conditional question that was never reached is stored as a null, which on
    its own reads exactly like an empty answer.

    Anything in the stored data that the form no longer asks is appended, so a
    response collected under an older version still reads back in full.
    """
    fields = form_json.get("fields") or []
    sections = {s.get("key"): s for s in (form_json.get("sections") or [])}
    data = form_data or {}

    answers = []
    seen = set()

    for field in fields:
        name = field_name(field)
        if not name or name in seen:
            continue
        seen.add(name)

        section = sections.get(field.get("section")) or {}
        answers.append({
            "name": name,
            "label": field.get("label") or name,
            "type": field.get("type") or "text",
            "section": section.get("title") or "",
            "value": data.get(name),
            "answered": name in data and not _is_empty(data.get(name)),
        })

    for name, value in data.items():
        if name in seen or str(name).startswith("_"):
            continue
        # A question the form used to ask. Kept rather than dropped: the answer
        # was given, and a reviewer judging it should see it.
        answers.append({
            "name": name,
            "label": name,
            "type": "text",
            "section": "",
            "value": value,
            "answered": True,
            "retired": True,
        })

    return answers


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return ", ".join(str(v) for v in value)
    if isinstance(value, dict):
        return "; ".join(f"{k}={v}" for k, v in value.items())
    return str(value)


def export_csv(form: Dict[str, Any]) -> str:
    data = list_submissions(form, limit=100000, offset=0)
    buffer = io.StringIO()
    writer = csv.writer(buffer)

    headers = ["survey_id", "created_on", "created_by", "form_version"]
    headers += [c["label"] for c in data["columns"]]
    writer.writerow(headers)

    for row in data["rows"]:
        form_data = row.get("form_data") or {}
        line = [
            row.get("survey_id"),
            row.get("created_on"),
            row.get("created_by"),
            row.get("form_version"),
        ]
        line += [_cell(form_data.get(c["name"])) for c in data["columns"]]
        writer.writerow(line)

    return buffer.getvalue()
