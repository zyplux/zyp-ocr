import type { Context, MiddlewareHandler } from 'hono';

import { zValidator } from '@hono/zod-validator';
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { Hono } from 'hono';
import { createFactory } from 'hono/factory';
import { ulid } from 'ulid';
import { z } from 'zod';

import type { ApplyCallbackInput } from '~/durable-objects/user-do';
import type { CallbackClaims } from '~/lib/callback-token';

import {
  DEFAULT_USER_ID,
  MAX_PAGES,
  MAX_PDF_BYTES,
  MAX_PDF_MB,
  PDF_CONTENT_TYPE,
} from '~/constants';
import { PipelineCallback } from '~/contracts';
import { verifyCallbackToken } from '~/lib/callback-token';
import { getMessage } from '~/lib/error';
import { estimatePageCount } from '~/lib/pdf-pages';
import { blob } from '~/lib/s3';

export { UserDO } from '~/durable-objects/user-do';

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
  await blob.put(c.env, blob.source(jobId), bytes);

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
    return c.json({ error: getMessage(err, 'callback token') }, 401);
  }
  await next();
};

const factory = createFactory<App>();

const pipelineCallbackHandlers = factory.createHandlers(
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
);

const JobIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

const JobParams = z.object({ jobId: JobIdSchema });
const PageParams = z.object({
  jobId: JobIdSchema,
  page: z.coerce.number().int().min(1).max(MAX_PAGES),
});

const blobRoute = <S extends z.ZodType>(
  schema: S,
  toBlob: (params: z.output<S>) => { contentType: string; key: string },
) =>
  factory.createHandlers(
    zValidator('param', schema, (result, c) => {
      if (!result.success) return c.json({ error: 'invalid path params' }, 400);
    }),
    c => blob.fetch(c.env, toBlob(c.req.valid('param'))),
  );

const api = new Hono<App>()
  .post('/api/jobs', handleCreateJob)
  .get('/api/me/items', handleSnapshot)
  .all('/api/me/ws', handleWebSocket)
  .post('/api/pipeline/callback', ...pipelineCallbackHandlers)
  .get('/api/jobs/:jobId/source', ...blobRoute(JobParams, p => blob.source(p.jobId)))
  .get('/api/jobs/:jobId/pages/:page', ...blobRoute(PageParams, p => blob.page(p.jobId, p.page)))
  .all('/api/*', c => c.json({ error: 'not found' }, 404))
  .all('*', c => startHandler(c.req.raw));

export default api satisfies ExportedHandler<Env>;
