import { describe, expect } from 'vitest';

import { it } from './_fixtures';

const REPLAY_DELAY = 100;
const COMPLETED_AT = 1500;
const LATER_AT = COMPLETED_AT + REPLAY_DELAY;
const TWO_PAGES = 2;
const THREE_PAGES = 3;
const SEQUENTIAL_PAGE_NUMBERS = Array.from({ length: THREE_PAGES }, (_, i) => i + 1);
const RUNNING_JOB_COUNT = 2;
const CUTOFF_AT = 1000;
const BEFORE_CUTOFF_AT = 500;
const AFTER_CUTOFF_AT = 5000;
const CONFIRM_AT = 600;
const PIPELINE_AT = 700;
const DONE_AT = 800;
const OLDER_AT = 500;
const NEWER_AT = 1500;
const OLDER_CONFIRM_AT = 600;
const NEWER_CONFIRM_AT = 1600;

describe('UserStore.reserveJob', () => {
  it('inserts a fresh job in awaiting_upload', ({ createdAt, ocrJob, store }) => {
    store.reserveJob({ ocrJobId: 'j1', sizeBytes: 12_345, uploadKey: 'u/j1' }, createdAt);
    expect(ocrJob('j1')).toMatchObject({
      created_at: createdAt,
      id: 'j1',
      size_bytes: 12_345,
      status: 'awaiting_upload',
      total_pages: 0,
      upload_key: 'u/j1',
    });
  });

  it('rejects duplicate ids', ({ createdAt, store }) => {
    store.reserveJob({ ocrJobId: 'j1', sizeBytes: 0, uploadKey: 'u' }, createdAt);
    expect(() => store.reserveJob({ ocrJobId: 'j1', sizeBytes: 0, uploadKey: 'u' }, createdAt)).toThrow(
      /UNIQUE|PRIMARY KEY/,
    );
  });
});

describe('UserStore.confirmUpload', () => {
  it('records size + page count and seeds md_pages with sequential numbers', ({
    db,
    ocrJob,
    schema,
    seedReserved,
    store,
    uploadAt,
  }) => {
    seedReserved();
    store.confirmUpload({ ocrJobId: 'j1', sizeBytes: 999, totalPages: 3 }, uploadAt);

    expect(ocrJob()).toMatchObject({ size_bytes: 999, status: 'uploaded', total_pages: 3 });
    const pageNumbers = db
      .select({ pn: schema.mdPages.page_number })
      .from(schema.mdPages)
      .all()
      .map(p => p.pn)
      .toSorted((a, b) => a - b);
    expect(pageNumbers).toEqual(SEQUENTIAL_PAGE_NUMBERS);
  });

  it('skips page seeding when totalPages is 0', ({ db, schema, seedReserved, store, uploadAt }) => {
    seedReserved();
    store.confirmUpload({ ocrJobId: 'j1', sizeBytes: 0, totalPages: 0 }, uploadAt);
    expect(db.select().from(schema.mdPages).all()).toEqual([]);
  });
});

describe('UserStore.setPipelineId', () => {
  it('writes pipeline_id and started_at atomically, advancing job to transcribing', ({
    ocrJob,
    seedReserved,
    startAt,
    store,
    uploadAt,
  }) => {
    seedReserved();
    store.confirmUpload({ ocrJobId: 'j1', sizeBytes: 100, totalPages: 1 }, uploadAt);
    store.setPipelineId('j1', 'pipe-1', startAt);

    expect(ocrJob()).toMatchObject({ pipeline_id: 'pipe-1', started_at: startAt, status: 'transcribing' });
  });
});

describe('UserStore.failJob', () => {
  it('marks the job failed with the given error', ({ completeAt, ocrJob, seedReserved, store }) => {
    seedReserved();
    store.failJob('j1', 'boom', completeAt);
    expect(ocrJob()).toMatchObject({ completed_at: completeAt, error: 'boom', status: 'failed' });
  });

  it('overwrites prior terminal state unconditionally', ({ completeAt, ocrJob, seedReserved, store }) => {
    seedReserved();
    store.failJob('j1', 'first', completeAt);
    store.failJob('j1', 'second', LATER_AT);
    expect(ocrJob()).toMatchObject({ completed_at: LATER_AT, error: 'second' });
  });
});

