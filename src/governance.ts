import { RestClient, ClientOptions } from './client.js';
import { CancellationError, TimeoutError } from './errors.js';
import type {
  AuditEvent,
  AuditQuery,
  DeliveryStatus,
  EvaluationResult,
  Policy,
  RequestStatus,
  ResolveOutcome,
  ResolveResult,
  SubmitGovernedRequestInput,
  SubmitResult,
  VersionInfo,
  Workitem,
} from './models.js';
import { UnsupportedVersionError } from './errors.js';

export interface EvaluateInput {
  tool: string;
  action: string;
  params?: Record<string, unknown>;
  criteriaInputs?: Record<string, unknown>;
}

export interface ResolveOptions {
  note?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WaitForDecisionOptions {
  /** Poll interval in ms. Default 1000. */
  intervalMs?: number;
  /** Give up after this many ms and throw TimeoutError. Default 60000. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

function toResolveOutcome(res: ResolveResult): ResolveOutcome {
  return {
    hitlId: res.hitl_id,
    decision: res.result.decision,
    params: res.result.params ?? null,
    executed: res.result.executed ?? false,
    followUpReviewId: res.result.follow_up_hitl_id ?? null,
    deliveryId: res.delivery_id,
    delivered: res.delivered,
    replayed: res.replayed ?? false,
    raw: res,
  };
}

/**
 * Governance convenience façade over the low-level RestClient. Every
 * method here is a thin, direct mapping to one REST call (or, for
 * `waitForDecision`, a bounded loop of one) — no hidden batching, no
 * client-side caching, no background timers started implicitly.
 */
export class AmpClient {
  readonly rest: RestClient;

  constructor(options: ClientOptions) {
    this.rest = new RestClient(options);
  }

  // -- health/version -----------------------------------------------------

  health(): Promise<{ status: string }> {
    return this.rest.request('GET', '/health');
  }

  getVersion(): Promise<VersionInfo> {
    return this.rest.request('GET', '/version');
  }

  /**
   * Opt-in client-side check: throws UnsupportedVersionError if the
   * server's `contracts` field is not "v0". The server has no dedicated
   * error code for this (see the compatibility baseline); this is a
   * synthesized SDK-side guard, not a server contract.
   */
  async checkVersion(): Promise<VersionInfo> {
    const info = await this.getVersion();
    if (info.contracts !== 'v0') {
      throw new UnsupportedVersionError(
        `this SDK implements the "v0" contract baseline; server reports "${info.contracts}"`);
    }
    return info;
  }

  me(): Promise<{ principal_id: string; role: string; scope: string | null }> {
    return this.rest.request('GET', '/api/v0/me');
  }

  // -- policy lifecycle -----------------------------------------------------

  listPolicies(): Promise<{ items: string[] }> {
    return this.rest.request('GET', '/api/v0/policies');
  }

  getPolicy(policyId: string): Promise<Policy> {
    return this.rest.request('GET', `/api/v0/policies/${encodeURIComponent(policyId)}`);
  }

  /** Import/update a policy (reviewer role required server-side). */
  importPolicy(policyId: string, policy: Policy): Promise<{ policy_id: string; stored: boolean }> {
    return this.rest.request('PUT', `/api/v0/policies/${encodeURIComponent(policyId)}`, { body: policy });
  }

  /**
   * Validate a policy document without storing it. The server's route
   * shape includes a `{policy_id}` path segment for URL consistency with
   * the other policy routes, but the validate handler does not look it up
   * or use it — validation runs purely against the request body. This
   * method defaults it to the policy's own `policy_id` (or a placeholder
   * when absent) so callers never have to think about it.
   */
  validatePolicy(policy: Policy, policyId?: string): Promise<{ valid: boolean; errors: string[] }> {
    const id = policyId ?? policy.policy_id ?? 'unvalidated';
    return this.rest.request('POST', `/api/v0/policies/${encodeURIComponent(id)}/validate`, { body: policy });
  }

  // -- evaluation and governed requests -------------------------------------

  evaluate(policyId: string, input: EvaluateInput): Promise<EvaluationResult> {
    return this.rest.request('POST',
      `/api/v0/policies/${encodeURIComponent(policyId)}/evaluate`, {
        body: {
          tool: input.tool,
          action: input.action,
          params: input.params ?? {},
          criteria_inputs: input.criteriaInputs,
        },
      });
  }

  /**
   * Submit a governed tool call. Strongly recommend passing `requestId`:
   * without one, this call is NOT automatically retried on transport
   * failure (see the compatibility baseline's idempotency notes — only
   * requests that reach human review are idempotent by request_id).
   */
  submitGovernedRequest(input: SubmitGovernedRequestInput): Promise<SubmitResult> {
    return this.rest.request<SubmitResult>('POST', '/api/v0/requests', {
      idempotent: Boolean(input.requestId),
      body: {
        policy_id: input.policyId,
        tool: input.tool,
        action: input.action,
        params: input.params ?? {},
        criteria_inputs: input.criteriaInputs,
        request_id: input.requestId,
      },
    });
  }

  /**
   * Poll the decision for a request that reached human review. Throws
   * NotFoundError (via the underlying REST call) if the request was
   * allowed/denied synchronously (there is nothing to poll) or does not
   * exist.
   */
  getRequest(requestId: string): Promise<RequestStatus> {
    return this.rest.request('GET', `/api/v0/requests/${encodeURIComponent(requestId)}`);
  }

  /**
   * Optional polling helper: repeatedly calls getRequest until the
   * decision leaves "pending" or the timeout budget is exhausted. This is
   * a convenience built entirely from public methods — callers may
   * implement their own polling loop with getRequest() directly instead.
   */
  async waitForDecision(requestId: string, options: WaitForDecisionOptions = {}): Promise<RequestStatus> {
    const intervalMs = options.intervalMs ?? 1000;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (options.signal?.aborted) throw new CancellationError();
      const status = await this.getRequest(requestId);
      if (status.status !== 'pending') return status;
      if (Date.now() + intervalMs > deadline) {
        throw new TimeoutError(
          `request ${requestId} did not leave "pending" within ${timeoutMs}ms`);
      }
      await this.delay(intervalMs, options.signal);
    }
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        const onAbort = () => { clearTimeout(timer); reject(new CancellationError()); };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  // -- HITL review lifecycle -------------------------------------------------

  listReviews(): Promise<{ items: Workitem[] }> {
    return this.rest.request('GET', '/api/v0/hitl');
  }

  getReview(hitlId: string): Promise<Workitem> {
    return this.rest.request('GET', `/api/v0/hitl/${encodeURIComponent(hitlId)}`);
  }

  async approve(hitlId: string, options: ResolveOptions = {}): Promise<ResolveOutcome> {
    const res = await this.rest.request<ResolveResult>(
      'POST', `/api/v0/hitl/${encodeURIComponent(hitlId)}/resolve`, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        body: { decision: 'approve', note: options.note },
      });
    return toResolveOutcome(res);
  }

  async reject(hitlId: string, options: ResolveOptions = {}): Promise<ResolveOutcome> {
    const res = await this.rest.request<ResolveResult>(
      'POST', `/api/v0/hitl/${encodeURIComponent(hitlId)}/resolve`, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        body: { decision: 'reject', note: options.note },
      });
    return toResolveOutcome(res);
  }

