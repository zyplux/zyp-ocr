import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { ulid } from 'ulid';

import type { Delta } from '~/durable-objects/wire';
import type { TranscriptionUpdate } from '~/server';
import type { ConfirmUploadInput, ReserveUploadInput } from '~/server-fns/uploads';

import { DEFAULT_RECONCILE_TIMEOUT_SECONDS, DEFAULT_USER_ID, MAX_INFLIGHT_JOBS, TOKEN_TTL_SECONDS } from '~/constants';
import { TranscriptionSubmission, TranscriptionSubmissionAck } from '~/contracts';
import migrations from '~/durable-objects/migrations';
import * as schema from '~/durable-objects/schema';
import { UserStore } from '~/durable-objects/user-store';
import { getMessage } from '~/lib/error';
import { type ResultClaims, signResultToken } from '~/lib/result-token';
import { blob } from '~/lib/s3';

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
      const failed = this.store.failJob(ocrJob.id, isAwaitingUpload ? 'upload abandoned' : 'timeout', now);
      if (failed) this.broadcast(failed);
    }
    if ((await this.store.countInflight()) > 0) {
      await this.ctx.storage.setAlarm(now + this.reconcileTimeoutMs());
    }
  }

  confirmUpload(input: ConfirmUploadInput) {
    const broadcasts = this.store.confirmUpload(input, Date.now());
    for (const delta of broadcasts) this.broadcast(delta);
    const { ocrJobId } = input;
    this.ctx.waitUntil(
      (async () => {
        const ocrJob = await this.store.requireOcrJob(ocrJobId);
        const resultId = ulid();
        const token = await this.signTokenFor({ ocrJobId, resultId, userId: DEFAULT_USER_ID });
        const resultBase = this.env.WORKER_INTERNAL_BASE ?? this.env.PUBLIC_BASE;
        const payload: TranscriptionSubmission = {
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
          const ack = TranscriptionSubmissionAck.parse(await res.json());
          this.setPipelineId(ocrJobId, ack.pipeline_id);
        } catch (err) {
          const failed = this.store.failJob(ocrJobId, getMessage(err, 'transcription submit'), Date.now());
          if (failed) this.broadcast(failed);
        }
      })(),
    );
  }

  failUpload(ocrJobId: string, error: string) {
    const failed = this.store.failJob(ocrJobId, error, Date.now());
    if (failed) this.broadcast(failed);
  }

  async onTranscriptionUpdate(input: TranscriptionUpdate) {
    const saved = this.store.saveUpdate(input, Date.now());
    if (!saved) return;

    this.broadcast(saved);
    if (saved.op !== 'md-page-upsert') return;

    const inflight = await this.store.countInflightPages(input.ocrJobId);
    if (inflight > 0) return;
    const failed = await this.store.hasFailedPage(input.ocrJobId);
    const completed = this.store.completeJobIfRunning(
      input.ocrJobId,
      failed ? PAGES_FAILED_REASON : undefined,
      Date.now(),
    );
    if (completed) this.broadcast(completed);
  }

  async reserveUpload(input: ReserveUploadInput) {
    if ((await this.store.countInflight()) >= MAX_INFLIGHT_JOBS) {
      throw new Error(`too many in-flight jobs (max ${MAX_INFLIGHT_JOBS})`);
    }
    const reserved = this.store.reserveJob(input, Date.now());
    if (reserved) this.broadcast(reserved);

    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null) {
      await this.ctx.storage.setAlarm(Date.now() + this.reconcileTimeoutMs());
    }
  }

  setPipelineId(ocrJobId: string, pipelineId: string) {
    const updated = this.store.setPipelineId(ocrJobId, pipelineId, Date.now());
    if (updated) this.broadcast(updated);
  }

  async signTokenFor(claims: Omit<ResultClaims, 'exp'>) {
    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    return await signResultToken({ ...claims, exp }, this.env.RESULT_HMAC_SECRET);
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

  private reconcileTimeoutMs() {
    const seconds = Number.parseInt(this.env.RECONCILE_TIMEOUT_SECONDS, 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RECONCILE_TIMEOUT_SECONDS * 1000;
  }
}
