set shell := ["bash", "-euo", "pipefail", "-c"]
set dotenv-load := true

compose := "podman compose -f infra/compose.yaml"
dev_stack := compose + " -f infra/compose.dev.yaml"
mock_stack := compose + " -f infra/compose.mock.yaml"

default:
    @just --list

install:
    pnpm install
    uv sync --all-packages
    {{ dev_stack }} build

dev:
    {{ dev_stack }} up

dev-mock:
    {{ mock_stack }} up

up:
    {{ dev_stack }} up -d

down:
    {{ dev_stack }} down

build service="":
    {{ dev_stack }} build {{ service }}

logs service="":
    {{ dev_stack }} logs -f {{ service }}

ps:
    {{ dev_stack }} ps

clean:
    {{ dev_stack }} down -v
    rm -rf node_modules apps/*/node_modules packages/*/node_modules
    rm -rf .venv services/*/.venv
    find . -type d -name __pycache__ -prune -exec rm -rf {} +
    find . -type d -name .pytest_cache -prune -exec rm -rf {} +
    find . -type d -name .ruff_cache -prune -exec rm -rf {} +

test:
    pnpm -r test
    uv run --active pytest

lint:
    pnpm -r lint
    uv run --active ruff check .

format:
    pnpm exec prettier --write .
    uv run --active ruff format .

typecheck:
    pnpm -r typecheck
    uv run --active ty check services/pipeline-api/src

codegen:
    uv run scripts/export_schemas.py

seed-minio:
    uv run scripts/seed_minio.py