describe('UserStore.completeJobIfRunning', () => {
  it('completes a running job cleanly when error is undefined', ({ completeAt, ocrJob, seedTranscribing, store }) => {
    seedTranscribing();
    const completed = store.completeJobIfRunning('j1', undefined, completeAt);

    expect(completed).toMatchObject({
      op: 'ocr-job-upsert',
      row: { completed_at: completeAt, id: 'j1', status: 'done' },
    });
    expect(ocrJob().error).toBeNull();
  });

  it('fails a running job when an error is provided', ({ completeAt, ocrJob, seedTranscribing, store }) => {
    seedTranscribing();
    const completed = store.completeJobIfRunning('j1', 'pages failed', completeAt);

    expect(completed).toMatchObject({
      op: 'ocr-job-upsert',
      row: { completed_at: completeAt, error: 'pages failed', status: 'failed' },
    });
    expect(ocrJob()).toMatchObject({ completed_at: completeAt, error: 'pages failed', status: 'failed' });
  });

  it('returns undefined and leaves state untouched when the job is already terminal', ({
    completeAt,
    ocrJob,
    seedReserved,
    store,
  }) => {
    seedReserved();
    store.failJob('j1', 'first', completeAt);
    const completed = store.completeJobIfRunning('j1', 'second', LATER_AT);

    expect(completed).toBeUndefined();
    expect(ocrJob()).toMatchObject({ completed_at: completeAt, error: 'first' });
  });
});

