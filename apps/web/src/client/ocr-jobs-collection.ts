import { createCollection } from '@tanstack/db';

import type { Delta, MdPageRow, OcrJobRow, Snapshot } from '~/durable-objects/wire';

import { Delta as DeltaSchema } from '~/durable-objects/wire';

const STATE_STREAM_URL = '/api/_internal/state-stream';

type SyncApi<T extends object> = {
  begin: () => void;
  commit: () => void;
  markReady: () => void;
  write: (msg: { type: 'insert' | 'update'; value: T }) => void;
};

const mdPageId = (ocrJob: string, n: number) => `${ocrJob}#${n}`;

// Module-level shared transport: both collections feed off one EventSource.
// The DO emits the snapshot as the first SSE frame, then per-row deltas; both
// collections share the snapshot moment for hydration.
type Subscribers = {
  mdPages?: SyncApi<MdPageRow>;
  ocrJobs?: SyncApi<OcrJobRow>;
};
const subs: Subscribers = {};

let source: EventSource | undefined;
let started = false;

const applySnapshot = (snap: Snapshot) => {
  if (subs.ocrJobs) {
    subs.ocrJobs.begin();
    for (const row of snap.ocr_jobs) subs.ocrJobs.write({ type: 'insert', value: row });
    subs.ocrJobs.commit();
    subs.ocrJobs.markReady();
  }
  if (subs.mdPages) {
    subs.mdPages.begin();
    for (const row of snap.md_pages) subs.mdPages.write({ type: 'insert', value: row });
    subs.mdPages.commit();
    subs.mdPages.markReady();
  }
};

const applyDelta = (delta: Delta) => {
  if (delta.op === 'snapshot') {
    applySnapshot(delta.snapshot);
    return;
  }
  if (delta.op === 'ocr-job-upsert' && subs.ocrJobs) {
    subs.ocrJobs.begin();
    subs.ocrJobs.write({ type: 'update', value: delta.row });
    subs.ocrJobs.commit();
    return;
  }
  if (delta.op === 'md-page-upsert' && subs.mdPages) {
    subs.mdPages.begin();
    subs.mdPages.write({ type: 'update', value: delta.row });
    subs.mdPages.commit();
  }
};

const startSourceIfReady = () => {
  if (started) return;
  if (!subs.ocrJobs || !subs.mdPages) return;
  if (typeof EventSource === 'undefined') return;
  started = true;
  source = new EventSource(STATE_STREAM_URL, { withCredentials: true });
  source.addEventListener('message', event => {
    try {
      const raw: unknown = event.data;
      if (typeof raw !== 'string') return;
      const parsed: unknown = JSON.parse(raw);
      const result = DeltaSchema.safeParse(parsed);
      if (!result.success) return;
      applyDelta(result.data);
    } catch {
      /* ignore malformed frames */
    }
  });
};

const stop = () => {
  if (!started) return;
  started = false;
  source?.close();
  source = undefined;
};

export const ocrJobsCollection = createCollection<OcrJobRow, string>({
  getKey: row => row.id,
  id: 'ocr_jobs',
  sync: {
    sync: ({ begin, commit, markReady, write }) => {
      subs.ocrJobs = { begin, commit, markReady, write };
      startSourceIfReady();
      return () => {
        delete subs.ocrJobs;
        if (!subs.mdPages) stop();
      };
    },
  },
});

export const mdPagesCollection = createCollection<MdPageRow, string>({
  getKey: row => mdPageId(row.ocr_job_id, row.page_number),
  id: 'md_pages',
  sync: {
    sync: ({ begin, commit, markReady, write }) => {
      subs.mdPages = { begin, commit, markReady, write };
      startSourceIfReady();
      return () => {
        delete subs.mdPages;
        if (!subs.ocrJobs) stop();
      };
    },
  },
});
