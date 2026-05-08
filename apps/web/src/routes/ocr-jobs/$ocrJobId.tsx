import { useLiveQuery } from '@tanstack/react-db';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import type { PageRow } from '~/durable-objects/user-do';

import { jobsCollection, pagesCollection } from '~/client/jobs-collection';
import { Markdown } from '~/client/markdown';

const JobPage = () => {
  const params: { jobId: string } = Route.useParams();
  const { jobId } = params;
  const { data: jobMatches } = useLiveQuery(
    q => q.from({ j: jobsCollection }).where(({ j }) => j.id === jobId),
    [jobId],
  );
  const { data: pages } = useLiveQuery(
    q =>
      q
        .from({ p: pagesCollection })
        .where(({ p }) => p.job_id === jobId)
        .orderBy(({ p }) => p.page_number),
    [jobId],
  );

  const job = jobMatches[0];

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <p>
        <Link to="/">← Back</Link>
      </p>
      <h1>Job {jobId}</h1>
      {job ? (
        <p>
          status: <strong>{job.status}</strong> · {job.total_pages} pages · {(job.size_bytes / 1024).toFixed(1)} KiB
          {job.error ? ` · error: ${job.error}` : ''}
        </p>
      ) : (
        <p>loading…</p>
      )}
      <p>
        <a href={`/api/jobs/${jobId}/source`} rel="noreferrer" target="_blank">
          original PDF
        </a>
      </p>
      <hr />
      {pages.map(page => (
        <PageBlock jobId={jobId} key={page.page_number} page={page} />
      ))}
    </main>
  );
};

const PageBlock = ({ jobId, page }: { jobId: string; page: PageRow }) => {
  const [markdown, setMarkdown] = useState<string>();

  useEffect(() => {
    if (page.status !== 'done' || !page.markdown_key) return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/jobs/${jobId}/pages/${page.page_number}`);
        if (!r.ok) return;
        const text = await r.text();
        if (!cancelled) setMarkdown(text);
      } catch {
        /* ignore fetch failures; rerender will retry on dep change */
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [jobId, page.page_number, page.status, page.markdown_key]);

  return (
    <section style={{ marginBlock: '1.5rem' }}>
      <h2>
        Page {page.page_number} — <em>{page.status}</em>
      </h2>
      {page.status === 'failed' && <p style={{ color: 'crimson' }}>{page.error ?? 'failed'}</p>}
      {page.status === 'pending' && <p>processing…</p>}
      {page.status === 'done' && markdown !== undefined && <Markdown source={markdown} />}
      {page.status === 'done' && markdown === undefined && <p>fetching markdown…</p>}
    </section>
  );
};

export const Route = createFileRoute('/jobs/$jobId')({
  component: JobPage,
});
