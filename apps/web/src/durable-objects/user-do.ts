import { DurableObject } from 'cloudflare:workers';
import { and, count, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { ulid } from 'ulid';

import { DEFAULT_RECONCILE_TIMEOUT_SECONDS, DEFAULT_USER_ID, MAX_INFLIGHT_JOBS, TOKEN_TTL_SECONDS } from '~/constants';
import migrations from '~/durable-objects/migrations';
import * as schema from '~/durable-objects/schema';
import { getMessage } from '~/lib/error';
import { type ResultClaims, signResultToken } from '~/lib/result-token';
import { blob } from '~/lib/s3';

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

export type MdPageRow = schema.MdPageDbRow & { status: schema.MdPageStatus };

export type OcrJobRow = schema.OcrJobDbRow & { status: schema.OcrJobStatus };

export type ReserveUploadInput = {
  ocrJobId: string;
  sizeBytes: number;
  uploadKey: string;
};

export type Snapshot = {
  md_pages: MdPageRow[];
  ocr_jobs: OcrJobRow[];
};

export type SubscribeResult = { id: string; stream: ReadableStream<Uint8Array> };

type Delta =
  | { op: 'md-page-upsert'; row: MdPageRow }
  | { op: 'ocr-job-upsert'; row: OcrJobRow }
  | { op: 'snapshot'; snapshot: Snapshot };

const stripNulls = <T extends Record<string, unknown>>(row: T): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== null) out[k] = v;
  }
  return out as T;
};

const withOcrJobStatus = (row: schema.OcrJobDbRow) => ({
  ...stripNulls(row),
  status: schema.deriveOcrJobStatus(row),
});

const withMdPageStatus = (row: schema.MdPageDbRow) => ({
  ...stripNulls(row),
  status: schema.deriveMdPageStatus(row),
});

const PAGES_FAILED_REASON = 'one or more pages failed';

const sseEncoder = new TextEncoder();
const formatSseEvent = (delta: Delta) => sseEncoder.encode(`data: ${JSON.stringify(delta)}\n\n`);

