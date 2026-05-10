export function isPrepareShutdownSuccess(statusCode: number | undefined, payload: string): boolean {
  if (!statusCode || statusCode < 200 || statusCode >= 300) {
    return false;
  }

  try {
    const parsed = JSON.parse(payload) as { success?: unknown };
    return parsed?.success === true;
  } catch {
    return false;
  }
}
