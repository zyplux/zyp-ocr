from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .schemas import PipelineSubmission, PipelineSubmissionAck

router = APIRouter()


@router.post("/submit", response_model=PipelineSubmissionAck)
async def submit(_payload: PipelineSubmission) -> PipelineSubmissionAck:
    raise HTTPException(status_code=501, detail="not implemented")


@router.get("/jobs/{pipeline_id}")
async def get_job(_pipeline_id: str) -> dict[str, str]:
    raise HTTPException(status_code=501, detail="not implemented")
