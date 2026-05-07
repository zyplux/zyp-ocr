"""End-to-end test against a live mock stack.

Skipped unless `TOTVIBE_E2E=1` is set and the stack is up via:

    just dev-mock

Verifies: PDF upload → DO writes job + per-page rows → mock pipeline
emits per-page callbacks → /api/me/items reflects status='done'.
"""

from __future__ import annotations

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


@pytest.mark.skipif(not E2E_ENABLED, reason="set TOTVIBE_E2E=1 with the mock stack running")
def test_upload_then_pages_complete() -> None:
    with httpx.Client(base_url=WEB_BASE, timeout=10.0) as client:
        res = client.post("/api/jobs", content=MIN_PDF, headers={"content-type": "application/pdf"})
        res.raise_for_status()
        job_id = res.json()["jobId"]

        deadline = time.time() + 15.0
        while time.time() < deadline:
            snap = client.get("/api/me/items").json()
            job = next((j for j in snap["jobs"] if j["id"] == job_id), None)
            pages = [p for p in snap["pages"] if p["job_id"] == job_id]
            if job and job["status"] == "done" and all(p["status"] == "done" for p in pages):
                assert len(pages) == 2
                return
            time.sleep(0.5)
        pytest.fail("job did not complete within 15 s")
