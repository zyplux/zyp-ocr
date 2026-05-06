"""Cross-language contract: source of truth for callback + submission shapes.

Generated TS Zod schemas live at apps/web/src/contracts.ts (run `just codegen`).

Note: no `from __future__ import annotations` — annotations must evaluate at
runtime so Pydantic's JSON-Schema export resolves Literal[...] for codegen.
"""

from typing import Literal

from pydantic import BaseModel


class PipelineSubmission(BaseModel):
    job_id: str
    source_key: str
    callback_url: str
    callback_token: str


class PipelineSubmissionAck(BaseModel):
    pipeline_id: str


class PipelineCallback(BaseModel):
    callback_id: str
    job_id: str
    page_number: int | None = None
    status: Literal["done", "failed"]
    markdown_key: str | None = None
    error: str | None = None


class HealthCheck(BaseModel):
    status: Literal["ok"]
