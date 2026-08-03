import {
  AmpError,
  CancellationError,
  MalformedResponseError,
  TimeoutError,
  TransportError,
  errorFromEnvelope,
} from './errors.js';
import {
  DEFAULT_RETRY_POLICY,
  RetryPolicy,
  computeBackoffMs,
  isRetryableStatus,
  parseRetryAfterMs,
} from './retry.js';

export const SDK_VERSION = '0.1.0';
export const DEFAULT_USER_AGENT = `inquiryon-amp-sdk-ts/${SDK_VERSION}`;

/** Hard cap on response bytes read into memory, regardless of Content-Length. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MiB

export interface ClientOptions {
  /** Base URL of the amp-community server, e.g. "http://127.0.0.1:8080". */
  baseUrl: string;
  /** Bearer token. Never logged; never placed in the User-Agent string. */
  token: string;
  /** Default per-call timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Retry policy overrides. */
  retry?: Partial<RetryPolicy>;
  /**
   * Additional User-Agent product token appended after the SDK's own
   * identifier, e.g. "my-agent/2.1". Never include secrets here.
   */
  userAgent?: string;
  /** Override for the fetch implementation (tests only). */
  fetch?: typeof fetch;
  /**
   * Require HTTPS for non-loopback base URLs. Default true. Set false only
   * for deliberate, documented local/dev use.
   */
  requireHttpsForRemote?: boolean;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * True only when the caller has confirmed this specific mutation is safe
   * to retry (e.g. POST /requests with a caller-supplied request_id, or a
   * delivery retry, which is idempotent by construction). GET/HEAD are
   * always eligible regardless of this flag.
   */
  idempotent?: boolean;
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new MalformedResponseError(
      `response declared Content-Length ${declared} exceeds the ${MAX_RESPONSE_BYTES}-byte SDK limit`);
  }
  if (!response.body) {
    return response.text();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MalformedResponseError(
          `response body exceeded the ${MAX_RESPONSE_BYTES}-byte SDK limit`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
}

function mergeSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!a) return b as AbortSignal;
  if (!b) return a;
  // AbortSignal.any is available on Node >=20; fall back to a manual merge
  // for the minimum supported Node 18.17.
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([a, b]);
  const controller = new AbortController();
  const onAbort = (signal: AbortSignal) => controller.abort(signal.reason);
  if (a.aborted) onAbort(a); else a.addEventListener('abort', () => onAbort(a), { once: true });
  if (b.aborted) onAbort(b); else b.addEventListener('abort', () => onAbort(b), { once: true });
  return controller.signal;
}

/**
 * Low-level REST client: one HTTP call per method invocation, typed errors,
 * conservative retry, timeouts, cancellation. No governance-domain
 * knowledge lives here — see governance.ts for the convenience façade.
 */
export class RestClient {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly defaultTimeoutMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    if (!options.baseUrl) throw new Error('baseUrl is required');
    if (!options.token) throw new Error('token is required');
    this.baseUrl = new URL(options.baseUrl);
    const requireHttps = options.requireHttpsForRemote ?? true;
    if (requireHttps && this.baseUrl.protocol === 'http:' && !isLoopback(this.baseUrl.hostname)) {
      throw new Error(
        `refusing to use plain HTTP against a non-loopback host (${this.baseUrl.hostname}); ` +
        'use https:// or pass requireHttpsForRemote: false to explicitly opt out for local/dev use');
    }
    this.token = options.token;
    this.defaultTimeoutMs = options.timeoutMs ?? 30_000;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.userAgent = options.userAgent
      ? `${DEFAULT_USER_AGENT} ${options.userAgent}`
      : DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error(
        'no fetch implementation available; Node >=18.17 provides one built in, ' +
        'or pass { fetch } explicitly');
    }
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(path.replace(/^\//, ''), this.baseUrl);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    const isSafeMethod = method === 'GET' || method === 'HEAD';
    const canRetry = isSafeMethod || options.idempotent === true;

    const budgetDeadline = Date.now() + this.retryPolicy.timeoutBudgetMs;
    let lastError: AmpError | undefined;

    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt++) {
      if (Date.now() >= budgetDeadline) break;
      try {
        return await this.attemptOnce<T>(method, url, options);
      } catch (err) {
        if (options.signal?.aborted) throw new CancellationError();
        if (!(err instanceof AmpError)) throw err;
        lastError = err;
        const canRetryThis = canRetry && err.retryable && attempt < this.retryPolicy.maxAttempts;
        if (!canRetryThis) throw err;
        const retryAfterMs = err instanceof TransportError
          ? null
          : parseRetryAfterMs((err as AmpError & { retryAfterHeader?: string }).retryAfterHeader ?? null);
        const delay = retryAfterMs ?? computeBackoffMs(attempt, this.retryPolicy);
        const remaining = budgetDeadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(delay, remaining), options.signal);
      }
    }
    throw lastError ?? new TransportError('retry budget exhausted with no recorded error');
  }

  private async attemptOnce<T>(method: string, url: URL, options: RequestOptions): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = mergeSignals(options.signal, timeoutController.signal);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        redirect: 'manual', // never silently forward Authorization cross-origin
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          'User-Agent': this.userAgent,
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal,
      });
    } catch (err) {
      if (timeoutController.signal.aborted && !options.signal?.aborted) {
        throw new TimeoutError(`request timed out after ${timeoutMs}ms`);
      }
      if (options.signal?.aborted) throw new CancellationError();
      throw new TransportError(
        `transport failure calling ${method} ${url.pathname}: ${(err as Error).message}`,
        { cause: err });
    } finally {
      clearTimeout(timer);
    }

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new MalformedResponseError(
        `server responded with a redirect (HTTP ${response.status}); this SDK never follows ` +
        'redirects automatically to avoid silently forwarding the Authorization header to another origin');
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await readBoundedText(response);
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch (err) {
      throw new MalformedResponseError(
        `server response was not valid JSON (HTTP ${response.status})`, { cause: err });
    }

    if (response.status >= 400) {
      const httpError = errorFromEnvelope(response.status, parsed);
      const retryAfter = response.headers.get('retry-after');
      const retryable = isRetryableStatus(response.status);
      const err = Object.assign(
        Object.create(Object.getPrototypeOf(httpError)),
        httpError,
        { retryable: retryable || httpError.retryable },
      ) as AmpError & { retryAfterHeader?: string | null };
      err.retryAfterHeader = retryAfter;
      throw err;
    }

    return parsed as T;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(timer); reject(new CancellationError()); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
