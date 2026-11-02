import { test } from 'vitest';
import { interceptFetch } from '~tests/network';

import { getMessage } from '~/lib/error';
import { estimatePageCount } from '~/lib/pdf-pages';
import { signResultToken, verifyResultToken } from '~/lib/result-token';
import { blob } from '~/lib/s3';

type Tools = {
  blob: typeof blob;
  blobEnv: Parameters<typeof blob.head>[0];
  estimatePageCount: typeof estimatePageCount;
  getMessage: typeof getMessage;
  signResultToken: typeof signResultToken;
  storage: ReturnType<typeof interceptFetch>;
  verifyResultToken: typeof verifyResultToken;
};

export const it = test.extend<Tools>({
  blob: async ({}, use) => {
    await use(blob);
  },
  blobEnv: {
    S3_ACCESS_KEY_ID: 'test-access',
    S3_BUCKET: 'scans',
    S3_ENDPOINT: 'https://storage.example.test',
    S3_PUBLIC_ENDPOINT: 'https://uploads.example.test',
    S3_REGION: 'auto',
    S3_SECRET_ACCESS_KEY: 'test-secret',
  },
  estimatePageCount: async ({}, use) => {
    await use(estimatePageCount);
  },
  getMessage: async ({}, use) => {
    await use(getMessage);
  },
  signResultToken: async ({}, use) => {
    await use(signResultToken);
  },
  storage: async ({}, use) => {
    const storage = interceptFetch();
    try {
      await use(storage);
    } finally {
      storage.restore();
    }
  },
  verifyResultToken: async ({}, use) => {
    await use(verifyResultToken);
  },
});