  /**
   * Structured modify. `modifiedParams` is required and must be a plain
   * object — the server rejects a missing/null value (422) rather than
   * silently executing an empty change (see the contract-compatibility
   * report's Finding 1). `executed: false` with a populated
   * `followUpReviewId` means the modification requires another review; it
   * is NOT an error, and this method resolves normally in that case.
   */
  async modify(hitlId: string, modifiedParams: Record<string, unknown>,
              options: ResolveOptions = {}): Promise<ResolveOutcome> {
    const res = await this.rest.request<ResolveResult>(
      'POST', `/api/v0/hitl/${encodeURIComponent(hitlId)}/resolve`, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        body: { decision: 'modify', modified_params: modifiedParams, note: options.note },
      });
    return toResolveOutcome(res);
  }

  // -- callback delivery ---------------------------------------------------

  getDeliveryStatus(deliveryId: string): Promise<DeliveryStatus> {
    return this.rest.request('GET', `/api/v0/callbacks/${encodeURIComponent(deliveryId)}`);
  }

  /** Retry exactly one delivery. Idempotent: safe to call on an already-delivered id. */
  retryDelivery(deliveryId: string): Promise<{ delivery_id: string; delivered: boolean; status: string }> {
    return this.rest.request('POST', `/api/v0/callbacks/${encodeURIComponent(deliveryId)}/retry`, {
      idempotent: true,
    });
  }

  /** Retry every currently-undelivered callback (reviewer role, bulk convenience). */
  retryAllDeliveries(): Promise<{ results: Record<string, boolean> }> {
    return this.rest.request('POST', '/api/v0/callbacks/retry', { idempotent: true });
  }

  // -- audit -----------------------------------------------------------------

  listAuditEvents(query: AuditQuery = {}): Promise<{ items: AuditEvent[] }> {
    return this.rest.request('GET', '/api/v0/audit', {
      query: {
        request_id: query.requestId,
        event_type: query.eventType,
        since: query.since,
        until: query.until,
        limit: query.limit,
      },
    });
  }
}
