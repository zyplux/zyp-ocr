import { eq } from 'drizzle-orm';
import { test as base } from 'vitest';

import * as schema from '~/durable-objects/schema';
import { type MdPageDbRow, type OcrJobDbRow } from '~/durable-objects/schema';
import { UserStore } from '~/durable-objects/user-store';

import { createTestDb, type TestDb } from './_db';

export const CREATED_AT = 1000;
export const UPLOAD_AT = 1100;
export const START_AT = 1200;
export const COMPLETE_AT = 1500;

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
          .from(schema.md_pages)
          .where(eq(schema.md_pages.ocr_job_id, jobId))
          .all()
          .find(p => p.page_number === pageNumber),
      ),
    );
  },
  ocrJob: async ({ db }, use) => {
    await use((id = 'j1') => requireRow(db.select().from(schema.ocr_jobs).where(eq(schema.ocr_jobs.id, id)).get()));
  },
  seedReserved: async ({ db }, use) => {
    await use((id = 'j1', size = 100, key = 'uploads/j1', at = CREATED_AT) => {
      db.insert(schema.ocr_jobs)
        .values({ created_at: at, id, size_bytes: size, total_pages: 0, upload_key: key })
        .run();
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
