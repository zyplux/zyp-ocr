// Wire schemas for SSE state-stream frames between the DurableObject and the
// client collection. Lives separately from `user-do.ts` so the schemas (and
// inferred types) can be imported on the client without pulling in
// `cloudflare:workers`.
//
// Row shapes are duplicated from `schema.ts` here because `drizzle-zod`
// misinfers SQLite text/integer columns as Buffer/any under our drizzle-orm
// 0.45 + TS 6 setup. If that gets fixed upstream, switch to
// `createSelectSchema(table).extend({ status })`.

import * as z from 'zod';

const MdPageRowSchema = z.object({
  completed_at: z.number().nullable(),
  created_at: z.number(),
  error: z.string().nullable(),
  markdown_key: z.string().nullable(),
  ocr_job_id: z.string(),
  page_number: z.number(),
  started_at: z.number().nullable(),
  status: z.enum(['transcribing', 'done', 'failed']),
});

const OcrJobRowSchema = z.object({
  completed_at: z.number().nullable(),
  created_at: z.number(),
  error: z.string().nullable(),
  id: z.string(),
  pipeline_id: z.string().nullable(),
  size_bytes: z.number(),
  started_at: z.number().nullable(),
  status: z.enum(['awaiting_upload', 'uploaded', 'transcribing', 'done', 'failed']),
  total_pages: z.number(),
  upload_key: z.string(),
});

const SnapshotSchema = z.object({
  md_pages: z.array(MdPageRowSchema),
  ocr_jobs: z.array(OcrJobRowSchema),
});

export const Delta = z.discriminatedUnion('op', [
  z.object({ op: z.literal('md-page-upsert'), row: MdPageRowSchema }),
  z.object({ op: z.literal('ocr-job-upsert'), row: OcrJobRowSchema }),
  z.object({ op: z.literal('snapshot'), snapshot: SnapshotSchema }),
]);

export type Delta = z.infer<typeof Delta>;
export type MdPageRow = z.infer<typeof MdPageRowSchema>;
export type OcrJobRow = z.infer<typeof OcrJobRowSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
