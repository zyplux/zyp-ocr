# totvibe-ocr

Scanned PDFs in, markdown out, page-by-page over WebSocket. See [`plan/totvibe-ocr.md`](./plan/totvibe-ocr.md) for the architecture and [`plan/project-structure.md`](./plan/project-structure.md) for the repo layout.

## Prerequisites

- Node 22 (`.nvmrc`)
- pnpm 10.26.1 (via corepack: `corepack enable && corepack prepare pnpm@10.26.1 --activate`)
- Python 3.14 (`.python-version`)
- uv 0.11+
- podman + podman-compose
- NVIDIA Container Toolkit (only for the real GPU pipeline; not needed for `dev-mock`)

## Quick start

```bash
just install                                  # pnpm install + uv sync + image builds
pnpm --filter @totvibe/web build              # produces apps/web/dist (wrangler dev consumes it)
just dev-mock                                 # bring up the stack without GPU
```

Open `http://localhost:8787`.

To exercise the data flow end-to-end:

```bash
TOTVIBE_E2E=1 uv run --active pytest -k e2e
```

## Common recipes

```bash
just dev         # full stack including vLLM (GPU required)
just down        # stop the stack
just test        # vitest + pytest
just lint        # ruff + eslint
just codegen     # regenerate apps/web/src/contracts.ts from Pydantic schemas
```

## First-run notes

- TanStack Start generates `apps/web/src/routeTree.gen.ts` on first `pnpm dev` /
  `pnpm build`. Until that file exists, `pnpm typecheck` reports two errors on the
  `createFileRoute(...)` calls — they go away after the first dev run.
- Run `pnpm --filter @totvibe/web wrangler:types` after editing `wrangler.jsonc`
  to refresh `worker-configuration.d.ts`.

