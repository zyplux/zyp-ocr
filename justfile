set shell := ["bash", "-euo", "pipefail", "-c"]
set dotenv-load

alias l := lint
alias tc := typecheck
alias t := test
alias i := install
alias u := upgrade
alias b := build

compose := "podman compose -f infra/compose.yaml"
dev_stack := compose + " -f infra/compose.dev.yaml"
mock_stack := compose + " -f infra/compose.mock.yaml"

# List available recipes.
default:
    @just --list

# Install JS and Python dependencies + git hooks (images are built lazily by `just up`).
install:
    bun install
    uv sync --all-packages
    uv run lefthook install

# Upgrade JS dependencies across the workspace via ncu (catalog-aware). Forwards extra args to ncu (e.g. `just u -i`, `just u --target newest`).
upgrade *args='-u':
    bun run upgrade -- {{ args }}
    bun install

# Build JS workspaces — produces apps/web/dist consumed by `wrangler dev`.
build:
    bun run build

# Build images, start the stack detached, and wait until all services are healthy. mode: dev (default) | mock.
up mode="dev":
    @[ "{{ mode }}" = "dev" ] || [ "{{ mode }}" = "mock" ] || { echo "unknown mode: {{ mode }} (expected: dev | mock)" >&2; exit 2; }
    {{ if mode == "mock" { mock_stack } else { dev_stack } }} up --build --wait

# Stop the stack and remove its containers (volumes preserved). Works for any mode.
down:
    {{ compose }} down

# Tail logs from running services — pass a service name to follow only that one. Works for any mode.
logs service="":
    {{ compose }} logs -f {{ service }}

# Show status of running stack containers. Works for any mode.
ps:
    {{ compose }} ps

# Tear down the stack with volumes and wipe local deps and tool caches.
clean:
    {{ compose }} down -v
    rm -rf node_modules apps/*/node_modules packages/*/node_modules
    rm -rf .venv services/*/.venv
    find . -type d -name __pycache__ -prune -exec rm -rf {} +
    find . -type d -name .pytest_cache -prune -exec rm -rf {} +
    find . -type d -name .ruff_cache -prune -exec rm -rf {} +

# Report unused files, dependencies, and exports across the JS workspace via knip.
knip:
    bun run knip

# Auto-format JS/MD via prettier and Python via ruff.
format:
    bunx prettier --write .
    uv run --active ruff format .

# Type-check JS (root + all workspaces) and transcription-api Python; runs `knip` first.
typecheck: knip
    bun run typecheck
    uv run --active ty check services/transcription-api/src

# Lint JS (eslint), Python (ruff), Markdown (rumdl) — autofix by default; runs `typecheck` first. --check/-c to check only.
[arg('fix', long='check', short='c', value='')]
lint fix='--fix': typecheck
    bun run {{ if fix == '--fix' { 'lint:fix' } else { 'lint' } }}
    uv run --active ruff check {{ fix }} .
    rumdl check {{ fix }} .

# Run all JS (workspace) and Python (pytest) unit tests; runs `lint` first. --check/-c to skip lint fixes.
[arg('fix', long='check', short='c', value='')]
test fix='--fix': (lint fix)
    bun --filter '*' test
    uv run --active pytest

# Run end-to-end Python tests (gated by TOTVIBE_E2E); runs `test` first. --check/-c to skip lint fixes.
[arg('fix', long='check', short='c', value='')]
e2e fix='--fix': (test fix)
    TOTVIBE_E2E=1 uv run --active pytest -k e2e

# Load fixture objects into the local MinIO bucket for development.
seed-minio:
    uv run scripts/seed_minio.py
