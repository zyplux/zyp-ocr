import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { ulid } from 'ulid';

import type { Delta } from '~/durable-objects/wire';

import { DEFAULT_RECONCILE_TIMEOUT_SECONDS, DEFAULT_USER_ID, MAX_INFLIGHT_JOBS, TOKEN_TTL_SECONDS } from '~/constants';
import migrations from '~/durable-objects/migrations';
import * as schema from '~/durable-objects/schema';
import {
  type ApplyResultInput,
  type ConfirmUploadInput,
  type ReserveJobInput,
  UserStore,
} from '~/durable-objects/user-store';
import { getMessage } from '~/lib/error';
import { type ResultClaims, signResultToken } from '~/lib/result-token';
import { blob } from '~/lib/s3';

export type { ApplyResultInput, ConfirmUploadInput } from '~/durable-objects/user-store';
export type ReserveUploadInput = ReserveJobInput;

export type SubscribeResult = { id: string; stream: ReadableStream<Uint8Array> };

const PAGES_FAILED_REASON = 'one or more pages failed';

const sseEncoder = new TextEncoder();
const omitNulls = (_: string, value: unknown) => (value === null ? undefined : value);
const formatSseEvent = (delta: Delta) => sseEncoder.encode(`data: ${JSON.stringify(delta, omitNulls)}\n\n`);

export class UserDO extends DurableObject<Env> {
  private store: UserStore;
  // Per-subscriber writers; consumers (SSE proxies) get the readable half via
  // `subscribe()` and call `unsubscribe(id)` when their downstream HTTP request
  // aborts. Replaces the prior hibernation-aware WebSocket fanout.
  private subscribers = new Map<string, WritableStreamDefaultWriter<Uint8Array>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = drizzle(ctx.storage, { logger: false, schema });
    migrate(db, migrations);
    this.store = new UserStore(db);
  }

  override async alarm() {
    const now = Date.now();
    const cutoff = now - this.reconcileTimeoutMs();
    const stale = await this.store.findStaleJobs(cutoff);
    for (const ocrJob of stale) {
      const isAwaitingUpload = ocrJob.total_pages === 0 && ocrJob.started_at === null;
      if (isAwaitingUpload) {
        try {
          await blob.delete(this.env, ocrJob.upload_key);
        } catch {
          /* best-effort cleanup; failed delete should not block fail-marking */
        }
      }
      await this.store.failJob(ocrJob.id, isAwaitingUpload ? 'upload abandoned' : 'timeout', now);
      this.broadcast({ op: 'ocr-job-upsert', row: await this.store.requireOcrJob(ocrJob.id) });
    }
    if ((await this.store.countInflight()) > 0) {
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
    const applied = this.store.applyResult(input, Date.now());
    if (!applied) return;

    if (typeof input.pageNumber === 'number') {
      this.broadcast({ op: 'md-page-upsert', row: await this.store.requireMdPage(input.ocrJobId, input.pageNumber) });
      await this.maybeCompleteOcrJob(input.ocrJobId);
      return;
    }
    this.broadcast({ op: 'ocr-job-upsert', row: await this.store.requireOcrJob(input.ocrJobId) });
  }

  async confirmUpload(input: ConfirmUploadInput) {
    await this.store.confirmUpload(input, Date.now());
    this.broadcast({ op: 'ocr-job-upsert', row: await this.store.requireOcrJob(input.ocrJobId) });
    for (let n = 1; n <= input.totalPages; n++) {
      this.broadcast({ op: 'md-page-upsert', row: await this.store.requireMdPage(input.ocrJobId, n) });
    }
    this.ctx.waitUntil(this.submitToPipeline(input.ocrJobId));
  }

  async failUpload(ocrJobId: string, error: string) {
    await this.store.failJob(ocrJobId, error, Date.now());
    this.broadcast({ op: 'ocr-job-upsert', row: await this.store.requireOcrJob(ocrJobId) });
  }

  async reserveUpload(input: ReserveUploadInput) {
    if ((await this.store.countInflight()) >= MAX_INFLIGHT_JOBS) {
      throw new Error(`too many in-flight jobs (max ${MAX_INFLIGHT_JOBS})`);
    }
    await this.store.reserveJob(input, Date.now());
    this.broadcast({ op: 'ocr-job-upsert', row: await this.store.requireOcrJob(input.ocrJobId) });
    await this.scheduleReconcile();
  }

  async setPipelineId(ocrJobId: string, pipelineId: string) {
    await this.store.setPipelineId(ocrJobId, pipelineId, Date.now());
    this.broadcast({ op: 'ocr-job-upsert', row: await this.store.requireOcrJob(ocrJobId) });
  }

  async signTokenFor(claims: Omit<ResultClaims, 'exp'>) {
    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    return await signResultToken({ ...claims, exp }, this.env.RESULT_HMAC_SECRET);
  }

  async snapshot() {
    return await this.store.readSnapshot();
  }

  async subscribe() {
    const id = ulid();
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    this.subscribers.set(id, writer);
    const snap = await this.store.readSnapshot();
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

  private async maybeCompleteOcrJob(ocrJobId: string) {
    const inflight = await this.store.countInflightPages(ocrJobId);
    if (inflight > 0) return;
    const failed = await this.store.hasFailedPage(ocrJobId);
    await this.store.completeJobIfRunning(ocrJobId, failed ? PAGES_FAILED_REASON : undefined, Date.now());
    this.broadcast({ op: 'ocr-job-upsert', row: await this.store.requireOcrJob(ocrJobId) });
  }

  private reconcileTimeoutMs() {
    const seconds = Number.parseInt(this.env.RECONCILE_TIMEOUT_SECONDS, 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RECONCILE_TIMEOUT_SECONDS * 1000;
  }

  private async scheduleReconcile() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + this.reconcileTimeoutMs());
  }

  private async submitToPipeline(ocrJobId: string) {
    const ocrJob = await this.store.requireOcrJob(ocrJobId);
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
      await this.store.failJob(ocrJobId, getMessage(err, 'transcription submit'), Date.now());
      this.broadcast({ op: 'ocr-job-upsert', row: await this.store.requireOcrJob(ocrJobId) });
    }
  }
}
