"""Mock pipeline: same HTTP surface as the real service, canned per-page callbacks.

Activated by `python -m pipeline_api --mock`. Does NOT import glmocr/paddle so it
runs without a GPU and inside a slimmer container image (the `mock` Containerfile target).
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import APIRouter, BackgroundTasks, FastAPI
from ulid import ULID

from .callbacks import post_callback
from .schemas import (
    HealthCheck,
    PipelineCallback,
    PipelineSubmission,
    PipelineSubmissionAck,
)

DEFAULT_PAGE_DELAY_SECONDS = float(os.environ.get("MOCK_PAGE_DELAY_SECONDS", "0.5"))
DEFAULT_TOTAL_PAGES = int(os.environ.get("MOCK_TOTAL_PAGES", "3"))


async def _emit_canned_callbacks(submission: PipelineSubmission) -> None:
    for page_number in range(1, DEFAULT_TOTAL_PAGES + 1):
        await asyncio.sleep(DEFAULT_PAGE_DELAY_SECONDS)
        await post_callback(
            submission.callback_url,
            submission.callback_token,
            PipelineCallback(
                callback_id=str(ULID()),
                ocr_job_id=submission.ocr_job_id,
                page_number=page_number,
                status="done",
                markdown_key=f"ocr-jobs/{submission.ocr_job_id}/md-pages/{page_number}.md",
            ),
        )
    await post_callback(
        submission.callback_url,
        submission.callback_token,
        PipelineCallback(
            callback_id=str(ULID()),
            ocr_job_id=submission.ocr_job_id,
            status="done",
        ),
    )


def make_router() -> APIRouter:
    router = APIRouter()

    @router.post("/submit", response_model=PipelineSubmissionAck)
    async def submit(
        payload: PipelineSubmission,
        background: BackgroundTasks,
    ) -> PipelineSubmissionAck:
        pipeline_id = str(ULID())
        background.add_task(_emit_canned_callbacks, payload)
        return PipelineSubmissionAck(pipeline_id=pipeline_id)

    @router.get("/ocr-jobs/{pipeline_id}")
    async def get_ocr_job(pipeline_id: str) -> dict[str, str]:
        return {"pipeline_id": pipeline_id, "status": "processing"}

    return router


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="totvibe-ocr pipeline-api (mock)", lifespan=lifespan)
    app.include_router(make_router())

    @app.get("/healthz", response_model=HealthCheck)
    async def healthz() -> HealthCheck:
        return HealthCheck(status="ok")

    return app


app = create_app()
