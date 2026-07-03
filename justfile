# BASELINE
set shell := ["bash", "-euo", "pipefail", "-c"]

alias i := install
alias k := knip
alias tc := typecheck
alias l := lint
alias t := test
alias c := check
alias u := upgrade
alias ui := upgrade-interactive
alias p := push
alias pr := push-ready

# List available recipes.
default:
    @just --list

# Install both workspaces: bun + uv.
install:
    bun install
    uv sync --all-packages --all-groups

# Report unused files, deps, and exports: knip (JS workspace) + vulture (Python).
knip:
    bun run knip
    uv run vulture

# Type-check both workspaces: tsc/bun for .ts, pyrefly for .py.
typecheck:
    bun run typecheck
    uv run pyrefly check

# Lint and format both workspaces with autofix, then verify org invariants with cerberus.
lint:
    bun run lint:fix
    bun run format
    uv run rumdl check --fix
    uv run rumdl fmt
    uv run ruff check --fix
    uv run ruff format
    uv run cerberus --fix

# Run tests for both workspaces. Optional arg filters by test name; never fails when nothing matches.
test name='':
    bun run test {{ if name == '' { '' } else { '-t ' + quote(name) + ' --passWithNoTests' } }}
    uv run pytest {{ if name == '' { '' } else { '-k ' + quote(name) } }} || [ "$?" -eq 5 ]

# Full gate across both workspaces: install, knip, typecheck, lint, test — autofix throughout.
check: install knip typecheck lint test

# Upgrade deps across both workspaces: ncu bumps JS ranges; uv lock --upgrade + uv-bump raise Python >= floors. Forwards extra args to ncu.
upgrade *args='':
    bun run upgrade -- {{ args }}
    uv lock --upgrade
    uvx uv-bump -v
    uv sync --all-packages --all-groups

# Interactively select JS upgrades, then non-interactively upgrade Python (uv has no interactive mode) and reinstall both.
upgrade-interactive:
    bun run upgrade -- -i
    bun install
    uv lock --upgrade
    uvx uv-bump -v
    uv sync --all-packages --all-groups

# Push the current branch and open a draft PR (-r/--ready marks it ready and enables auto-merge).
push *flags:
    bun run cz push-branch {{ flags }}

# Push the current branch and open a PR marked ready, enabling auto-merge.
push-ready: (push "--ready")

# Remove deps and caches from all workspaces.
clean:
    find . -type d \( -name node_modules -o -name .venv -o -name __pycache__ -o -name .tsbuild -o -name dist -o -name .ruff_cache -o -name .pytest_cache -o -name .rumdl_cache \) -prune -exec rm -rf {} +
    find . -type f \( -name '*.tsbuildinfo' -o -name '.eslintcache' -o -name '*.py[cod]' \) -delete

# CUSTOM
set dotenv-load

alias b := build

compose := "podman compose -f infra/compose.yaml"
dev_stack := compose + " -f infra/compose.dev.yaml"
mock_stack := compose + " -f infra/compose.mock.yaml"

# Build images, start the stack detached, and wait until all services are healthy. mode: dev (default) | mock.
up mode="dev":
    @[ "{{ mode }}" = "dev" ] || [ "{{ mode }}" = "mock" ] || { echo "unknown mode: {{ mode }} (expected: dev | mock)" >&2; exit 2; }
    {{ if mode == "mock" { mock_stack } else { dev_stack } }} up --build --wait

# Stop the stack and remove its containers (volumes preserved). Works for any mode.
down:
    {{ compose }} down

# Tear down the stack including its volumes. Works for any mode.
clean-stack:
    {{ compose }} down -v

# Tail logs from running services — pass a service name to follow only that one. Works for any mode.
logs service="":
    {{ compose }} logs -f {{ service }}

# Show status of running stack containers. Works for any mode.
ps:
    {{ compose }} ps

# Build JS workspaces — produces apps/web/dist consumed by `wrangler dev`.
build:
    bun run build

# Run end-to-end Python tests (gated by TOTVIBE_E2E).
e2e:
    TOTVIBE_E2E=1 uv run pytest -k e2e

# Auto-format JS/MD via prettier and Python via ruff.
format:
    bunx prettier --write .
    uv run ruff format .

# Load fixture objects into the local MinIO bucket for development.
seed-minio:
    uv run scripts/seed_minio.py
