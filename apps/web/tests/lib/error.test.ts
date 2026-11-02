import { describe, expect } from 'vitest';

import { it } from './fixtures';

describe('error messages', () => {
  it('uses an exception message with optional operation context', ({ getMessage }) => {
    expect(getMessage(new Error('access denied'))).toBe('access denied');
    expect(getMessage({ message: 'access denied' }, 'upload')).toBe('upload: access denied');
  });

  it('renders non-error values as JSON', ({ getMessage }) => {
    expect(getMessage({ status: 'failed' })).toBe('{"status":"failed"}');
    expect(getMessage('failed')).toBe('"failed"');
    expect(getMessage({ message: 1 })).toBe('{"message":1}');
  });

  it('falls back to string conversion for values JSON cannot represent', ({ getMessage }) => {
    const bigint = 1n;
    expect(getMessage(bigint)).toBe('1');
  });
});
