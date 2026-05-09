import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const OCR_JOB_STATUSES = ['awaiting_upload', 'uploaded', 'transcribing', 'done', 'failed'] as const;
export type OcrJobStatus = (typeof OCR_JOB_STATUSES)[number];

export const MD_PAGE_STATUSES = ['transcribing', 'done', 'failed'] as const;
export type MdPageStatus = (typeof MD_PAGE_STATUSES)[number];

export const ocr_jobs = sqliteTable('ocr_jobs', {
  completed_at: integer(),
  created_at: integer().notNull(),
  error: text(),
  id: text().primaryKey(),
  pipeline_id: text(),
  size_bytes: integer().notNull(),
  started_at: integer(),
  total_pages: integer().notNull(),
  upload_key: text().notNull(),
});

export const md_pages = sqliteTable(
  'md_pages',
  {
    completed_at: integer(),
    created_at: integer().notNull(),
    error: text(),
    markdown_key: text(),
    ocr_job_id: text()
      .notNull()
      .references(() => ocr_jobs.id),
    page_number: integer().notNull(),
    started_at: integer(),
  },
  table => [primaryKey({ columns: [table.ocr_job_id, table.page_number] })],
);

export const received_results = sqliteTable('received_results', {
  received_at: integer().notNull(),
  result_id: text().primaryKey(),
});

export type MdPageDbRow = typeof md_pages.$inferSelect;
export type OcrJobDbRow = typeof ocr_jobs.$inferSelect;

// Status is derived, not persisted: it's a function of the timestamp + error
// columns. Keeping a separate `status` column would invite drift (status='done'
// with completed_at IS NULL).
//
// Canonical predicates per status — mirror these when writing SQL filters that
// used to look at `status` directly:
//   ocr_jobs:
//     'failed'           error IS NOT NULL
//     'done'             completed_at IS NOT NULL AND error IS NULL
//     'transcribing'     started_at IS NOT NULL AND completed_at IS NULL AND error IS NULL
//     'uploaded'         total_pages > 0 AND started_at IS NULL AND completed_at IS NULL AND error IS NULL
//     'awaiting_upload'  total_pages = 0 AND started_at IS NULL AND completed_at IS NULL AND error IS NULL
//   md_pages:
//     'failed'           error IS NOT NULL
//     'done'             completed_at IS NOT NULL AND error IS NULL
//     'transcribing'     completed_at IS NULL AND error IS NULL
//   in-flight (any non-terminal): completed_at IS NULL AND error IS NULL
export const deriveOcrJobStatus = (row: OcrJobDbRow) => {
  if (row.error !== null) return 'failed' as const;
  if (row.completed_at !== null) return 'done' as const;
  if (row.started_at !== null) return 'transcribing' as const;
  if (row.total_pages > 0) return 'uploaded' as const;
  return 'awaiting_upload' as const;
};

export const deriveMdPageStatus = (row: MdPageDbRow) => {
  if (row.error !== null) return 'failed' as const;
  if (row.completed_at !== null) return 'done' as const;
  return 'transcribing' as const;
};
