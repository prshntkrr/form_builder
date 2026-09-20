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
from app.modules.forms.form_schema import (
    LOCATION_COLUMN, PARENT_COLUMN, field_name,
)
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


class SubmissionConflict(ValueError):
    """A `client_submission_id` already names a different submission of this form."""


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

    elif kind_of_source == "data_standard":
        # Only a field that says it is ISO 3166-1 is checked against it. Nothing
        # is inferred from a label: a question called "Country" that names no
        # standard is somebody's own list and is left alone.
        if source.get("standard") != "ISO_3166_1":
            return []
        try:
            from app.modules.standards.iso3166 import service as iso3166
        except Exception:
            return []

        check = lambda value: iso3166.is_valid(  # noqa: E731
            source.get("code_type") or "alpha_2", value)

    elif kind_of_source == "client_catalog":
        try:
            from app.modules.client_catalog import catalog_options
        except Exception:
            return []

        # A field may offer part of a catalogue. Both are checked: the code has
        # to be in the catalogue *and* among the ones this field offers.
        check = lambda value: catalog_options.is_valid(  # noqa: E731
            source.get("catalog"), value, depends_on_value,
            allowed=source.get("allowed_values"))

    else:
        return []

    try:
        return [str(value) for value in selected if not check(value)]
    except Exception:
        logger.exception("Could not check %s against its source", field.get("name"))
        return []


#: `_check_field` found nothing to store under this name — the answer was
#: refused outright, so `form_data` does not get the key at all.
_NOT_STORED = object()


def _check_field(
    field: Dict[str, Any],
    raw: Any,
    answers: Dict[str, Any],
    language: Optional[str],
    not_applicable: bool,
) -> Tuple[Any, Optional[str]]:
    """One question, checked against its own definition.

    The single implementation of per-question validation: `validate_payload`
    runs it for every question of a form, `validate_field` for one at a time.
    `field` is already translated and `not_applicable` already decided by the
    caller, so neither is worked out twice for a whole form.

    Returns `(stored, error)`. `stored` is what `form_data` holds for this
    question — `_NOT_STORED` when the answer was refused outright — and `error`
    the message for it, or None. Both can be set: an answer outside its range is
    still coerced and reported, exactly as it always was.
    """
    name = field_name(field)
    label = field.get("label") or name
    spec = get_type(field.get("type") or "text")

    if not_applicable:
        # The form did not ask this. An answer to it is refused rather than
        # quietly dropped: silently discarding it would leave the sender
        # believing it had been recorded, and a required question that does
        # not apply is not a missing answer.
        if not _is_empty(raw):
            return None, translations.message(language, "not_applicable", label=label)
        return None, None

    if _is_empty(raw):
        if field.get("required"):
            return None, translations.message(language, "required", label=label)
        return None, None

    # option membership
    if spec.has_options:
        selected = raw if isinstance(raw, list) else [raw]

        if field.get("options_from"):
            # The choices were never written onto the form — they are read
            # when it is drawn — so the answer is checked against the source
            # itself, and against whatever the field it depends on says.
            invalid = _not_offered(field, selected, answers)
        else:
            allowed = {o["value"] for o in field.get("options") or []}
            invalid = [str(v) for v in selected if str(v) not in allowed]

        if invalid:
            return _NOT_STORED, translations.message(
                language, "not_an_option", label=label, value=invalid[0])
        if not spec.multi and isinstance(raw, list):
            raw = raw[0] if raw else None

    try:
        value = coerce_value(field["type"], raw)
    except FieldValueError as exc:
        return _NOT_STORED, f"{label}: {exc}"

    error: Optional[str] = None
    rules = field.get("validation") or {}
    numeric = spec.json_type == "number"

    if numeric and value is not None:
        if rules.get("min") is not None and float(value) < float(rules["min"]):
            error = translations.message(
                language, "min", label=label, limit=rules["min"])
        if rules.get("max") is not None and float(value) > float(rules["max"]):
            error = translations.message(
                language, "max", label=label, limit=rules["max"])

    measured, unit = _measure(spec, raw, value)
    if measured is not None:
        if rules.get("min_length") and len(measured) < int(rules["min_length"]):
            error = translations.message(
                language, "min_length", label=label,
                limit=rules["min_length"], unit=translations.word(language, unit))
        if rules.get("max_length") and len(measured) > int(rules["max_length"]):
            error = translations.message(
                language, "max_length", label=label,
                limit=rules["max_length"], unit=translations.word(language, unit))

    if rules.get("pattern") and isinstance(raw, str):
        try:
            if not re.match(rules["pattern"], raw.strip()):
                error = translations.message(language, "pattern", label=label)
        except re.error:
            pass  # a bad pattern from the model must not block a submission

    return json_safe(value), error


