import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '~/durable-objects/schema';
import { UserStore } from '~/durable-objects/user-store';

import { createTestDb, type TestDb } from './_db';

const CREATED_AT = 1000;
const UPLOAD_AT = 1100;
const START_AT = 1200;
const COMPLETE_AT = 1500;

let db: TestDb;
let store: UserStore;

beforeEach(() => {
  db = createTestDb();
  store = new UserStore(db);
});

const requireRow = <T>(row: T | undefined): T => {
  if (row === undefined) throw new Error('expected a row');
  return row;
};

const seedReserved = (id = 'j1', size = 100, key = 'uploads/j1', at = CREATED_AT) => {
  db.insert(schema.ocr_jobs).values({ created_at: at, id, size_bytes: size, total_pages: 0, upload_key: key }).run();
};

const seedTranscribing = async (id = 'j1', pages = 1) => {
  seedReserved(id);
  await store.confirmUpload({ ocrJobId: id, sizeBytes: 100, totalPages: pages }, UPLOAD_AT);
  await store.setPipelineId(id, `pipe-${id}`, START_AT);
};

const ocrJob = (id = 'j1') => requireRow(db.select().from(schema.ocr_jobs).where(eq(schema.ocr_jobs.id, id)).get());

const mdPage = (id: string, pn: number) =>
  requireRow(
    db
      .select()
      .from(schema.md_pages)
      .where(eq(schema.md_pages.ocr_job_id, id))
      .all()
      .find(p => p.page_number === pn),
  );

const receivedResultIds = () =>
  db
    .select({ id: schema.received_results.result_id })
    .from(schema.received_results)
    .all()
    .map(r => r.id);

describe('UserStore.reserveJob', () => {
  it('inserts a fresh job in awaiting_upload', async () => {
    await store.reserveJob({ ocrJobId: 'j1', sizeBytes: 12_345, uploadKey: 'u/j1' }, CREATED_AT);
    expect(ocrJob('j1')).toMatchObject({
      created_at: CREATED_AT,
      id: 'j1',
      size_bytes: 12_345,
      status: 'awaiting_upload',
      total_pages: 0,
      upload_key: 'u/j1',
    });
  });

  it('rejects duplicate ids', async () => {
    await store.reserveJob({ ocrJobId: 'j1', sizeBytes: 0, uploadKey: 'u' }, CREATED_AT);
    await expect(store.reserveJob({ ocrJobId: 'j1', sizeBytes: 0, uploadKey: 'u' }, CREATED_AT)).rejects.toThrow(
      /UNIQUE|PRIMARY KEY/,
    );
  });
});

describe('UserStore.confirmUpload', () => {
  it('records size + page count and seeds md_pages with sequential numbers', async () => {
    seedReserved();
    await store.confirmUpload({ ocrJobId: 'j1', sizeBytes: 999, totalPages: 3 }, UPLOAD_AT);

    expect(ocrJob()).toMatchObject({ size_bytes: 999, status: 'uploaded', total_pages: 3 });
    const pageNumbers = db
      .select({ pn: schema.md_pages.page_number })
      .from(schema.md_pages)
      .all()
      .map(p => p.pn)
      .toSorted((a, b) => a - b);
    expect(pageNumbers).toEqual([1, 2, 3]);
  });

  it('skips page seeding when totalPages is 0', async () => {
    seedReserved();
    await store.confirmUpload({ ocrJobId: 'j1', sizeBytes: 0, totalPages: 0 }, UPLOAD_AT);
    expect(db.select().from(schema.md_pages).all()).toEqual([]);
  });
});

describe('UserStore.setPipelineId', () => {
  it('writes pipeline_id and started_at atomically, advancing job to transcribing', async () => {
    seedReserved();
    await store.confirmUpload({ ocrJobId: 'j1', sizeBytes: 100, totalPages: 1 }, UPLOAD_AT);
    await store.setPipelineId('j1', 'pipe-1', START_AT);

    expect(ocrJob()).toMatchObject({ pipeline_id: 'pipe-1', started_at: START_AT, status: 'transcribing' });
  });
});

describe('UserStore.failJob', () => {
  it('marks the job failed with the given error', async () => {
    seedReserved();
    await store.failJob('j1', 'boom', COMPLETE_AT);
    expect(ocrJob()).toMatchObject({ completed_at: COMPLETE_AT, error: 'boom', status: 'failed' });
  });

  it('overwrites prior terminal state unconditionally', async () => {
    seedReserved();
    await store.failJob('j1', 'first', COMPLETE_AT);
    await store.failJob('j1', 'second', COMPLETE_AT + 100);
    expect(ocrJob()).toMatchObject({ completed_at: COMPLETE_AT + 100, error: 'second' });
  });
});

