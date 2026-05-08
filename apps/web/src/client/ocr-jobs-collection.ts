// TanStack DB collections for jobs + per-page rows.
// Hydrates via GET /api/me/items, stays live via WS /api/me/ws.
// Exponential-backoff reconnect; refetches the snapshot after every reconnect.

import { createCollection } from '@tanstack/db';

import type { JobRow, PageRow, Snapshot } from '~/durable-objects/user-do';

import { WS_RECONNECT_BASE_MS, WS_RECONNECT_MAX_EXPONENT, WS_RECONNECT_MAX_MS } from '~/constants';

type Delta =
  | { op: 'job-upsert'; row: JobRow }
  | { op: 'page-upsert'; row: PageRow }
  | { op: 'snapshot'; snapshot: Snapshot };

const pageId = (job: string, n: number) => `${job}#${n}`;

type Writer<T extends object> = {
  begin: () => void;
  commit: () => void;
  markReady: () => void;
  write: (msg: { type: 'insert' | 'update'; value: T }) => void;
};

let jobsWriter: undefined | Writer<JobRow>;
let pagesWriter: undefined | Writer<PageRow>;
let teardown: (() => void) | undefined;

const applySnapshot = (snap: Snapshot) => {
  if (jobsWriter) {
    jobsWriter.begin();
    for (const row of snap.jobs) jobsWriter.write({ type: 'insert', value: row });
    jobsWriter.commit();
  }
  if (pagesWriter) {
    pagesWriter.begin();
    for (const row of snap.pages) pagesWriter.write({ type: 'insert', value: row });
    pagesWriter.commit();
  }
};

const applyDelta = (delta: Delta) => {
  if (delta.op === 'snapshot') {
    applySnapshot(delta.snapshot);
    return;
  }
  if (delta.op === 'job-upsert' && jobsWriter) {
    jobsWriter.begin();
    jobsWriter.write({ type: 'update', value: delta.row });
    jobsWriter.commit();
    return;
  }
  if (delta.op === 'page-upsert' && pagesWriter) {
    pagesWriter.begin();
    pagesWriter.write({ type: 'update', value: delta.row });
    pagesWriter.commit();
  }
};

const fetchSnapshot = async () => {
  const res = await fetch('/api/me/items', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`hydrate failed: ${res.status}`);
  const snap: Snapshot = await res.json();
  applySnapshot(snap);
  jobsWriter?.markReady();
  pagesWriter?.markReady();
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
  if (jobsWriter && pagesWriter && !teardown) {
    teardown = openLiveStream();
  }
};

export const jobsCollection = createCollection<JobRow, string>({
  getKey: row => row.id,
  id: 'jobs',
  sync: {
    sync: ({ begin, commit, markReady, write }) => {
      jobsWriter = { begin, commit, markReady, write: write as Writer<JobRow>['write'] };
      maybeStart();
    },
  },
});

export const pagesCollection = createCollection<PageRow, string>({
  getKey: row => pageId(row.job_id, row.page_number),
  id: 'job-pages',
  sync: {
    sync: ({ begin, commit, markReady, write }) => {
      pagesWriter = { begin, commit, markReady, write: write as Writer<PageRow>['write'] };
      maybeStart();
    },
  },
});
