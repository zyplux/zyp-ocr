import { DurableObject } from 'cloudflare:workers';
import { ulid } from 'ulid';

import { type CallbackClaims, signCallbackToken } from '../lib/callback-token';
import schemaSql from './user-do.sql?raw';

export type ApplyCallbackInput = {
  callbackId: string;
  error?: string;
  jobId: string;
  markdownKey?: string;
  pageNumber?: number;
  status: 'done' | 'failed';
};
export type CreateJobInput = {
  sizeBytes: number;
  // Template using `{jobId}` placeholder; the DO substitutes its generated id.
  sourceKeyTemplate: string;
  totalPages: number;
};

export type JobRow = {
  completed_at?: number;
  created_at: number;
  error?: string;
  id: string;
  pipeline_id?: string;
  size_bytes: number;
  source_key: string;
  started_at?: number;
  status: JobStatus;
  total_pages: number;
};

export type JobStatus = 'done' | 'failed' | 'pending' | 'processing';

export type PageRow = {
  error?: string;
  job_id: string;
  markdown_key?: string;
  page_number: number;
  status: PageStatus;
};

const SQL_NULL = JSON.parse('null') as SqlStorageValue;

type SqlRow = Record<string, SqlStorageValue>;

const cleanRow = (raw: SqlRow): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== SQL_NULL) out[k] = v;
  }
  return out;
};

export type PageStatus = 'done' | 'failed' | 'pending';

export type Snapshot = {
  jobs: JobRow[];
  pages: PageRow[];
};

type Delta =
  | { op: 'job-upsert'; row: JobRow }
  | { op: 'page-upsert'; row: PageRow }
  | { op: 'snapshot'; snapshot: Snapshot };

const MAX_INFLIGHT_JOBS = 10;
const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_USER_ID = 'default';

