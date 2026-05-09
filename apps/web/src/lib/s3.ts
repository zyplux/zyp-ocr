import { AwsClient } from 'aws4fetch';

import { BLOB_CACHE_CONTROL, MARKDOWN_CONTENT_TYPE, PDF_CONTENT_TYPE } from '~/constants';

type Blob = { contentType: string; key: string };

const client = (env: Env) =>
  new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    region: env.S3_REGION,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    service: 's3',
  });

const objectUrl = (endpoint: string, env: Env, key: string) => `${endpoint}/${env.S3_BUCKET}/${key}`;

const fetchBlob = async (env: Env, b: Blob) => {
  const res = await client(env).fetch(objectUrl(env.S3_ENDPOINT, env, b.key));
  if (res.status === 404) return new Response('not found', { status: 404 });
  if (!res.ok) throw new Error(`GET ${b.key}: ${res.status}`);
  return new Response(res.body, {
    headers: { 'cache-control': BLOB_CACHE_CONTROL, 'content-type': b.contentType },
    status: 200,
  });
};

const fetchHead = async (env: Env, key: string, lastByte: number) => {
  const res = await client(env).fetch(objectUrl(env.S3_ENDPOINT, env, key), {
    headers: { range: `bytes=0-${lastByte}` },
  });
  if (res.status !== 200 && res.status !== 206) throw new Error(`GET ${key}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

const headBlob = async (env: Env, key: string) => {
  const res = await client(env).fetch(objectUrl(env.S3_ENDPOINT, env, key), { method: 'HEAD' });
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`HEAD ${key}: ${res.status}`);
  return { sizeBytes: Number.parseInt(res.headers.get('content-length') ?? '0', 10) };
};

const deleteBlob = async (env: Env, key: string) => {
  const res = await client(env).fetch(objectUrl(env.S3_ENDPOINT, env, key), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${key}: ${res.status}`);
};

const signPutUrl = async (env: Env, key: string, ttlSeconds: number) => {
  const url = new URL(objectUrl(env.S3_PUBLIC_ENDPOINT, env, key));
  url.searchParams.set('X-Amz-Expires', String(ttlSeconds));
  const signed = await client(env).sign(new Request(url, { method: 'PUT' }), {
    aws: { signQuery: true },
  });
  return signed.url;
};

export const blob = {
  delete: deleteBlob,
  fetch: fetchBlob,
  fetchHead,
  head: headBlob,
  mdPage: (ocrJobId: string, page: number) => ({
    contentType: MARKDOWN_CONTENT_TYPE,
    key: `ocr-jobs/${ocrJobId}/md-pages/${page}.md`,
  }),
  signPutUrl,
  upload: (ocrJobId: string) => ({
    contentType: PDF_CONTENT_TYPE,
    key: `ocr-jobs/${ocrJobId}/upload.pdf`,
  }),
};
