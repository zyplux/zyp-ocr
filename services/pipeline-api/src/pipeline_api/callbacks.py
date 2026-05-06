from __future__ import annotations

import httpx

from .schemas import PipelineCallback


async def post_callback(
    callback_url: str,
    callback_token: str,
    payload: PipelineCallback,
) -> None:
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(
            callback_url,
            json=payload.model_dump(exclude_none=True),
            headers={"x-callback-token": callback_token},
        )
        response.raise_for_status()
