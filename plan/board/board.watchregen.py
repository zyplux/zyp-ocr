#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = [
#   "pyyaml>=6.0",
#   "watchfiles>=0.21",
# ]
# ///
"""Regenerate plan/board/README.md from task files in todo/, doing/, done/.

Each task file may begin with optional YAML frontmatter:

    ---
    title: Friendly card title
    assignee: realSergiy
    priority: High
    ---

Without frontmatter the title falls back to the first H1 (`# ...`) line, then
to the filename stem. `assignee` and `priority` are rendered for todo/doing
cards only; done cards intentionally omit them.

Any new `.md` file dropped into todo/, doing/, or done/ without a leading
`NNN-` numeric prefix is auto-renamed with the next available board-wide
prefix before the README is regenerated.

Run modes:
    uv run plan/board/refresh.py             # one-shot regenerate
    uv run plan/board/refresh.py --watch     # regenerate on every .md change
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import NamedTuple

import yaml
from watchfiles import watch

BOARD_DIR = Path(__file__).resolve().parent
README = BOARD_DIR / "README.md"
COLUMNS: list[tuple[str, str]] = [
    ("todo", "🌱 Todo"),
    ("doing", "🌿 Doing"),
    ("done", "🌳 Done"),
]
COLUMN_NAMES = {col for col, _ in COLUMNS}
COLUMNS_WITHOUT_META = {"done"}
TICKET_BASE_URL = "https://github.com/realSergiy/totvibe-ocr/blob/main/plan/board/#TICKET#"
VALID_PRIORITIES = {"Very High", "High", "Low", "Very Low"}
PREFIX_RE = re.compile(r"^(\d+)[-_]")
PREFIX_WIDTH = 3


class Task(NamedTuple):
    title: str
    ticket: str
    assignee: str | None
    priority: str | None


def numeric_prefix(name: str) -> int | None:
    m = PREFIX_RE.match(name)
    return int(m.group(1)) if m else None


def split_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    parsed = yaml.safe_load(text[4:end]) or {}
    if not isinstance(parsed, dict):
        return {}, text
    return parsed, text[end + 5 :]


def first_h1(body: str) -> str | None:
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
    return None


def parse_task(path: Path, column: str) -> Task:
    text = path.read_text(encoding="utf-8")
    fm, body = split_frontmatter(text)

    title = fm.get("title") or first_h1(body) or path.stem

    assignee = fm.get("assignee") or fm.get("assigned")
    if assignee is not None:
        assignee = str(assignee)

    priority = fm.get("priority")
    if priority is not None:
        priority = str(priority)
        if priority not in VALID_PRIORITIES:
            allowed = ", ".join(sorted(VALID_PRIORITIES))
            print(
                f"warn: {path.name}: priority {priority!r} not one of {{{allowed}}}; dropping",
                file=sys.stderr,
            )
            priority = None

    return Task(
        title=str(title),
        ticket=f"{column}/{path.name}",
        assignee=assignee,
        priority=priority,
    )


def assign_prefixes() -> list[tuple[Path, Path]]:
    """Rename any .md files lacking a `NNN-` prefix; returns (old, new) pairs."""
    unprefixed: list[Path] = []
    max_n = 0
    for column in COLUMN_NAMES:
        for f in sorted((BOARD_DIR / column).glob("*.md")):
            n = numeric_prefix(f.name)
            if n is None:
                unprefixed.append(f)
            else:
                max_n = max(max_n, n)

    renames: list[tuple[Path, Path]] = []
    next_n = max_n + 1
    for f in sorted(unprefixed, key=lambda p: (p.parent.name, p.name)):
        new_path = f.with_name(f"{next_n:0{PREFIX_WIDTH}d}-{f.name}")
        f.rename(new_path)
        renames.append((f, new_path))
        next_n += 1
    return renames


def task_sort_key(path: Path) -> tuple[int, str]:
    n = numeric_prefix(path.name)
    return (n if n is not None else 10**9, path.name)


def collect_tasks() -> dict[str, list[Task]]:
    return {
        column: [
            parse_task(f, column)
            for f in sorted((BOARD_DIR / column).glob("*.md"), key=task_sort_key)
        ]
        for column, _ in COLUMNS
    }


def render_metadata(task: Task, column: str) -> str:
    parts = [f"ticket: '{task.ticket}'"]
    if column not in COLUMNS_WITHOUT_META:
        if task.assignee:
            parts.append(f"assigned: '{task.assignee}'")
        if task.priority:
            parts.append(f"priority: '{task.priority}'")
    return "@{ " + ", ".join(parts) + " }"


def render_readme(by_column: dict[str, list[Task]]) -> str:
    lines = [
        "# Project Board",
        "",
        "```mermaid",
        "---",
        "config:",
        "  kanban:",
        f"    ticketBaseUrl: '{TICKET_BASE_URL}'",
        "---",
        "kanban",
    ]
    for column, label in COLUMNS:
        lines.append(f"  {label}")
        for task in by_column.get(column, []):
            lines.append(f"    [{task.title}]{render_metadata(task, column)}")
    lines.append("```")
    lines.append("")
    return "\n".join(lines)


def write_readme() -> bool:
    content = render_readme(collect_tasks())
    if README.exists() and README.read_text(encoding="utf-8") == content:
        return False
    README.write_text(content, encoding="utf-8")
    return True


def refresh() -> bool:
    changed = False
    for old, new in assign_prefixes():
        print(f"renamed {old.name} -> {new.name}")
        changed = True
    if write_readme():
        print(f"wrote {README}")
        changed = True
    return changed


def relevant_change(path_str: str) -> bool:
    p = Path(path_str)
    if p.suffix != ".md":
        return False
    if p.resolve() == README.resolve():
        return False
    return p.parent.name in COLUMN_NAMES


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--watch",
        action="store_true",
        help="stay running and regenerate on every .md change",
    )
    args = parser.parse_args()

    refresh()

    if not args.watch:
        return

    watch_dirs = [str(BOARD_DIR / col) for col, _ in COLUMNS]
    print(f"watching: {', '.join(watch_dirs)}", flush=True)
    for changes in watch(*watch_dirs):
        if not any(relevant_change(path) for _event, path in changes):
            continue
        refresh()


if __name__ == "__main__":
    main()
