import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { Hono } from 'hono';

import type { ApplyCallbackInput } from './durable-objects/user-do';

import { PipelineCallback } from './contracts';
import { verifyCallbackToken } from './lib/callback-token';
import { estimatePageCount } from './lib/pdf-pages';
import { makeS3Client, pageKey, sourceKey } from './lib/s3';

export { UserDO } from './durable-objects/user-do';

const startHandler = createStartHandler(defaultStreamHandler);

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 100;
const DEFAULT_USER_DO = 'default';

const userStub = (env: Env) => env.USER_DO.get(env.USER_DO.idFromName(DEFAULT_USER_DO));

const jsonResponse = (body: unknown, status = 200): Response =>
  Response.json(body, {
    headers: { 'content-type': 'application/json' },
    status,
  });

const handleCreateJob = async (request: Request, env: Env): Promise<Response> => {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/pdf')) {
    return jsonResponse({ error: 'expected application/pdf' }, 415);
  }
  const lengthHeader = request.headers.get('content-length');
  const declaredLength = lengthHeader ? Number.parseInt(lengthHeader, 10) : Number.NaN;
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
    return jsonResponse({ error: 'file too large (max 50 MB)' }, 413);
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_PDF_BYTES) {
    return jsonResponse({ error: 'file too large (max 50 MB)' }, 413);
  }

  const bytes = new Uint8Array(body);
  const totalPages = estimatePageCount(bytes);
  if (totalPages > MAX_PAGES) {
    return jsonResponse({ error: `too many pages (max ${MAX_PAGES})` }, 413);
  }

  const stub = userStub(env);
  const result = await stub.createJob({
    sizeBytes: bytes.byteLength,
    sourceKeyTemplate: 'jobs/{jobId}/source.pdf',
    totalPages,
  });
  const s3 = makeS3Client(env);
  await s3.send(
    new PutObjectCommand({
      Body: bytes,
      Bucket: env.S3_BUCKET,
      ContentType: 'application/pdf',
      Key: sourceKey(result.jobId),
    }),
  );
  return jsonResponse({ jobId: result.jobId });
};

const handleSnapshot = async (env: Env): Promise<Response> => {
  const stub = userStub(env);
  const snap = await stub.snapshot();
  return jsonResponse(snap);
};

const handleWebSocket = async (request: Request, env: Env): Promise<Response> => {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('expected websocket upgrade', { status: 426 });
  }
  const stub = userStub(env);
  const url = new URL(request.url);
  url.pathname = '/ws';
  return await stub.fetch(new Request(url, request));
};

const handlePipelineCallback = async (request: Request, env: Env): Promise<Response> => {
  const token = request.headers.get('x-callback-token');
  if (!token) return jsonResponse({ error: 'missing x-callback-token' }, 401);
  const secrets = [env.CALLBACK_HMAC_SECRET, env.CALLBACK_HMAC_SECRET_PREVIOUS ?? ''];
  let claims;
  try {
    claims = await verifyCallbackToken(token, secrets);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid token';
    return jsonResponse({ error: message }, 401);
  }
  const raw = await request.json();
  const parsed = PipelineCallback.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse({ details: parsed.error.issues, error: 'invalid callback payload' }, 400);
  }
  if (parsed.data.job_id !== claims.jobId) {
    return jsonResponse({ error: 'token / payload job mismatch' }, 403);
  }
  const stub = userStub(env);
  const input: ApplyCallbackInput = {
    callbackId: parsed.data.callback_id,
    jobId: parsed.data.job_id,
    status: parsed.data.status,
  };
  if (parsed.data.page_number != undefined) input.pageNumber = parsed.data.page_number;
  if (parsed.data.markdown_key) input.markdownKey = parsed.data.markdown_key;
  if (parsed.data.error) input.error = parsed.data.error;
  await stub.applyCallback(input);
  return jsonResponse({ ok: true });
};

const proxyBlob = async (env: Env, key: string, contentType: string): Promise<Response> => {
  const s3 = makeS3Client(env);
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    const body = obj.Body as ReadableStream | undefined;
    if (!body) return new Response('not found', { status: 404 });
    return new Response(body, {
      headers: {
        'cache-control': 'private, max-age=60',
        'content-type': contentType,
      },
      status: 200,
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
};

const api = new Hono<{ Bindings: Env }>()
  .post('/api/jobs', c => handleCreateJob(c.req.raw, c.env))
  .get('/api/me/items', c => handleSnapshot(c.env))
  .all('/api/me/ws', c => handleWebSocket(c.req.raw, c.env))
  .post('/api/pipeline/callback', c => handlePipelineCallback(c.req.raw, c.env))
  .get('/api/jobs/:jobId/source', c => proxyBlob(c.env, sourceKey(c.req.param('jobId')), 'application/pdf'))
  .get('/api/jobs/:jobId/pages/:page', c => {
    const page = Number.parseInt(c.req.param('page'), 10);
    return proxyBlob(c.env, pageKey(c.req.param('jobId'), page), 'text/markdown; charset=utf-8');
  });

export default {
  fetch: async (request, env, ctx) => {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return api.fetch(request, env, ctx);
    }
    return startHandler(request);
  },
} satisfies ExportedHandler<Env>;
