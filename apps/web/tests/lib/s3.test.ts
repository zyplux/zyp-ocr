import { describe, expect } from 'vitest';

import { it } from './fixtures';

describe('signed object storage requests', () => {
  it('uploads through a public presigned PUT URL without exposing the secret', async ({ blob, blobEnv }) => {
    const ttlSeconds = 600;
    const url = new URL(await blob.signPutUrl(blobEnv, blob.upload('job-1').key, ttlSeconds));
    expect(url.origin).toBe(blobEnv.S3_PUBLIC_ENDPOINT);
    expect(url.pathname).toBe('/scans/ocr-jobs/job-1/upload.pdf');
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(ttlSeconds));
    expect(url.searchParams.get('X-Amz-Credential')).toContain('test-access/');
    expect(url.searchParams.has('X-Amz-Signature')).toBe(true);
    expect(url.href).not.toContain(blobEnv.S3_SECRET_ACCESS_KEY);
  });

  it('fetches a PDF with signed authorization and private caching', async ({ blob, blobEnv, storage }) => {
    storage.reply(() => new Response('PDF bytes'));
    const response = await blob.fetch(blobEnv, blob.upload('job-1'));
    expect(await response.text()).toBe('PDF bytes');
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('cache-control')).toBe('private, max-age=60');
    expect(storage.requests[0]?.url).toBe('https://storage.example.test/scans/ocr-jobs/job-1/upload.pdf');
    expect(storage.requests[0]?.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
  });

  it('fetches markdown using its own content type', async ({ blob, blobEnv, storage }) => {
    storage.reply(() => new Response('# Page'));
    const pageNumber = 2;
    const response = await blob.fetch(blobEnv, blob.mdPage('job-1', pageNumber));
    expect(await response.text()).toBe('# Page');
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  });

  it('reports an absent object and rejects a denied download', async ({ blob, blobEnv, storage }) => {
    const missing = 404;
    const denied = 403;
    storage.reply(() => new Response(undefined, { status: missing }));
    const response = await blob.fetch(blobEnv, blob.upload('missing'));
    expect(response.status).toBe(missing);
    expect(await response.text()).toBe('not found');
    storage.reply(() => new Response(undefined, { status: denied }));
    await expect(blob.fetch(blobEnv, blob.upload('denied'))).rejects.toThrow('GET ocr-jobs/denied/upload.pdf: 403');
  });

  it('reads size metadata and distinguishes absence from denied access', async ({ blob, blobEnv, storage }) => {
    const sizeBytes = 123;
    const missing = 404;
    const denied = 403;
    storage.reply(() => new Response(undefined, { headers: { 'content-length': String(sizeBytes) } }));
    await expect(blob.head(blobEnv, 'scan.pdf')).resolves.toEqual({ sizeBytes });
    expect(storage.requests[0]?.method).toBe('HEAD');
    storage.reply(() => new Response(undefined));
    await expect(blob.head(blobEnv, 'scan.pdf')).resolves.toEqual({ sizeBytes: 0 });
    storage.reply(() => new Response(undefined, { status: missing }));
    await expect(blob.head(blobEnv, 'missing.pdf')).resolves.toBeUndefined();
    storage.reply(() => new Response(undefined, { status: denied }));
    await expect(blob.head(blobEnv, 'denied.pdf')).rejects.toThrow('HEAD denied.pdf: 403');
  });

  it('requests only the PDF header and accepts full or partial storage responses', async ({
    blob,
    blobEnv,
    storage,
  }) => {
    const lastByte = 4;
    const partial = 206;
    const denied = 403;
    storage.reply(() => new Response('%PDF-', { status: partial }));
    await expect(blob.fetchHead(blobEnv, 'scan.pdf', lastByte)).resolves.toEqual(new TextEncoder().encode('%PDF-'));
    expect(storage.requests[0]?.headers.get('range')).toBe('bytes=0-4');
    storage.reply(() => new Response('%PDF-'));
    await expect(blob.fetchHead(blobEnv, 'scan.pdf', lastByte)).resolves.toEqual(new TextEncoder().encode('%PDF-'));
    storage.reply(() => new Response(undefined, { status: denied }));
    await expect(blob.fetchHead(blobEnv, 'scan.pdf', lastByte)).rejects.toThrow('GET scan.pdf: 403');
  });

  it('deletes objects idempotently and reports authorization failures', async ({ blob, blobEnv, storage }) => {
    const missing = 404;
    const denied = 403;
    storage.reply(() => new Response(undefined));
    await expect(blob.delete(blobEnv, 'scan.pdf')).resolves.toBeUndefined();
    expect(storage.requests[0]?.method).toBe('DELETE');
    storage.reply(() => new Response(undefined, { status: missing }));
    await expect(blob.delete(blobEnv, 'scan.pdf')).resolves.toBeUndefined();
    storage.reply(() => new Response(undefined, { status: denied }));
    await expect(blob.delete(blobEnv, 'scan.pdf')).rejects.toThrow('DELETE scan.pdf: 403');
  });
});
