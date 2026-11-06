"""S3 storage service for Research Platforms and Trials media assets."""
import logging
import re
import uuid
from typing import Any, Dict, Optional

import boto3
from botocore.config import Config

from app.core.config import settings

logger = logging.getLogger(__name__)


def safe_filename(name: str) -> str:
    """Sanitize filename to prevent S3 key traversal or invalid characters."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(name or "").strip())
    cleaned = re.sub(r"\.{2,}", ".", cleaned).strip("._-")[-120:]
    return cleaned or "file"


def get_s3_client():
    """Build and return an authenticated boto3 S3 client using application settings."""
    if not settings.aws_s3_bucket:
        raise RuntimeError("AWS_S3_BUCKET is not configured in environment.")

    keys = {}
    if settings.aws_access_key_id and settings.aws_secret_access_key:
        keys = {
            "aws_access_key_id": settings.aws_access_key_id,
            "aws_secret_access_key": settings.aws_secret_access_key,
        }

    return boto3.client(
        "s3",
        region_name=settings.aws_region or "ap-south-1",
        config=Config(
            signature_version="s3v4",
            region_name=settings.aws_region or "ap-south-1",
            s3={"addressing_style": "virtual"},
        ),
        **keys,
    )


def upload_file_to_s3(
    file_bytes: bytes,
    filename: str,
    content_type: str,
    category: str = "photos",
) -> Dict[str, Any]:
    """Upload binary file directly to AWS S3 and return key + presigned download URL."""
    client = get_s3_client()
    clean_name = safe_filename(filename)
    unique_id = uuid.uuid4().hex[:12]
    category_slug = safe_filename(category) or "photos"
    key = f"research/trials/{category_slug}/{unique_id}_{clean_name}"

    client.put_object(
        Bucket=settings.aws_s3_bucket,
        Key=key,
        Body=file_bytes,
        ContentType=content_type or "application/octet-stream",
    )

    url = generate_presigned_download_url(key)
    return {
        "s3_key": key,
        "url": url,
        "name": filename,
        "content_type": content_type,
        "size": len(file_bytes),
    }


def generate_presigned_download_url(key: str, expires_in: int = 86400 * 7) -> str:
    """Generate a presigned GET URL valid for up to 7 days."""
    client = get_s3_client()
    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.aws_s3_bucket, "Key": key},
        ExpiresIn=expires_in,
    )


def refresh_trial_media_urls(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Inspect trial payload and ensure all S3 media have fresh presigned download URLs."""
    if not isinstance(payload, dict):
        return payload

    try:
        # 1. Layout Sketch
        sketch = payload.get("layout_sketch")
        if isinstance(sketch, dict) and sketch.get("s3_key"):
            sketch["url"] = generate_presigned_download_url(sketch["s3_key"])

        # 2. Photos list
        photos = payload.get("photos")
        if isinstance(photos, list):
            for photo in photos:
                if isinstance(photo, dict) and photo.get("s3_key"):
                    photo["url"] = generate_presigned_download_url(photo["s3_key"])
    except Exception as exc:
        logger.warning(f"Could not refresh presigned S3 URLs for trial: {exc}")

    return payload
