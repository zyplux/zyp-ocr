import { useLiveQuery } from '@tanstack/react-db';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useCallback, useState } from 'react';

import { ocrJobsCollection } from '~/client/ocr-jobs-collection';
import { getMessage } from '~/lib/error';

const HomePage = () => {
  const router = useRouter();
  const { data: ocrJobs } = useLiveQuery(q => q.from({ j: ocrJobsCollection }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const upload = useCallback(
    async (file: File) => {
      setBusy(true);
      setError('');
      try {
        const res = await fetch('/api/ocr-jobs', {
          body: file,
          headers: { 'content-type': 'application/pdf' },
          method: 'POST',
        });
        if (!res.ok) {
          const raw: unknown = await res.json().catch(() => ({}));
          const body = (raw ?? {}) as { error?: string };
          throw new Error(body.error ?? `upload failed (${res.status})`);
        }
        const { ocrJobId }: { ocrJobId: string } = await res.json();
        await router.navigate({ params: { ocrJobId }, to: '/ocr-jobs/$ocrJobId' });
      } catch (err) {
        setError(getMessage(err, 'upload'));
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

      <h2>OCR jobs</h2>
      {ocrJobs.length === 0 ? (
        <p>No OCR jobs yet.</p>
      ) : (
        <ul>
          {ocrJobs.map(ocrJob => (
            <li key={ocrJob.id}>
              <Link params={{ ocrJobId: ocrJob.id }} to="/ocr-jobs/$ocrJobId">
                {ocrJob.id}
              </Link>{' '}
              — {ocrJob.status} ({ocrJob.total_pages} pages)
              {ocrJob.error ? ` — ${ocrJob.error}` : ''}
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
