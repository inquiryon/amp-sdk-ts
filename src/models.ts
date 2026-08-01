/**
 * Typed request/response models for the AMP Community v0 governance API.
 *
 * These five decision/status vocabularies are DISTINCT and must never be
 * conflated (see oss-release/phase-5/contract-compatibility-report.md):
 * EvaluationDecisionValue, SubmitStatus, ResolveDecisionInput,
 * ResolvedDecisionValue, WorkitemStatus.
 *
 * Every interface here is intentionally permissive of extra keys — the
 * runtime does not enforce `additionalProperties: false` anywhere, and
 * SDK consumers must not crash on a field this file has not yet learned
 * about. TypeScript's structural typing already allows this (an object
 * with extra properties still satisfies an interface); no `exact` types
 * are used here on purpose.
 */

/** Dry-run/internal evaluation outcome. Never conflate with SubmitStatus. */
export type EvaluationDecisionValue = 'allow' | 'deny' | 'require_human';

/** Outcome of POST /api/v0/requests. Never conflate with EvaluationDecisionValue. */
export type SubmitStatus = 'allowed' | 'denied' | 'pending_review';

/** Input to POST /api/v0/hitl/{id}/resolve. Imperative form. */
export type ResolveDecisionInput = 'approve' | 'reject' | 'modify';

/** Output of a resolve call. Past-tense form; distinct type from the input. */
export type ResolvedDecisionValue = 'approved' | 'rejected' | 'modified';

/** Full HITL workitem lifecycle. */
export type WorkitemStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'modified'
  | 'resumed'
  | 'closed'
  | 'expired'
  | 'cancelled';

export type DeliveryStatusValue = 'pending' | 'delivered' | 'failed';

export interface Policy {
  policy_id?: string;
  schema_version?: 'v0';
  allow_unknown_tools?: boolean;
  action_governance: {
    force_human_approval?: boolean;
    criteria?: PolicyCriterion[];
  };
  [key: string]: unknown;
}

export interface PolicyCriterion {
  criterion_id: string;
  tool?: string;
  action?: string;
  hardness?: 'hard' | 'soft';
  condition_semantics?: 'block_when' | 'allow_when';
  text?: string;
  description?: string;
  evaluator?: {
    type?: 'compute' | 'llm' | 'hybrid' | 'input';
    formula?: string;
    prompt?: string;
    input_key?: string;
    fallback_result?: boolean;
  };
  [key: string]: unknown;
}

export interface CriterionResult {
  criterion_id: string;
  hardness: 'hard' | 'soft';
  evaluator_type: 'compute' | 'llm' | 'hybrid' | 'input';
  status?: 'met' | 'not_met';
  condition_semantics?: 'block_when' | 'allow_when';
  condition_met: boolean;
  triggered: boolean;
  reason?: string;
  trigger_reason?: string;
  [key: string]: unknown;
}

export interface EvaluationResult {
  decision: EvaluationDecisionValue;
  reason: string;
  triggered_criteria?: string[];
  soft_triggered?: string[];
  criteria_results?: CriterionResult[];
  [key: string]: unknown;
}

export interface SubmitGovernedRequestInput {
  policyId: string;
  tool: string;
  action: string;
  params?: Record<string, unknown>;
  criteriaInputs?: Record<string, unknown>;
  /**
   * Idempotency key for this operation. Strongly recommended: without it,
   * a retried submission is not guaranteed to be safe to auto-retry (see
   * the compatibility baseline's "Idempotency" section) and this SDK will
   * not automatically retry a POST /requests call that lacks one.
   */
  requestId?: string;
}

export interface SubmitResult {
  request_id: string;
  status: SubmitStatus;
  reason?: string;
  hitl_id?: string;
  replayed?: boolean;
  [key: string]: unknown;
}

export interface Workitem {
  hitl_id: string;
  request_id: string;
  tool?: string;
  action?: string;
  params?: Record<string, unknown>;
  reason?: string;
  triggered_criteria?: string[];
  status: WorkitemStatus;
  requested_by?: string;
  scope?: string | null;
  policy_id?: string | null;
  created_at?: string;
  decision?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ResolveResult {
  hitl_id: string;
  result: {
    decision: ResolvedDecisionValue;
    params?: Record<string, unknown> | null;
    executed?: boolean;
    follow_up_hitl_id?: string | null;
    [key: string]: unknown;
  };
  delivery_id: string;
  delivered: boolean;
  replayed?: boolean;
  [key: string]: unknown;
}

/** Convenience-layer shape returned by AmpClient.approve/reject/modify. */
export interface ResolveOutcome {
  hitlId: string;
  decision: ResolvedDecisionValue;
  params: Record<string, unknown> | null;
  executed: boolean;
  followUpReviewId: string | null;
  deliveryId: string;
  delivered: boolean;
  replayed: boolean;
  raw: ResolveResult;
}

export interface RequestStatus {
  request_id: string;
  hitl_id?: string;
  status: string;
  decision?: string | null;
  executed_params?: Record<string, unknown> | null;
  follow_up_hitl_id?: string | null;
  [key: string]: unknown;
}

export interface AuditEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  request_id: string;
  actor: string;
  scope?: string | null;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DeliveryStatus {
  delivery_id: string;
  hitl_id: string;
  request_id: string;
  status: DeliveryStatusValue;
  attempts: number;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface AuditQuery {
  requestId?: string;
  eventType?: string;
  since?: string;
  until?: string;
  /** Server default is 200 when omitted. */
  limit?: number;
}

export interface VersionInfo {
  name: string;
  version: string;
  contracts: string;
  [key: string]: unknown;
}
