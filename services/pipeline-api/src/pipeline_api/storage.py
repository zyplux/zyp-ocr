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


def source_key(job_id: str) -> str:
    return f"jobs/{job_id}/source.pdf"


def page_key(job_id: str, page_number: int) -> str:
    return f"jobs/{job_id}/pages/{page_number}.md"
