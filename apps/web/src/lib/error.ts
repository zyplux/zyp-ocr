const rawMessage = (error: unknown) => {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

export const getMessage = (error: unknown, context?: string) => {
  const msg = rawMessage(error);
  return context ? `${context}: ${msg}` : msg;
};
