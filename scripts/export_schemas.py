# /// script
# requires-python = ">=3.14"
# dependencies = [
#   "pydantic>=2.12.0",
# ]
# ///
"""Generate apps/web/src/contracts.ts from services/pipeline-api/src/pipeline_api/schemas.py.

Pydantic v2 → JSON Schema (via model_json_schema) → naive Zod TS emitter.
The output file is committed; rerun on schema changes via `just codegen`.

This is a host-run helper — it does NOT depend on workspace state at runtime
(uv ignores pyproject.toml when invoked via `uv run scripts/...`). It dynamically
loads schemas.py by path so we don't need `pipeline-api` installed.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SCHEMAS_PY = ROOT / "services/pipeline-api/src/pipeline_api/schemas.py"
OUTPUT_TS = ROOT / "apps/web/src/contracts.ts"

# Order matters: emit referenced models before the ones that reference them.
EXPORTED = [
    "PipelineSubmission",
    "PipelineSubmissionAck",
    "PipelineCallback",
]


def load_schemas_module():
    spec = importlib.util.spec_from_file_location("pipeline_schemas", SCHEMAS_PY)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load {SCHEMAS_PY}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def json_schema_to_zod(schema: dict[str, Any]) -> str:
    """Walk a JSON Schema fragment and emit a Zod expression."""
    if "anyOf" in schema:
        return "z.union([" + ", ".join(json_schema_to_zod(s) for s in schema["anyOf"]) + "])"
    if "enum" in schema:
        return "z.enum([" + ", ".join(json.dumps(v) for v in schema["enum"]) + "])"
    t = schema.get("type")
    if t == "string":
        return "z.string()"
    if t == "integer":
        return "z.number().int()"
    if t == "number":
        return "z.number()"
    if t == "boolean":
        return "z.boolean()"
    if t == "null":
        return "z.null()"
    if t == "object":
        return emit_object(schema)
    if t == "array":
        items = schema.get("items", {})
        return f"z.array({json_schema_to_zod(items)})"
    return "z.unknown()"


def emit_object(schema: dict[str, Any]) -> str:
    properties = schema.get("properties", {})
    required = set(schema.get("required", []))
    parts = []
    for name, prop in properties.items():
        zod = json_schema_to_zod(prop)
        if name not in required:
            zod = f"{zod}.optional()"
        parts.append(f"  {json.dumps(name)}: {zod}")
    return "z.object({\n" + ",\n".join(parts) + "\n})"


def emit_models(module) -> Iterator[str]:
    for name in EXPORTED:
        cls = getattr(module, name)
        schema = cls.model_json_schema()
        body = emit_object(schema)
        yield f"export const {name} = {body};"
        yield f"export type {name} = z.infer<typeof {name}>;"
        yield ""


def main() -> int:
    module = load_schemas_module()
    header = (
        "// GENERATED FILE — do not edit by hand.\n"
        "// Source of truth: services/pipeline-api/src/pipeline_api/schemas.py\n"
        "// Run `just codegen` to regenerate.\n\n"
        'import { z } from "zod";\n\n'
    )
    body = "\n".join(emit_models(module)).rstrip() + "\n"
    OUTPUT_TS.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_TS.write_text(header + body, encoding="utf-8")
    print(f"wrote {OUTPUT_TS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
