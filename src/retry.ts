/**
 * Conservative retry policy. Retries are bounded by attempt count AND a
 * total timeout budget, use exponential backoff with jitter, and honor a
 * server-supplied Retry-After header when present.
 */

export interface RetryPolicy {
  /** Total attempts including the first (not "retries"). Default 3. */
  maxAttempts: number;
  /** Base delay for exponential backoff, in ms. Default 200. */
  baseDelayMs: number;
  /** Upper bound on any single computed delay, in ms. Default 5000. */
  maxDelayMs: number;
  /** Total wall-clock budget across all attempts, in ms. Default 30000. */
  timeoutBudgetMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5000,
  timeoutBudgetMs: 30_000,
};

/** Full jitter exponential backoff (AWS-style): random in [0, cappedDelay]. */
export function computeBackoffMs(attempt: number, policy: RetryPolicy): number {
  const exp = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, policy.maxDelayMs);
  return Math.random() * capped;
}

/** Parse a Retry-After header: either delta-seconds or an HTTP-date. */
export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

/**
 * HTTP-status-level retry classification for transport-received responses.
 * This only covers "did we get a response, and should THAT status be
 * retried" — auth/authz/validation/conflict statuses always return false
 * here; callers additionally gate on operation-level idempotency safety
 * (see client.ts `isSafeToRetry`).
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;
  if (status === 502 || status === 503 || status === 504) return true;
  return false;
}
