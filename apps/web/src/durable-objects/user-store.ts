import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import { and, count, desc, eq, lt, notInArray, sql } from 'drizzle-orm';

import type { MdPageDbRow, OcrJobDbRow } from '~/durable-objects/schema';
import type { TranscriptionUpdate } from '~/server';
import type { ConfirmUploadInput, ReserveUploadInput } from '~/server-fns/uploads';

import * as schema from '~/durable-objects/schema';

export type StoreDb<TRunResult = unknown> = BaseSQLiteDatabase<'sync', TRunResult, typeof schema>;

type SavedUpdate = { op: 'md-page-upsert'; row: MdPageDbRow } | { op: 'ocr-job-upsert'; row: OcrJobDbRow };

export class UserStore<TRunResult = unknown> {
  constructor(private readonly db: StoreDb<TRunResult>) {}

  completeJobIfRunning = (ocrJobId: string, error: string | undefined, completedAt: number) => {
    const [row] = this.db
      .update(schema.ocr_jobs)
      .set({ completed_at: completedAt, error: error ?? sql`NULL` })
      .where(and(eq(schema.ocr_jobs.id, ocrJobId), eq(schema.ocr_jobs.status, 'transcribing')))
      .returning()
      .all();
    return row ? ({ op: 'ocr-job-upsert', row } as const satisfies SavedUpdate) : undefined;
  };

  confirmUpload = (input: ConfirmUploadInput, now: number) => {
    const broadcasts: SavedUpdate[] = [];
    const [jobRow] = this.db
      .update(schema.ocr_jobs)
      .set({ size_bytes: input.sizeBytes, total_pages: input.totalPages })
      .where(eq(schema.ocr_jobs.id, input.ocrJobId))
      .returning()
      .all();
    if (!jobRow) return broadcasts;
    broadcasts.push({ op: 'ocr-job-upsert', row: jobRow });
    if (input.totalPages > 0) {
      const pageValues = Array.from({ length: input.totalPages }, (_, i) => ({
        created_at: now,
        ocr_job_id: input.ocrJobId,
        page_number: i + 1,
      }));
      const pageRows = this.db.insert(schema.md_pages).values(pageValues).returning().all();
      for (const row of pageRows) broadcasts.push({ op: 'md-page-upsert', row });
    }
    return broadcasts;
  };

  countInflight = async () => {
    const [row] = await this.db
      .select({ c: count() })
      .from(schema.ocr_jobs)
      .where(notInArray(schema.ocr_jobs.status, ['done', 'failed']));
    return row?.c ?? 0;
  };

  countInflightPages = async (ocrJobId: string) => {
    const [row] = await this.db
      .select({ c: count() })
      .from(schema.md_pages)
      .where(and(eq(schema.md_pages.ocr_job_id, ocrJobId), eq(schema.md_pages.status, 'transcribing')));
    return row?.c ?? 0;
  };

  failJob = (ocrJobId: string, error: string, completedAt: number) => {
    const [row] = this.db
      .update(schema.ocr_jobs)
      .set({ completed_at: completedAt, error })
      .where(eq(schema.ocr_jobs.id, ocrJobId))
      .returning()
      .all();
    return row ? ({ op: 'ocr-job-upsert', row } as const satisfies SavedUpdate) : undefined;
  };

  findStaleJobs = async (cutoff: number) =>
    await this.db
      .select({
        id: schema.ocr_jobs.id,
        started_at: schema.ocr_jobs.started_at,
        total_pages: schema.ocr_jobs.total_pages,
        upload_key: schema.ocr_jobs.upload_key,
      })
      .from(schema.ocr_jobs)
      .where(and(notInArray(schema.ocr_jobs.status, ['done', 'failed']), lt(schema.ocr_jobs.created_at, cutoff)));

  hasFailedPage = async (ocrJobId: string) => {
    const [row] = await this.db
      .select({ c: count() })
      .from(schema.md_pages)
      .where(and(eq(schema.md_pages.ocr_job_id, ocrJobId), eq(schema.md_pages.status, 'failed')));
    return (row?.c ?? 0) > 0;
  };

  readSnapshot = async () => {
    const ocrRows = await this.db.select().from(schema.ocr_jobs).orderBy(desc(schema.ocr_jobs.created_at));
    const pageRows = await this.db
      .select()
      .from(schema.md_pages)
      .orderBy(schema.md_pages.ocr_job_id, schema.md_pages.page_number);
    return { md_pages: pageRows, ocr_jobs: ocrRows };
  };

  requireMdPage = async (ocrJobId: string, pageNumber: number) => {
    const [row] = await this.db
      .select()
      .from(schema.md_pages)
      .where(and(eq(schema.md_pages.ocr_job_id, ocrJobId), eq(schema.md_pages.page_number, pageNumber)))
      .limit(1);
    if (!row) throw new Error(`md page not found: ${ocrJobId}/${pageNumber}`);
    return row;
  };

  requireOcrJob = async (ocrJobId: string) => {
    const [row] = await this.db.select().from(schema.ocr_jobs).where(eq(schema.ocr_jobs.id, ocrJobId)).limit(1);
    if (!row) throw new Error(`ocr job not found: ${ocrJobId}`);
    return row;
  };

  reserveJob = (input: ReserveUploadInput, createdAt: number) => {
    const [row] = this.db
      .insert(schema.ocr_jobs)
      .values({
        created_at: createdAt,
        id: input.ocrJobId,
        size_bytes: input.sizeBytes,
        total_pages: 0,
        upload_key: input.uploadKey,
      })
      .returning()
      .all();
    return row ? ({ op: 'ocr-job-upsert', row } as const satisfies SavedUpdate) : undefined;
  };

  saveUpdate = (input: TranscriptionUpdate, now: number) =>
    this.db.transaction(tx => {
      if (typeof input.pageNumber === 'number') {
        const [row] = tx
          .update(schema.md_pages)
          .set({
            completed_at: now,
            error: input.status === 'failed' ? (input.error ?? 'failed') : sql`NULL`,
            markdown_key: input.markdownKey ?? sql`NULL`,
          })
          .where(
            and(
              eq(schema.md_pages.ocr_job_id, input.ocrJobId),
              eq(schema.md_pages.page_number, input.pageNumber),
              eq(schema.md_pages.status, 'transcribing'),
            ),
          )
          .returning()
          .all();
        return row ? ({ op: 'md-page-upsert', row } as const satisfies SavedUpdate) : undefined;
      }

      const finalError = input.status === 'failed' ? (input.error ?? 'failed') : sql`NULL`;
      const [row] = tx
        .update(schema.ocr_jobs)
        .set({ completed_at: now, error: finalError })
        .where(and(eq(schema.ocr_jobs.id, input.ocrJobId), eq(schema.ocr_jobs.status, 'transcribing')))
        .returning()
        .all();
      return row ? ({ op: 'ocr-job-upsert', row } as const satisfies SavedUpdate) : undefined;
    });

  setPipelineId = (ocrJobId: string, pipelineId: string, startedAt: number) => {
    const [row] = this.db
      .update(schema.ocr_jobs)
      .set({ pipeline_id: pipelineId, started_at: startedAt })
      .where(eq(schema.ocr_jobs.id, ocrJobId))
      .returning()
      .all();
    return row ? ({ op: 'ocr-job-upsert', row } as const satisfies SavedUpdate) : undefined;
  };
}
