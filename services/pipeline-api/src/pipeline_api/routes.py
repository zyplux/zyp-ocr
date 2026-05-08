from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from ulid import ULID

from .callbacks import post_callback
from .schemas import PipelineCallback, PipelineSubmission, PipelineSubmissionAck

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/submit", response_model=PipelineSubmissionAck)
async def submit(
    payload: PipelineSubmission,
    background: BackgroundTasks,
    request: Request,
) -> PipelineSubmissionAck:
    pipeline_id = str(ULID())
    db = request.app.state.db
    await db.execute(
        """
        INSERT INTO pipeline_ocr_jobs (
          pipeline_id, ocr_job_id, upload_key, callback_url, callback_token,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'processing', ?)
        """,
        (
            pipeline_id,
            payload.ocr_job_id,
            payload.upload_key,
            payload.callback_url,
            payload.callback_token,
            int(time.time()),
        ),
    )
    await db.commit()
    background.add_task(_run_ocr_job, payload, pipeline_id, db)
    return PipelineSubmissionAck(pipeline_id=pipeline_id)


@router.get("/ocr-jobs/{pipeline_id}")
async def get_ocr_job(pipeline_id: str, request: Request) -> dict[str, str]:
    db = request.app.state.db
    cursor = await db.execute(
        "SELECT ocr_job_id, status FROM pipeline_ocr_jobs WHERE pipeline_id = ?",
        (pipeline_id,),
    )
    row = await cursor.fetchone()
    await cursor.close()
    if row is None:
        raise HTTPException(status_code=404, detail="unknown pipeline_id")
    return {"pipeline_id": pipeline_id, "ocr_job_id": row[0], "status": row[1]}


async def _run_ocr_job(submission: PipelineSubmission, pipeline_id: str, db) -> None:
    try:
        from .ocr import run_ocr  # imported lazily so --mock images can skip torch

        async for callback in _ocr_with_fallback(run_ocr, submission):
            await post_callback(submission.callback_url, submission.callback_token, callback)
        await post_callback(
            submission.callback_url,
            submission.callback_token,
            PipelineCallback(
                callback_id=str(ULID()),
                ocr_job_id=submission.ocr_job_id,
                status="done",
            ),
        )
        await db.execute(
            "UPDATE pipeline_ocr_jobs SET status='done', completed_at=? WHERE pipeline_id=?",
            (int(time.time()), pipeline_id),
        )
    except Exception as exc:
        logger.exception("pipeline ocr job %s failed", pipeline_id)
        await post_callback(
            submission.callback_url,
            submission.callback_token,
            PipelineCallback(
                callback_id=str(ULID()),
                ocr_job_id=submission.ocr_job_id,
                status="failed",
                error=str(exc),
            ),
        )
        await db.execute(
            "UPDATE pipeline_ocr_jobs SET status='failed', completed_at=? WHERE pipeline_id=?",
            (int(time.time()), pipeline_id),
        )
    finally:
        await db.commit()


async def _ocr_with_fallback(
    runner, submission: PipelineSubmission
) -> AsyncIterator[PipelineCallback]:
    try:
        async for cb in runner(submission.upload_key, submission.ocr_job_id):
            yield cb
    except NotImplementedError:
        # Real OCR stack isn't wired yet (no GPU image / no glmocr install).
        # Emit a single failed page so the worker doesn't hang on the alarm.
        await asyncio.sleep(0)
        yield PipelineCallback(
            callback_id=str(ULID()),
            ocr_job_id=submission.ocr_job_id,
            page_number=1,
            status="failed",
            error="real OCR pipeline not wired yet — use --mock for v0.1 dev loop",
        )
