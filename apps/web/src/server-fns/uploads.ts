import { createServerFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { ulid } from 'ulid';
import { z } from 'zod';

import { DEFAULT_USER_ID, MAX_PAGES, MAX_PDF_BYTES, MAX_PDF_MB } from '~/constants';
import { estimatePageCount } from '~/lib/pdf-pages';
import { blob } from '~/lib/s3';

const PDF_HEAD_BYTES = 1024 * 1024;
const PUT_TTL_SECONDS = 600;

const ReserveSchema = z.object({ sizeBytes: z.number().int().positive().max(MAX_PDF_BYTES) });
const ConfirmSchema = z.object({ ocrJobId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) });

export type ConfirmUploadInput = {
  ocrJobId: string;
  sizeBytes: number;
  totalPages: number;
};

export type ReserveUploadInput = {
  ocrJobId: string;
  sizeBytes: number;
  uploadKey: string;
};

const userStub = () => env.USER_DO.get(env.USER_DO.idFromName(DEFAULT_USER_ID));

const fail = async (ocrJobId: string, key: string, message: string, withDelete: boolean) => {
  if (withDelete) await blob.delete(env, key);
  await userStub().failUpload(ocrJobId, message);
  throw new Error(message);
};

export const reserveUpload = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => ReserveSchema.parse(d))
  .handler(async ({ data }) => {
    const ocrJobId = ulid();
    const { key } = blob.upload(ocrJobId);
    const uploadUrl = await blob.signPutUrl(env, key, PUT_TTL_SECONDS);
    await userStub().reserveUpload({ ocrJobId, sizeBytes: data.sizeBytes, uploadKey: key });
    return { ocrJobId, uploadUrl };
  });

export const confirmUpload = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => ConfirmSchema.parse(d))
  .handler(async ({ data }) => {
    const { key } = blob.upload(data.ocrJobId);
    const head = await blob.head(env, key);
    if (!head) return fail(data.ocrJobId, key, 'upload not found', false);
    if (head.sizeBytes > MAX_PDF_BYTES) {
      return fail(data.ocrJobId, key, `file too large (max ${MAX_PDF_MB} MB)`, true);
    }
    const headBytes = await blob.fetchHead(env, key, PDF_HEAD_BYTES - 1);
    if (!new TextDecoder('latin1').decode(headBytes.slice(0, 5)).startsWith('%PDF-')) {
      return fail(data.ocrJobId, key, 'not a PDF', true);
    }
    const totalPages = estimatePageCount(headBytes);
    if (totalPages > MAX_PAGES) {
      return fail(data.ocrJobId, key, `too many pages (max ${MAX_PAGES})`, true);
    }
    await userStub().confirmUpload({
      ocrJobId: data.ocrJobId,
      sizeBytes: head.sizeBytes,
      totalPages,
    });
    return { ocrJobId: data.ocrJobId };
  });
