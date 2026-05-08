// TanStack DB collections for ocr_jobs + per-md_page rows.
// Hydrates via GET /api/me/items, stays live via WS /api/me/ws.
// Exponential-backoff reconnect; refetches the snapshot after every reconnect.

import { createCollection } from '@tanstack/db';

import type { MdPageRow, OcrJobRow, Snapshot } from '~/durable-objects/user-do';

import { WS_RECONNECT_BASE_MS, WS_RECONNECT_MAX_EXPONENT, WS_RECONNECT_MAX_MS } from '~/constants';

type Delta =
  | { op: 'md-page-upsert'; row: MdPageRow }
  | { op: 'ocr-job-upsert'; row: OcrJobRow }
  | { op: 'snapshot'; snapshot: Snapshot };

const mdPageId = (ocrJob: string, n: number) => `${ocrJob}#${n}`;

type Writer<T extends object> = {
  begin: () => void;
  commit: () => void;
  markReady: () => void;
  write: (msg: { type: 'insert' | 'update'; value: T }) => void;
};

let ocrJobsWriter: undefined | Writer<OcrJobRow>;
let mdPagesWriter: undefined | Writer<MdPageRow>;
let teardown: (() => void) | undefined;

const applySnapshot = (snap: Snapshot) => {
  if (ocrJobsWriter) {
    ocrJobsWriter.begin();
    for (const row of snap.ocr_jobs) ocrJobsWriter.write({ type: 'insert', value: row });
    ocrJobsWriter.commit();
  }
  if (mdPagesWriter) {
    mdPagesWriter.begin();
    for (const row of snap.md_pages) mdPagesWriter.write({ type: 'insert', value: row });
    mdPagesWriter.commit();
  }
};

const applyDelta = (delta: Delta) => {
  if (delta.op === 'snapshot') {
    applySnapshot(delta.snapshot);
    return;
  }
  if (delta.op === 'ocr-job-upsert' && ocrJobsWriter) {
    ocrJobsWriter.begin();
    ocrJobsWriter.write({ type: 'update', value: delta.row });
    ocrJobsWriter.commit();
    return;
  }
  if (delta.op === 'md-page-upsert' && mdPagesWriter) {
    mdPagesWriter.begin();
    mdPagesWriter.write({ type: 'update', value: delta.row });
    mdPagesWriter.commit();
  }
};

const fetchSnapshot = async () => {
  const res = await fetch('/api/me/items', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`hydrate failed: ${res.status}`);
  const snap: Snapshot = await res.json();
  applySnapshot(snap);
  ocrJobsWriter?.markReady();
  mdPagesWriter?.markReady();
};

const openLiveStream = () => {
  let closed = false;
  let socket: undefined | WebSocket;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/me/ws`;
    const ws = new WebSocket(url);
    socket = ws;
    ws.addEventListener('open', () => {
      attempt = 0;
    });
    ws.addEventListener('message', event => {
      try {
        applyDelta(JSON.parse(event.data as string) as Delta);
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.addEventListener('close', () => {
      if (closed) return;
      const backoff = Math.min(
        WS_RECONNECT_MAX_MS,
        WS_RECONNECT_BASE_MS * 2 ** Math.min(attempt, WS_RECONNECT_MAX_EXPONENT),
      );
      attempt += 1;
      timer = setTimeout(() => {
        void hydrateThenConnect();
      }, backoff);
    });
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    });
  };

  const hydrateThenConnect = async () => {
    try {
      await fetchSnapshot();
    } catch {
      /* hydrate failures are recoverable; reconnect loop will retry */
    }
    connect();
  };

  void hydrateThenConnect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (socket) socket.close();
  };
};

const maybeStart = () => {
  if (ocrJobsWriter && mdPagesWriter && !teardown) {
    teardown = openLiveStream();
  }
};

export const ocrJobsCollection = createCollection<OcrJobRow, string>({
  getKey: row => row.id,
  id: 'ocr_jobs',
  sync: {
    sync: ({ begin, commit, markReady, write }) => {
      ocrJobsWriter = { begin, commit, markReady, write: write as Writer<OcrJobRow>['write'] };
      maybeStart();
    },
  },
});

export const mdPagesCollection = createCollection<MdPageRow, string>({
  getKey: row => mdPageId(row.ocr_job_id, row.page_number),
  id: 'md_pages',
  sync: {
    sync: ({ begin, commit, markReady, write }) => {
      mdPagesWriter = { begin, commit, markReady, write: write as Writer<MdPageRow>['write'] };
      maybeStart();
    },
  },
});
