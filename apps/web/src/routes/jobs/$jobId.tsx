import { Link, createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useState } from "react";
import { Markdown } from "../../client/markdown";
import { jobsCollection, pagesCollection } from "../../client/jobs-collection";
import type { PageRow } from "../../durable-objects/user-do";

export const Route = createFileRoute("/jobs/$jobId")({
  component: JobPage,
});

function JobPage() {
  const params: { jobId: string } = Route.useParams();
  const { jobId } = params;
  const { data: jobMatches } = useLiveQuery(
    (q) => q.from({ j: jobsCollection }).where(({ j }) => j.id === jobId),
    [jobId],
  );
  const { data: pages } = useLiveQuery(
    (q) =>
      q
        .from({ p: pagesCollection })
        .where(({ p }) => p.job_id === jobId)
        .orderBy(({ p }) => p.page_number),
    [jobId],
  );

  const job = jobMatches[0];

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <p>
        <Link to="/">← Back</Link>
      </p>
      <h1>Job {jobId}</h1>
      {job ? (
        <p>
          status: <strong>{job.status}</strong> · {job.total_pages} pages ·{" "}
          {(job.size_bytes / 1024).toFixed(1)} KiB
          {job.error ? ` · error: ${job.error}` : ""}
        </p>
      ) : (
        <p>loading…</p>
      )}
      <p>
        <a href={`/api/jobs/${jobId}/source`} target="_blank" rel="noreferrer">
          original PDF
        </a>
      </p>
      <hr />
      {pages.map((page) => (
        <PageBlock key={page.page_number} jobId={jobId} page={page} />
      ))}
    </main>
  );
}

function PageBlock({ jobId, page }: { jobId: string; page: PageRow }) {
  const [markdown, setMarkdown] = useState<string | null>(null);

  useEffect(() => {
    if (page.status !== "done" || !page.markdown_key) return;
    let cancelled = false;
    void fetch(`/api/jobs/${jobId}/pages/${page.page_number}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then((text) => {
        if (!cancelled) setMarkdown(text);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [jobId, page.page_number, page.status, page.markdown_key]);

  return (
    <section style={{ marginBlock: "1.5rem" }}>
      <h2>
        Page {page.page_number} — <em>{page.status}</em>
      </h2>
      {page.status === "failed" && (
        <p style={{ color: "crimson" }}>{page.error ?? "failed"}</p>
      )}
      {page.status === "pending" && <p>processing…</p>}
      {page.status === "done" && markdown !== null && <Markdown source={markdown} />}
      {page.status === "done" && markdown === null && <p>fetching markdown…</p>}
    </section>
  );
}
