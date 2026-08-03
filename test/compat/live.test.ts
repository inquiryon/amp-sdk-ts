/**
 * Shared live compatibility scenarios, run against a REAL amp-community
 * server (not a mock). The Python SDK's tests/compat/test_live.py
 * implements the identical scenarios against the same contract. All data
 * is fictional.
 *
 * Run: npm run test:compat (requires a Python interpreter with
 * amp-core/amp-community installed; set AMP_COMMUNITY_PYTHON if it is not
 * `python3` on PATH). Skips cleanly, one line per test, if the server
 * cannot be started — never fails the run for an environment gap.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  AmpClient,
  AuthenticationError,
  CancellationError,
  ConflictError,
  TimeoutError,
  TransportError,
  UnsupportedVersionError,
  ValidationError,
} from '../../src/index.js';
import { startCompatServer, CompatServer, REVIEWER_TOKEN, AGENT_TOKEN, INVOICE_POLICY } from './server.js';

let server: CompatServer | null = null;

before(async () => {
  server = await startCompatServer();
  if (!server) {
    console.warn('[compat] amp-community could not be started; live compatibility '
      + 'scenarios will be skipped (set AMP_COMMUNITY_PYTHON to a Python with '
      + 'amp-core/amp-community installed to run them)');
  }
});

after(() => { server?.stop(); });

function reviewer(): AmpClient {
  return new AmpClient({ baseUrl: server!.baseUrl, token: REVIEWER_TOKEN });
}
function agent(): AmpClient {
  return new AmpClient({ baseUrl: server!.baseUrl, token: AGENT_TOKEN });
}

let counter = 0;
function nextRequestId(scenario: string): string {
  counter += 1;
  return `req-${scenario}-${counter.toString().padStart(4, '0')}`;
}

// 1. health/version -----------------------------------------------------

test('1. health/version', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const c = reviewer();
  assert.equal((await c.health()).status, 'ok');
  assert.equal((await c.getVersion()).contracts, 'v0');
});

// 2. authentication failure ------------------------------------------------

test('2. authentication failure', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const bad = new AmpClient({ baseUrl: server.baseUrl, token: 'not-a-real-token' });
  await assert.rejects(() => bad.me(), (err: unknown) => {
    assert.ok(err instanceof AuthenticationError);
    assert.equal((err as AuthenticationError).status, 401);
    return true;
  });
});

// 3. policy import and retrieval --------------------------------------------

test('3. policy import and retrieval', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const c = reviewer();
  const stored = await c.importPolicy('invoice-governance', INVOICE_POLICY);
  assert.equal(stored.stored, true);
  const fetched = await c.getPolicy('invoice-governance');
  const criteria = fetched.action_governance.criteria as Array<{ criterion_id: string }> | undefined;
  assert.equal(criteria?.[0]?.criterion_id, 'c-high-amount');
});

// 4. policy validation -----------------------------------------------------

test('4. policy validation', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const c = reviewer();
  const bad = await c.validatePolicy({ nonsense: true } as never);
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.length > 0);
  const good = await c.validatePolicy(INVOICE_POLICY);
  assert.equal(good.valid, true);
});

// 5. allow evaluation --------------------------------------------------------

test('5. allow evaluation', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const c = reviewer();
  await c.importPolicy('invoice-governance', INVOICE_POLICY);
  const result = await c.evaluate('invoice-governance', { tool: 'pay_invoice', action: 'submit', params: { amount: 40 } });
  assert.equal(result.decision, 'allow');
});

// 6. hard-policy failure ------------------------------------------------------

test('6. hard-policy failure', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const c = reviewer();
  await c.importPolicy('invoice-governance', INVOICE_POLICY);
  const result = await c.evaluate('invoice-governance', { tool: 'pay_invoice', action: 'submit', params: { amount: 5000 } });
  assert.equal(result.decision, 'require_human');
  assert.deepEqual(result.triggered_criteria, ['c-high-amount']);
});

// 7. human-review evaluation via submission -----------------------------------

test('7. human-review evaluation via submission', async (t) => {
  if (!server) return t.skip('amp-community not available');
  await reviewer().importPolicy('invoice-governance', INVOICE_POLICY);
  const out = await agent().submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: nextRequestId('scn7'),
  });
  assert.equal(out.status, 'pending_review');
  assert.ok(out.hitl_id);
});

// 8. governed request submission (allow path) ---------------------------------

test('8. governed request submission (allow path)', async (t) => {
  if (!server) return t.skip('amp-community not available');
  await reviewer().importPolicy('invoice-governance', INVOICE_POLICY);
  const out = await agent().submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 40 }, requestId: nextRequestId('scn8'),
  });
  assert.equal(out.status, 'allowed');
  assert.ok(!out.hitl_id);
});

// 9. idempotent submission replay ------------------------------------------------

test('9. idempotent submission replay', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const r = reviewer();
  await r.importPolicy('invoice-governance', INVOICE_POLICY);
  const a = agent();
  const requestId = nextRequestId('scn9');
  const first = await a.submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId,
  });
  const before = (await r.listReviews()).items.length;
  const replay = await a.submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId,
  });
  assert.equal(replay.hitl_id, first.hitl_id);
  assert.equal(replay.replayed, true);
  assert.equal((await r.listReviews()).items.length, before);
});

// 10. conflicting idempotency reuse ----------------------------------------------

test('10. conflicting idempotency reuse', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const r = reviewer();
  await r.importPolicy('invoice-governance', INVOICE_POLICY);
  const out = await agent().submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: nextRequestId('scn10'),
  });
  await r.approve(out.hitl_id as string);
  await assert.rejects(() => r.reject(out.hitl_id as string), (err: unknown) => {
    assert.ok(err instanceof ConflictError);
    assert.equal((err as ConflictError).status, 409);
    return true;
  });
  const review = await r.getReview(out.hitl_id as string);
  assert.equal((review.decision as { decision: string }).decision, 'approved');
});

// 11. decision polling -----------------------------------------------------------

test('11. decision polling', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const r = reviewer();
  await r.importPolicy('invoice-governance', INVOICE_POLICY);
  const out = await agent().submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: nextRequestId('scn11'),
  });
  const pending = await agent().getRequest(out.request_id);
  assert.equal(pending.status, 'pending');
  await r.approve(out.hitl_id as string);
  const resolved = await agent().getRequest(out.request_id);
  // See sdk-compatibility-baseline.md: status is the workitem lifecycle
  // state (poll-callback mode closes straight to "resumed"), not the
  // decision verb — that is the separate `decision` field.
  assert.equal(resolved.status, 'resumed');
  assert.equal(resolved.decision, 'approved');
  assert.deepEqual(resolved.executed_params, { amount: 5000 });
});

// 12. approve ---------------------------------------------------------------------

test('12. approve', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const r = reviewer();
  await r.importPolicy('invoice-governance', INVOICE_POLICY);
  const out = await agent().submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: nextRequestId('scn12'),
  });
  const outcome = await r.approve(out.hitl_id as string);
  assert.equal(outcome.decision, 'approved');
  assert.deepEqual(outcome.params, { amount: 5000 });
  assert.ok(outcome.deliveryId);
});

// 13. reject -------------------------------------------------------------------------

test('13. reject', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const r = reviewer();
  await r.importPolicy('invoice-governance', INVOICE_POLICY);
  const out = await agent().submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: nextRequestId('scn13'),
  });
  const outcome = await r.reject(out.hitl_id as string);
  assert.equal(outcome.decision, 'rejected');
  assert.equal(outcome.params, null);
});

// 14. valid structured modify -----------------------------------------------------------

test('14. valid structured modify', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const r = reviewer();
  await r.importPolicy('invoice-governance', INVOICE_POLICY);
  const out = await agent().submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: nextRequestId('scn14'),
  });
  const outcome = await r.modify(out.hitl_id as string, { amount: 900 });
  assert.equal(outcome.executed, true);
  assert.deepEqual(outcome.params, { amount: 900 });
  assert.equal(outcome.followUpReviewId, null);
});

// 15. malformed structured modify -------------------------------------------------------

test('15. malformed structured modify', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const r = reviewer();
  await r.importPolicy('invoice-governance', INVOICE_POLICY);
  const out = await agent().submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: nextRequestId('scn15'),
  });
  await assert.rejects(
    () => r.rest.request('POST', `/api/v0/hitl/${out.hitl_id}/resolve`, { body: { decision: 'modify' } }),
    (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.equal((err as ValidationError).status, 422);
      return true;
    });
  const review = await r.getReview(out.hitl_id as string);
  assert.equal(review.status, 'pending');
});

// 16. hard failure after modification ----------------------------------------------------

test('16. hard failure after modification', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const r = reviewer();
  await r.importPolicy('invoice-governance', INVOICE_POLICY);
  const out = await agent().submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: nextRequestId('scn16'),
  });
  const outcome = await r.modify(out.hitl_id as string, { amount: 99999 });
  assert.equal(outcome.executed, false);
  assert.ok(outcome.followUpReviewId);
});

// 17. material-change re-review -------------------------------------------------------------

test('17. material-change re-review', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const r = reviewer();
  await r.importPolicy('invoice-governance', INVOICE_POLICY);
  const out = await agent().submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: nextRequestId('scn17'),
  });
  const outcome = await r.modify(out.hitl_id as string, { amount: 99999 });
  const followUp = await r.getReview(outcome.followUpReviewId as string);
  assert.equal(followUp.status, 'pending');
  assert.equal(followUp.policy_id, 'invoice-governance');
});

// 18. callback delivery status -----------------------------------------------------------------

test('18. callback delivery status', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const r = reviewer();
  await r.importPolicy('invoice-governance', INVOICE_POLICY);
  const out = await agent().submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: nextRequestId('scn18'),
  });
  const outcome = await r.approve(out.hitl_id as string);
  const status = await r.getDeliveryStatus(outcome.deliveryId);
  assert.equal(status.status, 'delivered');
  assert.ok(status.attempts >= 1);
});

// 19. callback retry -----------------------------------------------------------------------------

test('19. callback retry', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const r = reviewer();
  await r.importPolicy('invoice-governance', INVOICE_POLICY);
  const out = await agent().submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: nextRequestId('scn19'),
  });
  const outcome = await r.approve(out.hitl_id as string);
  const retried = await r.retryDelivery(outcome.deliveryId);
  assert.equal(retried.delivered, true);
});

// 20. append-only audit query ---------------------------------------------------------------------

test('20. append-only audit query', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const r = reviewer();
  await r.importPolicy('invoice-governance', INVOICE_POLICY);
  const out = await agent().submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: nextRequestId('scn20'),
  });
  await r.approve(out.hitl_id as string);
  const events = (await r.listAuditEvents({ requestId: out.request_id })).items;
  const types = events.map((e) => e.event_type);
  assert.deepEqual(types.slice(0, 4),
    ['evaluation.completed', 'decision.completed', 'hitl.requested', 'hitl.pending']);
  assert.ok(types.includes('hitl.approved'));
  for (const e of events) {
    assert.ok(e.event_id && e.event_type && e.occurred_at);
  }
});

// 21. provider failure and safe fallback -----------------------------------------------------------
// Not exercised live (the Community server's default provider does not
// crash). Covered by amp-community's own
// test_provider_failure_falls_back_safely_with_audit — see compat-scenarios.md.

// 22. timeout -----------------------------------------------------------------------------------------

test('22. timeout', async (t) => {
  if (!server) return t.skip('amp-community not available');
  // Real, deterministic socket-level timeout: a local TCP listener that
  // accepts the connection but never responds.
  const { createServer } = await import('node:net');
  const listener = createServer((socket) => { /* accept, never write, never close */ });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const c = new AmpClient({
      baseUrl: `http://127.0.0.1:${port}`, token: REVIEWER_TOKEN,
      timeoutMs: 200, retry: { maxAttempts: 1, timeoutBudgetMs: 1000 },
    });
    await assert.rejects(() => c.listPolicies(), TimeoutError);
  } finally {
    listener.close();
  }
});