def validate_field(
    form_json: Dict[str, Any],
    name: str,
    value: Any,
    answers: Optional[Dict[str, Any]] = None,
    language: Optional[str] = None,
) -> Any:
    """One answer, checked the way a whole submission would check it.

    For a channel that asks one question at a time — a WhatsApp conversation, an
    IVR call — and needs to know now, not after the last question, whether this
    reply can stand. The same per-question check `validate_payload` runs
    (`_check_field`), and the same unit standardisation afterwards, so an answer
    accepted here is one the final submission accepts.

    `answers` is what has been answered so far. It decides whether this question
    applies at all, and what a dependent list offers; `value` is laid over it.

    Returns the value as `form_data` would store it. Raises `ValidationFailed`
    keyed by the question's name, or `KeyError` for a question the form does
    not have.
    """
    form_json = translations.translate_form(form_json, language)
    field = next((f for f in form_json.get("fields") or [] if field_name(f) == name), None)
    if field is None:
        raise KeyError(f"This form has no question '{name}'")

    so_far = {**(answers or {}), name: value}
    not_applicable = name in set(conditions.hidden(form_json, so_far)["fields"])

    stored, error = _check_field(field, value, so_far, language, not_applicable)
    if error:
        raise ValidationFailed({name: error})
    if stored is _NOT_STORED:   # never without an error; kept for the type checker
        raise ValidationFailed({name: translations.message(language, "required", label=name)})

    converted, unit_errors = standardization.standardize(
        {"fields": [field]}, {name: stored})
    if unit_errors:
        raise ValidationFailed(unit_errors)
    return converted.get(name)


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
        stored, error = _check_field(
            field, payload.get(name), payload, language, name in not_applicable)
        if stored is not _NOT_STORED:
            clean[name] = stored
        if error:
            errors[name] = error

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
# --------------------------------------------------------------------------- #
# starting one
# --------------------------------------------------------------------------- #
def start(form: Dict[str, Any], created_by: str = "") -> str:
    """Hand out the next `survey_id` for this form and mark it IN_PROGRESS.

    Called when somebody presses Submit, not when they open the form: an id is
    only issued once there is something to store under it. What it buys is a
    place to file uploads — the browser has to know where its photo goes before
    it can send it, and the answers are not stored until they have all landed.

    A row in `form_survey_progress` is what IN_PROGRESS means. `submit` moves it
    into the form's own table, which is what SUBMITTED means. If submission
    fails the row stays, and the browser retries with the same id rather than
    burning a second one.
    """
    table_name = (form["form_json"] or {}).get("table_name")
    if not table_name:
        raise FormNotFound(f"Form {form['form_id']} has no data table")

    with transaction() as cur:
        if not table_exists(cur, table_name):
            raise FormNotFound(f"Data table '{table_name}' does not exist")

        survey_id = next_survey_id(cur, form["form_id"], table_name)
        cur.execute(
            "INSERT INTO form_survey_progress (form_id, survey_id, created_by) "
            "VALUES (%s, %s, %s)",
            (form["form_id"], survey_id, created_by or settings.default_user),
        )

    return survey_id


def in_progress(form_id: str, survey_id: str) -> Optional[Dict[str, Any]]:
    """The started-but-not-submitted survey, or None if there is no such thing."""
    with transaction() as cur:
        cur.execute(
            "SELECT * FROM form_survey_progress WHERE form_id = %s AND survey_id = %s",
            (form_id, survey_id),
        )
        row = cur.fetchone()
    return dict(row) if row else None