export class UserDO extends DurableObject<Env> {
  private db: DrizzleSqliteDODatabase<typeof schema>;
  // Per-subscriber writers; consumers (SSE proxies) get the readable half via
  // `subscribe()` and call `unsubscribe(id)` when their downstream HTTP request
  // aborts. Replaces the prior hibernation-aware WebSocket fanout.
  private subscribers = new Map<string, WritableStreamDefaultWriter<Uint8Array>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false, schema });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  override async alarm() {
    const now = Date.now();
    const cutoff = now - this.reconcileTimeoutMs();
    const stale = await this.db
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
    for (const ocrJob of stale) {
      const isAwaitingUpload = ocrJob.total_pages === 0 && ocrJob.started_at === null;
      if (isAwaitingUpload) {
        try {
          await blob.delete(this.env, ocrJob.upload_key);
        } catch {
          /* best-effort cleanup; failed delete should not block fail-marking */
        }
      }
      await this.db
        .update(schema.ocr_jobs)
        .set({
          completed_at: now,
          error: isAwaitingUpload ? 'upload abandoned' : 'timeout',
        })
        .where(eq(schema.ocr_jobs.id, ocrJob.id));
      this.broadcast({ op: 'ocr-job-upsert', row: await this.requireOcrJob(ocrJob.id) });
    }
    if ((await this.countInflight()) > 0) {
      await this.ctx.storage.setAlarm(now + this.reconcileTimeoutMs());
    }
  }

  // Per-result delivery handler: audit the delivery for forensics, then
  // CAS-update the target row with a "still in flight" predicate. If the row
  // already moved to a terminal state (replay or out-of-order), the audit row
  // is still written but the data write is a no-op and we skip broadcasts.
  // The DO is single-writer, so the transaction wraps the two writes purely
  // for atomicity-on-error; concurrency is not a concern.
  async applyResult(input: ApplyResultInput) {
    const now = Date.now();
    const applied = await this.db.transaction(async tx => {
      await tx
        .insert(schema.received_results)
        .values({ received_at: now, result_id: input.resultId })
        .onConflictDoNothing();

      if (typeof input.pageNumber === 'number') {
        const updated = await tx
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
          .returning({ pn: schema.md_pages.page_number });
        return updated.length > 0;
      }

      const finalError = input.status === 'failed' ? (input.error ?? 'failed') : sql`NULL`;
      const updated = await tx
        .update(schema.ocr_jobs)
        .set({ completed_at: now, error: finalError })
        .where(
          and(
            eq(schema.ocr_jobs.id, input.ocrJobId),
            isNull(schema.ocr_jobs.completed_at),
            isNull(schema.ocr_jobs.error),
          ),
        )
        .returning({ id: schema.ocr_jobs.id });
      return updated.length > 0;
    });

    if (!applied) return;

    if (typeof input.pageNumber === 'number') {
      this.broadcast({ op: 'md-page-upsert', row: await this.requireMdPage(input.ocrJobId, input.pageNumber) });
      await this.maybeCompleteOcrJob(input.ocrJobId);
      return;
    }
    this.broadcast({ op: 'ocr-job-upsert', row: await this.requireOcrJob(input.ocrJobId) });
  }

  async confirmUpload(input: ConfirmUploadInput) {
    await this.db
      .update(schema.ocr_jobs)
      .set({ size_bytes: input.sizeBytes, total_pages: input.totalPages })
      .where(eq(schema.ocr_jobs.id, input.ocrJobId));
    const now = Date.now();
    const pageValues = Array.from({ length: input.totalPages }, (_, i) => ({
      created_at: now,
      ocr_job_id: input.ocrJobId,
      page_number: i + 1,
    }));
    if (pageValues.length > 0) {
      await this.db.insert(schema.md_pages).values(pageValues);
    }
    this.broadcast({ op: 'ocr-job-upsert', row: await this.requireOcrJob(input.ocrJobId) });
    for (let n = 1; n <= input.totalPages; n++) {
      this.broadcast({ op: 'md-page-upsert', row: await this.requireMdPage(input.ocrJobId, n) });
    }
    this.ctx.waitUntil(this.submitToPipeline(input.ocrJobId));
  }

  async failUpload(ocrJobId: string, error: string) {
    await this.db
      .update(schema.ocr_jobs)
      .set({ completed_at: Date.now(), error })
      .where(eq(schema.ocr_jobs.id, ocrJobId));
    this.broadcast({ op: 'ocr-job-upsert', row: await this.requireOcrJob(ocrJobId) });
  }

  async reserveUpload(input: ReserveUploadInput) {
    if ((await this.countInflight()) >= MAX_INFLIGHT_JOBS) {
      throw new Error(`too many in-flight jobs (max ${MAX_INFLIGHT_JOBS})`);
    }
    await this.db.insert(schema.ocr_jobs).values({
      created_at: Date.now(),
      id: input.ocrJobId,
      size_bytes: input.sizeBytes,
      total_pages: 0,
      upload_key: input.uploadKey,
    });
    this.broadcast({ op: 'ocr-job-upsert', row: await this.requireOcrJob(input.ocrJobId) });
    await this.scheduleReconcile();
  }

  async setPipelineId(ocrJobId: string, pipelineId: string) {
    await this.db
      .update(schema.ocr_jobs)
      .set({ pipeline_id: pipelineId, started_at: Date.now() })
      .where(eq(schema.ocr_jobs.id, ocrJobId));
    this.broadcast({ op: 'ocr-job-upsert', row: await this.requireOcrJob(ocrJobId) });
  }

  async signTokenFor(claims: Omit<ResultClaims, 'exp'>) {
    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    return await signResultToken({ ...claims, exp }, this.env.RESULT_HMAC_SECRET);
  }

  async snapshot() {
    return await this.readSnapshot();
  }

  async subscribe() {
    const id = ulid();
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    this.subscribers.set(id, writer);
    const snap = await this.readSnapshot();
    try {
      await writer.write(formatSseEvent({ op: 'snapshot', snapshot: snap }));
    } catch {
      this.subscribers.delete(id);
      try {
        await writer.close();
      } catch {
        /* noop */
      }
    }
    return { id, stream: stream.readable };
  }

  unsubscribe(id: string) {
    const writer = this.subscribers.get(id);
    if (!writer) return;
    this.subscribers.delete(id);
    try {
      void writer.close();
    } catch {
      /* noop */
    }
  }

  private broadcast(delta: Delta) {
    if (this.subscribers.size === 0) return;
    const payload = formatSseEvent(delta);
    for (const [id, writer] of this.subscribers) {
      writer.write(payload).catch(() => {
        this.subscribers.delete(id);
      });
    }
  }

  private async countInflight() {
    const [row] = await this.db
      .select({ c: count() })
      .from(schema.ocr_jobs)
      .where(and(isNull(schema.ocr_jobs.completed_at), isNull(schema.ocr_jobs.error)));
    return row?.c ?? 0;
  }

  private async hasFailedPage(ocrJobId: string) {
    const [row] = await this.db
      .select({ c: count() })
      .from(schema.md_pages)
      .where(and(eq(schema.md_pages.ocr_job_id, ocrJobId), isNotNull(schema.md_pages.error)));
    return (row?.c ?? 0) > 0;
  }

  private async maybeCompleteOcrJob(ocrJobId: string) {
    const [inflight] = await this.db
      .select({ c: count() })
      .from(schema.md_pages)
      .where(
        and(
          eq(schema.md_pages.ocr_job_id, ocrJobId),
          isNull(schema.md_pages.completed_at),
          isNull(schema.md_pages.error),
        ),
      );
    if (!inflight || inflight.c > 0) return;
    const failed = await this.hasFailedPage(ocrJobId);
    await this.db
      .update(schema.ocr_jobs)
      .set({ completed_at: Date.now(), error: failed ? PAGES_FAILED_REASON : sql`NULL` })
      .where(
        and(eq(schema.ocr_jobs.id, ocrJobId), isNull(schema.ocr_jobs.completed_at), isNull(schema.ocr_jobs.error)),
      );
    this.broadcast({ op: 'ocr-job-upsert', row: await this.requireOcrJob(ocrJobId) });
  }

  private async readSnapshot() {
    const ocrRows = await this.db.select().from(schema.ocr_jobs).orderBy(desc(schema.ocr_jobs.created_at));
    const pageRows = await this.db
      .select()
      .from(schema.md_pages)
      .orderBy(schema.md_pages.ocr_job_id, schema.md_pages.page_number);
    return {
      md_pages: pageRows.map(p => withMdPageStatus(p)),
      ocr_jobs: ocrRows.map(j => withOcrJobStatus(j)),
    } satisfies Snapshot;
  }

  private reconcileTimeoutMs() {
    const seconds = Number.parseInt(this.env.RECONCILE_TIMEOUT_SECONDS, 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RECONCILE_TIMEOUT_SECONDS * 1000;
  }

  private async requireMdPage(ocrJobId: string, pageNumber: number) {
    const [row] = await this.db
      .select()
      .from(schema.md_pages)
      .where(and(eq(schema.md_pages.ocr_job_id, ocrJobId), eq(schema.md_pages.page_number, pageNumber)))
      .limit(1);
    if (!row) throw new Error(`md page not found: ${ocrJobId}/${pageNumber}`);
    return withMdPageStatus(row);
  }

  private async requireOcrJob(ocrJobId: string) {
    const [row] = await this.db.select().from(schema.ocr_jobs).where(eq(schema.ocr_jobs.id, ocrJobId)).limit(1);
    if (!row) throw new Error(`ocr job not found: ${ocrJobId}`);
    return withOcrJobStatus(row);
  }

  private async scheduleReconcile() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + this.reconcileTimeoutMs());
  }

  private async submitToPipeline(ocrJobId: string) {
    const ocrJob = await this.requireOcrJob(ocrJobId);
    const resultId = ulid();
    const token = await this.signTokenFor({
      ocrJobId,
      resultId,
      userId: DEFAULT_USER_ID,
    });
    const resultBase = this.env.WORKER_INTERNAL_BASE ?? this.env.PUBLIC_BASE;
    const payload = {
      ocr_job_id: ocrJobId,
      result_token: token,
      result_url: `${resultBase}/api/transcription/results`,
      upload_key: ocrJob.upload_key,
    };
    try {
      const res = await fetch(`${this.env.TRANSCRIPTION_BASE}/submit`, {
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`transcription /submit: ${res.status} ${body}`);
      }
      const ack: { pipeline_id: string } = await res.json();
      await this.setPipelineId(ocrJobId, ack.pipeline_id);
    } catch (err) {
      await this.db
        .update(schema.ocr_jobs)
        .set({
          completed_at: Date.now(),
          error: getMessage(err, 'transcription submit'),
        })
        .where(eq(schema.ocr_jobs.id, ocrJobId));
      this.broadcast({ op: 'ocr-job-upsert', row: await this.requireOcrJob(ocrJobId) });
    }
  }
}
