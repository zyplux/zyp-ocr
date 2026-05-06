"""glmocr SDK wrapper. Imported only by the real-pipeline path; --mock skips this module."""

from __future__ import annotations

from collections.abc import AsyncIterator

from .schemas import PipelineCallback


async def run_ocr(_pdf_path: str, _job_id: str) -> AsyncIterator[PipelineCallback]:
    """Run glmocr page-by-page and yield per-page completion records."""
    raise NotImplementedError
    if False:  # pragma: no cover
        yield  # type: ignore[misc]
