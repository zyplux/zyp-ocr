// Best-effort PDF page count by scanning for `/Type /Pages ... /Count <n>`.
// Works on uncompressed PDFs and most scan tools' output. If parsing fails we
// fall back to 1 — the pipeline will validate the actual page count and the
// DO accepts pipeline page numbers up to total_pages.

const PAGE_TYPE_RE = /\/Type\s*\/Pages\b/g;
const COUNT_RE = /\/Count\s+(\d+)/g;

export function estimatePageCount(bytes: Uint8Array): number {
  // Search the trailing 64 KiB first — page tree usually lives near the xref.
  const view = new TextDecoder("latin1").decode(bytes);
  const counts: number[] = [];
  let typeMatch: RegExpExecArray | null;
  while ((typeMatch = PAGE_TYPE_RE.exec(view)) !== null) {
    COUNT_RE.lastIndex = typeMatch.index;
    const c = COUNT_RE.exec(view);
    if (c?.[1]) counts.push(Number.parseInt(c[1], 10));
  }
  if (counts.length === 0) return 1;
  return Math.max(...counts);
}
