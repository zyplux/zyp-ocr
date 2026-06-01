from __future__ import annotations

import httpx

from .schemas import TranscriptionResult


async def post_result(
    result_url: str,
    result_token: str,
    payload: TranscriptionResult,
) -> None:
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(
            result_url,
            json=payload.model_dump(exclude_none=True),
            headers={"x-result-token": result_token},
        )
        response.raise_for_status()