export class UserDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      this.migrate();
      return Promise.resolve();
    });
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const cutoff = now - this.reconcileTimeoutMs();
    const stale = (
      this.ctx.storage.sql
        .exec(
          `SELECT * FROM jobs
         WHERE status IN ('pending','processing')
           AND created_at < ?`,
          cutoff,
        )
        .toArray() as SqlRow[]
    ).map(r => cleanRow(r) as unknown as JobRow);
    for (const job of stale) {
      this.ctx.storage.sql.exec(
        `UPDATE jobs SET status = 'failed', error = 'timeout', completed_at = ? WHERE id = ?`,
        now,
        job.id,
      );
      this.broadcast({ op: 'job-upsert', row: this.requireJob(job.id) });
    }
    // Reschedule if anything remains in-flight
    if (this.countInflight() > 0) {
      await this.ctx.storage.setAlarm(now + this.reconcileTimeoutMs());
    }
  }

  // ---- Public RPC ---------------------------------------------------------

  applyCallback(input: ApplyCallbackInput): Promise<void> {
    const seen = this.ctx.storage.sql
      .exec(`SELECT 1 FROM callbacks_seen WHERE callback_id = ?`, input.callbackId)
      .toArray();
    if (seen.length > 0) return Promise.resolve();
    this.ctx.storage.sql.exec(
      `INSERT INTO callbacks_seen (callback_id, seen_at) VALUES (?, ?)`,
      input.callbackId,
      Date.now(),
    );

    if (typeof input.pageNumber === 'number') {
      this.ctx.storage.sql.exec(
        `UPDATE job_pages
         SET status = ?, markdown_key = ?, error = ?
         WHERE job_id = ? AND page_number = ?`,
        input.status,
        input.markdownKey ?? SQL_NULL,
        input.error ?? SQL_NULL,
        input.jobId,
        input.pageNumber,
      );
      const page = this.requirePage(input.jobId, input.pageNumber);
      this.broadcast({ op: 'page-upsert', row: page });
      this.maybeCompleteJob(input.jobId);
      return Promise.resolve();
    }

    // Job-level final callback
    const finalStatus: JobStatus = input.status === 'failed' ? 'failed' : this.deriveJobStatus(input.jobId);
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET status = ?, completed_at = ?, error = ? WHERE id = ?`,
      finalStatus,
      Date.now(),
      input.error ?? SQL_NULL,
      input.jobId,
    );
    this.broadcast({ op: 'job-upsert', row: this.requireJob(input.jobId) });
    return Promise.resolve();
  }

  async createJob(input: CreateJobInput): Promise<{ jobId: string }> {
    const inflight = this.countInflight();
    if (inflight >= MAX_INFLIGHT_JOBS) {
      throw new Error(`too many in-flight jobs (max ${MAX_INFLIGHT_JOBS})`);
    }
    const jobId = ulid();
    const sourceKey = input.sourceKeyTemplate.replace('{jobId}', jobId);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO jobs (id, status, source_key, size_bytes, total_pages, created_at)
       VALUES (?, 'pending', ?, ?, ?, ?)`,
      jobId,
      sourceKey,
      input.sizeBytes,
      input.totalPages,
      now,
    );
    for (let n = 1; n <= input.totalPages; n++) {
      this.ctx.storage.sql.exec(
        `INSERT INTO job_pages (job_id, page_number, status) VALUES (?, ?, 'pending')`,
        jobId,
        n,
      );
    }
    this.broadcast({ op: 'job-upsert', row: this.requireJob(jobId) });
    for (let n = 1; n <= input.totalPages; n++) {
      this.broadcast({ op: 'page-upsert', row: this.requirePage(jobId, n) });
    }
    await this.scheduleReconcile();
    this.ctx.waitUntil(this.submitToPipeline(jobId));
    return { jobId };
  }

  override fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      return Promise.resolve(this.handleWebSocketUpgrade());
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  }

  setPipelineId(jobId: string, pipelineId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET pipeline_id = ?, status = 'processing', started_at = ? WHERE id = ?`,
      pipelineId,
      Date.now(),
      jobId,
    );
    this.broadcast({ op: 'job-upsert', row: this.requireJob(jobId) });
    return Promise.resolve();
  }

  async signTokenFor(claims: Omit<CallbackClaims, 'exp'>): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    return await signCallbackToken({ ...claims, exp }, this.env.CALLBACK_HMAC_SECRET);
  }

  // ---- HTTP / WebSocket ---------------------------------------------------

  snapshot(): Promise<Snapshot> {
    return Promise.resolve(this.readSnapshot());
  }

  override webSocketClose(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      /* noop */
    }
  }

  private broadcast(delta: Delta): void {
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

  private countInflight(): number {
    const row = this.ctx.storage.sql
      .exec(`SELECT count(*) as c FROM jobs WHERE status IN ('pending','processing')`)
      .toArray()[0] as undefined | { c: number };
    return row?.c ?? 0;
  }

  // ---- Internals ----------------------------------------------------------

  private deriveJobStatus(jobId: string): JobStatus {
    const failed = this.ctx.storage.sql
      .exec(`SELECT count(*) as c FROM job_pages WHERE job_id = ? AND status = 'failed'`, jobId)
      .toArray()[0] as undefined | { c: number };
    return (failed?.c ?? 0) > 0 ? 'failed' : 'done';
  }

  private handleWebSocketUpgrade(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const snap = this.readSnapshot();
    server.send(JSON.stringify({ op: 'snapshot', snapshot: snap } satisfies Delta));
    return new Response(undefined, { status: 101, webSocket: client });
  }

  private maybeCompleteJob(jobId: string): void {
    const pending = this.ctx.storage.sql
      .exec(`SELECT count(*) as c FROM job_pages WHERE job_id = ? AND status = 'pending'`, jobId)
      .toArray()[0] as undefined | { c: number };
    if (!pending || pending.c > 0) return;
    const failed = this.ctx.storage.sql
      .exec(`SELECT count(*) as c FROM job_pages WHERE job_id = ? AND status = 'failed'`, jobId)
      .toArray()[0] as undefined | { c: number };
    const status: JobStatus = (failed?.c ?? 0) > 0 ? 'failed' : 'done';
    this.ctx.storage.sql.exec(`UPDATE jobs SET status = ?, completed_at = ? WHERE id = ?`, status, Date.now(), jobId);
    this.broadcast({ op: 'job-upsert', row: this.requireJob(jobId) });
  }

  private migrate(): void {
    const statements = schemaSql
      .split(/;\s*$/m)
      .map(s => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      this.ctx.storage.sql.exec(stmt);
    }
  }

  private readSnapshot(): Snapshot {
    const jobs = (this.ctx.storage.sql.exec(`SELECT * FROM jobs ORDER BY created_at DESC`).toArray() as SqlRow[]).map(
      r => cleanRow(r) as unknown as JobRow,
    );
    const pages = (
      this.ctx.storage.sql.exec(`SELECT * FROM job_pages ORDER BY job_id, page_number`).toArray() as SqlRow[]
    ).map(r => cleanRow(r) as unknown as PageRow);
    return { jobs, pages };
  }

  private reconcileTimeoutMs(): number {
    const seconds = Number.parseInt(this.env.RECONCILE_TIMEOUT_SECONDS, 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3600 * 1000;
  }

  private requireJob(jobId: string): JobRow {
    const rows = this.ctx.storage.sql.exec(`SELECT * FROM jobs WHERE id = ?`, jobId).toArray() as SqlRow[];
    const row = rows[0];
    if (!row) throw new Error(`job not found: ${jobId}`);
    return cleanRow(row) as unknown as JobRow;
  }

  private requirePage(jobId: string, pageNumber: number): PageRow {
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM job_pages WHERE job_id = ? AND page_number = ?`, jobId, pageNumber)
      .toArray() as SqlRow[];
    const row = rows[0];
    if (!row) throw new Error(`page not found: ${jobId}/${pageNumber}`);
    return cleanRow(row) as unknown as PageRow;
  }

  private async scheduleReconcile(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing != undefined) return;
    await this.ctx.storage.setAlarm(Date.now() + this.reconcileTimeoutMs());
  }

  private async submitToPipeline(jobId: string): Promise<void> {
    const job = this.requireJob(jobId);
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
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.storage.sql.exec(
        `UPDATE jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
        message,
        Date.now(),
        jobId,
      );
      this.broadcast({ op: 'job-upsert', row: this.requireJob(jobId) });
    }
  }
}
