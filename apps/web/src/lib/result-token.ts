// HMAC-SHA256 signing/verification for transcription result tokens.
// Claims: { userId, ocrJobId, pageNumber?, resultId, exp }
// Format: base64url(JSON(claims)) "." base64url(HMAC-SHA256(claims))
// See plan/totvibe-ocr.md §6 ("Signed result tokens").

export type ResultClaims = {
  exp: number;
  ocrJobId: string;
  pageNumber?: number;
  resultId: string;
  userId: string;
};

const isResultClaims = (x: unknown): x is ResultClaims => {
  if (x === null || typeof x !== 'object') return false;
  if (!('exp' in x) || typeof x.exp !== 'number') return false;
  if (!('ocrJobId' in x) || typeof x.ocrJobId !== 'string') return false;
  if (!('resultId' in x) || typeof x.resultId !== 'string') return false;
  if (!('userId' in x) || typeof x.userId !== 'string') return false;
  if ('pageNumber' in x && x.pageNumber !== undefined && typeof x.pageNumber !== 'number') return false;
  return true;
};

const encoder = new TextEncoder();

const base64UrlEncode = (bytes: Uint8Array) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCodePoint(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const base64UrlDecode = (input: string) => {
  const padded = input.replaceAll('-', '+').replaceAll('_', '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const bin = atob(padded + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.codePointAt(i) ?? 0;
  return bytes;
};

const importKey = async (secret: string) =>
  await crypto.subtle.importKey('raw', encoder.encode(secret), { hash: 'SHA-256', name: 'HMAC' }, false, [
    'sign',
    'verify',
  ]);

const timingSafeEqual = (a: Uint8Array, b: Uint8Array) => {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

export const signResultToken = async (claims: ResultClaims, secret: string) => {
  const headerBytes = encoder.encode(JSON.stringify(claims));
  const header = base64UrlEncode(headerBytes);
  const key = await importKey(secret);
  const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(header));
  return `${header}.${base64UrlEncode(new Uint8Array(sigBuf))}`;
};

export const verifyResultToken = async (token: string, secrets: readonly string[]) => {
  const dot = token.indexOf('.');
  if (dot === -1) throw new Error('malformed token');
  const header = token.slice(0, dot);
  const sig = base64UrlDecode(token.slice(dot + 1));
  const headerBytes = encoder.encode(header);

  let matched = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const key = await importKey(secret);
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, headerBytes));
    if (timingSafeEqual(expected, sig)) {
      matched = true;
      break;
    }
  }
  if (!matched) throw new Error('invalid signature');

  const claimsJson = new TextDecoder().decode(base64UrlDecode(header));
  const claims: unknown = JSON.parse(claimsJson);
  if (!isResultClaims(claims)) throw new Error('malformed token');
  if (claims.exp * 1000 < Date.now()) throw new Error('token expired');
  return claims;
};
