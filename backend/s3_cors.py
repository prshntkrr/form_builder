"""Let the browser upload to the bucket.

The browser PUTs its photo straight to S3, which is a cross-origin request: S3
has to say the app's origin is allowed, or the upload fails before it is sent
and the page reports nothing more useful than "Failed to fetch".

The origins come from CORS_ORIGINS — the same list the API itself allows — so
there is one place to add the production site to, not two. Run this once per
bucket, and again whenever that list changes:

    python s3_cors.py            # show what the bucket allows now
    python s3_cors.py --apply    # make it match CORS_ORIGINS
"""
import json
import sys

import boto3
from botocore.exceptions import ClientError

from app.core.config import settings


def rules():
    return [{
        "AllowedOrigins": settings.cors_origin_list,
        # PUT to upload, GET/HEAD to read one back through a signed link.
        "AllowedMethods": ["PUT", "GET", "HEAD"],
        # The one header the upload sends, and the one the browser reads back.
        "AllowedHeaders": ["content-type"],
        "ExposeHeaders": ["ETag"],
        "MaxAgeSeconds": 3000,
    }]


def main():
    if not settings.aws_s3_bucket:
        sys.exit("No AWS_S3_BUCKET is configured.")

    s3 = boto3.client("s3", region_name=settings.aws_region)
    print(f"bucket {settings.aws_s3_bucket} · region {settings.aws_region}")

    try:
        current = s3.get_bucket_cors(Bucket=settings.aws_s3_bucket)["CORSRules"]
        print("currently allows:", json.dumps(current, indent=2))
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "NoSuchCORSConfiguration":
            raise
        print("currently allows: nothing — every browser upload will fail")

    if "--apply" not in sys.argv:
        print("\nwould apply:", json.dumps(rules(), indent=2))
        print("\nRun with --apply to set it.")
        return

    s3.put_bucket_cors(Bucket=settings.aws_s3_bucket,
                       CORSConfiguration={"CORSRules": rules()})
    print("\napplied:", json.dumps(rules(), indent=2))


if __name__ == "__main__":
    main()
