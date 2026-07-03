import { createCollection } from '@tanstack/db';

import type { MdPageRow, OcrJobRow, Snapshot } from '~/durable-objects/wire';

import { DeltaSchema } from '~/durable-objects/wire';

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

type Transport = {
  isStarted: boolean;
  source: EventSource | undefined;
};
const transport: Transport = { isStarted: false, source: undefined };

const applySnapshot = ({ md_pages: mdPageRows, ocr_jobs: ocrJobRows }: Snapshot) => {
  if (subs.ocrJobs) {
    subs.ocrJobs.begin();
    for (const row of ocrJobRows) subs.ocrJobs.write({ type: 'insert', value: row });
    subs.ocrJobs.commit();
    subs.ocrJobs.markReady();
  }
  if (subs.mdPages) {
    subs.mdPages.begin();
    for (const row of mdPageRows) subs.mdPages.write({ type: 'insert', value: row });
    subs.mdPages.commit();
    subs.mdPages.markReady();
  }
};

const applyOcrJobUpsert = (row: OcrJobRow) => {
  if (!subs.ocrJobs) return;
  subs.ocrJobs.begin();
  subs.ocrJobs.write({ type: 'update', value: row });
  subs.ocrJobs.commit();
};

const applyMdPageUpsert = (row: MdPageRow) => {
  if (!subs.mdPages) return;
  subs.mdPages.begin();
  subs.mdPages.write({ type: 'update', value: row });
  subs.mdPages.commit();
};

const startSourceIfReady = () => {
  if (transport.isStarted) return;
  if (!subs.ocrJobs || !subs.mdPages) return;
  if (typeof EventSource === 'undefined') return;
  transport.isStarted = true;
  transport.source = new EventSource(STATE_STREAM_URL, { withCredentials: true });
  transport.source.addEventListener('message', event => {
    try {
      const raw: unknown = event.data;
      if (typeof raw !== 'string') return;
      const result = DeltaSchema.safeParse(JSON.parse(raw));
      if (!result.success) return;
      const delta = result.data;
      if (delta.op === 'snapshot') applySnapshot(delta.snapshot);
      else if (delta.op === 'ocr-job-upsert') applyOcrJobUpsert(delta.row);
      else applyMdPageUpsert(delta.row);
    } catch {
      /* ignore malformed frames */
    }
  });
};

const stop = () => {
  if (!transport.isStarted) return;
  transport.isStarted = false;
  transport.source?.close();
  transport.source = undefined;
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
