from __future__ import annotations

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS pipeline_jobs (
  pipeline_id    TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL,
  source_key     TEXT NOT NULL,
  callback_url   TEXT NOT NULL,
  callback_token TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  completed_at   INTEGER
);
"""


async def open_db(path: str) -> aiosqlite.Connection:
    conn = await aiosqlite.connect(path)
    await conn.executescript(SCHEMA)
    await conn.commit()
    return conn
