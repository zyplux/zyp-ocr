import { COMPLETE_AT, describe, expect, it, UPLOAD_AT } from '~tests/durable-objects/_fixtures';

import { estimatePageCount } from '~/lib/pdf-pages';
import { signResultToken, verifyResultToken } from '~/lib/result-token';

const SCAN_PAGE_COUNT = 2;
const MILLISECONDS_PER_SECOND = 1000;
const TOKEN_TTL_SECONDS = 60;

const claims = {
  exp: Math.floor(Date.now() / MILLISECONDS_PER_SECOND) + TOKEN_TTL_SECONDS,
  ocrJobId: 'j1',
  resultId: 'r1',
  userId: 'default',
};

describe('1.1 reserving and uploading a scan', () => {
  it('1.1.1 a fresh reservation starts awaiting upload', ({ ocrJob, seedReserved }) => {
    seedReserved();
    expect(ocrJob()).toMatchObject({ status: 'awaiting_upload', total_pages: 0 });
  });

  it('1.1.2 confirming the upload seeds one md page per pdf page', ({ mdPage, ocrJob, seedReserved, store }) => {
    seedReserved();
    store.confirmUpload({ ocrJobId: 'j1', sizeBytes: 1, totalPages: SCAN_PAGE_COUNT }, UPLOAD_AT);

    expect(ocrJob()).toMatchObject({ status: 'uploaded', total_pages: SCAN_PAGE_COUNT });
    expect(mdPage('j1', 1)).toMatchObject({ status: 'transcribing' });
    expect(mdPage('j1', SCAN_PAGE_COUNT)).toMatchObject({ status: 'transcribing' });
  });
});

describe('1.2 tracking transcription progress', () => {
  it('1.2.1 handing the job to the pipeline marks it transcribing', ({ ocrJob, seedTranscribing }) => {
    seedTranscribing();
    expect(ocrJob()).toMatchObject({ pipeline_id: 'pipe-j1', status: 'transcribing' });
  });

  it('1.2.2 a delivered page becomes done with its markdown key', ({ mdPage, seedTranscribing, store }) => {
    seedTranscribing();
    store.saveUpdate(
      { markdownKey: 'ocr-jobs/j1/md-pages/1.md', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'done' },
      COMPLETE_AT,
    );
    expect(mdPage('j1', 1)).toMatchObject({ markdown_key: 'ocr-jobs/j1/md-pages/1.md', status: 'done' });
  });

  it('1.2.3 the job completes once every page is delivered', ({ ocrJob, seedTranscribing, store }) => {
    seedTranscribing();
    store.saveUpdate(
      { markdownKey: 'ocr-jobs/j1/md-pages/1.md', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'done' },
      COMPLETE_AT,
    );
    store.completeJobIfRunning('j1', undefined, COMPLETE_AT);
    expect(ocrJob()).toMatchObject({ completed_at: COMPLETE_AT, status: 'done' });
  });
});

describe('1.3 guarding the result callback', () => {
  it('1.3.1 a signed result token round trips', async () => {
    const token = await signResultToken(claims, 'secret-a');
    await expect(verifyResultToken(token, ['secret-a'])).resolves.toEqual(claims);
  });

  it('1.3.2 a tampered result token is rejected', async () => {
    const token = await signResultToken(claims, 'secret-a');
    const [header] = token.split('.');
    await expect(verifyResultToken(`${header ?? ''}.AAAA`, ['secret-a'])).rejects.toThrow(/invalid signature/);
  });

  it('1.3.3 an expired result token is rejected', async () => {
    const expired = { ...claims, exp: Math.floor(Date.now() / MILLISECONDS_PER_SECOND) - 1 };
    const token = await signResultToken(expired, 'secret-a');
    await expect(verifyResultToken(token, ['secret-a'])).rejects.toThrow(/expired/);
  });
});

describe('1.4 estimating pdf page counts', () => {
  it('1.4.1 the page count comes from the pages object', () => {
    const pdf = `%PDF-1.4\n1 0 obj\n<< /Type /Pages /Kids [] /Count ${SCAN_PAGE_COUNT} >>\nendobj\n`;
    expect(estimatePageCount(new TextEncoder().encode(pdf))).toBe(SCAN_PAGE_COUNT);
  });

  it('1.4.2 an unparseable pdf falls back to a single page', () => {
    expect(estimatePageCount(new TextEncoder().encode('not a pdf'))).toBe(1);
  });
});
