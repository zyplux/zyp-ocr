import { eq } from 'drizzle-orm';
import { it as base } from '~tests/lib/fixtures';

import * as schema from '~/durable-objects/schema';
import { type MdPageDbRow, type OcrJobDbRow } from '~/durable-objects/schema';
import { UserStore } from '~/durable-objects/user-store';

import { createTestDb, type TestDb } from './_db';

const CREATED_AT = 1000;
const UPLOAD_AT = 1100;
const START_AT = 1200;
const COMPLETE_AT = 1500;

const DEFAULT_SIZE_BYTES = 100;

const requireRow = <T>(row: T | undefined): T => {
  if (row === undefined) throw new Error('expected a row');
  return row;
};

type UserStoreFixtures = {
  completeAt: number;
  createdAt: number;
  db: TestDb;
  mdPage: (jobId: string, pageNumber: number) => MdPageDbRow;
  ocrJob: (id?: string) => OcrJobDbRow;
  schema: typeof schema;
  seedReserved: (id?: string, size?: number, key?: string, at?: number) => void;
  seedTranscribing: (id?: string, pages?: number) => void;
  startAt: number;
  store: UserStore;
  uploadAt: number;
};

export const it = base.extend<UserStoreFixtures>({
  completeAt: COMPLETE_AT,
  createdAt: CREATED_AT,
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
  schema: async ({}, use) => {
    await use(schema);
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
  startAt: START_AT,
  store: async ({ db }, use) => {
    await use(new UserStore(db));
  },
  uploadAt: UPLOAD_AT,
});