describe('UserStore.saveUpdate (page)', () => {
  it('marks the page done with markdown_key and returns the broadcast row', ({
    completeAt,
    mdPage,
    seedTranscribing,
    store,
  }) => {
    seedTranscribing('j1', TWO_PAGES);
    const saved = store.saveUpdate(
      { markdownKey: 'md/j1/p1.md', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'done' },
      completeAt,
    );

    expect(saved).toMatchObject({
      op: 'md-page-upsert',
      row: { completed_at: completeAt, markdown_key: 'md/j1/p1.md', page_number: 1, status: 'done' },
    });
    expect(mdPage('j1', 1).error).toBeNull();
    expect(mdPage('j1', TWO_PAGES)).toMatchObject({ status: 'transcribing' });
  });

  it('marks the page failed when status=failed', ({ completeAt, mdPage, seedTranscribing, store }) => {
    seedTranscribing();
    const saved = store.saveUpdate(
      { error: 'OCR crashed', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' },
      completeAt,
    );

    expect(saved).toMatchObject({
      op: 'md-page-upsert',
      row: { error: 'OCR crashed', status: 'failed' },
    });
    expect(mdPage('j1', 1).markdown_key).toBeNull();
  });

  it('defaults to "failed" when status=failed and no error message is supplied', ({
    completeAt,
    mdPage,
    seedTranscribing,
    store,
  }) => {
    seedTranscribing();
    store.saveUpdate({ ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' }, completeAt);
    expect(mdPage('j1', 1)).toMatchObject({ error: 'failed' });
  });

  it('returns undefined on replay against an already finalized page', ({
    completeAt,
    mdPage,
    seedTranscribing,
    store,
  }) => {
    seedTranscribing();
    const first = store.saveUpdate(
      { markdownKey: 'md/j1/p1.md', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'done' },
      completeAt,
    );
    const replay = store.saveUpdate(
      { markdownKey: 'md/j1/p1-other.md', ocrJobId: 'j1', pageNumber: 1, resultId: 'r2', status: 'done' },
      LATER_AT,
    );

    expect(first).toMatchObject({ op: 'md-page-upsert' });
    expect(replay).toBeUndefined();
    expect(mdPage('j1', 1).markdown_key).toBe('md/j1/p1.md');
  });

  it('replaying a failed result is a no-op and leaves sibling pages untouched', ({
    completeAt,
    mdPage,
    seedTranscribing,
    store,
  }) => {
    seedTranscribing('j1', THREE_PAGES);
    const first = store.saveUpdate(
      { error: 'boom', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' },
      completeAt,
    );
    const replay = store.saveUpdate(
      { error: 'boom', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' },
      completeAt + 1,
    );

    expect(first).toMatchObject({ op: 'md-page-upsert' });
    expect(replay).toBeUndefined();
    expect(mdPage('j1', 1)).toMatchObject({ completed_at: completeAt, error: 'boom', status: 'failed' });
    expect(mdPage('j1', TWO_PAGES)).toMatchObject({ status: 'transcribing' });
    expect(mdPage('j1', THREE_PAGES)).toMatchObject({ status: 'transcribing' });
  });

  it('a failed page rejects a subsequent success replay', ({ completeAt, mdPage, seedTranscribing, store }) => {
    seedTranscribing();
    store.saveUpdate({ error: 'boom', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' }, completeAt);
    const replay = store.saveUpdate(
      { markdownKey: 'md/j1/p1.md', ocrJobId: 'j1', pageNumber: 1, resultId: 'r2', status: 'done' },
      LATER_AT,
    );

    expect(replay).toBeUndefined();
    const page = mdPage('j1', 1);
    expect(page).toMatchObject({ completed_at: completeAt, error: 'boom', status: 'failed' });
    expect(page.markdown_key).toBeNull();
  });
});

describe('UserStore.saveUpdate (job)', () => {
  it('marks the job done when no pageNumber is given and returns the broadcast row', ({
    completeAt,
    ocrJob,
    seedTranscribing,
    store,
  }) => {
    seedTranscribing();
    const saved = store.saveUpdate({ ocrJobId: 'j1', resultId: 'r1', status: 'done' }, completeAt);

    expect(saved).toMatchObject({
      op: 'ocr-job-upsert',
      row: { completed_at: completeAt, id: 'j1', status: 'done' },
    });
    expect(ocrJob().error).toBeNull();
  });

  it('marks the job failed when status=failed', ({ completeAt, ocrJob, seedTranscribing, store }) => {
    seedTranscribing();
    const saved = store.saveUpdate(
      { error: 'pipeline aborted', ocrJobId: 'j1', resultId: 'r1', status: 'failed' },
      completeAt,
    );

    expect(saved).toMatchObject({
      op: 'ocr-job-upsert',
      row: { error: 'pipeline aborted', status: 'failed' },
    });
    expect(ocrJob()).toMatchObject({ error: 'pipeline aborted', status: 'failed' });
  });

  it('returns undefined on replay against an already terminal job', ({
    completeAt,
    ocrJob,
    seedTranscribing,
    store,
  }) => {
    seedTranscribing();
    store.saveUpdate({ ocrJobId: 'j1', resultId: 'r1', status: 'done' }, completeAt);
    const replay = store.saveUpdate({ ocrJobId: 'j1', resultId: 'r2', status: 'failed' }, LATER_AT);

    expect(replay).toBeUndefined();
    expect(ocrJob()).toMatchObject({ status: 'done' });
  });

  it('a failed job rejects a subsequent success replay', ({ completeAt, ocrJob, seedTranscribing, store }) => {
    seedTranscribing();
    store.saveUpdate({ error: 'pipeline aborted', ocrJobId: 'j1', resultId: 'r1', status: 'failed' }, completeAt);
    const replay = store.saveUpdate({ ocrJobId: 'j1', resultId: 'r2', status: 'done' }, LATER_AT);

    expect(replay).toBeUndefined();
    expect(ocrJob()).toMatchObject({ completed_at: completeAt, error: 'pipeline aborted', status: 'failed' });
  });
});

describe('UserStore.countInflight', () => {
  it('returns 0 when there are no jobs', async ({ store }) => {
    expect(await store.countInflight()).toBe(0);
  });

  it('counts only jobs without completion and without error', async ({
    completeAt,
    seedReserved,
    seedTranscribing,
    store,
  }) => {
    seedReserved('running-1');
    seedReserved('running-2');
    seedTranscribing('done-1');
    seedReserved('failed-1');
    store.completeJobIfRunning('done-1', undefined, completeAt);
    store.failJob('failed-1', 'boom', completeAt);

    expect(await store.countInflight()).toBe(RUNNING_JOB_COUNT);
  });
});

describe('UserStore.countInflightPages', () => {
  it('counts only in-flight pages for the given job', async ({ completeAt, seedTranscribing, store }) => {
    seedTranscribing('j1', THREE_PAGES);
    seedTranscribing('j2', TWO_PAGES);
    store.saveUpdate({ markdownKey: 'k', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'done' }, completeAt);
    store.saveUpdate({ error: 'x', ocrJobId: 'j1', pageNumber: 2, resultId: 'r2', status: 'failed' }, completeAt);

    expect(await store.countInflightPages('j1')).toBe(1);
    expect(await store.countInflightPages('j2')).toBe(TWO_PAGES);
  });
});

describe('UserStore.findStaleJobs', () => {
  it('returns jobs created before the cutoff that are still running', async ({ seedReserved, store }) => {
    seedReserved('old', 0, 'u/old', BEFORE_CUTOFF_AT);
    seedReserved('new', 0, 'u/new', AFTER_CUTOFF_AT);

    const stale = await store.findStaleJobs(CUTOFF_AT);
    expect(stale.map(s => s.id)).toEqual(['old']);
  });

  it('omits jobs that have already completed or failed', async ({ seedReserved, store }) => {
    seedReserved('done', 0, 'u/done', BEFORE_CUTOFF_AT);
    seedReserved('failed', 0, 'u/failed', BEFORE_CUTOFF_AT);
    seedReserved('running', 0, 'u/running', BEFORE_CUTOFF_AT);
    store.confirmUpload({ ocrJobId: 'done', sizeBytes: 0, totalPages: 1 }, CONFIRM_AT);
    store.setPipelineId('done', 'p', PIPELINE_AT);
    store.completeJobIfRunning('done', undefined, DONE_AT);
    store.failJob('failed', 'boom', DONE_AT);

    const stale = await store.findStaleJobs(CUTOFF_AT);
    expect(stale.map(s => s.id)).toEqual(['running']);
  });
});

describe('UserStore.hasFailedPage', () => {
  it('returns true once any page is failed', async ({ completeAt, seedTranscribing, store }) => {
    seedTranscribing('j1', TWO_PAGES);
    expect(await store.hasFailedPage('j1')).toBe(false);

    store.saveUpdate({ error: 'x', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'failed' }, completeAt);
    expect(await store.hasFailedPage('j1')).toBe(true);
  });

  it('ignores pages on other jobs', async ({ completeAt, seedTranscribing, store }) => {
    seedTranscribing('j1', 1);
    seedTranscribing('j2', 1);
    store.saveUpdate({ error: 'x', ocrJobId: 'j2', pageNumber: 1, resultId: 'r1', status: 'failed' }, completeAt);

    expect(await store.hasFailedPage('j1')).toBe(false);
    expect(await store.hasFailedPage('j2')).toBe(true);
  });
});

describe('UserStore.readSnapshot', () => {
  it('orders jobs by created_at desc and pages by (ocr_job_id, page_number)', async ({ seedReserved, store }) => {
    seedReserved('older', 0, 'u/older', OLDER_AT);
    seedReserved('newer', 0, 'u/newer', NEWER_AT);
    store.confirmUpload({ ocrJobId: 'older', sizeBytes: 0, totalPages: TWO_PAGES }, OLDER_CONFIRM_AT);
    store.confirmUpload({ ocrJobId: 'newer', sizeBytes: 0, totalPages: TWO_PAGES }, NEWER_CONFIRM_AT);

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

it('ignores confirmations and pipeline updates for a missing job', ({ store }) => {
  expect(store.confirmUpload({ ocrJobId: 'missing', sizeBytes: 1, totalPages: 1 }, 1)).toEqual([]);
  expect(store.setPipelineId('missing', 'pipe-1', 1)).toBeUndefined();
});
