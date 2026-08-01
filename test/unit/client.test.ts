import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RestClient } from '../../src/client.js';
import { AmpClient } from '../../src/governance.js';
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  PolicyRejectedError,
  TimeoutError,
  TransportError,
  ValidationError,
} from '../../src/errors.js';

type Handler = (req: Request) => Promise<Response> | Response;

function mockFetch(handler: Handler): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input as string, init);
    const signal = init?.signal;
    if (!signal) return handler(req);
    // Real fetch rejects with an AbortError as soon as the signal fires;
    // replicate that so timeout/cancellation tests are meaningful.
    return Promise.race([
      Promise.resolve(handler(req)),
      new Promise<Response>((_, reject) => {
        if (signal.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
    ]);
  }) as typeof fetch;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(handler: Handler, overrides: Record<string, unknown> = {}) {
  return new RestClient({
    baseUrl: 'http://127.0.0.1:8080',
    token: 'fictional-token-do-not-use',
    fetch: mockFetch(handler),
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, timeoutBudgetMs: 2000 },
    ...overrides,
  });
}

test('never sends the token in a form other than the Authorization header', async () => {
  let seenAuth = '';
  const c = client((req) => {
    seenAuth = req.headers.get('authorization') ?? '';
    assert.equal(req.headers.get('user-agent')?.includes('fictional-token-do-not-use'), false);
    return json(200, { status: 'ok' });
  });
  await c.request('GET', '/health');
  assert.equal(seenAuth, 'Bearer fictional-token-do-not-use');
});

test('maps 401 to AuthenticationError, never retries it', async () => {
  let calls = 0;
  const c = client(() => { calls++; return json(401, { error: { code: 'unauthenticated', message: 'no' } }); });
  await assert.rejects(() => c.request('GET', '/api/v0/me'), AuthenticationError);
  assert.equal(calls, 1);
});

test('maps 409 to ConflictError and 422 invalid_policy to PolicyRejectedError', async () => {
  const c1 = client(() => json(409, { error: { code: 'conflict', message: 'already decided' } }));
  await assert.rejects(() => c1.request('POST', '/x'), ConflictError);

  const c2 = client(() => json(422, {
    error: { code: 'invalid_policy', message: 'bad', details: { errors: ['x: required'] } },
  }));
  await assert.rejects(() => c2.request('PUT', '/api/v0/policies/p'), (err: unknown) => {
    assert.ok(err instanceof PolicyRejectedError);
    assert.deepEqual((err as PolicyRejectedError).details, { errors: ['x: required'] });
    return true;
  });
});

test('maps 404 to NotFoundError', async () => {
  const c = client(() => json(404, { error: { code: 'not_found', message: 'nope' } }));
  await assert.rejects(() => c.request('GET', '/api/v0/policies/missing'), NotFoundError);
});

test('retries GET on transport failure and succeeds', async () => {
  let calls = 0;
  const c = client(() => {
    calls++;
    if (calls < 3) throw new TypeError('fetch failed');
    return json(200, { status: 'ok' });
  });
  const result = await c.request<{ status: string }>('GET', '/health');
  assert.equal(result.status, 'ok');
  assert.equal(calls, 3);
});

test('never retries a POST without an idempotent flag', async () => {
  let calls = 0;
  const c = client(() => { calls++; throw new TypeError('fetch failed'); });
  await assert.rejects(() => c.request('POST', '/api/v0/requests', { body: {} }), TransportError);
  assert.equal(calls, 1);
});

test('retries a POST with idempotent:true on transport failure', async () => {
  let calls = 0;
  const c = client(() => {
    calls++;
    if (calls < 2) throw new TypeError('fetch failed');
    return json(200, { request_id: 'r1', status: 'allowed' });
  });
  const out = await c.request('POST', '/api/v0/requests', { body: {}, idempotent: true });
  assert.deepEqual(out, { request_id: 'r1', status: 'allowed' });
  assert.equal(calls, 2);
});

