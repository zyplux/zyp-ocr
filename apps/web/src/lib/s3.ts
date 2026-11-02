import { AwsClient } from 'aws4fetch';

import { BLOB_CACHE_CONTROL, MARKDOWN_CONTENT_TYPE, PDF_CONTENT_TYPE } from '~/constants';

type Blob = { contentType: string; key: string };

type S3Environment = Pick<
  Env,
  'S3_ACCESS_KEY_ID' | 'S3_BUCKET' | 'S3_ENDPOINT' | 'S3_PUBLIC_ENDPOINT' | 'S3_REGION' | 'S3_SECRET_ACCESS_KEY'
>;

const HTTP_OK = 200;
const HTTP_PARTIAL_CONTENT = 206;
const HTTP_NOT_FOUND = 404;

const client = ({
  S3_ACCESS_KEY_ID: accessKeyId,
  S3_REGION: region,
  S3_SECRET_ACCESS_KEY: secretAccessKey,
}: S3Environment) =>
  new AwsClient({
    accessKeyId,
    region,
    secretAccessKey,
    service: 's3',
  });

const objectUrl = (endpoint: string, { S3_BUCKET: bucket }: S3Environment, key: string) =>
  `${endpoint}/${bucket}/${key}`;

const fetchBlob = async (env: S3Environment, { contentType, key }: Blob) => {
  const res = await client(env).fetch(objectUrl(env.S3_ENDPOINT, env, key));
  if (res.status === HTTP_NOT_FOUND) return new Response('not found', { status: HTTP_NOT_FOUND });
  if (!res.ok) throw new Error(`GET ${key}: ${res.status}`);
  return new Response(res.body, {
    headers: { 'cache-control': BLOB_CACHE_CONTROL, 'content-type': contentType },
    status: HTTP_OK,
  });
};

const fetchHead = async (env: S3Environment, key: string, lastByte: number) => {
  const res = await client(env).fetch(objectUrl(env.S3_ENDPOINT, env, key), {
    headers: { range: `bytes=0-${lastByte}` },
  });
  if (res.status !== HTTP_OK && res.status !== HTTP_PARTIAL_CONTENT) throw new Error(`GET ${key}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

const headBlob = async (env: S3Environment, key: string) => {
  const res = await client(env).fetch(objectUrl(env.S3_ENDPOINT, env, key), { method: 'HEAD' });
  if (res.status === HTTP_NOT_FOUND) return;
  if (!res.ok) throw new Error(`HEAD ${key}: ${res.status}`);
  return { sizeBytes: Number(res.headers.get('content-length') ?? '0') };
};

const deleteBlob = async (env: S3Environment, key: string) => {
  const res = await client(env).fetch(objectUrl(env.S3_ENDPOINT, env, key), { method: 'DELETE' });
  if (!res.ok && res.status !== HTTP_NOT_FOUND) throw new Error(`DELETE ${key}: ${res.status}`);
};

const signPutUrl = async (env: S3Environment, key: string, ttlSeconds: number) => {
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
