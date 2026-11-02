import { describe, expect } from 'vitest';

import { it } from './fixtures';

const MILLISECONDS_PER_SECOND = 1000;
const TOKEN_TTL_SECONDS = 60;

describe('result-token', () => {
  const claims = {
    exp: Math.floor(Date.now() / MILLISECONDS_PER_SECOND) + TOKEN_TTL_SECONDS,
    ocrJobId: '01HABC',
    pageNumber: 3,
    resultId: '01CBID',
    userId: 'default',
  };

  it('round-trips with a valid secret', async ({ signResultToken, verifyResultToken }) => {
    const token = await signResultToken(claims, 'test-secret');
    const decoded = await verifyResultToken(token, ['test-secret']);
    expect(decoded).toEqual(claims);
  });

  it('rejects a mismatched secret', async ({ signResultToken, verifyResultToken }) => {
    const token = await signResultToken(claims, 'right-secret');
    await expect(verifyResultToken(token, ['wrong-secret'])).rejects.toThrow(/invalid signature/);
  });

  it('accepts the previous secret during rotation', async ({ signResultToken, verifyResultToken }) => {
    const token = await signResultToken(claims, 'old-secret');
    const decoded = await verifyResultToken(token, ['new-secret', 'old-secret']);
    expect(decoded).toEqual(claims);
  });

  it('rejects expired tokens', async ({ signResultToken, verifyResultToken }) => {
    const expired = { ...claims, exp: Math.floor(Date.now() / MILLISECONDS_PER_SECOND) - 1 };
    const token = await signResultToken(expired, 'test-secret');
    await expect(verifyResultToken(token, ['test-secret'])).rejects.toThrow(/expired/);
  });

  it('rejects malformed tokens', async ({ verifyResultToken }) => {
    await expect(verifyResultToken('nope', ['test-secret'])).rejects.toThrow();
  });
});

describe('result-token validation', () => {
  it('skips unconfigured rotation keys', async ({ signResultToken, verifyResultToken }) => {
    const claims = {
      exp: Math.floor(Date.now() / MILLISECONDS_PER_SECOND) + TOKEN_TTL_SECONDS,
      ocrJobId: 'j1',
      resultId: 'r1',
      userId: 'default',
    };
    const token = await signResultToken(claims, 'secret');
    expect(await verifyResultToken(token, ['', 'secret'])).toEqual(claims);
  });

  it('rejects correctly signed claims with an invalid expiry', async ({ signResultToken, verifyResultToken }) => {
    const token = await signResultToken({ exp: NaN, ocrJobId: 'j1', resultId: 'r1', userId: 'default' }, 'secret');
    await expect(verifyResultToken(token, ['secret'])).rejects.toThrow('malformed token');
  });
});
