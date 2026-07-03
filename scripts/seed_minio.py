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
  uv run scripts/seed_minio.py --fixture path/to/scan.pdf [--ocr-job-id <ulid>]
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import boto3
from botocore.client import Config

if TYPE_CHECKING:
    from mypy_boto3_s3.client import S3Client

logger = logging.getLogger("seed_minio")


def make_client() -> S3Client:
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("S3_ENDPOINT", "http://localhost:9000"),
        region_name=os.environ.get("S3_REGION", "auto"),
        aws_access_key_id=os.environ.get("S3_ACCESS_KEY_ID", "minioadmin"),
        aws_secret_access_key=os.environ.get("S3_SECRET_ACCESS_KEY", "minioadmin"),
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def ensure_bucket(client: S3Client, bucket: str) -> None:
    existing = {b["Name"] for b in client.list_buckets().get("Buckets", [])}
    if bucket in existing:
        logger.info("bucket %r already exists", bucket)
        return
    client.create_bucket(Bucket=bucket)
    logger.info("created bucket %r", bucket)


def upload_fixture(client: S3Client, bucket: str, fixture: Path, ocr_job_id: str | None) -> None:
    ocr_job = ocr_job_id or fixture.stem
    key = f"ocr-jobs/{ocr_job}/upload.pdf"
    client.upload_file(str(fixture), bucket, key, ExtraArgs={"ContentType": "application/pdf"})
    logger.info("uploaded %s → s3://%s/%s", fixture, bucket, key)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, help="optional PDF to seed")
    parser.add_argument("--ocr-job-id", help="ocr job id to use for the fixture key")
    args = parser.parse_args()

    bucket = os.environ.get("S3_BUCKET", "totvibe")
    client = make_client()
    ensure_bucket(client, bucket)

    if args.fixture:
        if not args.fixture.exists():
            logger.error("fixture not found: %s", args.fixture)
            return 1
        upload_fixture(client, bucket, args.fixture, args.ocr_job_id)

    return 0


if __name__ == "__main__":
    sys.exit(main())
