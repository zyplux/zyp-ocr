import { DurableObject } from 'cloudflare:workers';
import { ulid } from 'ulid';
import { type CallbackClaims, signCallbackToken } from '../lib/callback-token';
import schemaSql from './user-do.sql?raw';

export type JobStatus = 'pending' | 'processing' | 'done' | 'failed';
export type PageStatus = 'pending' | 'done' | 'failed';

export type JobRow = {
  id: string;
  status: JobStatus;
  source_key: string;
  size_bytes: number;
  total_pages: number;
  pipeline_id: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
};

export type PageRow = {
  job_id: string;
  page_number: number;
  status: PageStatus;
  markdown_key: string | null;
  error: string | null;
};

export type Snapshot = {
  jobs: JobRow[];
  pages: PageRow[];
};

export type CreateJobInput = {
  sizeBytes: number;
  totalPages: number;
  // Template using `{jobId}` placeholder; the DO substitutes its generated id.
  sourceKeyTemplate: string;
};

export type ApplyCallbackInput = {
  callbackId: string;
  jobId: string;
  pageNumber?: number;
  status: 'done' | 'failed';
  markdownKey?: string;
  error?: string;
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

  private migrate(): void {
    const statements = schemaSql
      .split(/;\s*$/m)
      .map(s => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      this.ctx.storage.sql.exec(stmt);
    }
  }

  // ---- Public RPC ---------------------------------------------------------

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
        input.markdownKey ?? null,
        input.error ?? null,
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
      input.error ?? null,
      input.jobId,
    );
    this.broadcast({ op: 'job-upsert', row: this.requireJob(input.jobId) });
    return Promise.resolve();
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

  snapshot(): Promise<Snapshot> {
    return Promise.resolve(this.readSnapshot());
  }

  async signTokenFor(claims: Omit<CallbackClaims, 'exp'>): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    return await signCallbackToken({ ...claims, exp }, this.env.CALLBACK_HMAC_SECRET);
  }

  // ---- HTTP / WebSocket ---------------------------------------------------

  override fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      return Promise.resolve(this.handleWebSocketUpgrade());
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  }

  private handleWebSocketUpgrade(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const snap = this.readSnapshot();
    server.send(JSON.stringify({ op: 'snapshot', snapshot: snap } satisfies Delta));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // Clients are passive receivers in v0.x.
  }

  override webSocketClose(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      /* noop */
    }
  }

  // ---- Alarm reconcile ----------------------------------------------------

  override async alarm(): Promise<void> {
    const now = Date.now();
    const cutoff = now - this.reconcileTimeoutMs();
    const stale = this.ctx.storage.sql
      .exec<JobRow>(
        `SELECT * FROM jobs
         WHERE status IN ('pending','processing')
           AND created_at < ?`,
        cutoff,
      )
      .toArray();
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

  // ---- Internals ----------------------------------------------------------

  private async scheduleReconcile(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing != null) return;
    await this.ctx.storage.setAlarm(Date.now() + this.reconcileTimeoutMs());
  }

  private reconcileTimeoutMs(): number {
    const seconds = Number.parseInt(this.env.RECONCILE_TIMEOUT_SECONDS ?? '3600', 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3600 * 1000;
  }

  private async submitToPipeline(jobId: string): Promise<void> {
    const job = this.requireJob(jobId);
    const callbackId = ulid();
    const token = await this.signTokenFor({
      userId: DEFAULT_USER_ID,
      jobId,
      callbackId,
    });
    const callbackBase = this.env.WORKER_INTERNAL_BASE ?? this.env.PUBLIC_BASE;
    const payload = {
      job_id: jobId,
      source_key: job.source_key,
      callback_url: `${callbackBase}/api/pipeline/callback`,
      callback_token: token,
    };
    try {
      const res = await fetch(`${this.env.PIPELINE_BASE}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
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

  private maybeCompleteJob(jobId: string): void {
    const pending = this.ctx.storage.sql
      .exec(`SELECT count(*) as c FROM job_pages WHERE job_id = ? AND status = 'pending'`, jobId)
      .toArray()[0] as { c: number } | undefined;
    if (!pending || pending.c > 0) return;
    const failed = this.ctx.storage.sql
      .exec(`SELECT count(*) as c FROM job_pages WHERE job_id = ? AND status = 'failed'`, jobId)
      .toArray()[0] as { c: number } | undefined;
    const status: JobStatus = (failed?.c ?? 0) > 0 ? 'failed' : 'done';
    this.ctx.storage.sql.exec(`UPDATE jobs SET status = ?, completed_at = ? WHERE id = ?`, status, Date.now(), jobId);
    this.broadcast({ op: 'job-upsert', row: this.requireJob(jobId) });
  }

  private deriveJobStatus(jobId: string): JobStatus {
    const failed = this.ctx.storage.sql
      .exec(`SELECT count(*) as c FROM job_pages WHERE job_id = ? AND status = 'failed'`, jobId)
      .toArray()[0] as { c: number } | undefined;
    return (failed?.c ?? 0) > 0 ? 'failed' : 'done';
  }

  private requireJob(jobId: string): JobRow {
    const rows = this.ctx.storage.sql.exec<JobRow>(`SELECT * FROM jobs WHERE id = ?`, jobId).toArray();
    const row = rows[0];
    if (!row) throw new Error(`job not found: ${jobId}`);
    return row;
  }

  private requirePage(jobId: string, pageNumber: number): PageRow {
    const rows = this.ctx.storage.sql
      .exec<PageRow>(`SELECT * FROM job_pages WHERE job_id = ? AND page_number = ?`, jobId, pageNumber)
      .toArray();
    const row = rows[0];
    if (!row) throw new Error(`page not found: ${jobId}/${pageNumber}`);
    return row;
  }

  private readSnapshot(): Snapshot {
    const jobs = this.ctx.storage.sql.exec<JobRow>(`SELECT * FROM jobs ORDER BY created_at DESC`).toArray();
    const pages = this.ctx.storage.sql.exec<PageRow>(`SELECT * FROM job_pages ORDER BY job_id, page_number`).toArray();
    return { jobs, pages };
  }

  private countInflight(): number {
    const row = this.ctx.storage.sql
      .exec(`SELECT count(*) as c FROM jobs WHERE status IN ('pending','processing')`)
      .toArray()[0] as { c: number } | undefined;
    return row?.c ?? 0;
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
}
