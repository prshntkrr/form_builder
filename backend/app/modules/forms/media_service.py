"""The images, recordings and documents a form collects.

The bytes go to S3; Postgres keeps a row saying what and where. Nothing binary
is ever written to `form_data`, and no browser is ever given a credential — it
is handed a presigned URL that is good for one object, one method, and a few
minutes.

    ask for a link   POST .../media/upload-url   → a presigned PUT, and a media_id
    upload           the browser PUTs to S3 directly
    say it landed    POST .../media/{id}/complete
    read it back     GET  .../media/{id}/url     → a presigned GET

The object key carries the ids of everything the object belongs to:

    projects/{project_id}/forms/{form_id}/{survey_id}/{media_type}/{filename}

ids, never names — a project renamed tomorrow does not strip a bucket of its
history. A form outside every project is filed under `system/` instead, so the
system and project halves stay as separate in the bucket as they are everywhere
else.
"""
import logging
import re
import uuid
from typing import Any, Dict, List, Optional

from app.core.config import settings
from app.core.database import transaction

logger = logging.getLogger(__name__)


class MediaError(ValueError):
    """The upload cannot be accepted as asked."""


class StorageUnavailable(RuntimeError):
    """No bucket is configured, so there is nowhere to put anything."""


# The three kinds of media a field can ask for, and what a browser may send for
# each. Deliberately a short list: an installation that needs another type adds
# it here, and anything not named is refused.
ALLOWED_TYPES: Dict[str, List[str]] = {
    "image": ["image/jpeg", "image/png", "image/webp", "image/heic"],
    "audio": ["audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/mp4"],
    "file": ["application/pdf",
             "application/msword",
             "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
             "application/vnd.ms-excel",
             "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
             "text/csv", "text/plain"],
}

MEDIA_TYPES = tuple(ALLOWED_TYPES)


def is_media_field(field: Any) -> bool:
    return isinstance(field, dict) and field.get("type") in MEDIA_TYPES


def field_media_type(form_json: Dict[str, Any], field_name: str) -> Optional[str]:
    """The kind of media one field asks for, or None if it asks for none."""
    for field in (form_json or {}).get("fields") or []:
        if isinstance(field, dict) and field.get("name") == field_name:
            kind = field.get("type")
            return kind if kind in MEDIA_TYPES else None
    return None


def safe_filename(name: str) -> str:
    """A filename that cannot climb out of its folder or confuse a key.

    Everything but letters, digits, dot, dash and underscore becomes an
    underscore, and the result can never be empty or start with a dot.
    """
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(name or "").strip())
    # A run of dots cannot traverse an S3 key — there is no separator left to
    # traverse with — but a bucket synced to a filesystem is a different matter,
    # and `..` in a name is never what anybody meant.
    cleaned = re.sub(r"\.{2,}", ".", cleaned).strip("._-")[-120:]
    return cleaned or "upload"


def object_key(project_id: Optional[str], form_id: str, survey_id: str,
               media_type: str, filename: str) -> str:
    """Where in the bucket one object lives.

    ids only. A form belonging to no project is filed under `system/`, which
    keeps the two halves of the application as separate in the bucket as they
    are in the database.
    """
    root = f"projects/{project_id}" if project_id else "system"
    return f"{root}/forms/{form_id}/{survey_id}/{media_type}/{safe_filename(filename)}"


# --------------------------------------------------------------------------- #
# S3
# --------------------------------------------------------------------------- #
def _client():
    """A boto3 S3 client, or a refusal that says what is missing.

    Credentials are only passed when the settings carry them; otherwise boto3
    uses its own chain — an instance role, a profile, the environment — which is
    how a deployed server should be doing it.
    """
    if not settings.aws_s3_bucket:
        raise StorageUnavailable(
            "No S3 bucket is configured, so this installation cannot store "
            "uploads. Set AWS_S3_BUCKET."
        )

    import boto3
    from botocore.config import Config

    keys = {}
    if settings.aws_access_key_id and settings.aws_secret_access_key:
        keys = {"aws_access_key_id": settings.aws_access_key_id,
                "aws_secret_access_key": settings.aws_secret_access_key}

    # Signature Version 4, explicitly. Left to itself in us-east-1 botocore will
    # sign with the legacy v2 scheme, which produces a URL carrying
    # `AWSAccessKeyId`/`Signature`/`Expires` — refused outright by buckets in
    # newer regions and by any bucket with KMS encryption or a policy requiring
    # v4. Naming it here means every region signs the same way.
    return boto3.client(
        "s3",
        region_name=settings.aws_region,
        config=Config(
            signature_version="s3v4",
            region_name=settings.aws_region,
            # Virtual addressing, so the URL is signed for the bucket's own
            # regional host — `bucket.s3.<region>.amazonaws.com`. Left to
            # itself botocore signs against the global `s3.amazonaws.com`,
            # which answers a PUT with a 307 to the regional host: harmless to
            # a CLI that follows redirects, fatal to a browser, which reports
            # it as "Failed to fetch".
            s3={"addressing_style": "virtual"},
        ),
        **keys,
    )


def presign_upload(key: str, content_type: str) -> str:
    """A URL the browser may PUT one object to, and nothing else."""
    return _client().generate_presigned_url(
        "put_object",
        Params={"Bucket": settings.aws_s3_bucket, "Key": key,
                "ContentType": content_type},
        ExpiresIn=settings.s3_url_seconds,
    )


