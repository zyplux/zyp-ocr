from __future__ import annotations

import aioboto3

from .config import Settings


def make_session() -> aioboto3.Session:
    return aioboto3.Session()


def s3_client(session: aioboto3.Session, settings: Settings):
    return session.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        region_name=settings.s3_region,
        aws_access_key_id=settings.s3_access_key_id,
        aws_secret_access_key=settings.s3_secret_access_key,
    )


def upload_key(ocr_job_id: str) -> str:
    return f"ocr-jobs/{ocr_job_id}/upload.pdf"


def md_page_key(ocr_job_id: str, page_number: int) -> str:
    return f"ocr-jobs/{ocr_job_id}/md-pages/{page_number}.md"
