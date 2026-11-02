import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { interceptFetch } from '~tests/network';

vi.mock('~/server-fns/uploads', () => ({ confirmUpload: vi.fn(), reserveUpload: vi.fn() }));
import { it as base } from '~tests/durable-objects/_fixtures';

import type { Snapshot } from '~/durable-objects/contracts';

import { Markdown } from '~/client/markdown';

const renderMarkdown = (source: string) => {
  const { container } = render(<Markdown source={source} />);
  const pre = container.querySelector('pre');
  if (!pre) throw new Error('Markdown block was not rendered');
  return pre;
};

type Browser = {
  drop: (files: File[]) => void;
  fetch: ReturnType<typeof interceptFetch>;
  getPage: typeof getPage;
  render: (path?: string) => Promise<void>;
  upload: (file?: File) => void;
  uploads: typeof import('~/server-fns/uploads');
};
type Collections = typeof import('~/client/ocr-jobs-collection');

type StateTransport = {
  collections: Collections;
  hydrate: (snapshot: Snapshot) => Promise<void>;
  isClosed: () => boolean;
  send: (frame: unknown) => void;
  url: () => string;
};

const dropZone = () => {
  const zone = document.querySelector('input[type=file]')?.parentElement;
  if (!zone) throw new Error('File drop zone is missing');
  return zone;
};

const getPage = () => within(document.documentElement);

export const it = base.extend<{ browser: Browser; renderMarkdown: typeof renderMarkdown; transport: StateTransport }>({
  browser: async ({ transport }, use) => {
    const network = interceptFetch();
    vi.spyOn(globalThis, 'scrollTo').mockImplementation(vi.fn());
    const uploads = await import('~/server-fns/uploads');
    const { getRouter } = await import('~/router');
    const router = getRouter();
    try {
      await use({
        drop: files => {
          fireEvent.dragOver(dropZone());
          fireEvent.drop(dropZone(), { dataTransfer: { files } });
        },
        fetch: network,
        getPage,
        render: async (path = '/') => {
          router.update({ history: createMemoryHistory({ initialEntries: [path] }) });
          await router.load();
          render(<RouterProvider router={router} />, { container: document });
          const ready = Promise.all([
            transport.collections.ocrJobsCollection.preload(),
            transport.collections.mdPagesCollection.preload(),
          ]);
          transport.send(JSON.stringify({ op: 'snapshot', snapshot: { md_pages: [], ocr_jobs: [] } }));
          await ready;
          await waitFor(() => {
            if (within(document.documentElement).queryAllByRole('heading').length === 0)
              throw new Error('Page has not loaded');
          });
        },
        upload: file => {
          const input = document.querySelector('input[type=file]');
          if (!input) throw new Error('File input is missing');
          fireEvent.change(input, { target: { files: file ? [file] : [] } });
        },
        uploads,
      });
    } finally {
      cleanup();
      network.restore();
      vi.restoreAllMocks();
      vi.resetAllMocks();
    }
  },
  renderMarkdown: async ({}, use) => {
    await use(renderMarkdown);
  },
  transport: async ({}, use) => {
    vi.resetModules();
    class StateStream extends EventTarget {
      static current: StateStream | undefined;
      isClosed = false;
      url: string;
      constructor(url: string) {
        super();
        this.url = url;
        StateStream.current = this;
      }
      close() {
        this.isClosed = true;
      }
    }
    vi.stubGlobal('EventSource', StateStream);
    const collections = await import('~/client/ocr-jobs-collection');
    const requireStream = () => {
      const stream = StateStream.current;
      if (!stream) throw new Error('State stream has not started');
      return stream;
    };
    try {
      await use({
        collections,
        hydrate: async snapshot => {
          const ready = Promise.all([collections.ocrJobsCollection.preload(), collections.mdPagesCollection.preload()]);
          requireStream().dispatchEvent(
            new MessageEvent('message', { data: JSON.stringify({ op: 'snapshot', snapshot }) }),
          );
          await ready;
        },
        isClosed: () => requireStream().isClosed,
        send: frame => {
          requireStream().dispatchEvent(new MessageEvent('message', { data: frame }));
        },
        url: () => requireStream().url,
      });
    } finally {
      await collections.ocrJobsCollection.cleanup();
      await collections.mdPagesCollection.cleanup();
      vi.unstubAllGlobals();
    }
  },
});
