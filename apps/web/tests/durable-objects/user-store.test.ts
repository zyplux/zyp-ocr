// @vitest-environment node
import { describe, expect } from 'vitest';

import * as schema from '~/durable-objects/schema';

import { COMPLETE_AT, CREATED_AT, it, START_AT, UPLOAD_AT } from './_fixtures';

describe('UserStore.reserveJob', () => {
  it('inserts a fresh job in awaiting_upload', ({ ocrJob, store }) => {
    store.reserveJob({ ocrJobId: 'j1', sizeBytes: 12_345, uploadKey: 'u/j1' }, CREATED_AT);
    expect(ocrJob('j1')).toMatchObject({
      created_at: CREATED_AT,
      id: 'j1',
      size_bytes: 12_345,
      status: 'awaiting_upload',
      total_pages: 0,
      upload_key: 'u/j1',
    });
  });

  it('rejects duplicate ids', ({ store }) => {
    store.reserveJob({ ocrJobId: 'j1', sizeBytes: 0, uploadKey: 'u' }, CREATED_AT);
    expect(() => store.reserveJob({ ocrJobId: 'j1', sizeBytes: 0, uploadKey: 'u' }, CREATED_AT)).toThrow(
      /UNIQUE|PRIMARY KEY/,
    );
  });
});

describe('UserStore.confirmUpload', () => {
  it('records size + page count and seeds md_pages with sequential numbers', ({ db, ocrJob, seedReserved, store }) => {
    seedReserved();
    store.confirmUpload({ ocrJobId: 'j1', sizeBytes: 999, totalPages: 3 }, UPLOAD_AT);

    expect(ocrJob()).toMatchObject({ size_bytes: 999, status: 'uploaded', total_pages: 3 });
    const pageNumbers = db
      .select({ pn: schema.md_pages.page_number })
      .from(schema.md_pages)
      .all()
      .map(p => p.pn)
      .toSorted((a, b) => a - b);
    expect(pageNumbers).toEqual([1, 2, 3]);
  });

  it('skips page seeding when totalPages is 0', ({ db, seedReserved, store }) => {
    seedReserved();
    store.confirmUpload({ ocrJobId: 'j1', sizeBytes: 0, totalPages: 0 }, UPLOAD_AT);
    expect(db.select().from(schema.md_pages).all()).toEqual([]);
  });
});

describe('UserStore.setPipelineId', () => {
  it('writes pipeline_id and started_at atomically, advancing job to transcribing', ({
    ocrJob,
    seedReserved,
    store,
  }) => {
    seedReserved();
    store.confirmUpload({ ocrJobId: 'j1', sizeBytes: 100, totalPages: 1 }, UPLOAD_AT);
    store.setPipelineId('j1', 'pipe-1', START_AT);

    expect(ocrJob()).toMatchObject({ pipeline_id: 'pipe-1', started_at: START_AT, status: 'transcribing' });
  });
});

describe('UserStore.failJob', () => {
  it('marks the job failed with the given error', ({ ocrJob, seedReserved, store }) => {
    seedReserved();
    store.failJob('j1', 'boom', COMPLETE_AT);
    expect(ocrJob()).toMatchObject({ completed_at: COMPLETE_AT, error: 'boom', status: 'failed' });
  });

  it('overwrites prior terminal state unconditionally', ({ ocrJob, seedReserved, store }) => {
    seedReserved();
    store.failJob('j1', 'first', COMPLETE_AT);
    store.failJob('j1', 'second', COMPLETE_AT + 100);
    expect(ocrJob()).toMatchObject({ completed_at: COMPLETE_AT + 100, error: 'second' });
  });
});

