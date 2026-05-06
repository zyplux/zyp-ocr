from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Settings:
    public_base: str
    s3_endpoint: str
    s3_region: str
    s3_bucket: str
    s3_access_key_id: str
    s3_secret_access_key: str
    vllm_base: str
    vllm_model: str
    callback_hmac_secret: str
    pipeline_state_dir: str

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            public_base=os.environ.get("PUBLIC_BASE", "http://web:8787"),
            s3_endpoint=os.environ.get("S3_ENDPOINT", "http://minio:9000"),
            s3_region=os.environ.get("S3_REGION", "auto"),
            s3_bucket=os.environ.get("S3_BUCKET", "totvibe"),
            s3_access_key_id=os.environ.get("S3_ACCESS_KEY_ID", "minioadmin"),
            s3_secret_access_key=os.environ.get("S3_SECRET_ACCESS_KEY", "minioadmin"),
            vllm_base=os.environ.get("VLLM_BASE", "http://vllm:8080"),
            vllm_model=os.environ.get("VLLM_MODEL", "zai-org/GLM-OCR"),
            callback_hmac_secret=os.environ["CALLBACK_HMAC_SECRET"],
            pipeline_state_dir=os.environ.get("PIPELINE_STATE_DIR", "/var/lib/pipeline"),
        )
