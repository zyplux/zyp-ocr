# Post-skeleton

> **Status:** v0.1 walking skeleton wired and exercised end-to-end against the mock pipeline.
> **Last updated:** 2026-05-08

This file enumerates everything still open after the walking skeleton landed. It is the working list — items move into `plan/doing/` when picked up and `plan/done/NNN-<slug>.md` when shipped. The strategic roadmap stays in [`totvibe-ocr.md`](../../totvibe-ocr.md) §11; this doc just makes the next-layer-down concrete.

## What the skeleton actually shipped

- DO RPC: `createOcrJob`, `applyCallback`, `setPipelineId`, `snapshot`; alarm-driven `failed('timeout')`; hibernation-aware WS broadcast.
- Worker: `/api/ocr-jobs`, `/api/me/items`, `/api/me/ws`, `/api/pipeline/callback`, `/api/ocr-jobs/:id/{upload,md-pages/:n}`.
- Signed callback tokens (HMAC-SHA256) with rotation + expiry; unit-tested.
- TanStack DB collections (ocr_jobs + md_pages) with HTTP hydrate + WS deltas + exponential reconnect.
- SPA: drag-drop upload, ocr_jobs list, per-md_page markdown view via `useLiveQuery`.
- Pipeline `/submit` queues an asyncio task; mock variant (`compose.mock.yaml`) emits canned per-md_page callbacks.
- E2E test (`services/pipeline-api/tests/test_e2e_mock.py`, gated on `TOTVIBE_E2E=1`) verifies upload → DO state → mock callbacks → `done`.

## v0.1 — finish the skeleton

Targetable now. None of these need v0.5 infra.

- [ ] **Real OCR runner.** `services/pipeline-api/src/pipeline_api/ocr.py` is `NotImplementedError`. Wire `glmocr[selfhosted]` against the vLLM endpoint (`VLLM_BASE`) so `pipeline.py` (non-mock) drives real per-md_page callbacks. Manual smoke test against a fixture PDF on the laptop GPU before declaring done.
- [ ] **vLLM bring-up rehearsal.** `compose.yaml` declares the vLLM service but `dev-mock` skips it. Run `just dev` once on the GPU laptop, capture VRAM + latency baseline, document any compose tweaks needed (NVIDIA Container Toolkit notes per §14).
- [ ] **Build inside the web image.** `wrangler dev` reads `dist/server/wrangler.json`, so the host currently needs `pnpm --filter @totvibe/web build` before `just dev-mock`. Either bake the build into the dev Containerfile stage or move to vite dev directly. Update README accordingly.
- [ ] **Robust PDF page count.** `lib/pdf-pages.ts` is a regex over the raw bytes — fails on compressed page trees. Either bring in `pdf-lib` (works in Workers) or have the pipeline report `total_pages` back in its first callback and expand the md_page-row set lazily.
- [ ] **Cap enforcement coverage.** Add e2e cases for the 50 MB / 100-page / 10-in-flight caps. The DO already enforces; tests are missing.
- [ ] **Per-md_page failure path test.** Mock pipeline currently emits only `done`. Add a knob (env var or query param) to inject a failed page so the SPA's inline error rendering and ocr-job-level `failed` derivation are covered.
- [ ] **Alarm-timeout test.** Set `RECONCILE_TIMEOUT_SECONDS=2` in a test variant, submit an ocr job, never callback, assert the row flips to `failed('timeout')`. Surfaced once during this session as "stuck processing" ocr jobs after a misconfigured `WORKER_INTERNAL_BASE` — the alarm did fire eventually, but we never wrote the test.
- [ ] **Worker-side request-validation tests.** `/api/ocr-jobs` content-type/size, `/api/pipeline/callback` token verify + payload-vs-claims `ocrJobId` mismatch — covered by the code paths but not by tests.
- [ ] **TanStack DB optimistic insert.** `ocrJobsCollection` has no `onInsert`; the SPA waits for the WS delta to round-trip. Add an optimistic insert on upload so the new row appears before the snapshot reflects it.

## v0.5 — first Cloudflare deploy

Per the roadmap. Tracked here so we don't lose context.