test('never retries 422 validation errors even when idempotent', async () => {
  let calls = 0;
  const c = client(() => {
    calls++;
    return json(422, { error: { code: 'validation_failed', message: 'bad modify' } });
  });
  await assert.rejects(
    () => c.request('POST', '/x', { body: {}, idempotent: true }),
    ValidationError);
  assert.equal(calls, 1);
});

test('retries 503 for a safe GET and honors Retry-After', async () => {
  let calls = 0;
  const start = Date.now();
  const c = client(() => {
    calls++;
    if (calls < 2) return json(503, { error: { code: 'internal_error', message: 'busy' } }, { 'retry-after': '0' });
    return json(200, { status: 'ok' });
  });
  await c.request('GET', '/health');
  assert.equal(calls, 2);
  assert.ok(Date.now() - start < 500);
});

test('times out and throws TimeoutError, not TransportError', async () => {
  const c = client(async () => {
    await new Promise((r) => setTimeout(r, 200));
    return json(200, {});
  }, { timeoutMs: 20 });
  await assert.rejects(() => c.request('GET', '/health'), TimeoutError);
});

test('never follows a redirect automatically', async () => {
  const c = client(() => new Response(null, { status: 302, headers: { location: 'http://evil.example/' } }));
  await assert.rejects(() => c.request('GET', '/health'));
});

test('rejects a malformed (non-JSON) 2xx response distinctly', async () => {
  const c = client(() => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(() => c.request('GET', '/health'));
});

test('refuses plain HTTP against a non-loopback host by default', () => {
  assert.throws(() => new RestClient({ baseUrl: 'http://example.com', token: 't' }));
});

test('AmpClient.modify sends decision=modify with structured params', async () => {
  let body: unknown;
  const c = new AmpClient({
    baseUrl: 'http://127.0.0.1:8080', token: 't',
    fetch: mockFetch(async (req) => {
      body = await req.json();
      return json(200, {
        hitl_id: 'h1',
        result: { decision: 'modified', params: { amount: 900 }, executed: true, follow_up_hitl_id: null },
        delivery_id: 'd1', delivered: true, replayed: false,
      });
    }),
  });
  const out = await c.modify('h1', { amount: 900 }, { note: 'reduced' });
  assert.deepEqual(body, { decision: 'modify', modified_params: { amount: 900 }, note: 'reduced' });
  assert.equal(out.executed, true);
  assert.equal(out.followUpReviewId, null);
});

test('AmpClient.waitForDecision polls until non-pending, then returns', async () => {
  let calls = 0;
  const c = new AmpClient({
    baseUrl: 'http://127.0.0.1:8080', token: 't',
    fetch: mockFetch(() => {
      calls++;
      const status = calls < 3 ? 'pending' : 'modified';
      return json(200, { request_id: 'r1', status });
    }),
  });
  const result = await c.waitForDecision('r1', { intervalMs: 1, timeoutMs: 1000 });
  assert.equal(result.status, 'modified');
  assert.equal(calls, 3);
});

test('AmpClient.waitForDecision times out if never resolved', async () => {
  const c = new AmpClient({
    baseUrl: 'http://127.0.0.1:8080', token: 't',
    fetch: mockFetch(() => json(200, { request_id: 'r1', status: 'pending' })),
  });
  await assert.rejects(() => c.waitForDecision('r1', { intervalMs: 1, timeoutMs: 5 }), TimeoutError);
});

test('unknown response fields pass through without crashing', async () => {
  const c = new AmpClient({
    baseUrl: 'http://127.0.0.1:8080', token: 't',
    fetch: mockFetch(() => json(200, {
      request_id: 'r1', status: 'allowed', from_the_future: { nested: true },
    })),
  });
  const out = await c.submitGovernedRequest({ policyId: 'p', tool: 't', action: 'a', requestId: 'r1' });
  assert.equal(out.status, 'allowed');
  assert.deepEqual((out as unknown as { from_the_future: unknown }).from_the_future, { nested: true });
});
