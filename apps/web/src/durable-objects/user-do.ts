import { DurableObject } from 'cloudflare:workers';
import { and, count, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { ulid } from 'ulid';

import { DEFAULT_RECONCILE_TIMEOUT_SECONDS, DEFAULT_USER_ID, MAX_INFLIGHT_JOBS, TOKEN_TTL_SECONDS } from '~/constants';
import migrations from '~/durable-objects/migrations';
import * as schema from '~/durable-objects/schema';
import { type CallbackClaims, signCallbackToken } from '~/lib/callback-token';
import { getMessage } from '~/lib/error';
import { blob } from '~/lib/s3';

export type ApplyCallbackInput = {
  callbackId: string;
  error?: string;
  markdownKey?: string;
  ocrJobId: string;
  pageNumber?: number;
  status: 'done' | 'failed';
};

export type ConfirmUploadInput = {
  ocrJobId: string;
  sizeBytes: number;
  totalPages: number;
};

export type MdPageRow = typeof schema.md_pages.$inferSelect;

export type OcrJobRow = typeof schema.ocr_jobs.$inferSelect;

export type ReserveUploadInput = {
  ocrJobId: string;
  sizeBytes: number;
  uploadKey: string;
};

export type Snapshot = {
  md_pages: MdPageRow[];
  ocr_jobs: OcrJobRow[];
};

type Delta =
  | { op: 'md-page-upsert'; row: MdPageRow }
  | { op: 'ocr-job-upsert'; row: OcrJobRow }
  | { op: 'snapshot'; snapshot: Snapshot };

type OcrJobStatus = OcrJobRow['status'];

const stripNulls = <T extends Record<string, unknown>>(row: T): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== null) out[k] = v;
  }
  return out as T;
};