def _check_media(form_json: Dict[str, Any], form_id: str, survey_id: str,
                 clean: Dict[str, Any]) -> None:
    """Every media answer must be an upload that actually arrived, for this survey.

    The answer stored for an image, audio or file question is a `media_id`. The
    browser is the one that reports the upload finished, so the id is a claim
    until this looks it up: it has to exist, belong to this form and this
    survey, and have arrived. Required-but-missing is caught by the normal
    validation before this; what this catches is an id that is somebody else's,
    made up, or never finished uploading.
    """
    from app.modules.forms import media_service

    wanted = {
        name: clean[name]
        for name in clean
        if media_service.field_media_type(form_json, name) and clean[name]
    }
    if not wanted:
        return

    arrived = {m["media_id"] for m in media_service.for_submission(form_id, survey_id)}
    bad = {name: "That upload did not finish. Choose the file again."
           for name, media_id in wanted.items() if media_id not in arrived}
    if bad:
        raise ValidationFailed(bad)


# --------------------------------------------------------------------------- #
# the same submission, sent twice
# --------------------------------------------------------------------------- #
#: What a client may call its own submission: the same alphabet the gateway
#: already accepts for an `Idempotency-Key`, so one value works as either.
CLIENT_SUBMISSION_ID = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")


class _AlreadyTaken(Exception):
    """Another transaction stored this client id first. Rolls this one back."""


