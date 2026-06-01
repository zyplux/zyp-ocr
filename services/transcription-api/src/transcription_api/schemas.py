"""Cross-language contract: source of truth for transcription submission + result shapes.

Generated TS Zod schemas live at apps/web/src/contracts.ts (run `just codegen`).

Note: no `from __future__ import annotations` — annotations must evaluate at
runtime so Pydantic's JSON-Schema export resolves Literal[...] for codegen.
"""

from typing import Literal

from pydantic import BaseModel


class TranscriptionSubmission(BaseModel):
    ocr_job_id: str
    upload_key: str
    result_url: str
    result_token: str


class TranscriptionSubmissionAck(BaseModel):
    pipeline_id: str


class TranscriptionResult(BaseModel):
    result_id: str
    ocr_job_id: str
    page_number: int | None = None
    status: Literal["done", "failed"]
    markdown_key: str | None = None
    error: str | None = None


class HealthCheck(BaseModel):
    status: Literal["ok"]
