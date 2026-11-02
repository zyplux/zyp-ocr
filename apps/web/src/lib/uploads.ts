import { ulid } from 'ulid';

import { BYTES_PER_MIB, DEFAULT_USER_ID, MAX_PAGES, MAX_PDF_BYTES, MAX_PDF_MB } from '~/constants';
import { estimatePageCount } from '~/lib/pdf-pages';
import { blob } from '~/lib/s3';

const PDF_HEAD_BYTES = BYTES_PER_MIB;
const PDF_MAGIC = '%PDF-';
const PUT_TTL_SECONDS = 600;

const userStub = ({ USER_DO: userDoNamespace }: Env) =>
  userDoNamespace.get(userDoNamespace.idFromName(DEFAULT_USER_ID));

const fail = async (env: Env, ocrJobId: string, key: string, message: string, shouldDeleteBlob: boolean) => {
  if (shouldDeleteBlob) await blob.delete(env, key);
  await userStub(env).failUpload(ocrJobId, message);
  throw new Error(message);
};

export const reservePdfUpload = async (env: Env, sizeBytes: number) => {
  const ocrJobId = ulid();
  const { key } = blob.upload(ocrJobId);
  const uploadUrl = await blob.signPutUrl(env, key, PUT_TTL_SECONDS);
  await userStub(env).reserveUpload({ ocrJobId, sizeBytes, uploadKey: key });
  return { ocrJobId, uploadUrl };
};

export const confirmPdfUpload = async (env: Env, ocrJobId: string) => {
  const { key } = blob.upload(ocrJobId);
  const head = await blob.head(env, key);
  if (!head) return fail(env, ocrJobId, key, 'upload not found', false);
  if (head.sizeBytes > MAX_PDF_BYTES) {
    return fail(env, ocrJobId, key, `file too large (max ${MAX_PDF_MB} MB)`, true);
  }
  const headBytes = await blob.fetchHead(env, key, PDF_HEAD_BYTES - 1);
  if (!new TextDecoder('latin1').decode(headBytes.slice(0, PDF_MAGIC.length)).startsWith(PDF_MAGIC)) {
    return fail(env, ocrJobId, key, 'not a PDF', true);
  }
  const totalPages = estimatePageCount(headBytes);
  if (totalPages > MAX_PAGES) {
    return fail(env, ocrJobId, key, `too many pages (max ${MAX_PAGES})`, true);
  }
  await userStub(env).confirmUpload({
    ocrJobId,
    sizeBytes: head.sizeBytes,
    totalPages,
  });
  return { ocrJobId };
};
