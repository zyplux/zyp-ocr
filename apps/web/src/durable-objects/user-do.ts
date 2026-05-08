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

export type ApplyCallbackInput = {
  callbackId: string;
  error?: string;
  jobId: string;
  markdownKey?: string;
  pageNumber?: number;
  status: 'done' | 'failed';
};
export type CreateJobInput = {
  jobId?: string;
  sizeBytes: number;
  sourceKeyTemplate: string;
  totalPages: number;
};

export type JobRow = typeof schema.jobs.$inferSelect;
export type JobStatus = JobRow['status'];
export type PageRow = typeof schema.job_pages.$inferSelect;
export type PageStatus = PageRow['status'];

export type Snapshot = {
  jobs: JobRow[];
  pages: PageRow[];
};

type Delta =
  | { op: 'job-upsert'; row: JobRow }
  | { op: 'page-upsert'; row: PageRow }
  | { op: 'snapshot'; snapshot: Snapshot };

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
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(inArray(schema.jobs.status, ['pending', 'processing']), lt(schema.jobs.created_at, cutoff)));
    for (const job of stale) {
      await this.db
        .update(schema.jobs)
        .set({ completed_at: now, error: 'timeout', status: 'failed' })
        .where(eq(schema.jobs.id, job.id));
      this.broadcast({ op: 'job-upsert', row: await this.requireJob(job.id) });
    }
    if ((await this.countInflight()) > 0) {
      await this.ctx.storage.setAlarm(now + this.reconcileTimeoutMs());
    }
  }

  // ---- Public RPC ---------------------------------------------------------

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
        .update(schema.job_pages)
        .set({
          error: input.error ?? sql`NULL`,
          markdown_key: input.markdownKey ?? sql`NULL`,
          status: input.status,
        })
        .where(and(eq(schema.job_pages.job_id, input.jobId), eq(schema.job_pages.page_number, input.pageNumber)));
      this.broadcast({ op: 'page-upsert', row: await this.requirePage(input.jobId, input.pageNumber) });
      await this.maybeCompleteJob(input.jobId);
      return;
    }

    const finalStatus: JobStatus = input.status === 'failed' ? 'failed' : await this.deriveJobStatus(input.jobId);
    await this.db
      .update(schema.jobs)
      .set({
        completed_at: Date.now(),
        error: input.error ?? sql`NULL`,
        status: finalStatus,
      })
      .where(eq(schema.jobs.id, input.jobId));
    this.broadcast({ op: 'job-upsert', row: await this.requireJob(input.jobId) });
  }

  async createJob(input: CreateJobInput) {
    const inflight = await this.countInflight();
    if (inflight >= MAX_INFLIGHT_JOBS) {
      throw new Error(`too many in-flight jobs (max ${MAX_INFLIGHT_JOBS})`);
    }
    const jobId = input.jobId ?? ulid();
    const sourceKey = input.sourceKeyTemplate.replace('{jobId}', jobId);
    const now = Date.now();
    await this.db.insert(schema.jobs).values({
      created_at: now,
      id: jobId,
      size_bytes: input.sizeBytes,
      source_key: sourceKey,
      status: 'pending',
      total_pages: input.totalPages,
    });
    const pageValues = Array.from({ length: input.totalPages }, (_, i) => ({
      job_id: jobId,
      page_number: i + 1,
      status: 'pending' as const,
    }));
    if (pageValues.length > 0) {
      await this.db.insert(schema.job_pages).values(pageValues);
    }
    this.broadcast({ op: 'job-upsert', row: await this.requireJob(jobId) });
    for (let n = 1; n <= input.totalPages; n++) {
      this.broadcast({ op: 'page-upsert', row: await this.requirePage(jobId, n) });
    }
    await this.scheduleReconcile();
    this.ctx.waitUntil(this.submitToPipeline(jobId));
    return { jobId };
  }

  override fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      return Promise.resolve(this.handleWebSocketUpgrade());
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  }

  async setPipelineId(jobId: string, pipelineId: string) {
    await this.db
      .update(schema.jobs)
      .set({ pipeline_id: pipelineId, started_at: Date.now(), status: 'processing' })
      .where(eq(schema.jobs.id, jobId));
    this.broadcast({ op: 'job-upsert', row: await this.requireJob(jobId) });
  }

  async signTokenFor(claims: Omit<CallbackClaims, 'exp'>) {
    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    return await signCallbackToken({ ...claims, exp }, this.env.CALLBACK_HMAC_SECRET);
  }

  // ---- HTTP / WebSocket ---------------------------------------------------

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

  // ---- Alarm reconcile ----------------------------------------------------

  private async countInflight() {
    const [row] = await this.db
      .select({ c: count() })
      .from(schema.jobs)
      .where(inArray(schema.jobs.status, ['pending', 'processing']));
    return row?.c ?? 0;
  }

  // ---- Internals ----------------------------------------------------------

  private async deriveJobStatus(jobId: string) {
    const [row] = await this.db
      .select({ c: count() })
      .from(schema.job_pages)
      .where(and(eq(schema.job_pages.job_id, jobId), eq(schema.job_pages.status, 'failed')));
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

  private async maybeCompleteJob(jobId: string) {
    const [pending] = await this.db
      .select({ c: count() })
      .from(schema.job_pages)
      .where(and(eq(schema.job_pages.job_id, jobId), eq(schema.job_pages.status, 'pending')));
    if (!pending || pending.c > 0) return;
    const status = await this.deriveJobStatus(jobId);
    await this.db
      .update(schema.jobs)
      .set({ completed_at: Date.now(), status })
      .where(eq(schema.jobs.id, jobId));
    this.broadcast({ op: 'job-upsert', row: await this.requireJob(jobId) });
  }

  private async readSnapshot() {
    const jobs = await this.db.select().from(schema.jobs).orderBy(desc(schema.jobs.created_at));
    const pages = await this.db
      .select()
      .from(schema.job_pages)
      .orderBy(schema.job_pages.job_id, schema.job_pages.page_number);
    return { jobs: jobs.map(j => stripNulls(j)), pages: pages.map(p => stripNulls(p)) } satisfies Snapshot;
  }

  private reconcileTimeoutMs() {
    const seconds = Number.parseInt(this.env.RECONCILE_TIMEOUT_SECONDS, 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RECONCILE_TIMEOUT_SECONDS * 1000;
  }

  private async requireJob(jobId: string) {
    const [row] = await this.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
    if (!row) throw new Error(`job not found: ${jobId}`);
    return stripNulls(row);
  }

  private async requirePage(jobId: string, pageNumber: number) {
    const [row] = await this.db
      .select()
      .from(schema.job_pages)
      .where(and(eq(schema.job_pages.job_id, jobId), eq(schema.job_pages.page_number, pageNumber)))
      .limit(1);
    if (!row) throw new Error(`page not found: ${jobId}/${pageNumber}`);
    return stripNulls(row);
  }

  private async scheduleReconcile() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing != undefined) return;
    await this.ctx.storage.setAlarm(Date.now() + this.reconcileTimeoutMs());
  }

  private async submitToPipeline(jobId: string) {
    const job = await this.requireJob(jobId);
    const callbackId = ulid();
    const token = await this.signTokenFor({
      callbackId,
      jobId,
      userId: DEFAULT_USER_ID,
    });
    const callbackBase = this.env.WORKER_INTERNAL_BASE ?? this.env.PUBLIC_BASE;
    const payload = {
      callback_token: token,
      callback_url: `${callbackBase}/api/pipeline/callback`,
      job_id: jobId,
      source_key: job.source_key,
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
      await this.setPipelineId(jobId, ack.pipeline_id);
    } catch (err) {
      await this.db
        .update(schema.jobs)
        .set({
          completed_at: Date.now(),
          error: getMessage(err, 'pipeline submit'),
          status: 'failed',
        })
        .where(eq(schema.jobs.id, jobId));
      this.broadcast({ op: 'job-upsert', row: await this.requireJob(jobId) });
    }
  }
}
