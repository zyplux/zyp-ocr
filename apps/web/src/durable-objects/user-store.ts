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

  completeJobIfRunning(ocrJobId: string, error: string | undefined, completedAt: number) {
    const [row] = this.db
      .update(schema.ocrJobs)
      .set({ completed_at: completedAt, error: error ?? sql`NULL` })
      .where(and(eq(schema.ocrJobs.id, ocrJobId), eq(schema.ocrJobs.status, 'transcribing')))
      .returning()
      .all();
    return row ? ({ op: 'ocr-job-upsert', row } as const satisfies SavedUpdate) : undefined;
  }

  confirmUpload({ ocrJobId, sizeBytes, totalPages }: ConfirmUploadInput, now: number) {
    const broadcasts: SavedUpdate[] = [];
    const [jobRow] = this.db
      .update(schema.ocrJobs)
      .set({ size_bytes: sizeBytes, total_pages: totalPages })
      .where(eq(schema.ocrJobs.id, ocrJobId))
      .returning()
      .all();
    if (!jobRow) return broadcasts;
    broadcasts.push({ op: 'ocr-job-upsert', row: jobRow });
    if (totalPages > 0) {
      const pageValues = Array.from({ length: totalPages }, (_, i) => ({
        created_at: now,
        ocr_job_id: ocrJobId,
        page_number: i + 1,
      }));
      const pageRows = this.db.insert(schema.mdPages).values(pageValues).returning().all();
      for (const row of pageRows) broadcasts.push({ op: 'md-page-upsert', row });
    }
    return broadcasts;
  }

  async countInflight() {
    const [row] = await this.db
      .select({ c: count() })
      .from(schema.ocrJobs)
      .where(notInArray(schema.ocrJobs.status, ['done', 'failed']));
    return row?.c ?? 0;
  }

  async countInflightPages(ocrJobId: string) {
    const [row] = await this.db
      .select({ c: count() })
      .from(schema.mdPages)
      .where(and(eq(schema.mdPages.ocr_job_id, ocrJobId), eq(schema.mdPages.status, 'transcribing')));
    return row?.c ?? 0;
  }

  failJob(ocrJobId: string, error: string, completedAt: number) {
    const [row] = this.db
      .update(schema.ocrJobs)
      .set({ completed_at: completedAt, error })
      .where(eq(schema.ocrJobs.id, ocrJobId))
      .returning()
      .all();
    return row ? ({ op: 'ocr-job-upsert', row } as const satisfies SavedUpdate) : undefined;
  }

  async findStaleJobs(cutoff: number) {
    return await this.db
      .select({
        id: schema.ocrJobs.id,
        started_at: schema.ocrJobs.started_at,
        total_pages: schema.ocrJobs.total_pages,
        upload_key: schema.ocrJobs.upload_key,
      })
      .from(schema.ocrJobs)
      .where(and(notInArray(schema.ocrJobs.status, ['done', 'failed']), lt(schema.ocrJobs.created_at, cutoff)));
  }

  async hasFailedPage(ocrJobId: string) {
    const [row] = await this.db
      .select({ c: count() })
      .from(schema.mdPages)
      .where(and(eq(schema.mdPages.ocr_job_id, ocrJobId), eq(schema.mdPages.status, 'failed')));
    return (row?.c ?? 0) > 0;
  }

  async readSnapshot() {
    const ocrRows = await this.db.select().from(schema.ocrJobs).orderBy(desc(schema.ocrJobs.created_at));
    const pageRows = await this.db
      .select()
      .from(schema.mdPages)
      .orderBy(schema.mdPages.ocr_job_id, schema.mdPages.page_number);
    return { md_pages: pageRows, ocr_jobs: ocrRows };
  }

  async requireMdPage(ocrJobId: string, pageNumber: number) {
    const [row] = await this.db
      .select()
      .from(schema.mdPages)
      .where(and(eq(schema.mdPages.ocr_job_id, ocrJobId), eq(schema.mdPages.page_number, pageNumber)))
      .limit(1);
    if (!row) throw new Error(`md page not found: ${ocrJobId}/${pageNumber}`);
    return row;
  }

  async requireOcrJob(ocrJobId: string) {
    const [row] = await this.db.select().from(schema.ocrJobs).where(eq(schema.ocrJobs.id, ocrJobId)).limit(1);
    if (!row) throw new Error(`ocr job not found: ${ocrJobId}`);
    return row;
  }

  reserveJob({ ocrJobId, sizeBytes, uploadKey }: ReserveUploadInput, createdAt: number) {
    const [row] = this.db
      .insert(schema.ocrJobs)
      .values({
        created_at: createdAt,
        id: ocrJobId,
        size_bytes: sizeBytes,
        total_pages: 0,
        upload_key: uploadKey,
      })
      .returning()
      .all();
    return row ? ({ op: 'ocr-job-upsert', row } as const satisfies SavedUpdate) : undefined;
  }

  saveUpdate({ error, markdownKey, ocrJobId, pageNumber, status }: TranscriptionUpdate, now: number) {
    return this.db.transaction(tx => {
      if (typeof pageNumber === 'number') {
        const [row] = tx
          .update(schema.mdPages)
          .set({
            completed_at: now,
            error: status === 'failed' ? (error ?? 'failed') : sql`NULL`,
            markdown_key: markdownKey ?? sql`NULL`,
          })
          .where(
            and(
              eq(schema.mdPages.ocr_job_id, ocrJobId),
              eq(schema.mdPages.page_number, pageNumber),
              eq(schema.mdPages.status, 'transcribing'),
            ),
          )
          .returning()
          .all();
        return row ? ({ op: 'md-page-upsert', row } as const satisfies SavedUpdate) : undefined;
      }

      const finalError = status === 'failed' ? (error ?? 'failed') : sql`NULL`;
      const [row] = tx
        .update(schema.ocrJobs)
        .set({ completed_at: now, error: finalError })
        .where(and(eq(schema.ocrJobs.id, ocrJobId), eq(schema.ocrJobs.status, 'transcribing')))
        .returning()
        .all();
      return row ? ({ op: 'ocr-job-upsert', row } as const satisfies SavedUpdate) : undefined;
    });
  }

  setPipelineId(ocrJobId: string, pipelineId: string, startedAt: number) {
    const [row] = this.db
      .update(schema.ocrJobs)
      .set({ pipeline_id: pipelineId, started_at: startedAt })
      .where(eq(schema.ocrJobs.id, ocrJobId))
      .returning()
      .all();
    return row ? ({ op: 'ocr-job-upsert', row } as const satisfies SavedUpdate) : undefined;
  }
}
