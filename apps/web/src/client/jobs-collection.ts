// TanStack DB collections for jobs + per-page rows.
// Hydrates via GET /api/me/items, stays live via WS /api/me/ws.
// Exponential-backoff reconnect; refetches the snapshot after every reconnect.

import { createCollection } from "@tanstack/db";
import type { JobRow, PageRow, Snapshot } from "../durable-objects/user-do";

type Delta =
  | { op: "snapshot"; snapshot: Snapshot }
  | { op: "job-upsert"; row: JobRow }
  | { op: "page-upsert"; row: PageRow };

const pageId = (job: string, n: number) => `${job}#${n}`;

type Writer<T extends object> = {
  begin: () => void;
  write: (msg: { type: "insert" | "update"; value: T }) => void;
  commit: () => void;
  markReady: () => void;
};

let jobsWriter: Writer<JobRow> | null = null;
let pagesWriter: Writer<PageRow> | null = null;
let teardown: (() => void) | null = null;

function applySnapshot(snap: Snapshot): void {
  if (jobsWriter) {
    jobsWriter.begin();
    for (const row of snap.jobs) jobsWriter.write({ type: "insert", value: row });
    jobsWriter.commit();
  }
  if (pagesWriter) {
    pagesWriter.begin();
    for (const row of snap.pages) pagesWriter.write({ type: "insert", value: row });
    pagesWriter.commit();
  }
}

function applyDelta(delta: Delta): void {
  if (delta.op === "snapshot") {
    applySnapshot(delta.snapshot);
    return;
  }
  if (delta.op === "job-upsert" && jobsWriter) {
    jobsWriter.begin();
    jobsWriter.write({ type: "update", value: delta.row });
    jobsWriter.commit();
    return;
  }
  if (delta.op === "page-upsert" && pagesWriter) {
    pagesWriter.begin();
    pagesWriter.write({ type: "update", value: delta.row });
    pagesWriter.commit();
  }
}

function openLiveStream(): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const fetchSnapshot = async () => {
    const res = await fetch("/api/me/items", { credentials: "same-origin" });
    if (!res.ok) throw new Error(`hydrate failed: ${res.status}`);
    const snap: Snapshot = await res.json();
    applySnapshot(snap);
    jobsWriter?.markReady();
    pagesWriter?.markReady();
  };

  const connect = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/api/me/ws`;
    const ws = new WebSocket(url);
    socket = ws;
    ws.addEventListener("open", () => {
      attempt = 0;
    });
    ws.addEventListener("message", (event) => {
      try {
        applyDelta(JSON.parse(event.data as string) as Delta);
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.addEventListener("close", () => {
      if (closed) return;
      const backoff = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
      attempt += 1;
      timer = setTimeout(() => {
        void fetchSnapshot().catch(() => undefined).finally(connect);
      }, backoff);
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    });
  };

  void fetchSnapshot().catch(() => undefined).finally(connect);

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (socket) socket.close();
  };
}

function maybeStart(): void {
  if (jobsWriter && pagesWriter && !teardown) {
    teardown = openLiveStream();
  }
}

export const jobsCollection = createCollection<JobRow, string>({
  id: "jobs",
  getKey: (row) => row.id,
  sync: {
    sync: ({ begin, write, commit, markReady }) => {
      jobsWriter = { begin, write: write as Writer<JobRow>["write"], commit, markReady };
      maybeStart();
    },
  },
});

export const pagesCollection = createCollection<PageRow, string>({
  id: "job-pages",
  getKey: (row) => pageId(row.job_id, row.page_number),
  sync: {
    sync: ({ begin, write, commit, markReady }) => {
      pagesWriter = { begin, write: write as Writer<PageRow>["write"], commit, markReady };
      maybeStart();
    },
  },
});
