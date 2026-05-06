from __future__ import annotations

from fastapi import FastAPI

from .routes import router
from .schemas import HealthCheck


def create_app() -> FastAPI:
    app = FastAPI(title="totvibe-ocr pipeline-api")
    app.include_router(router)

    @app.get("/healthz", response_model=HealthCheck)
    async def healthz() -> HealthCheck:
        return HealthCheck(status="ok")

    return app


app = create_app()
