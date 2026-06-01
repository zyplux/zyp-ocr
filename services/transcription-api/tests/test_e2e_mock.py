"""End-to-end test against a live mock stack.

Skipped unless `TOTVIBE_E2E=1` is set and the stack is up via:

    just dev-mock

Verifies: PDF upload → DO writes ocr_job + per-md_page rows → mock transcription
service emits per-md_page results → state stream reflects status='done'.
"""

from __future__ import annotations

import json
import os
import time

import httpx
import pytest

WEB_BASE = os.environ.get("E2E_WEB_BASE", "http://127.0.0.1:8787")
E2E_ENABLED = os.environ.get("TOTVIBE_E2E") == "1"

MIN_PDF = b"""%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>
endobj
4 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>
endobj
xref
0 5
0000000000 65535 f
0000000010 00000 n
0000000056 00000 n
0000000111 00000 n
0000000168 00000 n
trailer << /Size 5 /Root 1 0 R >>
startxref
225
%%EOF
"""


def _read_first_snapshot(client: httpx.Client) -> dict:
    with client.stream("GET", "/api/_internal/state-stream") as response:
        response.raise_for_status()
        for line in response.iter_lines():
            if line.startswith("data: "):
                return json.loads(line[len("data: ") :])
    raise RuntimeError("state stream closed before any event")


@pytest.mark.skipif(not E2E_ENABLED, reason="set TOTVIBE_E2E=1 with the mock stack running")
def test_upload_then_md_pages_complete() -> None:
    with httpx.Client(base_url=WEB_BASE, timeout=10.0) as client:
        res = client.post(
            "/api/ocr-jobs",
            content=MIN_PDF,
            headers={"content-type": "application/pdf"},
        )
        res.raise_for_status()
        ocr_job_id = res.json()["ocrJobId"]

        deadline = time.time() + 15.0
        while time.time() < deadline:
            event = _read_first_snapshot(client)
            assert event["op"] == "snapshot"
            snap = event["snapshot"]
            ocr_job = next((j for j in snap["ocr_jobs"] if j["id"] == ocr_job_id), None)
            md_pages = [p for p in snap["md_pages"] if p["ocr_job_id"] == ocr_job_id]
            all_done = all(p["status"] == "done" for p in md_pages)
            if ocr_job and ocr_job["status"] == "done" and all_done:
                assert len(md_pages) == 2
                return
            time.sleep(0.5)
        pytest.fail("ocr job did not complete within 15 s")