export class UserDO extends DurableObject<Env> {
  private db: DrizzleSqliteDODatabase<typeof schema>;

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
      .select({ id: schema.ocr_jobs.id, status: schema.ocr_jobs.status, upload_key: schema.ocr_jobs.upload_key })
      .from(schema.ocr_jobs)
      .where(
        and(
          inArray(schema.ocr_jobs.status, ['awaiting_upload', 'uploaded', 'transcribing']),
          lt(schema.ocr_jobs.created_at, cutoff),
        ),
      );
    for (const ocrJob of stale) {
      if (ocrJob.status === 'awaiting_upload') {
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
          error: ocrJob.status === 'awaiting_upload' ? 'upload abandoned' : 'timeout',
          status: 'failed',
        })
        .where(eq(schema.ocr_jobs.id, ocrJob.id));
      this.broadcast({ op: 'ocr-job-upsert', row: await this.requireOcrJob(ocrJob.id) });
    }
    if ((await this.countInflight()) > 0) {
      await this.ctx.storage.setAlarm(now + this.reconcileTimeoutMs());
    }
  }

  async applyCallback(input: ApplyCallbackInput) {
    const seen = await this.db
      .select({ id: schema.callbacks_seen.callback_id })
      .from(schema.callbacks_seen)
      .where(eq(schema.callbacks_seen.callback_id, input.callbackId))
      .limit(1);
    if (seen.length > 0) return;
    await this.db.insert(schema.callbacks_seen).values({
      callback_id: input.callbackId,
      seen_at: Date.now(),
    });

    if (typeof input.pageNumber === 'number') {
      await this.db
        .update(schema.md_pages)
        .set({
          error: input.error ?? sql`NULL`,
          markdown_key: input.markdownKey ?? sql`NULL`,
          status: input.status,
        })
        .where(and(eq(schema.md_pages.ocr_job_id, input.ocrJobId), eq(schema.md_pages.page_number, input.pageNumber)));
      this.broadcast({ op: 'md-page-upsert', row: await this.requireMdPage(input.ocrJobId, input.pageNumber) });
      await this.maybeCompleteOcrJob(input.ocrJobId);
      return;
    }

    const finalStatus: OcrJobStatus =
      input.status === 'failed' ? 'failed' : await this.deriveOcrJobStatus(input.ocrJobId);
    await this.db
      .update(schema.ocr_jobs)
      .set({
        completed_at: Date.now(),
        error: input.error ?? sql`NULL`,
        status: finalStatus,
      })
      .where(eq(schema.ocr_jobs.id, input.ocrJobId));
    this.broadcast({ op: 'ocr-job-upsert', row: await this.requireOcrJob(input.ocrJobId) });
  }

  async confirmUpload(input: ConfirmUploadInput) {
    await this.db
      .update(schema.ocr_jobs)
      .set({ size_bytes: input.sizeBytes, status: 'uploaded', total_pages: input.totalPages })
      .where(eq(schema.ocr_jobs.id, input.ocrJobId));
    const pageValues = Array.from({ length: input.totalPages }, (_, i) => ({
      ocr_job_id: input.ocrJobId,
      page_number: i + 1,
      status: 'transcribing' as const,
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
      .set({ completed_at: Date.now(), error, status: 'failed' })
      .where(eq(schema.ocr_jobs.id, ocrJobId));
    this.broadcast({ op: 'ocr-job-upsert', row: await this.requireOcrJob(ocrJobId) });
  }

  override fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      return Promise.resolve(this.handleWebSocketUpgrade());
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  }

  async reserveUpload(input: ReserveUploadInput) {
    if ((await this.countInflight()) >= MAX_INFLIGHT_JOBS) {
      throw new Error(`too many in-flight jobs (max ${MAX_INFLIGHT_JOBS})`);
    }
    await this.db.insert(schema.ocr_jobs).values({
      created_at: Date.now(),
      id: input.ocrJobId,
      size_bytes: input.sizeBytes,
      status: 'awaiting_upload',
      total_pages: 0,
      upload_key: input.uploadKey,
    });
    this.broadcast({ op: 'ocr-job-upsert', row: await this.requireOcrJob(input.ocrJobId) });
    await this.scheduleReconcile();
  }

  async setPipelineId(ocrJobId: string, pipelineId: string) {
    await this.db
      .update(schema.ocr_jobs)
      .set({ pipeline_id: pipelineId, started_at: Date.now(), status: 'transcribing' })
      .where(eq(schema.ocr_jobs.id, ocrJobId));
    this.broadcast({ op: 'ocr-job-upsert', row: await this.requireOcrJob(ocrJobId) });
  }

  async signTokenFor(claims: Omit<CallbackClaims, 'exp'>) {
    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    return await signCallbackToken({ ...claims, exp }, this.env.CALLBACK_HMAC_SECRET);
  }

  async snapshot() {
    return await this.readSnapshot();
  }

  override webSocketClose(ws: WebSocket) {
    try {
      ws.close();
    } catch {
      /* noop */
    }
  }

  private broadcast(delta: Delta) {
    const message = JSON.stringify(delta);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        /* hibernating sockets surface errors lazily; ignore */
      }
    }
  }

  private async countInflight() {
    const [row] = await this.db
      .select({ c: count() })
      .from(schema.ocr_jobs)
      .where(inArray(schema.ocr_jobs.status, ['awaiting_upload', 'uploaded', 'transcribing']));
    return row?.c ?? 0;
  }

  private async deriveOcrJobStatus(ocrJobId: string) {
    const [row] = await this.db
      .select({ c: count() })
      .from(schema.md_pages)
      .where(and(eq(schema.md_pages.ocr_job_id, ocrJobId), eq(schema.md_pages.status, 'failed')));
    return (row?.c ?? 0) > 0 ? 'failed' : 'done';
  }

  private async handleWebSocketUpgrade() {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const snap = await this.readSnapshot();
    server.send(JSON.stringify({ op: 'snapshot', snapshot: snap } satisfies Delta));
    return new Response(undefined, { status: 101, webSocket: client });
  }

  private async maybeCompleteOcrJob(ocrJobId: string) {
    const [transcribing] = await this.db
      .select({ c: count() })
      .from(schema.md_pages)
      .where(and(eq(schema.md_pages.ocr_job_id, ocrJobId), eq(schema.md_pages.status, 'transcribing')));
    if (!transcribing || transcribing.c > 0) return;
    const status = await this.deriveOcrJobStatus(ocrJobId);
    await this.db
      .update(schema.ocr_jobs)
      .set({ completed_at: Date.now(), status })
      .where(eq(schema.ocr_jobs.id, ocrJobId));
    this.broadcast({ op: 'ocr-job-upsert', row: await this.requireOcrJob(ocrJobId) });
  }

  private async readSnapshot() {
    const ocr_jobs = await this.db.select().from(schema.ocr_jobs).orderBy(desc(schema.ocr_jobs.created_at));
    const md_pages = await this.db
      .select()
      .from(schema.md_pages)
      .orderBy(schema.md_pages.ocr_job_id, schema.md_pages.page_number);
    return {
      md_pages: md_pages.map(p => stripNulls(p)),
      ocr_jobs: ocr_jobs.map(j => stripNulls(j)),
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
    return stripNulls(row);
  }

  private async requireOcrJob(ocrJobId: string) {
    const [row] = await this.db.select().from(schema.ocr_jobs).where(eq(schema.ocr_jobs.id, ocrJobId)).limit(1);
    if (!row) throw new Error(`ocr job not found: ${ocrJobId}`);
    return stripNulls(row);
  }

  private async scheduleReconcile() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing != undefined) return;
    await this.ctx.storage.setAlarm(Date.now() + this.reconcileTimeoutMs());
  }

  private async submitToPipeline(ocrJobId: string) {
    const ocrJob = await this.requireOcrJob(ocrJobId);
    const callbackId = ulid();
    const token = await this.signTokenFor({
      callbackId,
      ocrJobId,
      userId: DEFAULT_USER_ID,
    });
    const callbackBase = this.env.WORKER_INTERNAL_BASE ?? this.env.PUBLIC_BASE;
    const payload = {
      callback_token: token,
      callback_url: `${callbackBase}/api/pipeline/callback`,
      ocr_job_id: ocrJobId,
      upload_key: ocrJob.upload_key,
    };
    try {
      const res = await fetch(`${this.env.PIPELINE_BASE}/submit`, {
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`pipeline /submit: ${res.status} ${body}`);
      }
      const ack: { pipeline_id: string } = await res.json();
      await this.setPipelineId(ocrJobId, ack.pipeline_id);
    } catch (err) {
      await this.db
        .update(schema.ocr_jobs)
        .set({
          completed_at: Date.now(),
          error: getMessage(err, 'pipeline submit'),
          status: 'failed',
        })
        .where(eq(schema.ocr_jobs.id, ocrJobId));
      this.broadcast({ op: 'ocr-job-upsert', row: await this.requireOcrJob(ocrJobId) });
    }
  }
}
