import type { Context, MiddlewareHandler } from 'hono';

import { GetObjectCommand, NoSuchKey, PutObjectCommand } from '@aws-sdk/client-s3';
import { zValidator } from '@hono/zod-validator';
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { Hono } from 'hono';
import { ulid } from 'ulid';

import type { ApplyCallbackInput } from './durable-objects/user-do';
import type { CallbackClaims } from './lib/callback-token';

import {
  BLOB_CACHE_CONTROL,
  DEFAULT_USER_ID,
  MARKDOWN_CONTENT_TYPE,
  MAX_PAGES,
  MAX_PDF_BYTES,
  MAX_PDF_MB,
  PDF_CONTENT_TYPE,
} from './constants';
import { PipelineCallback } from './contracts';
import { verifyCallbackToken } from './lib/callback-token';
import { estimatePageCount } from './lib/pdf-pages';
import { makeS3Client, pageKey, sourceKey } from './lib/s3';

export { UserDO } from './durable-objects/user-do';

const startHandler = createStartHandler(defaultStreamHandler);

type App = { Bindings: Env; Variables: { claims: CallbackClaims } };

const userStub = (env: Env) => env.USER_DO.get(env.USER_DO.idFromName(DEFAULT_USER_ID));

const handleCreateJob = async (c: Context<App>) => {
  const request = c.req.raw;
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes(PDF_CONTENT_TYPE)) {
    return c.json({ error: `expected ${PDF_CONTENT_TYPE}` }, 415);
  }
  const lengthHeader = request.headers.get('content-length');
  const declaredLength = lengthHeader ? Number.parseInt(lengthHeader, 10) : Number.NaN;
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
    return c.json({ error: `file too large (max ${MAX_PDF_MB} MB)` }, 413);
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_PDF_BYTES) {
    return c.json({ error: `file too large (max ${MAX_PDF_MB} MB)` }, 413);
  }

  const bytes = new Uint8Array(body);
  const totalPages = estimatePageCount(bytes);
  if (totalPages > MAX_PAGES) {
    return c.json({ error: `too many pages (max ${MAX_PAGES})` }, 413);
  }

  const jobId = ulid();
  const s3 = makeS3Client(c.env);
  await s3.send(
    new PutObjectCommand({
      Body: bytes,
      Bucket: c.env.S3_BUCKET,
      ContentType: PDF_CONTENT_TYPE,
      Key: sourceKey(jobId),
    }),
  );

  const result = await userStub(c.env).createJob({
    jobId,
    sizeBytes: bytes.byteLength,
    sourceKeyTemplate: 'jobs/{jobId}/source.pdf',
    totalPages,
  });
  return c.json({ jobId: result.jobId });
};

const handleSnapshot = async (c: Context<App>) => {
  const snap = await userStub(c.env).snapshot();
  return c.json(snap);
};

const handleWebSocket = (c: Context<App>) => {
  const request = c.req.raw;
  if (request.headers.get('Upgrade') !== 'websocket') {
    return c.text('expected websocket upgrade', 426);
  }
  const url = new URL(request.url);
  url.pathname = '/ws';
  return userStub(c.env).fetch(new Request(url, request));
};

const requireCallbackToken: MiddlewareHandler<App> = async (c, next) => {
  const token = c.req.header('x-callback-token');
  if (!token) return c.json({ error: 'missing x-callback-token' }, 401);
  try {
    const claims = await verifyCallbackToken(token, [
      c.env.CALLBACK_HMAC_SECRET,
      c.env.CALLBACK_HMAC_SECRET_PREVIOUS ?? '',
    ]);
    c.set('claims', claims);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid token';
    return c.json({ error: message }, 401);
  }
  await next();
};

const proxyBlob = async (env: Env, key: string, contentType: string): Promise<Response> => {
  const s3 = makeS3Client(env);
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    const body = obj.Body as ReadableStream | undefined;
    if (!body) return new Response('not found', { status: 404 });
    return new Response(body, {
      headers: {
        'cache-control': BLOB_CACHE_CONTROL,
        'content-type': contentType,
      },
      status: 200,
    });
  } catch (err) {
    if (err instanceof NoSuchKey) return new Response('not found', { status: 404 });
    throw err;
  }
};

const api = new Hono<App>()
  .post('/api/jobs', handleCreateJob)
  .get('/api/me/items', handleSnapshot)
  .all('/api/me/ws', handleWebSocket)
  .post(
    '/api/pipeline/callback',
    requireCallbackToken,
    zValidator('json', PipelineCallback, (result, c) => {
      if (!result.success) {
        return c.json({ details: result.error.issues, error: 'invalid callback payload' }, 400);
      }
    }),
    async c => {
      const claims = c.var.claims;
      const data = c.req.valid('json');
      if (data.job_id !== claims.jobId) {
        return c.json({ error: 'token / payload job mismatch' }, 403);
      }
      const input: ApplyCallbackInput = {
        callbackId: data.callback_id,
        jobId: data.job_id,
        status: data.status,
        ...(data.page_number != undefined && { pageNumber: data.page_number }),
        ...(data.markdown_key && { markdownKey: data.markdown_key }),
        ...(data.error && { error: data.error }),
      };
      await userStub(c.env).applyCallback(input);
      return c.json({ ok: true });
    },
  )
  .get('/api/jobs/:jobId/source', c => proxyBlob(c.env, sourceKey(c.req.param('jobId')), PDF_CONTENT_TYPE))
  .get('/api/jobs/:jobId/pages/:page', c => {
    const page = Number.parseInt(c.req.param('page'), 10);
    return proxyBlob(c.env, pageKey(c.req.param('jobId'), page), MARKDOWN_CONTENT_TYPE);
  });

export default {
  fetch: async (request, env, ctx) => {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return api.fetch(request, env, ctx);
    }
    return startHandler(request);
  },
} satisfies ExportedHandler<Env>;
