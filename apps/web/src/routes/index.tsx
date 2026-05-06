import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <main>
      <h1>totvibe-ocr</h1>
      <p>Drop a scanned PDF to get markdown back, page-by-page.</p>
    </main>
  );
}
