import { sql } from 'drizzle-orm';
import { check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const ocr_jobs = sqliteTable(
  'ocr_jobs',
  {
    completed_at: integer(),
    created_at: integer().notNull(),
    error: text(),
    id: text().primaryKey(),
    pipeline_id: text(),
    size_bytes: integer().notNull(),
    started_at: integer(),
    status: text({ enum: ['awaiting_upload', 'uploaded', 'transcribing', 'done', 'failed'] }).notNull(),
    total_pages: integer().notNull(),
    upload_key: text().notNull(),
  },
  table => [
    check(
      'ocr_jobs_status_enum',
      sql`${table.status} IN ('awaiting_upload','uploaded','transcribing','done','failed')`,
    ),
    check('ocr_jobs_size_bytes_max', sql`${table.size_bytes} <= 52428800`),
    check('ocr_jobs_total_pages_max', sql`${table.total_pages} <= 100`),
  ],
);

export const md_pages = sqliteTable(
  'md_pages',
  {
    error: text(),
    markdown_key: text(),
    ocr_job_id: text()
      .notNull()
      .references(() => ocr_jobs.id),
    page_number: integer().notNull(),
    status: text({ enum: ['transcribing', 'done', 'failed'] }).notNull(),
  },
  table => [
    primaryKey({ columns: [table.ocr_job_id, table.page_number] }),
    check('md_pages_status_enum', sql`${table.status} IN ('transcribing','done','failed')`),
  ],
);

export const callbacks_seen = sqliteTable('callbacks_seen', {
  callback_id: text().primaryKey(),
  seen_at: integer().notNull(),
});
