set shell := ["bash", "-euo", "pipefail", "-c"]
set dotenv-load := true

compose := "podman compose -f infra/compose.yaml"
dev_stack := compose + " -f infra/compose.dev.yaml"
mock_stack := compose + " -f infra/compose.mock.yaml"

# List available recipes.
default:
    @just --list

# Install JS and Python dependencies (images are built lazily by `just up`).
install:
    pnpm install
    uv sync --all-packages

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

# Run all JS (workspace) and Python (pytest) unit tests.
test:
    pnpm -r test
    uv run --active pytest

# Run end-to-end Python tests (gated by the TOTVIBE_E2E flag).
e2e:
    TOTVIBE_E2E=1 uv run --active pytest -k e2e

# Lint JS workspaces and Python sources (ruff check).
lint:
    pnpm -r lint
    uv run --active ruff check .

# Auto-format JS/MD via prettier and Python via ruff.
format:
    pnpm exec prettier --write .
    uv run --active ruff format .

# Type-check JS workspaces and the pipeline-api Python service.
typecheck:
    pnpm -r typecheck
    uv run --active ty check services/pipeline-api/src

# Export shared schemas (e.g. JSON Schema, OpenAPI) for cross-language use.
codegen:
    uv run scripts/export_schemas.py

# Load fixture objects into the local MinIO bucket for development.
seed-minio:
    uv run scripts/seed_minio.py
