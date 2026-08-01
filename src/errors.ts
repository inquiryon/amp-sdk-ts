/**
 * Typed error hierarchy for the AMP TypeScript SDK.
 *
 * Every error preserves: HTTP status (when there was an HTTP response),
 * the server's stable error `code` (when present), a message, the
 * request/correlation id (when the server supplied one), whether the SDK
 * considers the failure retryable, and bounded structured details.
 *
 * None of these ever include the bearer token, the Authorization header,
 * or any other secret — see the message-building helpers below, which
 * only ever read from the parsed error envelope, never from request
 * headers.
 */

export interface ErrorDetails {
  [key: string]: unknown;
}

export abstract class AmpError extends Error {
  /** HTTP status code, when this error originated from an HTTP response. */
  readonly status?: number;
  /** Stable server error code (e.g. "not_found"), when available. */
  readonly code?: string;
  /** Correlation id from the server's error envelope, when available. */
  readonly requestId?: string;
  /** Whether this SDK's retry policy would consider retrying this failure. */
  readonly retryable: boolean;
  /** Bounded structured details from the server (e.g. schema errors). */
  readonly details?: ErrorDetails;

  constructor(message: string, options: {
    status?: number;
    code?: string;
    requestId?: string;
    retryable?: boolean;
    details?: ErrorDetails;
    cause?: unknown;
  } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/** 401 unauthenticated — missing or unknown bearer token. Never retried. */
export class AuthenticationError extends AmpError {}

/** 403 forbidden — authenticated but not authorized. Never retried. */
export class AuthorizationError extends AmpError {}

/** 404 not_found. Never retried. */
export class NotFoundError extends AmpError {}

/** 409 conflict — already decided differently, or an illegal transition. Never retried. */
export class ConflictError extends AmpError {}

/**
 * 400/413/422 validation_failed (and related codes: invalid_json,
 * missing_field, invalid_decision, invalid_policy_id, payload_too_large).
 * Never retried — the server has told you the request itself is wrong.
 */
export class ValidationError extends AmpError {}

/** 422 invalid_policy — policy failed schema validation. `details.errors` holds the list. */
export class PolicyRejectedError extends ValidationError {}

/** 500 internal_error. Not retried by default (see retry policy docs). */
export class ServerError extends AmpError {}

/**
 * Connection-level failure: refused, reset, DNS failure, etc. No HTTP
 * response was received at all, so `status`/`code` are unset.
 */
export class TransportError extends AmpError {
  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { retryable: options.retryable ?? true, cause: options.cause });
  }
}

/** The call did not complete within the configured timeout budget. */
export class TimeoutError extends AmpError {
  constructor(message = 'request timed out') {
    super(message, { retryable: false });
  }
}

/** The caller cancelled the call via AbortSignal. */
export class CancellationError extends AmpError {
  constructor(message = 'request was cancelled') {
    super(message, { retryable: false });
  }
}

/**
 * Client-synthesized only — the server never emits this code (see the
 * compatibility baseline's "Version negotiation" section). Thrown by
 * `checkVersion()` when `GET /version`'s `contracts` field is not "v0".
 */
export class UnsupportedVersionError extends AmpError {
  constructor(message: string) {
    super(message, { retryable: false });
  }
}

/**
 * The server returned a 2xx response whose body could not be parsed as
 * JSON, or whose JSON did not have the minimum expected shape (e.g. an
 * error envelope missing `error.code`). Distinct from ValidationError,
 * which means the SERVER rejected the request; this means the SDK could
 * not make sense of what the server sent back.
 */
export class MalformedResponseError extends AmpError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { retryable: false, cause: options.cause });
  }
}

const STATUS_TO_ERROR: Record<number, new (message: string, options?: {
  status?: number; code?: string; requestId?: string; retryable?: boolean; details?: ErrorDetails;
}) => AmpError> = {
  401: AuthenticationError,
  403: AuthorizationError,
  404: NotFoundError,
  409: ConflictError,
  500: ServerError,
};

/**
 * Map a parsed v0 ErrorEnvelope + HTTP status to a typed error. Message
 * text is bounded (the server already bounds `message`; this function
 * additionally never echoes request headers or tokens, since it only
 * reads from the envelope).
 */
export function errorFromEnvelope(status: number, envelope: unknown): AmpError {
  const err = (envelope as { error?: { code?: string; message?: string; request_id?: string; details?: ErrorDetails } } | null)?.error;
  const code = err?.code ?? 'unknown_error';
  const message = err?.message ?? `request failed with HTTP ${status}`;
  const requestId = err?.request_id;
  const details = err?.details;

  if (status === 422 && code === 'invalid_policy') {
    return new PolicyRejectedError(message, { status, code, requestId, details, retryable: false });
  }
  if (status === 400 || status === 413 || status === 422) {
    return new ValidationError(message, { status, code, requestId, details, retryable: false });
  }
  const Ctor = STATUS_TO_ERROR[status];
  if (Ctor) {
    return new Ctor(message, { status, code, requestId, details, retryable: false });
  }
  return new ServerError(message, { status, code, requestId, details, retryable: false });
}
