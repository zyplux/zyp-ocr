# /// script
# requires-python = ">=3.14"
# dependencies = [
#   "pydantic>=2.12.0",
# ]
# ///
"""Generate apps/web/src/contracts.ts from transcription_api.schemas.

Pydantic v2 → JSON Schema (via model_json_schema) → naive Zod TS emitter.
The output file is committed; the pre-commit hook re-runs this script via
`scripts/codegen_runner.py` (picked up by the `*.lefthook.py` convention).

This is a host-run helper — it does NOT depend on workspace state at runtime
(uv ignores pyproject.toml when invoked via `uv run scripts/...`). It dynamically
loads schemas.py by path so we don't need `transcription-api` installed.
"""

from __future__ import annotations

import importlib.util
import logging
import re
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterator
    from types import ModuleType

logger = logging.getLogger("export_schemas")

JS_IDENT = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")
JS_RESERVED = frozenset({
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "new",
    "null",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
    "let",
    "static",
    "implements",
    "interface",
    "package",
    "private",
    "protected",
    "public",
})


def js_str(value: str) -> str:
    """Single-quoted JS string literal (matches prettier singleQuote: true)."""
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def js_key(name: str) -> str:
    """Object key — bare when it's a valid identifier (matches prettier quoteProps: as-needed)."""
    if JS_IDENT.match(name) and name not in JS_RESERVED:
        return name
    return js_str(name)


ROOT = Path(__file__).resolve().parent.parent
SCHEMAS_PY = ROOT / "services/transcription-api/src/transcription_api/schemas.py"
OUTPUT_TS = ROOT / "apps/web/src/contracts.ts"

# Order matters: emit referenced models before the ones that reference them.
EXPORTED = [
    "TranscriptionSubmission",
    "TranscriptionSubmissionAck",
    "TranscriptionResult",
]


class SchemasModuleLoadError(RuntimeError):
    def __init__(self) -> None:
        super().__init__(f"failed to load {SCHEMAS_PY}")


def load_schemas_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("transcription_schemas", SCHEMAS_PY)
    if spec is None or spec.loader is None:
        raise SchemasModuleLoadError
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SCALAR_ZOD = {
    "string": "z.string()",
    "integer": "z.number().int()",
    "number": "z.number()",
    "boolean": "z.boolean()",
    "null": "z.null()",
}


def json_schema_to_zod(schema: dict[str, Any]) -> str:
    """Walk a JSON Schema fragment and emit a Zod expression."""
    if "anyOf" in schema:
        return "z.union([" + ", ".join(json_schema_to_zod(s) for s in schema["anyOf"]) + "])"
    if "enum" in schema:
        return "z.enum([" + ", ".join(js_str(v) for v in schema["enum"]) + "])"
    t = schema.get("type")
    if t in SCALAR_ZOD:
        return SCALAR_ZOD[t]
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
    for name in sorted(properties):
        zod = json_schema_to_zod(properties[name])
        if name not in required:
            zod = f"{zod}.optional()"
        parts.append(f"  {js_key(name)}: {zod},")
    return "z.object({\n" + "\n".join(parts) + "\n})"


def emit_models(module: ModuleType) -> Iterator[str]:
    for name in EXPORTED:
        cls = getattr(module, name)
        schema = cls.model_json_schema()
        body = emit_object(schema)
        yield f"export const {name}Schema = {body};"
        yield f"export type {name} = z.infer<typeof {name}Schema>;"
        yield ""


def main() -> int:
    module = load_schemas_module()
    header = (
        "// GENERATED FILE — do not edit by hand.\n"
        "// Source of truth: services/transcription-api/src/transcription_api/schemas.py\n"
        "// Run `just codegen` to regenerate.\n\n"
        "import * as z from 'zod';\n\n"
    )
    body = "\n".join(emit_models(module)).rstrip() + "\n"
    OUTPUT_TS.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_TS.write_text(header + body, encoding="utf-8")
    logger.info("wrote %s", OUTPUT_TS.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(main())
