import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { test, vi } from 'vitest';
import { interceptFetch } from '~tests/network';

import type { UserDO } from '~/durable-objects/user-do';

import { MAX_INFLIGHT_JOBS, MAX_PAGES, MAX_PDF_BYTES } from '~/constants';
import { DeltaSchema, type Snapshot } from '~/durable-objects/contracts';
import { verifyResultToken } from '~/lib/result-token';
import * as uploadOperations from '~/lib/uploads';
import api from '~/server';

vi.mock('@tanstack/react-start/server', () => ({
  createStartHandler: () => () => new Response('Application page'),
  defaultStreamHandler: vi.fn(),
}));

type RuntimeFixture = {
  api: (path: string, init?: RequestInit) => Promise<Response>;
  environment: typeof env;
  maxInflight: number;
  maxPages: number;
  maxPdfBytes: number;
  network: ReturnType<typeof interceptFetch>;
  reserveExcess: () => Promise<string>;
  runAlarm: () => Promise<boolean>;
  snapshot: () => Promise<Snapshot>;
  startJob: (pages?: number) => Promise<void>;
  stub: DurableObjectStub<UserDO>;
  uploads: {
    confirm: (id: string) => ReturnType<typeof uploadOperations.confirmPdfUpload>;
    reserve: (sizeBytes: number) => ReturnType<typeof uploadOperations.reservePdfUpload>;
  };
  verifyResultToken: typeof verifyResultToken;
};

const HTTP_OK = 200;
const PDF_BYTES = 100;

export const it = test.extend<RuntimeFixture>({
  api: async ({}, use) => {
    await use(async (path, init) => api.request(path, init, env));
  },
  environment: async ({}, use) => {
    await use(env);
  },
  maxInflight: MAX_INFLIGHT_JOBS,
  maxPages: MAX_PAGES,
  maxPdfBytes: MAX_PDF_BYTES,
  network: async ({}, use) => {
    const network = interceptFetch();
    try {
      await use(network);
    } finally {
      network.restore();
      vi.restoreAllMocks();
    }
  },
  reserveExcess: async ({ stub }, use) => {
    await use(() =>
      runInDurableObject(stub, async instance => {
        try {
          await instance.reserveUpload({ ocrJobId: 'excess', sizeBytes: PDF_BYTES, uploadKey: 'uploads/excess' });
          return 'accepted';
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          return error.message;
        }
      }),
    );
  },
  runAlarm: async ({ stub }, use) => {
    await use(() => runDurableObjectAlarm(stub));
  },
  snapshot: async ({ stub }, use) => {
    await use(async () => {
      const subscription = await stub.subscribe();
      const reader = subscription.stream.getReader();
      const first = await reader.read();
      await stub.unsubscribe(subscription.id);
      await reader.cancel();
      const frame = new TextDecoder().decode(first.value);
      const delta = DeltaSchema.parse(JSON.parse(frame.slice('data: '.length)));
      if (delta.op !== 'snapshot') throw new Error('Expected initial snapshot');
      return delta.snapshot;
    });
  },
  startJob: async ({ network, snapshot, stub }, use) => {
    await use(async (pages = 1) => {
      network.reply(() => Response.json({ pipeline_id: 'pipe-1' }, { status: HTTP_OK }));
      await stub.reserveUpload({ ocrJobId: 'job-1', sizeBytes: PDF_BYTES, uploadKey: 'uploads/job-1' });
      await stub.confirmUpload({ ocrJobId: 'job-1', sizeBytes: PDF_BYTES, totalPages: pages });
      await vi.waitFor(async () => {
        const current = await snapshot();
        if (current.ocr_jobs[0]?.status !== 'transcribing') throw new Error('Pipeline has not started');
      });
    });
  },
  stub: async ({}, use) => {
    await use(env.USER_DO.get(env.USER_DO.newUniqueId()));
  },
  uploads: async ({}, use) => {
    await use({
      confirm: id => uploadOperations.confirmPdfUpload(env, id),
      reserve: size => uploadOperations.reservePdfUpload(env, size),
    });
  },
  verifyResultToken: async ({}, use) => {
    await use(verifyResultToken);
  },
});
