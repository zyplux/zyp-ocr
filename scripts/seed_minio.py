# /// script
# requires-python = ">=3.14"
# dependencies = [
#   "boto3>=1.40.0",
# ]
# ///
"""Create the MinIO bucket and (optionally) drop fixture PDFs into it.

Reads connection info from env (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID,
S3_SECRET_ACCESS_KEY) — defaults match the dev compose stack.

Usage:
  uv run scripts/seed_minio.py
  uv run scripts/seed_minio.py --fixture path/to/scan.pdf [--job-id <ulid>]
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import boto3
from botocore.client import Config


def make_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("S3_ENDPOINT", "http://localhost:9000"),
        region_name=os.environ.get("S3_REGION", "auto"),
        aws_access_key_id=os.environ.get("S3_ACCESS_KEY_ID", "minioadmin"),
        aws_secret_access_key=os.environ.get("S3_SECRET_ACCESS_KEY", "minioadmin"),
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def ensure_bucket(client, bucket: str) -> None:
    existing = {b["Name"] for b in client.list_buckets().get("Buckets", [])}
    if bucket in existing:
        print(f"bucket {bucket!r} already exists")
        return
    client.create_bucket(Bucket=bucket)
    print(f"created bucket {bucket!r}")


def upload_fixture(client, bucket: str, fixture: Path, job_id: str | None) -> None:
    job = job_id or fixture.stem
    key = f"jobs/{job}/source.pdf"
    client.upload_file(str(fixture), bucket, key, ExtraArgs={"ContentType": "application/pdf"})
    print(f"uploaded {fixture} → s3://{bucket}/{key}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, help="optional PDF to seed")
    parser.add_argument("--job-id", help="job id to use for the fixture key")
    args = parser.parse_args()

    bucket = os.environ.get("S3_BUCKET", "totvibe")
    client = make_client()
    ensure_bucket(client, bucket)

    if args.fixture:
        if not args.fixture.exists():
            print(f"fixture not found: {args.fixture}", file=sys.stderr)
            return 1
        upload_fixture(client, bucket, args.fixture, args.job_id)

    return 0


if __name__ == "__main__":
    sys.exit(main())
