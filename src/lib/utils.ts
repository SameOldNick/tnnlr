import logger from "../logger.js";

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
  fn: () => Promise<T>,
  retries: number,
  delayMs: number
): Promise<T> => {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries) {
        throw err;
      }
      logger.warn(`Attempt ${attempt} failed. Retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }
  throw new Error('Unreachable code');
}
