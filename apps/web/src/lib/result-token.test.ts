import { describe, expect, it } from 'vitest';

import { signResultToken, verifyResultToken } from '~/lib/result-token';

describe('result-token', () => {
  const claims = {
    exp: Math.floor(Date.now() / 1000) + 60,
    ocrJobId: '01HABC',
    pageNumber: 3,
    resultId: '01CBID',
    userId: 'default',
  };

  it('round-trips with a valid secret', async () => {
    const token = await signResultToken(claims, 'test-secret');
    const decoded = await verifyResultToken(token, ['test-secret']);
    expect(decoded).toEqual(claims);
  });

  it('rejects a mismatched secret', async () => {
    const token = await signResultToken(claims, 'right-secret');
    await expect(verifyResultToken(token, ['wrong-secret'])).rejects.toThrow(/invalid signature/);
  });

  it('accepts the previous secret during rotation', async () => {
    const token = await signResultToken(claims, 'old-secret');
    const decoded = await verifyResultToken(token, ['new-secret', 'old-secret']);
    expect(decoded).toEqual(claims);
  });

  it('rejects expired tokens', async () => {
    const expired = { ...claims, exp: Math.floor(Date.now() / 1000) - 1 };
    const token = await signResultToken(expired, 'test-secret');
    await expect(verifyResultToken(token, ['test-secret'])).rejects.toThrow(/expired/);
  });

  it('rejects malformed tokens', async () => {
    await expect(verifyResultToken('nope', ['test-secret'])).rejects.toThrow();
  });
});
