"""glmocr SDK wrapper. Imported only by the real-pipeline path; --mock skips this module."""

from __future__ import annotations

from collections.abc import AsyncIterator

from .schemas import TranscriptionResult


async def run_ocr(_pdf_path: str, _ocr_job_id: str) -> AsyncIterator[TranscriptionResult]:
    """Run glmocr page-by-page and yield per-page completion records."""
    raise NotImplementedError
    if False:  # pragma: no cover
        yield  # type: ignore[misc]
