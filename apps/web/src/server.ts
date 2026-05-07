import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { verifyCallbackToken } from './lib/callback-token';
import { estimatePageCount } from './lib/pdf-pages';
import { makeS3Client, pageKey, sourceKey } from './lib/s3';
import { PipelineCallback } from './contracts';
import type { ApplyCallbackInput } from './durable-objects/user-do';

export { UserDO } from './durable-objects/user-do';

const startHandler = createStartHandler(defaultStreamHandler);

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 100;
const DEFAULT_USER_DO = 'default';

function userStub(env: Env) {
  return env.USER_DO.get(env.USER_DO.idFromName(DEFAULT_USER_DO));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function handleCreateJob(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/pdf')) {
    return jsonResponse({ error: 'expected application/pdf' }, 415);
  }
  const lengthHeader = request.headers.get('content-length');
  const declaredLength = lengthHeader ? Number.parseInt(lengthHeader, 10) : NaN;
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
    totalPages,
    sourceKeyTemplate: 'jobs/{jobId}/source.pdf',
  });
  const s3 = makeS3Client(env);
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: sourceKey(result.jobId),
      Body: bytes,
      ContentType: 'application/pdf',
    }),
  );
  return jsonResponse({ jobId: result.jobId });
}

async function handleSnapshot(env: Env): Promise<Response> {
  const stub = userStub(env);
  const snap = await stub.snapshot();
  return jsonResponse(snap);
}

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('expected websocket upgrade', { status: 426 });
  }
  const stub = userStub(env);
  const url = new URL(request.url);
  url.pathname = '/ws';
  return await stub.fetch(new Request(url, request));
}

async function handlePipelineCallback(request: Request, env: Env): Promise<Response> {
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
    return jsonResponse({ error: 'invalid callback payload', details: parsed.error.issues }, 400);
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
  if (parsed.data.page_number != null) input.pageNumber = parsed.data.page_number;
  if (parsed.data.markdown_key) input.markdownKey = parsed.data.markdown_key;
  if (parsed.data.error) input.error = parsed.data.error;
  await stub.applyCallback(input);
  return jsonResponse({ ok: true });
}

async function proxyBlob(env: Env, key: string, contentType: string): Promise<Response> {
  const s3 = makeS3Client(env);
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    const body = obj.Body as ReadableStream | undefined;
    if (!body) return new Response('not found', { status: 404 });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': contentType,
        'cache-control': 'private, max-age=60',
      },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

const SOURCE_RE = /^\/api\/jobs\/([^/]+)\/source$/;
const PAGE_RE = /^\/api\/jobs\/([^/]+)\/pages\/(\d+)$/;

async function routeApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (!pathname.startsWith('/api/')) return null;

  if (pathname === '/api/jobs' && request.method === 'POST') {
    return await handleCreateJob(request, env);
  }
  if (pathname === '/api/me/items' && request.method === 'GET') {
    return await handleSnapshot(env);
  }
  if (pathname === '/api/me/ws') {
    return await handleWebSocket(request, env);
  }
  if (pathname === '/api/pipeline/callback' && request.method === 'POST') {
    return await handlePipelineCallback(request, env);
  }
  const sourceMatch = SOURCE_RE.exec(pathname);
  if (sourceMatch && request.method === 'GET') {
    return await proxyBlob(env, sourceKey(sourceMatch[1]!), 'application/pdf');
  }
  const pageMatch = PAGE_RE.exec(pathname);
  if (pageMatch && request.method === 'GET') {
    const jobId = pageMatch[1]!;
    const n = Number.parseInt(pageMatch[2]!, 10);
    return await proxyBlob(env, pageKey(jobId, n), 'text/markdown; charset=utf-8');
  }
  return new Response('not found', { status: 404 });
}

export default {
  async fetch(request, env) {
    const apiResponse = await routeApi(request, env);
    if (apiResponse) return apiResponse;
    return startHandler(request);
  },
} satisfies ExportedHandler<Env>;
