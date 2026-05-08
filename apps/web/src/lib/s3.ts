import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { BLOB_CACHE_CONTROL, MARKDOWN_CONTENT_TYPE, PDF_CONTENT_TYPE } from '~/constants';

type Blob = { contentType: string; key: string };

const makeS3Client = (env: Env) =>
  new S3Client({
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    region: env.S3_REGION,
  });

const fetchBlob = async (env: Env, b: Blob) => {
  const s3 = makeS3Client(env);
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: b.key }));
    const body = obj.Body as ReadableStream | undefined;
    if (!body) return new Response('not found', { status: 404 });
    return new Response(body, {
      headers: { 'cache-control': BLOB_CACHE_CONTROL, 'content-type': b.contentType },
      status: 200,
    });
  } catch (err) {
    if (err instanceof NoSuchKey) return new Response('not found', { status: 404 });
    throw err;
  }
};

const putBlob = async (env: Env, b: Blob, body: Uint8Array) => {
  const s3 = makeS3Client(env);
  await s3.send(
    new PutObjectCommand({ Body: body, Bucket: env.S3_BUCKET, ContentType: b.contentType, Key: b.key }),
  );
};

export const blob = {
  fetch: fetchBlob,
  mdPage: (ocrJobId: string, page: number) => ({
    contentType: MARKDOWN_CONTENT_TYPE,
    key: `ocr-jobs/${ocrJobId}/md-pages/${page}.md`,
  }),
  put: putBlob,
  upload: (ocrJobId: string) => ({
    contentType: PDF_CONTENT_TYPE,
    key: `ocr-jobs/${ocrJobId}/upload.pdf`,
  }),
};
