#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Discover and run convention-named helper scripts.

Two file conventions, picked up automatically anywhere in the repo (excluding
common build/dep dirs):

    *.lefthook.py     — hook scripts. Run once per pre-commit.
    *.watchregen.py   — regenerators. Run once per pre-commit AND in watch
                        mode from the IDE. Must accept a `--watch` flag.

Subcommands:
    lefthook   run every *.lefthook.py and *.watchregen.py once, fail-fast,
               stage what they change
    watch      run every *.watchregen.py with --watch, in parallel
"""

from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
EXCLUDED_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "dist",
    "build",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    ".rumdl_cache",
    ".next",
    "target",
}
LEFTHOOK_SUFFIX = ".lefthook.py"
WATCHREGEN_SUFFIX = ".watchregen.py"


def discover(suffix: str) -> list[Path]:
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(REPO_ROOT):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS]
        for fn in filenames:
            if fn.endswith(suffix):
                found.append(Path(dirpath) / fn)
    return sorted(found)


def git_status_pairs() -> dict[str, str]:
    out = subprocess.check_output(
        [
            "git",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ],
        cwd=REPO_ROOT,
        text=True,
    )
    return {entry[3:]: entry[:2] for entry in out.split("\0") if entry}


def stage_diff(before: dict[str, str], after: dict[str, str]) -> list[str]:
    changed = sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p))
    for path in changed:
        subprocess.run(
            ["git", "add", "--all", "--", path],
            cwd=REPO_ROOT,
            check=True,
        )
    return changed


def run_once(scripts: list[Path], stage: bool) -> int:
    if not scripts:
        return 0
    for script in scripts:
        rel = script.relative_to(REPO_ROOT)
        before = git_status_pairs() if stage else {}
        print(f"==> {rel}", flush=True)
        rc = subprocess.run(["uv", "run", str(script)], cwd=REPO_ROOT).returncode
        if rc != 0:
            print(f"FAIL: {rel} exited {rc}", file=sys.stderr)
            return rc
        if stage:
            staged = stage_diff(before, git_status_pairs())
            for path in staged:
                print(f"    staged: {path}", flush=True)
    return 0


async def run_one_watch(script: Path) -> int:
    rel = script.relative_to(REPO_ROOT)
    proc = await asyncio.create_subprocess_exec(
        "uv",
        "run",
        str(script),
        "--watch",
        cwd=REPO_ROOT,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        assert proc.stdout
        prefix = f"[{rel}] ".encode()
        async for line in proc.stdout:
            sys.stdout.buffer.write(prefix + line)
            sys.stdout.flush()
        return await proc.wait()
    except asyncio.CancelledError:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except TimeoutError:
                proc.kill()
                await proc.wait()
        raise


async def run_watch_all(scripts: list[Path]) -> int:
    if not scripts:
        print("no *.watchregen.py scripts found", file=sys.stderr)
        return 0
    print(f"watching {len(scripts)} script(s):", flush=True)
    for s in scripts:
        print(f"  - {s.relative_to(REPO_ROOT)}", flush=True)

    tasks = [asyncio.create_task(run_one_watch(s)) for s in scripts]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError, KeyboardInterrupt:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        return 130

    for t in tasks:
        if not t.done():
            t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    for t in done:
        try:
            return t.result()
        except asyncio.CancelledError:
            continue
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser(
        "lefthook",
        help="run *.lefthook.py + *.watchregen.py once, stage changes",
    )
    sub.add_parser("watch", help="run *.watchregen.py --watch in parallel")
    args = parser.parse_args()

    if args.cmd == "lefthook":
        scripts = discover(LEFTHOOK_SUFFIX) + discover(WATCHREGEN_SUFFIX)
        return run_once(scripts, stage=True)
    if args.cmd == "watch":
        try:
            return asyncio.run(run_watch_all(discover(WATCHREGEN_SUFFIX)))
        except KeyboardInterrupt:
            return 130
    return 1


if __name__ == "__main__":
    sys.exit(main())
