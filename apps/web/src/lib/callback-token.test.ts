import { describe, expect, it } from 'vitest';

import { signCallbackToken, verifyCallbackToken } from './callback-token';

describe('callback-token', () => {
  const claims = {
    callbackId: '01CBID',
    exp: Math.floor(Date.now() / 1000) + 60,
    jobId: '01HABC',
    pageNumber: 3,
    userId: 'default',
  };

  it('round-trips with a valid secret', async () => {
    const token = await signCallbackToken(claims, 'test-secret');
    const decoded = await verifyCallbackToken(token, ['test-secret']);
    expect(decoded).toEqual(claims);
  });

  it('rejects a mismatched secret', async () => {
    const token = await signCallbackToken(claims, 'right-secret');
    await expect(verifyCallbackToken(token, ['wrong-secret'])).rejects.toThrow(/invalid signature/);
  });

  it('accepts the previous secret during rotation', async () => {
    const token = await signCallbackToken(claims, 'old-secret');
    const decoded = await verifyCallbackToken(token, ['new-secret', 'old-secret']);
    expect(decoded).toEqual(claims);
  });

  it('rejects expired tokens', async () => {
    const expired = { ...claims, exp: Math.floor(Date.now() / 1000) - 1 };
    const token = await signCallbackToken(expired, 'test-secret');
    await expect(verifyCallbackToken(token, ['test-secret'])).rejects.toThrow(/expired/);
  });

  it('rejects malformed tokens', async () => {
    await expect(verifyCallbackToken('nope', ['test-secret'])).rejects.toThrow();
  });
});
