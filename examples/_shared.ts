// Shared setup for the examples in this directory. Fictional data only.
import { AmpClient, Policy } from '../src/index.js';

export const BASE_URL = process.env.AMP_BASE_URL ?? 'http://127.0.0.1:8080';
export const REVIEWER_TOKEN = process.env.AMP_REVIEWER_TOKEN ?? 'fictional-reviewer-token-0001';
export const AGENT_TOKEN = process.env.AMP_AGENT_TOKEN ?? 'fictional-agent-token-0001';

export const INVOICE_POLICY: Policy = {
  policy_id: 'invoice-governance',
  schema_version: 'v0',
  action_governance: {
    criteria: [{
      criterion_id: 'c-high-amount', tool: 'pay_invoice', action: '*',
      hardness: 'hard',
      evaluator: { type: 'compute', formula: 'amount > 1000' },
    }],
  },
};

export function reviewerClient(): AmpClient {
  return new AmpClient({ baseUrl: BASE_URL, token: REVIEWER_TOKEN });
}

export function agentClient(): AmpClient {
  return new AmpClient({ baseUrl: BASE_URL, token: AGENT_TOKEN });
}

export async function ensurePolicy(): Promise<void> {
  await reviewerClient().importPolicy('invoice-governance', INVOICE_POLICY);
}

export function newRequestId(prefix: string): string {
  return `req-${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}
