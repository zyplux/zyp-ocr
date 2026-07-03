// GENERATED FILE — do not edit by hand.
// Source of truth: services/transcription-api/src/transcription_api/schemas.py
// Run `just codegen` to regenerate.

import * as z from 'zod';

export const TranscriptionSubmissionSchema = z.object({
  ocr_job_id: z.string(),
  result_token: z.string(),
  result_url: z.string(),
  upload_key: z.string(),
});
export type TranscriptionSubmission = z.infer<typeof TranscriptionSubmissionSchema>;

export const TranscriptionSubmissionAckSchema = z.object({
  pipeline_id: z.string(),
});
export type TranscriptionSubmissionAck = z.infer<typeof TranscriptionSubmissionAckSchema>;

export const TranscriptionResultSchema = z.object({
  error: z.union([z.string(), z.null()]).optional(),
  markdown_key: z.union([z.string(), z.null()]).optional(),
  ocr_job_id: z.string(),
  page_number: z.union([z.number().int(), z.null()]).optional(),
  result_id: z.string(),
  status: z.enum(['done', 'failed']),
});
export type TranscriptionResult = z.infer<typeof TranscriptionResultSchema>;