describe('UserStore.completeJobIfRunning', () => {
  it('completes a running job cleanly when error is undefined', ({ ocrJob, seedTranscribing, store }) => {
    seedTranscribing();
    const completed = store.completeJobIfRunning('j1', undefined, COMPLETE_AT);

    expect(completed).toMatchObject({
      op: 'ocr-job-upsert',
      row: { completed_at: COMPLETE_AT, id: 'j1', status: 'done' },
    });
    expect(ocrJob().error).toBeNull();
  });

  it('fails a running job when an error is provided', ({ ocrJob, seedTranscribing, store }) => {
    seedTranscribing();
    const completed = store.completeJobIfRunning('j1', 'pages failed', COMPLETE_AT);

    expect(completed).toMatchObject({
      op: 'ocr-job-upsert',
      row: { completed_at: COMPLETE_AT, error: 'pages failed', status: 'failed' },
    });
    expect(ocrJob()).toMatchObject({ completed_at: COMPLETE_AT, error: 'pages failed', status: 'failed' });
  });

  it('returns undefined and leaves state untouched when the job is already terminal', ({
    ocrJob,
    seedReserved,
    store,
  }) => {
    seedReserved();
    store.failJob('j1', 'first', COMPLETE_AT);
    const completed = store.completeJobIfRunning('j1', 'second', COMPLETE_AT + 100);

    expect(completed).toBeUndefined();
    expect(ocrJob()).toMatchObject({ completed_at: COMPLETE_AT, error: 'first' });
  });
});

