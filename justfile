set shell := ["bash", "-euo", "pipefail", "-c"]
set dotenv-load

alias i := install
alias k := knip
alias tc := typecheck
alias l := lint
alias t := test
alias c := check
alias b := build
alias u := upgrade
alias ui := upgrade-interactive

compose := "podman compose -f infra/compose.yaml"
dev_stack := compose + " -f infra/compose.dev.yaml"
mock_stack := compose + " -f infra/compose.mock.yaml"

# List available recipes.
default:
    @just --list

# Install JS and Python dependencies + git hooks (images are built lazily by `just up`).
install:
    bun install
    uv sync --all-packages --all-groups
    uv run lefthook install

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

# Report unused files, dependencies, and exports across the JS workspace via knip.
knip:
    bun run knip

# Type-check JS (root + all workspaces) and transcription-api Python.
typecheck:
    bun run typecheck
    uv run --active pyrefly check services/transcription-api/src

# Lint and format with autofix: JS (eslint --fix + prettier --write), Python (ruff check --fix + format), Markdown (rumdl --fix).
lint:
    bun run lint:fix
    bunx prettier --write .
    uv run --active ruff check --fix .
    uv run --active ruff format .
    rumdl check --fix .

# Run all JS (workspace) and Python (pytest) unit tests.
test:
    bun --filter '*' test
    uv run --active pytest

# Full gate: install, build (generates routeTree.gen.ts), knip, typecheck, lint, test — autofix throughout.
check: install build knip typecheck lint test

# Build JS workspaces — produces apps/web/dist consumed by `wrangler dev`.
build:
    bun run build

# Run end-to-end Python tests (gated by TOTVIBE_E2E).
e2e:
    TOTVIBE_E2E=1 uv run --active pytest -k e2e

# Auto-format JS/MD via prettier and Python via ruff.
format:
    bunx prettier --write .
    uv run --active ruff format .

# Upgrade JS dependencies across the workspace via ncu (catalog-aware). Forwards extra args to ncu (e.g. `just u -i`, `just u --target newest`).
upgrade *args='':
    bun run upgrade -- {{ args }}

# Interactively select and apply upgrades, then reinstall
upgrade-interactive:
    bun run upgrade -- -i
    bun install

# Load fixture objects into the local MinIO bucket for development.
seed-minio:
    uv run scripts/seed_minio.py

# Tear down the stack with volumes and wipe local deps and tool caches.
clean:
    {{ compose }} down -v
    rm -rf node_modules apps/*/node_modules packages/*/node_modules
    rm -rf .venv services/*/.venv
    find . -type d -name __pycache__ -prune -exec rm -rf {} +
    find . -type d -name .pytest_cache -prune -exec rm -rf {} +
    find . -type d -name .ruff_cache -prune -exec rm -rf {} +
