import { describe, expect } from 'vitest';

import { it } from './fixtures';

describe('live OCR collections', () => {
  it('hydrates both collections from the shared state stream', async ({ seedTranscribing, store, transport }) => {
    seedTranscribing();
    const { mdPagesCollection, ocrJobsCollection } = transport.collections;
    await transport.hydrate(await store.readSnapshot());
    expect(transport.url()).toBe('/api/_internal/state-stream');
    expect(ocrJobsCollection.get('j1')).toMatchObject({ id: 'j1', status: 'transcribing' });
    expect(mdPagesCollection.get('j1#1')).toMatchObject({ ocr_job_id: 'j1', page_number: 1 });
  });

  it('applies delivered page and job updates without losing the other collection', async ({
    completeAt,
    seedTranscribing,
    store,
    transport,
  }) => {
    seedTranscribing();
    const { mdPagesCollection, ocrJobsCollection } = transport.collections;
    await transport.hydrate(await store.readSnapshot());
    const pageUpdate = store.saveUpdate(
      { markdownKey: 'pages/1.md', ocrJobId: 'j1', pageNumber: 1, resultId: 'r1', status: 'done' },
      completeAt,
    );
    transport.send(JSON.stringify(pageUpdate));
    transport.send(JSON.stringify(store.completeJobIfRunning('j1', undefined, completeAt)));
    expect(mdPagesCollection.get('j1#1')).toMatchObject({ markdown_key: 'pages/1.md', status: 'done' });
    expect(ocrJobsCollection.get('j1')).toMatchObject({ status: 'done' });
  });

  it('ignores malformed and unrecognised stream frames', async ({ seedTranscribing, store, transport }) => {
    seedTranscribing();
    const { mdPagesCollection, ocrJobsCollection } = transport.collections;
    await transport.hydrate(await store.readSnapshot());
    transport.send('not JSON');
    transport.send(JSON.stringify({ op: 'unknown' }));
    transport.send(1);
    expect(ocrJobsCollection.get('j1')?.status).toBe('transcribing');
    expect(mdPagesCollection.get('j1#1')?.status).toBe('transcribing');
  });

  it('closes the shared stream only after both collections are cleaned up', async ({ store, transport }) => {
    const { mdPagesCollection, ocrJobsCollection } = transport.collections;
    await transport.hydrate(await store.readSnapshot());
    await ocrJobsCollection.cleanup();
    expect(transport.isClosed()).toBe(false);
    await mdPagesCollection.cleanup();
    expect(transport.isClosed()).toBe(true);
  });
});
