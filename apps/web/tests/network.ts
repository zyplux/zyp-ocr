import { vi } from 'vitest';

export const interceptFetch = () => {
  const requests: Request[] = [];
  const pending: (() => Response)[] = [];
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    requests.push(
      input instanceof Request
        ? input
        : new Request(typeof input === 'string' ? new URL(input, 'http://localhost') : input, init),
    );
    const response = pending.shift();
    if (!response) throw new Error('No network response queued');
    return Promise.resolve(response());
  });
  return {
    reply: (response: () => Response) => {
      pending.push(response);
    },
    requests,
    restore: () => {
      mock.mockRestore();
    },
  };
};
