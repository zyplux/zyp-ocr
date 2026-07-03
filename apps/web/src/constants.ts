export const BYTES_PER_KIB = 1024;
const KIB_PER_MIB = 1024;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

export const BYTES_PER_MIB = KIB_PER_MIB * BYTES_PER_KIB;
export const MAX_PDF_MB = 50;
export const MAX_PDF_BYTES = MAX_PDF_MB * BYTES_PER_MIB;
export const MAX_PAGES = 100;

export const MAX_INFLIGHT_JOBS = 10;
export const TOKEN_TTL_SECONDS = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
export const DEFAULT_RECONCILE_TIMEOUT_SECONDS = 3600;

export const DEFAULT_USER_ID = 'default';

export const PDF_CONTENT_TYPE = 'application/pdf';
export const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';
export const BLOB_CACHE_CONTROL = 'private, max-age=60';