def request_hash(payload: Dict[str, Any]) -> str:
    """A fingerprint of the answers as they were sent.

    Compared on a retry, so the same `client_submission_id` reused for a
    *different* set of answers is refused rather than answered with the first
    submission — a client bug that would otherwise lose data silently.
    """
    import hashlib
    import json

    text = json.dumps(payload or {}, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _receipt(cur, form_id: str, client_submission_id: str) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT * FROM submission_receipt WHERE form_id = %s AND client_submission_id = %s",
        (form_id, client_submission_id),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def replay(
    form: Dict[str, Any],
    client_submission_id: Optional[str],
    payload: Dict[str, Any],
    channel: str = "web",
) -> Optional[Dict[str, Any]]:
    """The submission this client id already made, or None if it made none.

    A retry of the same answers, from the same channel, gets back exactly what
    the first attempt stored — nothing is written, and the version, status and
    validation checks the first attempt passed are not asked again (the form may
    have moved on; the answers were accepted when they were sent).

    The same id with different answers, or from a different channel, is not a
    retry of anything: `SubmissionConflict`.
    """
    if not client_submission_id:
        return None

    with transaction() as cur:
        receipt = _receipt(cur, form["form_id"], client_submission_id)
        if receipt is None:
            return None

        if (receipt["channel"] != channel
                or receipt["request_hash"] != request_hash(payload)):
            raise SubmissionConflict(
                f"'{client_submission_id}' was already used for a different "
                "submission of this form. Send a new id for new answers.")

        table_name = (form["form_json"] or {}).get("table_name")
        cur.execute(
            sql.SQL("SELECT survey_id, created_on, form_version FROM {}.{} "
                    "WHERE survey_id = %s").format(
                sql.Identifier(settings.db_schema), sql.Identifier(table_name)),
            (receipt["survey_id"],),
        )
        row = cur.fetchone()

    stored = dict(row) if row else {"survey_id": receipt["survey_id"],
                                    "created_on": receipt["created_on"],
                                    "form_version": None}
    return {
        "survey_id": stored["survey_id"],
        "created_on": stored["created_on"],
        "form_id": form["form_id"],
        "form_version": stored["form_version"],
        "table_name": table_name,
        "client_submission_id": client_submission_id,
        "replayed": True,
    }


def submit(
    form: Dict[str, Any],
    payload: Dict[str, Any],
    created_by: Optional[str] = None,
    language: Optional[str] = None,
    parent_survey_id: Optional[str] = None,
    location: Optional[Dict[str, Any]] = None,
    survey_id: Optional[str] = None,
    channel: str = "web",
    client_submission_id: Optional[str] = None,
    source_ref: str = "",
) -> Dict[str, Any]:
    """Store one response.

    `survey_id` is the id `start` handed out, for a submission whose uploads had
    to be filed somewhere first. Passing one moves that survey from IN_PROGRESS
    to SUBMITTED; passing none takes an id here and does both at once, which is
    what a form with nothing to upload does.

    `parent_survey_id` is only ever a value the caller has already had checked
    by `relationships.validate_parent` — this writes it, it does not judge it.
    An independent form is passed None and its table is untouched, exactly as
    before.

    `location` is checked here rather than by the caller, because a submission
    is refused for a bad position the same way it is refused for a bad answer:
    with the rest of the validation, before anything is written.

    `channel` is how the answers arrived. A form whose channel profile has that
    channel off refuses them (`_channel`); a form with no profile takes what it
    always took. It is recorded beside the submission in the same transaction.

    `client_submission_id` is the caller's own name for this submission. Sent
    again with the same answers it returns the first result instead of storing
    twice; see `replay`. `source_ref` is kept on its receipt for tracing only.
    """
    from app.modules.forms import geolocation

    form_json_for_location = form["form_json"] or {}
    from app.modules.forms import channels

    if client_submission_id is not None and not CLIENT_SUBMISSION_ID.match(
            str(client_submission_id)):
        raise ValidationFailed({"client_submission_id": (
            "Up to 64 letters, digits, dots, colons, underscores or hyphens.")})

    # A retry of a submission that already went through gets that submission
    # back, before anything else is asked of it. See `replay`.
    earlier = replay(form, client_submission_id, payload, channel)
    if earlier is not None:
        return earlier

    # Which channels this form is open to is part of its definition. A form with
    # no channel profile takes what it always took; see `channels.refusal`.
    refused = channels.refusal(form_json_for_location, channel)
    if refused:
        raise ValidationFailed({"_channel": refused})

    try:
        location, _ = geolocation.check(form_json_for_location, location)
    except geolocation.LocationError as exc:
        raise ValidationFailed({"_location": str(exc)})
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
    if survey_id:
        _check_media(form_json, form["form_id"], survey_id, clean)
    version = form.get("version_no") or form_json.get("version") or 1

    try:
        with transaction() as cur:
            row = _write(cur, form, form_json, table_name, clean, version,
                         created_by, parent_survey_id, location, survey_id,
                         channel, client_submission_id, source_ref, payload)
    except _AlreadyTaken:
        # Another request with this client id got there first, while this one
        # was validating. Everything this one wrote was rolled back with it; what
        # the caller gets is what the first one stored.
        earlier = replay(form, client_submission_id, payload, channel)
        if earlier is None:   # rolled back in turn — nothing to report as stored
            raise SubmissionConflict(
                f"'{client_submission_id}' is being submitted by another request. "
                "Try again.")
        return earlier
    survey_id = row["survey_id"]

    # Where this submission has got to, recorded beside it. Defensive: the
    # projects module can be switched off, and a response must still be stored.
    try:
        from app.modules.projects import submission_workflow
        submission_workflow.record_submission(
            form["form_id"], survey_id, created_by or settings.default_user)
    except Exception:
        logger.exception("Could not record the review state for %s", survey_id)

    logger.info("Stored submission %s in %s", survey_id, table_name)
    stored = {
        "survey_id": row["survey_id"],
        "created_on": row["created_on"],
        "form_id": form["form_id"],
        "form_version": version,
        "table_name": table_name,
        "parent_survey_id": parent_survey_id,
        "location": location,
    }
    if client_submission_id:
        stored.update(client_submission_id=client_submission_id, replayed=False)
    return stored


def _write(cur, form, form_json, table_name, clean, version, created_by,
           parent_survey_id, location, survey_id, channel,
           client_submission_id, source_ref, payload) -> Dict[str, Any]:
    """Everything one submission writes, on one cursor — so in one transaction.

        receipt   what the client called it, if it named it
        answers   the row in the form's own table
        mirror    the same answers, flat
        channel   how it arrived
        progress  IN_PROGRESS becomes SUBMITTED

    Any of these failing rolls every one of them back: there is never an answer
    without its receipt or its channel, and never a receipt for an answer that
    was not stored.
    """
    from app.modules.forms import ingestion

    if not table_exists(cur, table_name):
        raise FormNotFound(f"Data table '{table_name}' does not exist")

    if survey_id is None:
        survey_id = next_survey_id(cur, form["form_id"], table_name)
    else:
        # Started earlier, so it has to still be in progress: an id that was
        # never started, or has already been submitted, is not one to write
        # under. Locked so two clicks of Submit cannot both get through.
        cur.execute(
            "SELECT 1 FROM form_survey_progress WHERE form_id = %s AND survey_id = %s "
            "FOR UPDATE",
            (form["form_id"], survey_id),
        )
        if cur.fetchone() is None:
            raise ValidationFailed(
                {"_form": "This submission has already been sent, or was never "
                          "started. Open the form again."})

    if client_submission_id:
        # First, so a concurrent duplicate stops here: the primary key makes the
        # second insert wait for the first transaction, and then find the row.
        # Postgres decides, so this holds across processes and machines.
        cur.execute(
            """
            INSERT INTO submission_receipt
                (form_id, client_submission_id, survey_id, channel, source_ref,
                 request_hash)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (form_id, client_submission_id) DO NOTHING
            RETURNING survey_id
            """,
            (form["form_id"], client_submission_id, survey_id, channel,
             (source_ref or "")[:200], request_hash(payload)),
        )
        if cur.fetchone() is None:
            raise _AlreadyTaken()

    columns = ["survey_id", "form_id", "form_data", "form_version", "created_by"]
    values = [survey_id, form["form_id"], Json(clean), version,
              created_by or settings.default_user]

    # Only a child form has the column, so an independent form's INSERT is
    # the statement it always was.
    if parent_survey_id:
        columns.append(PARENT_COLUMN)
        values.append(parent_survey_id)

    if location:
        columns.append(LOCATION_COLUMN)
        values.append(Json(location))

    cur.execute(
        sql.SQL("INSERT INTO {}.{} ({}) VALUES ({}) RETURNING survey_id, created_on")
        .format(
            sql.Identifier(settings.db_schema),
            sql.Identifier(table_name),
            sql.SQL(", ").join(sql.Identifier(c) for c in columns),
            sql.SQL(", ").join(sql.Placeholder() * len(columns)),
        ),
        values,
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

    # IN_PROGRESS becomes SUBMITTED: the row moves out of the progress table
    # and into the form's own, in one transaction, so a survey is never both
    # and never neither.
    cur.execute(
        "DELETE FROM form_survey_progress WHERE form_id = %s AND survey_id = %s",
        (form["form_id"], survey_id),
    )

    # How it arrived, in the same transaction as what arrived: a submission is
    # never stored without its channel, and a channel never recorded for a
    # submission that was rolled back.
    ingestion.record_channel(form["form_id"], survey_id, channel, cur=cur)

    return row


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
                SELECT survey_id, form_data, created_on, form_version, created_by{}
                FROM {} WHERE form_id = %s
                ORDER BY created_on DESC, survey_id DESC
                LIMIT %s OFFSET %s
                """
            ).format(_parent_select(cur, table_name), qualified),
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
                SELECT survey_id, form_data, created_on, form_version, created_by{}
                FROM {}.{} WHERE form_id = %s AND survey_id = %s
                """
            ).format(_parent_select(cur, table_name),
                     sql.Identifier(settings.db_schema), sql.Identifier(table_name)),
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


def _parent_select(cur, table_name: str) -> sql.SQL:
    """The optional envelope columns this table actually has.

    `parent_survey_id` for a child form, `location` for a form that records
    where it was filled in — neither is on a table that did not ask for it.

    Read from the table rather than from the definition: a form marked as a
    child a moment ago and not yet saved would otherwise make every read of it
    fail on a column that is not there.
    """
    from app.modules.forms.form_schema import LOCATION_COLUMN, PARENT_COLUMN

    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s AND column_name = ANY(%s)",
        (settings.db_schema, table_name, [PARENT_COLUMN, LOCATION_COLUMN]),
    )
    present = [row["column_name"] for row in cur.fetchall()]
    if not present:
        return sql.SQL("")

    return sql.SQL(", ") + sql.SQL(", ").join(
        sql.Identifier(name) for name in sorted(present))


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
