import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import { and, count, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import * as schema from '~/durable-objects/schema';

export type ApplyResultInput = {
  error?: string;
  markdownKey?: string;
  ocrJobId: string;
  pageNumber?: number;
  resultId: string;
  status: 'done' | 'failed';
};

export type ConfirmUploadInput = {
  ocrJobId: string;
  sizeBytes: number;
  totalPages: number;
};

export type ReserveJobInput = {
  ocrJobId: string;
  sizeBytes: number;
  uploadKey: string;
};

export type StoreDb<TRunResult = unknown> = BaseSQLiteDatabase<'sync', TRunResult, typeof schema>;

export class UserStore<TRunResult = unknown> {
  constructor(private readonly db: StoreDb<TRunResult>) {}

  applyResult = (input: ApplyResultInput, now: number) =>
    this.db.transaction(tx => {
      tx.insert(schema.received_results)
        .values({ received_at: now, result_id: input.resultId })
        .onConflictDoNothing()
        .run();

      if (typeof input.pageNumber === 'number') {
        const updated = tx
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
              isNull(schema.md_pages.completed_at),
              isNull(schema.md_pages.error),
            ),
          )
          .returning({ pn: schema.md_pages.page_number })
          .all();
        return updated.length > 0;
      }

      const finalError = input.status === 'failed' ? (input.error ?? 'failed') : sql`NULL`;
      const updated = tx
        .update(schema.ocr_jobs)
        .set({ completed_at: now, error: finalError })
        .where(
          and(
            eq(schema.ocr_jobs.id, input.ocrJobId),
            isNull(schema.ocr_jobs.completed_at),
            isNull(schema.ocr_jobs.error),
          ),
        )
        .returning({ id: schema.ocr_jobs.id })
        .all();
      return updated.length > 0;
    });

  completeJobIfRunning = async (ocrJobId: string, error: string | undefined, completedAt: number) => {
    await this.db
      .update(schema.ocr_jobs)
      .set({ completed_at: completedAt, error: error ?? sql`NULL` })
      .where(
        and(eq(schema.ocr_jobs.id, ocrJobId), isNull(schema.ocr_jobs.completed_at), isNull(schema.ocr_jobs.error)),
      );
  };

  confirmUpload = async (input: ConfirmUploadInput, now: number) => {
    await this.db
      .update(schema.ocr_jobs)
      .set({ size_bytes: input.sizeBytes, total_pages: input.totalPages })
      .where(eq(schema.ocr_jobs.id, input.ocrJobId));
    if (input.totalPages > 0) {
      const pageValues = Array.from({ length: input.totalPages }, (_, i) => ({
        created_at: now,
        ocr_job_id: input.ocrJobId,
        page_number: i + 1,
      }));
      await this.db.insert(schema.md_pages).values(pageValues);
    }
  };

  countInflight = async () => {
    const [row] = await this.db
      .select({ c: count() })
      .from(schema.ocr_jobs)
      .where(and(isNull(schema.ocr_jobs.completed_at), isNull(schema.ocr_jobs.error)));
    return row?.c ?? 0;
  };

  countInflightPages = async (ocrJobId: string) => {
    const [row] = await this.db
      .select({ c: count() })
      .from(schema.md_pages)
      .where(
        and(
          eq(schema.md_pages.ocr_job_id, ocrJobId),
          isNull(schema.md_pages.completed_at),
          isNull(schema.md_pages.error),
        ),
      );
    return row?.c ?? 0;
  };

  failJob = async (ocrJobId: string, error: string, completedAt: number) => {
    await this.db
      .update(schema.ocr_jobs)
      .set({ completed_at: completedAt, error })
      .where(eq(schema.ocr_jobs.id, ocrJobId));
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
      .where(
        and(
          isNull(schema.ocr_jobs.completed_at),
          isNull(schema.ocr_jobs.error),
          lt(schema.ocr_jobs.created_at, cutoff),
        ),
      );

  hasFailedPage = async (ocrJobId: string) => {
    const [row] = await this.db
      .select({ c: count() })
      .from(schema.md_pages)
      .where(and(eq(schema.md_pages.ocr_job_id, ocrJobId), isNotNull(schema.md_pages.error)));
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

  reserveJob = async (input: ReserveJobInput, createdAt: number) => {
    await this.db.insert(schema.ocr_jobs).values({
      created_at: createdAt,
      id: input.ocrJobId,
      size_bytes: input.sizeBytes,
      total_pages: 0,
      upload_key: input.uploadKey,
    });
  };

  setPipelineId = async (ocrJobId: string, pipelineId: string, startedAt: number) => {
    await this.db
      .update(schema.ocr_jobs)
      .set({ pipeline_id: pipelineId, started_at: startedAt })
      .where(eq(schema.ocr_jobs.id, ocrJobId));
  };
}