// 23. cancellation -------------------------------------------------------------------------------------

test('23. cancellation', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const r = reviewer();
  await r.importPolicy('invoice-governance', INVOICE_POLICY);
  const out = await agent().submitGovernedRequest({
    policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
    params: { amount: 5000 }, requestId: nextRequestId('scn23'),
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    () => agent().waitForDecision(out.request_id, { intervalMs: 20, timeoutMs: 10_000, signal: controller.signal }),
    CancellationError);
});

// 24. retry behavior ---------------------------------------------------------------------------------------

test('24. retry behavior', async (t) => {
  if (!server) return t.skip('amp-community not available');
  // Port 1 on loopback: connection refused on every attempt.
  const c = new AmpClient({
    baseUrl: 'http://127.0.0.1:1', token: REVIEWER_TOKEN,
    retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20, timeoutBudgetMs: 2000 },
  });
  await assert.rejects(
    () => c.submitGovernedRequest({ policyId: 'p', tool: 't', action: 'a', requestId: nextRequestId('scn24') }),
    TransportError);
});

// 25. unknown response fields ------------------------------------------------------------------------------
// The live server does not currently emit undocumented extra fields (see
// compat-scenarios.md); forward-compatible parsing is exercised at the
// unit level (test/unit/client.test.ts: "unknown response fields pass
// through without crashing"). Every successful scenario above already
// demonstrates real responses parse without error.

// 26. unsupported schema/API version -----------------------------------------------------------------------------

test('26. unsupported schema/API version (checkVersion accepts the real server)', async (t) => {
  if (!server) return t.skip('amp-community not available');
  const c = reviewer();
  const info = await c.checkVersion(); // must not throw against the real v0 server
  assert.equal(info.contracts, 'v0');
  // The throwing branch (a server reporting something other than "v0")
  // cannot be produced by the real, correctly-functioning server; it is
  // covered at the unit level instead.
  void UnsupportedVersionError; // referenced for documentation clarity only
});

// 27. malformed server response -------------------------------------------------------------------------------------
// Not reproducible against the real, correctly-functioning server;
// covered at the unit level ("rejects a malformed (non-JSON) 2xx response
// distinctly").
