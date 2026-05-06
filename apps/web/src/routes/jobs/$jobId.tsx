import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/jobs/$jobId")({
  component: JobPage,
});

function JobPage() {
  return (
    <main>
      <h1>Job</h1>
      <p>Per-page markdown will stream in here as the pipeline reports completions.</p>
    </main>
  );
}
