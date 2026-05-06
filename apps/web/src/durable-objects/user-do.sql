CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  status       TEXT NOT NULL CHECK (status IN ('pending','processing','done','failed')),
  source_key   TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL CHECK (size_bytes <= 52428800),
  total_pages  INTEGER NOT NULL CHECK (total_pages <= 100),
  pipeline_id  TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS job_pages (
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  page_number  INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending','done','failed')),
  markdown_key TEXT,
  error        TEXT,
  PRIMARY KEY (job_id, page_number)
);

CREATE TABLE IF NOT EXISTS callbacks_seen (
  callback_id TEXT PRIMARY KEY,
  seen_at     INTEGER NOT NULL
);