def presign_download(key: str, filename: str = "") -> str:
    """A URL good for reading one object for a few minutes."""
    params = {"Bucket": settings.aws_s3_bucket, "Key": key}
    if filename:
        params["ResponseContentDisposition"] = (
            f'inline; filename="{safe_filename(filename)}"')

    return _client().generate_presigned_url(
        "get_object", Params=params, ExpiresIn=settings.s3_url_seconds)


# --------------------------------------------------------------------------- #
# what a field will accept
# --------------------------------------------------------------------------- #
def check_upload(form_json: Dict[str, Any], field_name: str,
                 content_type: str, size: Optional[int] = None) -> str:
    """Whether this form will take this upload for this field. Returns the kind.

    Every one of these is checked here rather than in the browser, because the
    browser is only where the request is composed:

        the field exists on this form
        it is a media field
        the content type is one that kind accepts
        the object is not larger than this installation allows
    """
    media_type = field_media_type(form_json, field_name)

    if media_type is None:
        known = {f.get("name") for f in (form_json or {}).get("fields") or []}
        if field_name in known:
            raise MediaError(f"'{field_name}' does not take an upload.")
        raise MediaError(f"This form has no question called '{field_name}'.")

    allowed = ALLOWED_TYPES[media_type]
    if (content_type or "").split(";")[0].strip().lower() not in allowed:
        raise MediaError(
            f"'{content_type}' is not something this question accepts. "
            f"It takes: {', '.join(allowed)}."
        )

    if size is not None and size > settings.media_max_mb * 1024 * 1024:
        raise MediaError(f"That file is larger than {settings.media_max_mb} MB.")

    return media_type


# --------------------------------------------------------------------------- #
# the rows
# --------------------------------------------------------------------------- #
def start_upload(project_id: Optional[str], form_id: str, survey_id: str,
                 field_name: str, media_type: str, filename: str,
                 content_type: str, created_by: str = "") -> Dict[str, Any]:
    """Record an upload about to happen, and say where it should go.

    The row exists before the object does, so a browser that never finishes
    leaves something to find rather than an orphan in the bucket. It is not
    served until `finish_upload` marks it arrived.
    """
    media_id = f"MED{uuid.uuid4().hex[:16]}"
    key = object_key(project_id, form_id, survey_id, media_type, filename)

    with transaction() as cur:
        cur.execute(
            """
            INSERT INTO form_media
                (media_id, project_id, form_id, survey_id, field_name,
                 media_type, s3_key, original_filename, content_type, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (media_id, project_id, form_id, survey_id, field_name, media_type,
             key, safe_filename(filename), content_type, created_by),
        )

    return {"media_id": media_id, "s3_key": key}


def finish_upload(media_id: str, file_size: Optional[int] = None) -> Dict[str, Any]:
    """Mark an upload as arrived, so it can be read back."""
    with transaction() as cur:
        cur.execute(
            "UPDATE form_media SET uploaded_on = CURRENT_TIMESTAMP, "
            "file_size = COALESCE(%s, file_size) WHERE media_id = %s RETURNING *",
            (file_size, media_id),
        )
        row = cur.fetchone()

    if row is None:
        raise MediaError(f"No upload '{media_id}'.")
    return dict(row)


def get(media_id: str) -> Optional[Dict[str, Any]]:
    with transaction() as cur:
        cur.execute("SELECT * FROM form_media WHERE media_id = %s", (media_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def summary(row: Dict[str, Any]) -> Dict[str, Any]:
    """What a screen needs to show one upload without downloading it.

    The `s3_key` is deliberately not in here: a browser has no use for it, and
    a key is the one part of this that hints at how the bucket is laid out.
    Reading a file is `GET .../media/{id}/url`, which authorizes first.
    """
    return {
        "media_id": row["media_id"],
        "field_name": row["field_name"],
        "media_type": row["media_type"],
        "filename": row["original_filename"],
        "content_type": row["content_type"],
        "size": row["file_size"],
    }


def for_submissions(form_id: str, survey_ids: List[str]) -> Dict[str, Dict[str, List[Dict[str, Any]]]]:
    """Everything that arrived for a page of submissions, by survey and field.

    One query for the whole page rather than one per row: a table of fifty
    records with a photo each should cost the same as a table of fifty records
    without one.
    """
    if not survey_ids:
        return {}

    with transaction() as cur:
        cur.execute(
            "SELECT * FROM form_media "
            "WHERE form_id = %s AND survey_id = ANY(%s) AND uploaded_on IS NOT NULL "
            "ORDER BY created_on",
            (form_id, list(survey_ids)),
        )
        rows = cur.fetchall()

    found: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
    for row in rows:
        by_field = found.setdefault(row["survey_id"], {})
        by_field.setdefault(row["field_name"], []).append(summary(row))
    return found


def for_submission(form_id: str, survey_id: str) -> List[Dict[str, Any]]:
    """Everything that arrived for one submission."""
    with transaction() as cur:
        cur.execute(
            "SELECT * FROM form_media "
            "WHERE form_id = %s AND survey_id = %s AND uploaded_on IS NOT NULL "
            "ORDER BY created_on",
            (form_id, survey_id),
        )
        return [dict(row) for row in cur.fetchall()]
