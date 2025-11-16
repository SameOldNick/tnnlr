export function isArbitraryObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return isArbitraryObject(error) &&
    error instanceof Error &&
    (typeof error.errno === "number" || typeof error.errno === "undefined") &&
    (typeof error.code === "string" || typeof error.code === "undefined") &&
    (typeof error.path === "string" || typeof error.path === "undefined") &&
    (typeof error.syscall === "string" || typeof error.syscall === "undefined");
}

export const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

export const retryAsync = async <T>(
  fn: (attempt: number) => Promise<T>,
  retriesOrWhen: number | ((error: unknown, attempt: number) => boolean),
  delayMs: number | ((attempt: number) => number)
): Promise<T> => {
  let attempt = 0;

  const when = typeof retriesOrWhen === 'number'
    ? (err: unknown, attempt: number) => attempt <= retriesOrWhen
    : retriesOrWhen;

  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      attempt++;

      if (!when(err, attempt)) {
        throw err;
      }

      const delay = typeof delayMs === 'number' ? delayMs : delayMs(attempt);

      await sleep(delay);
    }
  }
}
