import type { Context, MiddlewareHandler } from 'hono';

import { zValidator } from '@hono/zod-validator';
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { Hono } from 'hono';
import { createFactory } from 'hono/factory';
import * as z from 'zod';

import type { ResultClaims } from '~/lib/result-token';

import { DEFAULT_USER_ID, MAX_PAGES } from '~/constants';
import { TranscriptionResult } from '~/contracts';
import { getMessage } from '~/lib/error';
import { verifyResultToken } from '~/lib/result-token';
import { blob } from '~/lib/s3';

export { UserDO } from '~/durable-objects/user-do';

export type TranscriptionUpdate = {
  error?: string;
  markdownKey?: string;
  ocrJobId: string;
  pageNumber?: number;
  resultId: string;
  status: 'done' | 'failed';
};

const startHandler = createStartHandler(defaultStreamHandler);

type App = { Bindings: Env; Variables: { claims: ResultClaims } };

const userStub = (env: Env) => env.USER_DO.get(env.USER_DO.idFromName(DEFAULT_USER_ID));

const handleStateStream = async (c: Context<App>) => {
  const stub = userStub(c.env);
  const sub = await stub.subscribe();
  c.req.raw.signal.addEventListener('abort', () => {
    void stub.unsubscribe(sub.id);
  });
  return new Response(sub.stream, {
    headers: {
      'cache-control': 'no-cache, no-transform',
      'content-type': 'text/event-stream',
      'x-accel-buffering': 'no',
    },
  });
};

const requireResultToken: MiddlewareHandler<App> = async (c, next) => {
  const token = c.req.header('x-result-token');
  if (!token) return c.json({ error: 'missing x-result-token' }, 401);
  try {
    const claims = await verifyResultToken(token, [c.env.RESULT_HMAC_SECRET, c.env.RESULT_HMAC_SECRET_PREVIOUS ?? '']);
    c.set('claims', claims);
  } catch (err) {
    return c.json({ error: getMessage(err, 'result token') }, 401);
  }
  await next();
};

const factory = createFactory<App>();

const transcriptionResultHandlers = factory.createHandlers(
  requireResultToken,
  zValidator('json', TranscriptionResult, (result, c) => {
    if (!result.success) {
      return c.json({ details: result.error.issues, error: 'invalid result payload' }, 400);
    }
  }),
  async c => {
    const claims = c.var.claims;
    const data = c.req.valid('json');
    if (data.ocr_job_id !== claims.ocrJobId) {
      return c.json({ error: 'token / payload ocr job mismatch' }, 403);
    }
    const input: TranscriptionUpdate = {
      ocrJobId: data.ocr_job_id,
      resultId: data.result_id,
      status: data.status,
      ...(data.page_number !== null && data.page_number !== undefined && { pageNumber: data.page_number }),
      ...(data.markdown_key && { markdownKey: data.markdown_key }),
      ...(data.error && { error: data.error }),
    };
    await userStub(c.env).onTranscriptionUpdate(input);
    return c.json({ ok: true });
  },
);

const OcrJobIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

const OcrJobParams = z.object({ ocrJobId: OcrJobIdSchema });
const MdPageParams = z.object({
  ocrJobId: OcrJobIdSchema,
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
  .get('/api/_internal/state-stream', handleStateStream)
  .post('/api/transcription/results', ...transcriptionResultHandlers)
  .get('/api/ocr-jobs/:ocrJobId/upload', ...blobRoute(OcrJobParams, p => blob.upload(p.ocrJobId)))
  .get('/api/ocr-jobs/:ocrJobId/md-pages/:page', ...blobRoute(MdPageParams, p => blob.mdPage(p.ocrJobId, p.page)))
  .all('/api/*', c => c.json({ error: 'not found' }, 404))
  .all('*', c => startHandler(c.req.raw));

export default api satisfies ExportedHandler<Env>;
