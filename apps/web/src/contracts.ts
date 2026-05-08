// GENERATED FILE — do not edit by hand.
// Source of truth: services/pipeline-api/src/pipeline_api/schemas.py
// Run `just codegen` to regenerate.

import { z } from 'zod';

export const PipelineSubmission = z.object({
  callback_token: z.string(),
  callback_url: z.string(),
  ocr_job_id: z.string(),
  upload_key: z.string(),
});
export type PipelineSubmission = z.infer<typeof PipelineSubmission>;

export const PipelineSubmissionAck = z.object({
  pipeline_id: z.string(),
});
export type PipelineSubmissionAck = z.infer<typeof PipelineSubmissionAck>;

export const PipelineCallback = z.object({
  callback_id: z.string(),
  error: z.union([z.string(), z.null()]).optional(),
  markdown_key: z.union([z.string(), z.null()]).optional(),
  ocr_job_id: z.string(),
  page_number: z.union([z.number().int(), z.null()]).optional(),
  status: z.enum(['done', 'failed']),
});
export type PipelineCallback = z.infer<typeof PipelineCallback>;
