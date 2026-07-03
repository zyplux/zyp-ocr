from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from ulid import ULID

from .ocr import run_ocr
from .results import post_result
from .schemas import TranscriptionResult, TranscriptionSubmission, TranscriptionSubmissionAck

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Callable

    import aiosqlite

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/submit", response_model=TranscriptionSubmissionAck)
async def submit(
    payload: TranscriptionSubmission,
    background: BackgroundTasks,
    request: Request,
) -> TranscriptionSubmissionAck:
    pipeline_id = str(ULID())
    db = request.app.state.db
    await db.execute(
        """
        INSERT INTO transcription_ocr_jobs (
          pipeline_id, ocr_job_id, upload_key, result_url, result_token,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'processing', ?)
        """,
        (
            pipeline_id,
            payload.ocr_job_id,
            payload.upload_key,
            payload.result_url,
            payload.result_token,
            int(time.time()),
        ),
    )
    await db.commit()
    background.add_task(_run_ocr_job, payload, pipeline_id, db)
    return TranscriptionSubmissionAck(pipeline_id=pipeline_id)


@router.get("/ocr-jobs/{pipeline_id}")
async def get_ocr_job(pipeline_id: str, request: Request) -> dict[str, str]:
    db = request.app.state.db
    cursor = await db.execute(
        "SELECT ocr_job_id, status FROM transcription_ocr_jobs WHERE pipeline_id = ?",
        (pipeline_id,),
    )
    row = await cursor.fetchone()
    await cursor.close()
    if row is None:
        raise HTTPException(status_code=404, detail="unknown pipeline_id")
    return {"pipeline_id": pipeline_id, "ocr_job_id": row[0], "status": row[1]}


async def _run_ocr_job(submission: TranscriptionSubmission, pipeline_id: str, db: aiosqlite.Connection) -> None:
    try:
        async for result in _ocr_with_fallback(run_ocr, submission):
            await post_result(submission.result_url, submission.result_token, result)
        await post_result(
            submission.result_url,
            submission.result_token,
            TranscriptionResult(
                result_id=str(ULID()),
                ocr_job_id=submission.ocr_job_id,
                status="done",
            ),
        )
        await db.execute(
            "UPDATE transcription_ocr_jobs SET status='done', completed_at=? WHERE pipeline_id=?",
            (int(time.time()), pipeline_id),
        )
    except Exception as exc:
        logger.exception("transcription ocr job %s failed", pipeline_id)
        await post_result(
            submission.result_url,
            submission.result_token,
            TranscriptionResult(
                result_id=str(ULID()),
                ocr_job_id=submission.ocr_job_id,
                status="failed",
                error=str(exc),
            ),
        )
        await db.execute(
            "UPDATE transcription_ocr_jobs SET status='failed', completed_at=? WHERE pipeline_id=?",
            (int(time.time()), pipeline_id),
        )
    finally:
        await db.commit()


async def _ocr_with_fallback(
    runner: Callable[[str, str], AsyncIterator[TranscriptionResult]],
    submission: TranscriptionSubmission,
) -> AsyncIterator[TranscriptionResult]:
    try:
        async for result in runner(submission.upload_key, submission.ocr_job_id):
            yield result
    except NotImplementedError:
        # Real OCR stack isn't wired yet (no GPU image / no glmocr install).
        # Emit a single failed page so the worker doesn't hang on the alarm.
        await asyncio.sleep(0)
        yield TranscriptionResult(
            result_id=str(ULID()),
            ocr_job_id=submission.ocr_job_id,
            page_number=1,
            status="failed",
            error="real OCR pipeline not wired yet — use --mock for v0.1 dev loop",
        )