describe('UserStore.saveUpdate (page)', () => {
  it('marks the page done with markdown_key and returns the broadcast row', ({ mdPage, seedTranscribing, store }) => {
    seedTranscribing('j1', 2);
    const saved = store.saveUpdate(
      { markdownKey: 'md/j1/p1.md', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'done' },
      COMPLETE_AT,
    );

    expect(saved).toMatchObject({
      op: 'md-page-upsert',
      row: { completed_at: COMPLETE_AT, markdown_key: 'md/j1/p1.md', page_number: 1, status: 'done' },
    });
    expect(mdPage('j1', 1).error).toBeNull();
    expect(mdPage('j1', 2)).toMatchObject({ status: 'transcribing' });
  });

  it('marks the page failed when status=failed', ({ mdPage, seedTranscribing, store }) => {
    seedTranscribing();
    const saved = store.saveUpdate(
      { error: 'OCR crashed', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' },
      COMPLETE_AT,
    );

    expect(saved).toMatchObject({
      op: 'md-page-upsert',
      row: { error: 'OCR crashed', status: 'failed' },
    });
    expect(mdPage('j1', 1).markdown_key).toBeNull();
  });

  it('defaults to "failed" when status=failed and no error message is supplied', ({
    mdPage,
    seedTranscribing,
    store,
  }) => {
    seedTranscribing();
    store.saveUpdate({ ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' }, COMPLETE_AT);
    expect(mdPage('j1', 1)).toMatchObject({ error: 'failed' });
  });

  it('returns undefined on replay against an already finalized page', ({ mdPage, seedTranscribing, store }) => {
    seedTranscribing();
    const first = store.saveUpdate(
      { markdownKey: 'md/j1/p1.md', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'done' },
      COMPLETE_AT,
    );
    const replay = store.saveUpdate(
      { markdownKey: 'md/j1/p1-other.md', ocrJobId: 'j1', pageNumber: 1, resultId: 'r2', status: 'done' },
      COMPLETE_AT + 100,
    );

    expect(first).toMatchObject({ op: 'md-page-upsert' });
    expect(replay).toBeUndefined();
    expect(mdPage('j1', 1).markdown_key).toBe('md/j1/p1.md');
  });

  it('replaying a failed result is a no-op and leaves sibling pages untouched', ({
    mdPage,
    seedTranscribing,
    store,
  }) => {
    seedTranscribing('j1', 3);
    const first = store.saveUpdate(
      { error: 'boom', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' },
      COMPLETE_AT,
    );
    const replay = store.saveUpdate(
      { error: 'boom', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' },
      COMPLETE_AT + 1,
    );

    expect(first).toMatchObject({ op: 'md-page-upsert' });
    expect(replay).toBeUndefined();
    expect(mdPage('j1', 1)).toMatchObject({ completed_at: COMPLETE_AT, error: 'boom', status: 'failed' });
    expect(mdPage('j1', 2)).toMatchObject({ status: 'transcribing' });
    expect(mdPage('j1', 3)).toMatchObject({ status: 'transcribing' });
  });

  it('a failed page rejects a subsequent success replay', ({ mdPage, seedTranscribing, store }) => {
    seedTranscribing();
    store.saveUpdate({ error: 'boom', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' }, COMPLETE_AT);
    const replay = store.saveUpdate(
      { markdownKey: 'md/j1/p1.md', ocrJobId: 'j1', pageNumber: 1, resultId: 'r2', status: 'done' },
      COMPLETE_AT + 100,
    );

    expect(replay).toBeUndefined();
    const page = mdPage('j1', 1);
    expect(page).toMatchObject({ completed_at: COMPLETE_AT, error: 'boom', status: 'failed' });
    expect(page.markdown_key).toBeNull();
  });
});

describe('UserStore.saveUpdate (job)', () => {
  it('marks the job done when no pageNumber is given and returns the broadcast row', ({
    ocrJob,
    seedTranscribing,
    store,
  }) => {
    seedTranscribing();
    const saved = store.saveUpdate({ ocrJobId: 'j1', resultId: 'r1', status: 'done' }, COMPLETE_AT);

    expect(saved).toMatchObject({
      op: 'ocr-job-upsert',
      row: { completed_at: COMPLETE_AT, id: 'j1', status: 'done' },
    });
    expect(ocrJob().error).toBeNull();
  });

  it('marks the job failed when status=failed', ({ ocrJob, seedTranscribing, store }) => {
    seedTranscribing();
    const saved = store.saveUpdate(
      { error: 'pipeline aborted', ocrJobId: 'j1', resultId: 'r1', status: 'failed' },
      COMPLETE_AT,
    );

    expect(saved).toMatchObject({
      op: 'ocr-job-upsert',
      row: { error: 'pipeline aborted', status: 'failed' },
    });
    expect(ocrJob()).toMatchObject({ error: 'pipeline aborted', status: 'failed' });
  });

  it('returns undefined on replay against an already terminal job', ({ ocrJob, seedTranscribing, store }) => {
    seedTranscribing();
    store.saveUpdate({ ocrJobId: 'j1', resultId: 'r1', status: 'done' }, COMPLETE_AT);
    const replay = store.saveUpdate({ ocrJobId: 'j1', resultId: 'r2', status: 'failed' }, COMPLETE_AT + 100);

    expect(replay).toBeUndefined();
    expect(ocrJob()).toMatchObject({ status: 'done' });
  });

  it('a failed job rejects a subsequent success replay', ({ ocrJob, seedTranscribing, store }) => {
    seedTranscribing();
    store.saveUpdate({ error: 'pipeline aborted', ocrJobId: 'j1', resultId: 'r1', status: 'failed' }, COMPLETE_AT);
    const replay = store.saveUpdate({ ocrJobId: 'j1', resultId: 'r2', status: 'done' }, COMPLETE_AT + 100);

    expect(replay).toBeUndefined();
    expect(ocrJob()).toMatchObject({ completed_at: COMPLETE_AT, error: 'pipeline aborted', status: 'failed' });
  });
});

describe('UserStore.countInflight', () => {
  it('returns 0 when there are no jobs', async ({ store }) => {
    expect(await store.countInflight()).toBe(0);
  });

  it('counts only jobs without completion and without error', async ({ seedReserved, seedTranscribing, store }) => {
    seedReserved('running-1');
    seedReserved('running-2');
    seedTranscribing('done-1');
    seedReserved('failed-1');
    store.completeJobIfRunning('done-1', undefined, COMPLETE_AT);
    store.failJob('failed-1', 'boom', COMPLETE_AT);

    expect(await store.countInflight()).toBe(2);
  });
});

describe('UserStore.countInflightPages', () => {
  it('counts only in-flight pages for the given job', async ({ seedTranscribing, store }) => {
    seedTranscribing('j1', 3);
    seedTranscribing('j2', 2);
    store.saveUpdate({ markdownKey: 'k', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'done' }, COMPLETE_AT);
    store.saveUpdate({ error: 'x', ocrJobId: 'j1', pageNumber: 2, resultId: 'r2', status: 'failed' }, COMPLETE_AT);

    expect(await store.countInflightPages('j1')).toBe(1);
    expect(await store.countInflightPages('j2')).toBe(2);
  });
});

describe('UserStore.findStaleJobs', () => {
  it('returns jobs created before the cutoff that are still running', async ({ seedReserved, store }) => {
    seedReserved('old', 0, 'u/old', 500);
    seedReserved('new', 0, 'u/new', 5000);

    const stale = await store.findStaleJobs(1000);
    expect(stale.map(s => s.id)).toEqual(['old']);
  });

  it('omits jobs that have already completed or failed', async ({ seedReserved, store }) => {
    seedReserved('done', 0, 'u/done', 500);
    seedReserved('failed', 0, 'u/failed', 500);
    seedReserved('running', 0, 'u/running', 500);
    store.confirmUpload({ ocrJobId: 'done', sizeBytes: 0, totalPages: 1 }, 600);
    store.setPipelineId('done', 'p', 700);
    store.completeJobIfRunning('done', undefined, 800);
    store.failJob('failed', 'boom', 800);

    const stale = await store.findStaleJobs(1000);
    expect(stale.map(s => s.id)).toEqual(['running']);
  });
});

describe('UserStore.hasFailedPage', () => {
  it('returns true once any page is failed', async ({ seedTranscribing, store }) => {
    seedTranscribing('j1', 2);
    expect(await store.hasFailedPage('j1')).toBe(false);

    store.saveUpdate({ error: 'x', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' }, COMPLETE_AT);
    expect(await store.hasFailedPage('j1')).toBe(true);
  });

  it('ignores pages on other jobs', async ({ seedTranscribing, store }) => {
    seedTranscribing('j1', 1);
    seedTranscribing('j2', 1);
    store.saveUpdate({ error: 'x', ocrJobId: 'j2', pageNumber: 1, resultId: 'r1', status: 'failed' }, COMPLETE_AT);

    expect(await store.hasFailedPage('j1')).toBe(false);
    expect(await store.hasFailedPage('j2')).toBe(true);
  });
});

describe('UserStore.readSnapshot', () => {
  it('orders jobs by created_at desc and pages by (ocr_job_id, page_number)', async ({ seedReserved, store }) => {
    seedReserved('older', 0, 'u/older', 500);
    seedReserved('newer', 0, 'u/newer', 1500);
    store.confirmUpload({ ocrJobId: 'older', sizeBytes: 0, totalPages: 2 }, 600);
    store.confirmUpload({ ocrJobId: 'newer', sizeBytes: 0, totalPages: 2 }, 1600);

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
  it('returns the job when present', async ({ seedReserved, store }) => {
    seedReserved();
    const job = await store.requireOcrJob('j1');
    expect(job.id).toBe('j1');
  });

  it('throws when the job is missing', async ({ store }) => {
    await expect(store.requireOcrJob('nope')).rejects.toThrow(/ocr job not found: nope/);
  });
});

describe('UserStore.requireMdPage', () => {
  it('returns the page when present', async ({ seedReserved, store }) => {
    seedReserved();
    store.confirmUpload({ ocrJobId: 'j1', sizeBytes: 0, totalPages: 1 }, UPLOAD_AT);
    const page = await store.requireMdPage('j1', 1);
    expect(page).toMatchObject({ ocr_job_id: 'j1', page_number: 1, status: 'transcribing' });
  });

  it('throws when the page is missing', async ({ seedReserved, store }) => {
    seedReserved();
    await expect(store.requireMdPage('j1', 99)).rejects.toThrow(/md page not found: j1\/99/);
  });
});
