import { createServerFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import * as z from 'zod';

import { MAX_PDF_BYTES } from '~/constants';
import * as uploads from '~/lib/uploads';

const ReserveSchema = z.object({ sizeBytes: z.number().int().positive().max(MAX_PDF_BYTES) });
const ConfirmSchema = z.object({ ocrJobId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) });

export const reserveUpload = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ReserveSchema.parse(d))
  .handler(({ data }) => uploads.reservePdfUpload(env, data.sizeBytes));

export const confirmUpload = createServerFn({ method: 'POST' })
  .validator((d: unknown) => ConfirmSchema.parse(d))
  .handler(({ data }) => uploads.confirmPdfUpload(env, data.ocrJobId));
