// TanStack DB collection for jobs + job_pages.
// Hydrates from GET /api/me/items, stays live via WebSocket /api/me/ws.
// Wired into components via useLiveQuery — see plan/totvibe-ocr.md §6.

export const JOBS_COLLECTION_KEY = "jobs";
