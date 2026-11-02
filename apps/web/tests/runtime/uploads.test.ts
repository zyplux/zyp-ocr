import { describe, expect, vi } from 'vitest';

import { it } from './fixtures';

const PDF_BYTES = 100;
const HTTP_NOT_FOUND = 404;

describe('PDF upload operations', () => {
  it('reserves an upload with a signed URL and starts transcription after PDF validation', async ({
    network,
    uploads,
  }) => {
    const reservation = await uploads.reserve(PDF_BYTES);
    expect(reservation.ocrJobId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(new URL(reservation.uploadUrl).searchParams.get('X-Amz-Signature')).toBeTruthy();
    network.reply(() => new Response(undefined, { headers: { 'content-length': String(PDF_BYTES) } }));
    network.reply(() => new Response('%PDF-1.4\n<< /Type /Pages /Count 2 >>'));
    network.reply(() => Response.json({ pipeline_id: 'pipe-upload' }));
    expect(await uploads.confirm(reservation.ocrJobId)).toEqual({ ocrJobId: reservation.ocrJobId });
    await vi.waitFor(() => {
      expect(network.requests.some(request => request.url.endsWith('/submit'))).toBe(true);
    });
  });

  it('records an absent upload without deleting an object', async ({ network, uploads }) => {
    const { ocrJobId } = await uploads.reserve(PDF_BYTES);
    network.reply(() => new Response(undefined, { status: HTTP_NOT_FOUND }));
    await expect(uploads.confirm(ocrJobId)).rejects.toThrow('upload not found');
    expect(network.requests.map(request => request.method)).toEqual(['HEAD']);
  });

  it('deletes oversized uploads before rejecting them', async ({ maxPdfBytes, network, uploads }) => {
    const { ocrJobId } = await uploads.reserve(PDF_BYTES);
    network.reply(() => new Response(undefined, { headers: { 'content-length': String(maxPdfBytes + 1) } }));
    network.reply(() => new Response());
    await expect(uploads.confirm(ocrJobId)).rejects.toThrow('file too large');
    expect(network.requests.map(request => request.method)).toEqual(['HEAD', 'DELETE']);
  });

  it('deletes files whose contents are not PDF', async ({ network, uploads }) => {
    const { ocrJobId } = await uploads.reserve(PDF_BYTES);
    network.reply(() => new Response(undefined, { headers: { 'content-length': String(PDF_BYTES) } }));
    network.reply(() => new Response('not a PDF'));
    network.reply(() => new Response());
    await expect(uploads.confirm(ocrJobId)).rejects.toThrow('not a PDF');
    expect(network.requests.map(request => request.method)).toEqual(['HEAD', 'GET', 'DELETE']);
  });

  it('deletes PDFs exceeding the page limit', async ({ maxPages, network, uploads }) => {
    const { ocrJobId } = await uploads.reserve(PDF_BYTES);
    network.reply(() => new Response(undefined, { headers: { 'content-length': String(PDF_BYTES) } }));
    network.reply(() => new Response(`%PDF-1.4\n<< /Type /Pages /Count ${maxPages + 1} >>`));
    network.reply(() => new Response());
    await expect(uploads.confirm(ocrJobId)).rejects.toThrow('too many pages');
  });
});
