"""Story tests for the transcription service. Criteria live in 1_transcription_service.md."""

from __future__ import annotations

import asyncio
import sys
from http import HTTPStatus
from typing import TYPE_CHECKING

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient
from transcription_api import __main__ as cli
from transcription_api import mock as mock_module
from transcription_api import routes
from transcription_api.app import create_app
from transcription_api.results import post_result
from transcription_api.schemas import TranscriptionResult

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

MOCK_TOTAL_PAGES = 2

SUBMISSION = {
    "ocr_job_id": "job-1",
    "upload_key": "ocr-jobs/job-1/upload.pdf",
    "result_url": "http://web.test/api/transcription/results",
    "result_token": "token-1",
}


@pytest.fixture
def posted() -> list[TranscriptionResult]:
    return []


@pytest.fixture
def record_result(posted: list[TranscriptionResult]) -> object:
    async def record(_result_url: str, _result_token: str, payload: TranscriptionResult) -> None:
        await asyncio.sleep(0)
        posted.append(payload)

    return record


@pytest.fixture
def real_client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, record_result: object) -> Iterator[TestClient]:
    monkeypatch.setenv("TRANSCRIPTION_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(routes, "post_result", record_result)
    with TestClient(create_app()) as client:
        yield client


@pytest.fixture
def mock_client(monkeypatch: pytest.MonkeyPatch, record_result: object) -> Iterator[TestClient]:
    monkeypatch.setattr(mock_module, "post_result", record_result)
    monkeypatch.setattr(mock_module, "DEFAULT_PAGE_DELAY_SECONDS", 0.0)
    monkeypatch.setattr(mock_module, "DEFAULT_TOTAL_PAGES", MOCK_TOTAL_PAGES)
    with TestClient(mock_module.create_app()) as client:
        yield client


def test_1_1_1_healthz_reports_ok(real_client: TestClient) -> None:
    response = real_client.get("/healthz")
    assert response.status_code == HTTPStatus.OK
    assert response.json() == {"status": "ok"}


def test_1_2_1_submit_acks_with_a_pipeline_id(real_client: TestClient) -> None:
    response = real_client.post("/submit", json=SUBMISSION)
    assert response.status_code == HTTPStatus.OK
    assert response.json()["pipeline_id"]


def test_1_2_2_an_unwired_pipeline_delivers_a_failed_page_then_a_final_done_result(
    real_client: TestClient, posted: list[TranscriptionResult]
) -> None:
    real_client.post("/submit", json=SUBMISSION)

    page_result, final_result = posted
    assert page_result.status == "failed"
    assert page_result.page_number == 1
    assert page_result.error is not None
    assert final_result.status == "done"
    assert final_result.page_number is None


def test_1_2_3_the_recorded_job_status_is_readable_by_pipeline_id(real_client: TestClient) -> None:
    pipeline_id = real_client.post("/submit", json=SUBMISSION).json()["pipeline_id"]
    response = real_client.get(f"/ocr-jobs/{pipeline_id}")
    assert response.status_code == HTTPStatus.OK
    assert response.json() == {"pipeline_id": pipeline_id, "ocr_job_id": "job-1", "status": "done"}


def test_1_2_4_unknown_pipeline_ids_are_a_404(real_client: TestClient) -> None:
    response = real_client.get("/ocr-jobs/no-such-pipeline")
    assert response.status_code == HTTPStatus.NOT_FOUND


def test_1_2_5_a_submission_whose_result_delivery_blows_up_is_marked_failed(
    monkeypatch: pytest.MonkeyPatch, real_client: TestClient, posted: list[TranscriptionResult]
) -> None:
    async def explode_once(_result_url: str, _result_token: str, payload: TranscriptionResult) -> None:
        await asyncio.sleep(0)
        if not posted:
            posted.append(payload)
            message = "callback unreachable"
            raise RuntimeError(message)
        posted.append(payload)

    monkeypatch.setattr(routes, "post_result", explode_once)
    pipeline_id = real_client.post("/submit", json=SUBMISSION).json()["pipeline_id"]

    assert real_client.get(f"/ocr-jobs/{pipeline_id}").json()["status"] == "failed"
    assert posted[-1].status == "failed"


def test_1_3_1_mock_submit_delivers_one_done_result_per_page_then_a_final_done(
    mock_client: TestClient, posted: list[TranscriptionResult]
) -> None:
    response = mock_client.post("/submit", json=SUBMISSION)
    assert response.status_code == HTTPStatus.OK
    assert response.json()["pipeline_id"]

    page_results, final_result = posted[:-1], posted[-1]
    assert [result.page_number for result in page_results] == list(range(1, MOCK_TOTAL_PAGES + 1))
    assert all(result.status == "done" and result.markdown_key for result in page_results)
    assert final_result.status == "done"
    assert final_result.page_number is None


def test_1_3_2_mock_healthz_reports_ok(mock_client: TestClient) -> None:
    response = mock_client.get("/healthz")
    assert response.status_code == HTTPStatus.OK
    assert response.json() == {"status": "ok"}


def test_1_3_3_mock_job_status_always_reads_processing(mock_client: TestClient) -> None:
    response = mock_client.get("/ocr-jobs/any-pipeline-id")
    assert response.json() == {"pipeline_id": "any-pipeline-id", "status": "processing"}


@pytest.fixture
def http_exchange(monkeypatch: pytest.MonkeyPatch) -> tuple[list[httpx.Request], list[int]]:
    requests: list[httpx.Request] = []
    statuses: list[int] = [HTTPStatus.OK]
    original_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(statuses[0])

    def with_mock_transport(*, timeout: float) -> httpx.AsyncClient:
        return original_client(transport=httpx.MockTransport(handler), timeout=timeout)

    monkeypatch.setattr(httpx, "AsyncClient", with_mock_transport)
    return requests, statuses


def test_1_4_1_results_are_posted_with_the_result_token_header(
    http_exchange: tuple[list[httpx.Request], list[int]],
) -> None:
    requests, _ = http_exchange
    payload = TranscriptionResult(result_id="r1", ocr_job_id="job-1", status="done")

    asyncio.run(post_result("http://web.test/results", "token-1", payload))

    assert requests[0].headers["x-result-token"] == "token-1"
    assert requests[0].url == "http://web.test/results"


def test_1_4_2_a_rejected_result_post_raises(
    http_exchange: tuple[list[httpx.Request], list[int]],
) -> None:
    _, statuses = http_exchange
    statuses[0] = HTTPStatus.INTERNAL_SERVER_ERROR
    payload = TranscriptionResult(result_id="r1", ocr_job_id="job-1", status="failed")

    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(post_result("http://web.test/results", "token-1", payload))


@pytest.fixture
def served_factories(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    factories: list[str] = []

    def capture(app_factory: str, **_options: object) -> None:
        factories.append(app_factory)

    monkeypatch.setattr(uvicorn, "run", capture)
    return factories


def test_1_5_1_the_default_launch_serves_the_real_app_factory(
    monkeypatch: pytest.MonkeyPatch, served_factories: list[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["transcription-api"])
    cli.main()
    assert served_factories == ["transcription_api.app:create_app"]


def test_1_5_2_the_mock_flag_serves_the_mock_app_factory(
    monkeypatch: pytest.MonkeyPatch, served_factories: list[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["transcription-api", "--mock"])
    cli.main()
    assert served_factories == ["transcription_api.mock:create_app"]
