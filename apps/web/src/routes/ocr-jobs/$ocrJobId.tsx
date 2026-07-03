import { useLiveQuery } from '@tanstack/react-db';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import type { MdPageRow } from '~/durable-objects/wire';

import { Markdown } from '~/client/markdown';
import { mdPagesCollection, ocrJobsCollection } from '~/client/ocr-jobs-collection';
import { BYTES_PER_KIB } from '~/constants';

const OcrJobPage = () => {
  const params: { ocrJobId: string } = Route.useParams();
  const { ocrJobId } = params;
  const { data: ocrJobMatches } = useLiveQuery(
    q => q.from({ j: ocrJobsCollection }).where(({ j }) => j.id === ocrJobId),
    [ocrJobId],
  );
  const { data: mdPages } = useLiveQuery(
    q =>
      q
        .from({ p: mdPagesCollection })
        .where(({ p }) => p.ocr_job_id === ocrJobId)
        .orderBy(({ p }) => p.page_number),
    [ocrJobId],
  );

  const ocrJob = ocrJobMatches[0];

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <p>
        <Link to="/">← Back</Link>
      </p>
      <h1>OCR job {ocrJobId}</h1>
      {ocrJob ? (
        <p>
          status: <strong>{ocrJob.status}</strong> · {ocrJob.total_pages} pages ·{' '}
          {(ocrJob.size_bytes / BYTES_PER_KIB).toFixed(1)} KiB
          {ocrJob.error ? ` · error: ${ocrJob.error}` : ''}
        </p>
      ) : (
        <p>loading…</p>
      )}
      <p>
        <a href={`/api/ocr-jobs/${ocrJobId}/upload`} rel="noreferrer" target="_blank">
          original PDF
        </a>
      </p>
      <hr />
      {mdPages.map(mdPage => (
        <MdPageBlock key={mdPage.page_number} mdPage={mdPage} ocrJobId={ocrJobId} />
      ))}
    </main>
  );
};

type MdPageBlockProps = { mdPage: MdPageRow; ocrJobId: string };

const MdPageBlock = ({ mdPage, ocrJobId }: MdPageBlockProps) => {
  const [markdown, setMarkdown] = useState<string>();

  useEffect(() => {
    if (mdPage.status !== 'done' || !mdPage.markdown_key) return;
    let isCancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/ocr-jobs/${ocrJobId}/md-pages/${mdPage.page_number}`);
        if (!r.ok) return;
        const text = await r.text();
        if (!isCancelled) setMarkdown(text);
      } catch {
        /* ignore fetch failures; rerender will retry on dep change */
      }
    };
    void load();
    return () => {
      isCancelled = true;
    };
  }, [ocrJobId, mdPage.page_number, mdPage.status, mdPage.markdown_key]);

  return (
    <section style={{ marginBlock: '1.5rem' }}>
      <h2>
        Page {mdPage.page_number} — <em>{mdPage.status}</em>
      </h2>
      {mdPage.status === 'failed' && <p style={{ color: 'crimson' }}>{mdPage.error ?? 'failed'}</p>}
      {mdPage.status === 'transcribing' && <p>transcribing…</p>}
      {mdPage.status === 'done' && markdown !== undefined && <Markdown source={markdown} />}
      {mdPage.status === 'done' && markdown === undefined && <p>fetching markdown…</p>}
    </section>
  );
};

export const Route = createFileRoute('/ocr-jobs/$ocrJobId')({
  component: OcrJobPage,
});
