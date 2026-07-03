import { eq } from 'drizzle-orm';
import { test as base } from 'vitest';

export { describe, expect } from 'vitest';

import * as schema from '~/durable-objects/schema';
import { type MdPageDbRow, type OcrJobDbRow } from '~/durable-objects/schema';
import { UserStore } from '~/durable-objects/user-store';

import { createTestDb, type TestDb } from './_db';

export const CREATED_AT = 1000;
export const UPLOAD_AT = 1100;
export const START_AT = 1200;
export const COMPLETE_AT = 1500;

const DEFAULT_SIZE_BYTES = 100;

const requireRow = <T>(row: T | undefined): T => {
  if (row === undefined) throw new Error('expected a row');
  return row;
};

export type UserStoreFixtures = {
  db: TestDb;
  mdPage: (jobId: string, pageNumber: number) => MdPageDbRow;
  ocrJob: (id?: string) => OcrJobDbRow;
  seedReserved: (id?: string, size?: number, key?: string, at?: number) => void;
  seedTranscribing: (id?: string, pages?: number) => void;
  store: UserStore;
};

export const it = base.extend<UserStoreFixtures>({
  db: async ({}, use) => {
    await use(createTestDb());
  },
  mdPage: async ({ db }, use) => {
    await use((jobId, pageNumber) =>
      requireRow(
        db
          .select()
          .from(schema.mdPages)
          .where(eq(schema.mdPages.ocr_job_id, jobId))
          .all()
          .find(p => p.page_number === pageNumber),
      ),
    );
  },
  ocrJob: async ({ db }, use) => {
    await use((id = 'j1') => requireRow(db.select().from(schema.ocrJobs).where(eq(schema.ocrJobs.id, id)).get()));
  },
  seedReserved: async ({ db }, use) => {
    await use((id = 'j1', size = DEFAULT_SIZE_BYTES, key = 'uploads/j1', at = CREATED_AT) => {
      db.insert(schema.ocrJobs).values({ created_at: at, id, size_bytes: size, total_pages: 0, upload_key: key }).run();
    });
  },
  seedTranscribing: async ({ seedReserved, store }, use) => {
    await use((id = 'j1', pages = 1) => {
      seedReserved(id);
      store.confirmUpload({ ocrJobId: id, sizeBytes: 100, totalPages: pages }, UPLOAD_AT);
      store.setPipelineId(id, `pipe-${id}`, START_AT);
    });
  },
  store: async ({ db }, use) => {
    await use(new UserStore(db));
  },
});
