import { describe, expect } from 'vitest';

import { it } from './fixtures';

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const JOB_ID = '01J00000000000000000000000';
const JOB_OTHER = '01J00000000000000000000001';

const callback = (token?: string, payload?: unknown) => ({
  body: JSON.stringify(
    payload ?? { markdown_key: 'page.md', ocr_job_id: JOB_ID, page_number: 1, result_id: 'r1', status: 'done' },
  ),
  headers: { 'content-type': 'application/json', ...(token && { 'x-result-token': token }) },
  method: 'POST',
});

describe('Worker HTTP API', () => {
  it('streams the initial state and closes the subscription when the client disconnects', async ({ api }) => {
    const abort = new AbortController();
    const response = await api('/api/_internal/state-stream', { signal: abort.signal });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Expected state stream');
    const frame = await reader.read();
    expect(new TextDecoder().decode(frame.value)).toContain('"op":"snapshot"');
    abort.abort();
    await reader.cancel();
  });

  it('rejects missing and invalid result tokens', async ({ api }) => {
    const missing = await api('/api/transcription/results', callback());
    expect(missing.status).toBe(HTTP_UNAUTHORIZED);
    expect(await missing.json()).toEqual({ error: 'missing x-result-token' });
    const invalid = await api('/api/transcription/results', callback('invalid'));
    expect(invalid.status).toBe(HTTP_UNAUTHORIZED);
  });

  it('rejects an invalid payload and a token for a different job', async ({ api, stub }) => {
    const token = await stub.signTokenFor({ ocrJobId: JOB_ID, resultId: 'r1', userId: 'default' });
    const invalid = await api('/api/transcription/results', callback(token, {}));
    expect(invalid.status).toBe(HTTP_BAD_REQUEST);
    expect(await invalid.json()).toMatchObject({ error: 'invalid result payload' });
    const mismatch = await api(
      '/api/transcription/results',
      callback(token, { ocr_job_id: JOB_OTHER, result_id: 'r1', status: 'failed' }),
    );
    expect(mismatch.status).toBe(HTTP_FORBIDDEN);
  });

  it('accepts authenticated completion and failure callbacks', async ({ api, stub }) => {
    const token = await stub.signTokenFor({ ocrJobId: JOB_ID, resultId: 'r1', userId: 'default' });
    const success = await api('/api/transcription/results', callback(token));
    expect(await success.json()).toEqual({ ok: true });
    const failed = callback(token, { error: 'unreadable', ocr_job_id: JOB_ID, result_id: 'r1', status: 'failed' });
    const failure = await api('/api/transcription/results', failed);
    expect(await failure.json()).toEqual({ ok: true });
  });

  it('serves original PDFs and page markdown through signed storage requests', async ({ api, network }) => {
    network.reply(() => new Response('PDF bytes'));
    const pdf = await api(`/api/ocr-jobs/${JOB_ID}/upload`);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(new TextDecoder().decode(await pdf.arrayBuffer())).toBe('PDF bytes');
    network.reply(() => new Response('# Page'));
    const page = await api(`/api/ocr-jobs/${JOB_ID}/md-pages/1`);
    expect(await page.text()).toBe('# Page');
  });

  it('rejects invalid blob paths and returns a JSON error for unknown API endpoints', async ({ api }) => {
    const invalidJob = await api('/api/ocr-jobs/invalid/upload');
    expect(invalidJob.status).toBe(HTTP_BAD_REQUEST);
    const invalidPage = await api(`/api/ocr-jobs/${JOB_ID}/md-pages/0`);
    expect(invalidPage.status).toBe(HTTP_BAD_REQUEST);
    const missing = await api('/api/missing');
    expect(missing.status).toBe(HTTP_NOT_FOUND);
    expect(await missing.json()).toEqual({ error: 'not found' });
  });

  it('delegates application pages to the React Start handler', async ({ api }) => {
    const page = await api('/');
    expect(await page.text()).toBe('Application page');
  });
});
