from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from .persistence import open_db
from .routes import router
from .schemas import HealthCheck


def _ensure_state_dir() -> Path:
    state_dir = Path(os.environ.get("PIPELINE_STATE_DIR", "/var/lib/pipeline"))
    state_dir.mkdir(parents=True, exist_ok=True)
    return state_dir


@asynccontextmanager
async def lifespan(app: FastAPI):
    state_dir = await asyncio.to_thread(_ensure_state_dir)
    db = await open_db(str(state_dir / "pipeline.sqlite"))
    app.state.db = db
    try:
        yield
    finally:
        await db.close()


def create_app() -> FastAPI:
    app = FastAPI(title="totvibe-ocr pipeline-api", lifespan=lifespan)
    app.include_router(router)

    @app.get("/healthz", response_model=HealthCheck)
    async def healthz() -> HealthCheck:
        return HealthCheck(status="ok")

    return app


app = create_app()
