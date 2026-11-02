// @vitest-environment jsdom
import { describe, expect, vi } from 'vitest';

import { it } from './fixtures';

const JOB_ID = '01J00000000000000000000000';
const HTTP_FORBIDDEN = 403;

const reservation = { ocrJobId: JOB_ID, uploadUrl: 'https://uploads.example.test/job.pdf' };

describe('OCR pages', () => {
  it('shows the empty job list and uploads a selected PDF before opening its job', async ({ browser }) => {
    vi.mocked(browser.uploads.reserveUpload).mockResolvedValue(reservation);
    vi.mocked(browser.uploads.confirmUpload).mockResolvedValue({ ocrJobId: JOB_ID });
    browser.fetch.reply(() => new Response());
    await browser.render();
    expect(browser.getPage().getByText('No OCR jobs yet.')).toBeInTheDocument();
    browser.upload(new File(['%PDF-'], 'scan.pdf', { type: 'application/pdf' }));
    await vi.waitFor(() => {
      expect(browser.getPage().getByRole('heading', { name: `OCR job ${JOB_ID}` })).toBeInTheDocument();
    });
    expect(browser.uploads.reserveUpload).toHaveBeenCalledWith({ data: { sizeBytes: '%PDF-'.length } });
    expect(browser.uploads.confirmUpload).toHaveBeenCalledWith({ data: { ocrJobId: JOB_ID } });
    expect(browser.fetch.requests[0]?.method).toBe('PUT');
    expect(browser.getPage().getByRole('link', { name: 'original PDF' })).toHaveAttribute(
      'href',
      `/api/ocr-jobs/${JOB_ID}/upload`,
    );
  });

  it('shows a failed upload and permits another attempt', async ({ browser }) => {
    vi.mocked(browser.uploads.reserveUpload).mockResolvedValue(reservation);
    browser.fetch.reply(() => new Response(undefined, { status: HTTP_FORBIDDEN }));
    await browser.render();
    browser.drop([]);
    browser.upload();
    expect(browser.uploads.reserveUpload).not.toHaveBeenCalled();
    browser.drop([new File(['%PDF-'], 'scan.pdf')]);
    await vi.waitFor(() => {
      expect(browser.getPage().getByText('upload: upload failed (403)')).toBeInTheDocument();
    });
    expect(document.querySelector('input')).not.toBeDisabled();
    expect(browser.uploads.confirmUpload).not.toHaveBeenCalled();
  });

  it('renders streamed job details and page markdown without losing failed page diagnostics', async ({
    browser,
    store,
    transport,
  }) => {
    const totalPages = 3;
    store.reserveJob({ ocrJobId: JOB_ID, sizeBytes: 100, uploadKey: 'scan.pdf' }, 1);
    store.confirmUpload({ ocrJobId: JOB_ID, sizeBytes: 100, totalPages }, 1);
    store.saveUpdate({ markdownKey: 'page-1.md', ocrJobId: JOB_ID, pageNumber: 1, resultId: 'r1', status: 'done' }, 1);
    store.saveUpdate({ error: 'unreadable', ocrJobId: JOB_ID, pageNumber: 2, resultId: 'r2', status: 'failed' }, 1);
    store.failJob(JOB_ID, 'transcription failed', 1);
    browser.fetch.reply(() => new Response('# First page'));
    await browser.render(`/ocr-jobs/${JOB_ID}`);
    transport.send(JSON.stringify({ op: 'snapshot', snapshot: await store.readSnapshot() }));
    await vi.waitFor(() => {
      expect(browser.getPage().getByText('# First page')).toBeInTheDocument();
    });
    expect(browser.getPage().getByText('unreadable')).toBeInTheDocument();
    expect(browser.getPage().getByText('transcribing…')).toBeInTheDocument();
    expect(browser.getPage().getByText(/0.1 KiB/)).toBeInTheDocument();
  });

  it('keeps completed pages in a loading state when their stored markdown cannot be fetched', async ({
    browser,
    store,
    transport,
  }) => {
    store.reserveJob({ ocrJobId: JOB_ID, sizeBytes: 100, uploadKey: 'scan.pdf' }, 1);
    store.confirmUpload({ ocrJobId: JOB_ID, sizeBytes: 100, totalPages: 1 }, 1);
    store.saveUpdate({ markdownKey: 'page.md', ocrJobId: JOB_ID, pageNumber: 1, resultId: 'r1', status: 'done' }, 1);
    browser.fetch.reply(() => new Response(undefined, { status: HTTP_FORBIDDEN }));
    await browser.render(`/ocr-jobs/${JOB_ID}`);
    transport.send(JSON.stringify({ op: 'snapshot', snapshot: await store.readSnapshot() }));
    await vi.waitFor(() => {
      expect(browser.fetch.requests).toHaveLength(1);
    });
    expect(browser.getPage().getByText('fetching markdown…')).toBeInTheDocument();
  });
});

it('lists streamed jobs with their status, page count and failure reason', async ({
  browser,
  completeAt,
  seedReserved,
  store,
  transport,
}) => {
  seedReserved(JOB_ID);
  seedReserved('01J00000000000000000000001');
  store.failJob(JOB_ID, 'OCR unavailable', completeAt);
  await browser.render();
  transport.send(JSON.stringify({ op: 'snapshot', snapshot: await store.readSnapshot() }));
  await vi.waitFor(() => {
    expect(browser.getPage().getByRole('link', { name: JOB_ID })).toBeInTheDocument();
  });
  expect(browser.getPage().getByText(/failed \(0 pages\).*OCR unavailable/)).toBeInTheDocument();
});
