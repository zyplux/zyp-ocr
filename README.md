# totvibe-ocr

Scanned PDFs in, markdown out, page-by-page via a TanStack DB live collection backed by an SSE state stream. See [`plan/totvibe-ocr.md`](./plan/totvibe-ocr.md) for the architecture and [`plan/project-structure.md`](./plan/board/done/001-proj-struct.md) for the repo layout.

## Prerequisites

- Bun 1.3+ (`curl -fsSL https://bun.sh/install | bash`)
- Python 3.14 (`.python-version`)
- uv 0.11+
- podman + podman-compose
- NVIDIA Container Toolkit (only for the real GPU transcription path; not needed for `dev-mock`)

## Quick start

```bash
just install        # bun install + uv sync + git hooks
just build          # produces apps/web/dist (wrangler dev consumes it)
just up mock        # bring up the stack without GPU
```

Open `http://localhost:8787`.

To exercise the data flow end-to-end:

```bash
TOTVIBE_E2E=1 uv run --active pytest -k e2e
```

## Common recipes

```bash
just up          # full stack including vLLM (GPU required)
just up mock     # stack without GPU (vLLM is mocked)
just down        # stop the stack
just build       # rebuild apps/web/dist
just test        # vitest + pytest
just lint        # eslint + ruff + rumdl
just u -i        # interactive upgrade of catalog deps via ncu
```

## First-run notes

- TanStack Start generates `apps/web/src/routeTree.gen.ts` on first `bun run dev` /
  `bun run build`. Until that file exists, `bun run typecheck` reports two errors on the
  `createFileRoute(...)` calls — they go away after the first dev run.
- Run `bun --filter @totvibe/web wrangler:types` after editing `wrangler.jsonc`
  to refresh `worker-configuration.d.ts`.
- `just install` also installs all git hooks (lefthook).
- Drop a PEP 723 script anywhere in the repo with one of two suffixes and it's
  picked up automatically — no config edit needed:
  - `*.lefthook.py` — runs once on pre-commit.
  - `*.watchregen.py` — runs once on pre-commit AND continuously in the IDE
    (VS Code auto-starts the watcher when the workspace opens).
