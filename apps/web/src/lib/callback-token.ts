// HMAC-SHA256 signing/verification for pipeline callback tokens.
// Claims: { userId, jobId, pageNumber?, callbackId, exp }
// Format: base64url(JSON(claims)) "." base64url(HMAC-SHA256(claims))
// See plan/totvibe-ocr.md §6 ("Signed callback tokens").

export type CallbackClaims = {
  userId: string;
  jobId: string;
  pageNumber?: number;
  callbackId: string;
  exp: number;
};

export function signCallbackToken(_claims: CallbackClaims, _secret: string): Promise<string> {
  return Promise.reject(new Error("not implemented"));
}

export function verifyCallbackToken(
  _token: string,
  _secrets: readonly string[],
): Promise<CallbackClaims> {
  return Promise.reject(new Error("not implemented"));
}