describe('UserStore.completeJobIfRunning', () => {
  it('completes a running job cleanly when error is undefined', async () => {
    await seedTranscribing();
    await store.completeJobIfRunning('j1', undefined, COMPLETE_AT);
    const job = ocrJob();
    expect(job).toMatchObject({ completed_at: COMPLETE_AT, status: 'done' });
    expect(job.error).toBeNull();
  });

  it('fails a running job when an error is provided', async () => {
    await seedTranscribing();
    await store.completeJobIfRunning('j1', 'pages failed', COMPLETE_AT);
    expect(ocrJob()).toMatchObject({ completed_at: COMPLETE_AT, error: 'pages failed', status: 'failed' });
  });

  it('is a no-op when the job is already terminal', async () => {
    seedReserved();
    await store.failJob('j1', 'first', COMPLETE_AT);
    await store.completeJobIfRunning('j1', 'second', COMPLETE_AT + 100);
    expect(ocrJob()).toMatchObject({ completed_at: COMPLETE_AT, error: 'first' });
  });
});

describe('UserStore.applyResult (page)', () => {
  it('marks the page done with markdown_key and records the receipt', async () => {
    await seedTranscribing('j1', 2);
    const applied = store.applyResult(
      { markdownKey: 'md/j1/p1.md', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'done' },
      COMPLETE_AT,
    );

    expect(applied).toBe(true);
    const page = mdPage('j1', 1);
    expect(page).toMatchObject({
      completed_at: COMPLETE_AT,
      markdown_key: 'md/j1/p1.md',
      status: 'done',
    });
    expect(page.error).toBeNull();
    expect(mdPage('j1', 2)).toMatchObject({ status: 'transcribing' });
    expect(receivedResultIds()).toEqual(['r1']);
  });

  it('marks the page failed when status=failed', async () => {
    await seedTranscribing();
    const applied = store.applyResult(
      { error: 'OCR crashed', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' },
      COMPLETE_AT,
    );

    expect(applied).toBe(true);
    const page = mdPage('j1', 1);
    expect(page).toMatchObject({ error: 'OCR crashed', status: 'failed' });
    expect(page.markdown_key).toBeNull();
  });

  it('defaults to "failed" when status=failed and no error message is supplied', async () => {
    await seedTranscribing();
    store.applyResult({ ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' }, COMPLETE_AT);
    expect(mdPage('j1', 1)).toMatchObject({ error: 'failed' });
  });

  it('returns false on replay but still records the receipt for forensics', async () => {
    await seedTranscribing();
    const first = store.applyResult(
      { markdownKey: 'md/j1/p1.md', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'done' },
      COMPLETE_AT,
    );
    const replay = store.applyResult(
      { markdownKey: 'md/j1/p1-other.md', ocrJobId: 'j1', pageNumber: 1, resultId: 'r2', status: 'done' },
      COMPLETE_AT + 100,
    );

    expect(first).toBe(true);
    expect(replay).toBe(false);
    expect(mdPage('j1', 1).markdown_key).toBe('md/j1/p1.md');
    expect(receivedResultIds().toSorted()).toEqual(['r1', 'r2']);
  });

  it('does not re-insert the same resultId twice', async () => {
    await seedTranscribing();
    store.applyResult({ ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' }, COMPLETE_AT);
    store.applyResult({ ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' }, COMPLETE_AT + 1);
    expect(receivedResultIds()).toEqual(['r1']);
  });
});

describe('UserStore.applyResult (job)', () => {
  it('marks the job done when no pageNumber is given', async () => {
    await seedTranscribing();
    const applied = store.applyResult({ ocrJobId: 'j1', resultId: 'r1', status: 'done' }, COMPLETE_AT);

    expect(applied).toBe(true);
    const job = ocrJob();
    expect(job).toMatchObject({ completed_at: COMPLETE_AT, status: 'done' });
    expect(job.error).toBeNull();
  });

  it('marks the job failed when status=failed', async () => {
    await seedTranscribing();
    const applied = store.applyResult(
      { error: 'pipeline aborted', ocrJobId: 'j1', resultId: 'r1', status: 'failed' },
      COMPLETE_AT,
    );

    expect(applied).toBe(true);
    expect(ocrJob()).toMatchObject({ error: 'pipeline aborted', status: 'failed' });
  });

  it('returns false on replay against an already terminal job', async () => {
    await seedTranscribing();
    store.applyResult({ ocrJobId: 'j1', resultId: 'r1', status: 'done' }, COMPLETE_AT);
    const replay = store.applyResult({ ocrJobId: 'j1', resultId: 'r2', status: 'failed' }, COMPLETE_AT + 100);

    expect(replay).toBe(false);
    expect(ocrJob()).toMatchObject({ status: 'done' });
  });
});

describe('UserStore.countInflight', () => {
  it('returns 0 when there are no jobs', async () => {
    expect(await store.countInflight()).toBe(0);
  });

  it('counts only jobs without completion and without error', async () => {
    seedReserved('running-1');
    seedReserved('running-2');
    await seedTranscribing('done-1');
    seedReserved('failed-1');
    await store.completeJobIfRunning('done-1', undefined, COMPLETE_AT);
    await store.failJob('failed-1', 'boom', COMPLETE_AT);

    expect(await store.countInflight()).toBe(2);
  });
});

describe('UserStore.countInflightPages', () => {
  it('counts only in-flight pages for the given job', async () => {
    await seedTranscribing('j1', 3);
    await seedTranscribing('j2', 2);
    store.applyResult({ markdownKey: 'k', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'done' }, COMPLETE_AT);
    store.applyResult({ error: 'x', ocrJobId: 'j1', pageNumber: 2, resultId: 'r2', status: 'failed' }, COMPLETE_AT);

    expect(await store.countInflightPages('j1')).toBe(1);
    expect(await store.countInflightPages('j2')).toBe(2);
  });
});

describe('UserStore.findStaleJobs', () => {
  it('returns jobs created before the cutoff that are still running', async () => {
    seedReserved('old', 0, 'u/old', 500);
    seedReserved('new', 0, 'u/new', 5000);

    const stale = await store.findStaleJobs(1000);
    expect(stale.map(s => s.id)).toEqual(['old']);
  });

  it('omits jobs that have already completed or failed', async () => {
    seedReserved('done', 0, 'u/done', 500);
    seedReserved('failed', 0, 'u/failed', 500);
    seedReserved('running', 0, 'u/running', 500);
    await store.confirmUpload({ ocrJobId: 'done', sizeBytes: 0, totalPages: 1 }, 600);
    await store.setPipelineId('done', 'p', 700);
    await store.completeJobIfRunning('done', undefined, 800);
    await store.failJob('failed', 'boom', 800);

    const stale = await store.findStaleJobs(1000);
    expect(stale.map(s => s.id)).toEqual(['running']);
  });
});

describe('UserStore.hasFailedPage', () => {
  it('returns true once any page is failed', async () => {
    await seedTranscribing('j1', 2);
    expect(await store.hasFailedPage('j1')).toBe(false);

    store.applyResult({ error: 'x', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' }, COMPLETE_AT);
    expect(await store.hasFailedPage('j1')).toBe(true);
  });

  it('ignores pages on other jobs', async () => {
    await seedTranscribing('j1', 1);
    await seedTranscribing('j2', 1);
    store.applyResult({ error: 'x', ocrJobId: 'j2', pageNumber: 1, resultId: 'r1', status: 'failed' }, COMPLETE_AT);

    expect(await store.hasFailedPage('j1')).toBe(false);
    expect(await store.hasFailedPage('j2')).toBe(true);
  });
});

describe('UserStore.readSnapshot', () => {
  it('orders jobs by created_at desc and pages by (ocr_job_id, page_number)', async () => {
    seedReserved('older', 0, 'u/older', 500);
    seedReserved('newer', 0, 'u/newer', 1500);
    await store.confirmUpload({ ocrJobId: 'older', sizeBytes: 0, totalPages: 2 }, 600);
    await store.confirmUpload({ ocrJobId: 'newer', sizeBytes: 0, totalPages: 2 }, 1600);

    const snap = await store.readSnapshot();
    expect(snap.ocr_jobs.map(j => j.id)).toEqual(['newer', 'older']);
    expect(snap.md_pages.map(p => `${p.ocr_job_id}:${p.page_number}`)).toEqual([
      'newer:1',
      'newer:2',
      'older:1',
      'older:2',
    ]);
  });
});

describe('UserStore.requireOcrJob', () => {
  it('returns the job when present', async () => {
    seedReserved();
    const job = await store.requireOcrJob('j1');
    expect(job.id).toBe('j1');
  });

  it('throws when the job is missing', async () => {
    await expect(store.requireOcrJob('nope')).rejects.toThrow(/ocr job not found: nope/);
  });
});

describe('UserStore.requireMdPage', () => {
  it('returns the page when present', async () => {
    seedReserved();
    await store.confirmUpload({ ocrJobId: 'j1', sizeBytes: 0, totalPages: 1 }, UPLOAD_AT);
    const page = await store.requireMdPage('j1', 1);
    expect(page).toMatchObject({ ocr_job_id: 'j1', page_number: 1, status: 'transcribing' });
  });

  it('throws when the page is missing', async () => {
    seedReserved();
    await expect(store.requireMdPage('j1', 99)).rejects.toThrow(/md page not found: j1\/99/);
  });
});
