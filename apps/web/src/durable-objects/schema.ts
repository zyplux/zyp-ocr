import { sql } from 'drizzle-orm';
import { check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const OCR_JOB_STATUSES = ['awaiting_upload', 'uploaded', 'transcribing', 'done', 'failed'] as const;
export type OcrJobStatus = (typeof OCR_JOB_STATUSES)[number];

export const MD_PAGE_STATUSES = ['transcribing', 'done', 'failed'] as const;
export type MdPageStatus = (typeof MD_PAGE_STATUSES)[number];

export const ocrJobs = sqliteTable(
  'ocr_jobs',
  {
    completed_at: integer(),
    created_at: integer().notNull(),
    error: text(),
    id: text().primaryKey(),
    pipeline_id: text(),
    size_bytes: integer().notNull(),
    started_at: integer(),
    status: text({ enum: OCR_JOB_STATUSES })
      .notNull()
      .generatedAlwaysAs(
        sql`CASE
          WHEN "error" IS NOT NULL THEN 'failed'
          WHEN "completed_at" IS NOT NULL THEN 'done'
          WHEN "started_at" IS NOT NULL THEN 'transcribing'
          WHEN "total_pages" > 0 THEN 'uploaded'
          ELSE 'awaiting_upload'
        END`,
        { mode: 'virtual' },
      ),
    total_pages: integer().notNull(),
    upload_key: text().notNull(),
  },
  table => [
    check('ocr_jobs_size_bytes_nonneg', sql`${table.size_bytes} >= 0`),
    check('ocr_jobs_total_pages_nonneg', sql`${table.total_pages} >= 0`),
    check('ocr_jobs_created_at_positive', sql`${table.created_at} > 0`),
    check(
      'ocr_jobs_started_at_after_created',
      sql`${table.started_at} IS NULL OR ${table.started_at} >= ${table.created_at}`,
    ),
    check(
      'ocr_jobs_completed_at_after_created',
      sql`${table.completed_at} IS NULL OR ${table.completed_at} >= ${table.created_at}`,
    ),
    // Clean completion ('done') requires the pipeline to have started. Only failed jobs
    // are allowed to complete without a start (upload abandoned, /submit refused, etc.).
    check(
      'ocr_jobs_clean_done_requires_started',
      sql`${table.completed_at} IS NULL OR ${table.started_at} IS NOT NULL OR ${table.error} IS NOT NULL`,
    ),
    // pipeline_id and started_at are written atomically in setPipelineId; either both
    // are set or both are null.
    check(
      'ocr_jobs_pipeline_id_pairs_with_started_at',
      sql`(${table.pipeline_id} IS NULL) = (${table.started_at} IS NULL)`,
    ),
    // A job can only enter 'transcribing'/'done' after pages have been confirmed.
    check('ocr_jobs_started_requires_pages', sql`${table.started_at} IS NULL OR ${table.total_pages} > 0`),
    check('ocr_jobs_error_nonempty', sql`${table.error} IS NULL OR length(${table.error}) > 0`),
  ],
);

export const mdPages = sqliteTable(
  'md_pages',
  {
    completed_at: integer(),
    created_at: integer().notNull(),
    error: text(),
    markdown_key: text(),
    ocr_job_id: text()
      .notNull()
      .references(() => ocrJobs.id),
    page_number: integer().notNull(),
    started_at: integer(),
    status: text({ enum: MD_PAGE_STATUSES })
      .notNull()
      .generatedAlwaysAs(
        sql`CASE
          WHEN "error" IS NOT NULL THEN 'failed'
          WHEN "completed_at" IS NOT NULL THEN 'done'
          ELSE 'transcribing'
        END`,
        { mode: 'virtual' },
      ),
  },
  table => [
    primaryKey({ columns: [table.ocr_job_id, table.page_number] }),
    check('md_pages_page_number_positive', sql`${table.page_number} > 0`),
    check('md_pages_created_at_positive', sql`${table.created_at} > 0`),
    check(
      'md_pages_started_at_after_created',
      sql`${table.started_at} IS NULL OR ${table.started_at} >= ${table.created_at}`,
    ),
    check(
      'md_pages_completed_at_after_created',
      sql`${table.completed_at} IS NULL OR ${table.completed_at} >= ${table.created_at}`,
    ),
    check('md_pages_error_nonempty', sql`${table.error} IS NULL OR length(${table.error}) > 0`),
    // A markdown output is only produced on successful completion.
    check(
      'md_pages_markdown_requires_done',
      sql`${table.markdown_key} IS NULL OR (${table.completed_at} IS NOT NULL AND ${table.error} IS NULL)`,
    ),
  ],
);

export type MdPageDbRow = typeof mdPages.$inferSelect;
export type OcrJobDbRow = typeof ocrJobs.$inferSelect;
