const isErrorWithMessage = (error: unknown): error is { message: string } =>
  typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string';

const rawMessage = (error: unknown): string => {
  if (isErrorWithMessage(error)) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

export const getMessage = (error: unknown, context?: string): string => {
  const msg = rawMessage(error);
  return context ? `${context}: ${msg}` : msg;
};
