import { useLiveQuery } from '@tanstack/react-db';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useCallback, useState } from 'react';

import { jobsCollection } from '../client/jobs-collection';

const HomePage = () => {
  const router = useRouter();
  const { data: jobs } = useLiveQuery(q => q.from({ j: jobsCollection }));
  const [error, setError] = useState<null | string>(null);
  const [busy, setBusy] = useState(false);

  const upload = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch('/api/jobs', {
          body: file,
          headers: { 'content-type': 'application/pdf' },
          method: 'POST',
        });
        if (!res.ok) {
          const raw: unknown = await res.json().catch(() => ({}));
          const body = (raw ?? {}) as { error?: string };
          throw new Error(body.error ?? `upload failed (${res.status})`);
        }
        const { jobId }: { jobId: string } = await res.json();
        await router.navigate({ params: { jobId }, to: '/jobs/$jobId' });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'upload failed');
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) void upload(file);
    },
    [upload],
  );

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>totvibe-ocr</h1>
      <p>Drop a scanned PDF to get markdown back, page-by-page.</p>

      <div
        onDragOver={e => {
          e.preventDefault();
        }}
        onDrop={onDrop}
        style={{
          border: '2px dashed #888',
          marginBottom: '1rem',
          opacity: busy ? 0.6 : 1,
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        <p>Drop a PDF here, or pick a file:</p>
        <input
          accept="application/pdf"
          disabled={busy}
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
          type="file"
        />
      </div>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      <h2>Jobs</h2>
      {jobs.length === 0 ? (
        <p>No jobs yet.</p>
      ) : (
        <ul>
          {jobs.map(job => (
            <li key={job.id}>
              <Link params={{ jobId: job.id }} to="/jobs/$jobId">
                {job.id}
              </Link>{' '}
              — {job.status} ({job.total_pages} pages)
              {job.error ? ` — ${job.error}` : ''}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
};

export const Route = createFileRoute('/')({
  component: HomePage,
});
