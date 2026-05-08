import { sql } from 'drizzle-orm';
import { check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const jobs = sqliteTable(
  'jobs',
  {
    completed_at: integer(),
    created_at: integer().notNull(),
    error: text(),
    id: text().primaryKey(),
    pipeline_id: text(),
    size_bytes: integer().notNull(),
    source_key: text().notNull(),
    started_at: integer(),
    status: text({ enum: ['pending', 'processing', 'done', 'failed'] }).notNull(),
    total_pages: integer().notNull(),
  },
  table => [
    check('jobs_status_enum', sql`${table.status} IN ('pending','processing','done','failed')`),
    check('jobs_size_bytes_max', sql`${table.size_bytes} <= 52428800`),
    check('jobs_total_pages_max', sql`${table.total_pages} <= 100`),
  ],
);

export const job_pages = sqliteTable(
  'job_pages',
  {
    error: text(),
    job_id: text()
      .notNull()
      .references(() => jobs.id),
    markdown_key: text(),
    page_number: integer().notNull(),
    status: text({ enum: ['pending', 'done', 'failed'] }).notNull(),
  },
  table => [
    primaryKey({ columns: [table.job_id, table.page_number] }),
    check('job_pages_status_enum', sql`${table.status} IN ('pending','done','failed')`),
  ],
);

export const callbacks_seen = sqliteTable('callbacks_seen', {
  callback_id: text().primaryKey(),
  seen_at: integer().notNull(),
});