- [ ] **Real R2 binding.** Swap `S3_ENDPOINT`/keys for a `R2_BUCKET` binding in production; keep `@aws-sdk/client-s3` locally against MinIO. Single env-flag swap of the S3 client construction.
- [ ] **Cloudflare Tunnel for the pipeline.** Laptop pipeline reachable from the deployed Worker. Document the `cloudflared` setup in the README's deploy section.
- [ ] **Auth gate.** Basic password or CF Access at the public surface. The DO's identity stays singleton (`idFromName('default')`); v1 is where per-user lands.
- [ ] **Smart alarm reconcile.** Before flipping a row to `failed('timeout')`, the DO calls `GET /ocr-jobs/<pipeline_id>` on the pipeline. If the pipeline still shows `processing`, reschedule; if it shows `done`/`failed`, pull state and reconcile.
- [ ] **`compose.prod-like.yaml`.** Mirror the prod shape (R2 + tunnel-proxied pipeline) for full-stack rehearsal before deploying.
- [ ] **CI config.** `.github/workflows/ci.yml` runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, `uv run ruff`, `uv run pytest` (no e2e). `just ci` recipe materializes.

## v1 — production-ready

The publicly shippable release. The architectural moves are small; the operational ones are not.

- [ ] **DO-per-user.** One-line change: `USER_DO.idFromName(userId)`. Auth provides the `userId`.
- [ ] **Real auth.** CF Access or magic-link / OAuth allow-list. Both end up surfacing `userId` to the Worker.
- [ ] **Cloud GPU host for the pipeline.** Candidates: CF Containers with GPU, Modal, RunPod. Comparison on pricing + cold-start + DX before committing.
- [ ] **Schema migrations across cold DOs.** Today `migrate()` only does `CREATE TABLE IF NOT EXISTS`. Once users exist in the wild, version each migration and apply on first wake post-deploy.

## v1.x and beyond

- [ ] **RSC + server functions** for the TS edge layer. Drop the ad-hoc `/api/*` handlers in favour of TanStack Start server functions where it makes sense; keep the WS endpoint as a Worker route.
- [ ] **Per-md_page retry button.** v0.x recovery is re-upload; v1.x adds retry that the DO routes through to the pipeline as a single-md_page resubmit.
- [ ] **Delta resumption protocol.** WS reconnect with `?since=<seq>` instead of full snapshot refetch.
- [ ] **More input formats.** Images, DOCX, HTML — each requires a pipeline branch.
- [ ] **Batch upload + side-by-side preview.** Pure SPA work once the data layer's stable.
- [ ] **Parallel md_pages per ocr job.** Pipeline-side concurrency knob; the DO already handles out-of-order callbacks because it keys on `(ocr_job_id, page_number)`.

## Known unknowns (track, don't fix)

These are surfaced from §14 of the main plan plus things observed in this session. They turn into explicit TODOs once we hit them.

- GLM-OCR quality on the user's real scans.
- VRAM + latency under MTP speculative decoding sharing the card with PP-DocLayoutV3.
- TanStack Start Cloudflare-adapter edge cases (DO RPC stubs from server functions, RSC preview).
- TanStack DB 0.6+ sync-adapter shape; optimistic-mutation reconciliation when broadcast races local insert.
- Worker code-deploy impact on in-flight OCR jobs.
- `wrangler dev` fidelity to production around hibernation + alarms.
- DO SQLite 10 GB cap (almost certainly fine — blobs live in S3).

## Implementation gotchas captured this round

Worth recording so the next person doesn't rediscover them.

- **`pnpm --filter @totvibe/web wrangler dev` exits silently inside the dev container** — running directly as `pnpm wrangler dev` from the package's WORKDIR works. The compose overrides now use the direct form.
- **TanStack Start expects `src/router.tsx` to export `getRouter`** (not `createRouter`). The plugin-generated `routeTree.gen.ts` references it by name.
- **`PUBLIC_BASE` is browser-facing; the DO needs a network-internal hostname for callback URLs.** Split into `PUBLIC_BASE` + `WORKER_INTERNAL_BASE` (`http://web:8787` inside the compose network). Keep this distinction when moving to CF Tunnel in v0.5.
- **`wrangler.jsonc` `main` should point at the build artifact, not source** — but the plugin verifies the path exists at config time, so a fresh checkout fails until the first `pnpm build`. Either generate a placeholder or move the build into the image.
- **DO must own the `ocrJobId`.** The Worker generates a ULID for the S3 upload, then asks the DO to create with that key — but the DO also generates its own ULID, so the keys diverge. Fixed by having `createOcrJob` accept a template (`ocr-jobs/{ocrJobId}/upload.pdf`) and substitute in its generated id; the Worker uses the returned id to do the upload.
