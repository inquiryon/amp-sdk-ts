# amp-sdk-ts

TypeScript SDK for the AMP Community governance API: policy evaluation,
governed tool-call submission, human-in-the-loop (HITL) review, callback
delivery, and audit-history queries.

Implements the `v0` API contract. See
[the versioning policy](#versioning-policy) before depending on this in
production.

## What this SDK is

A small, typed client for the `amp-community` REST API (the "SDK
compatibility boundary" served at `/api/v0/openapi.json`). It exposes
exactly the operations documented in that OpenAPI contract: evaluate a
policy, submit a governed request, poll or wait for a decision,
list/approve/reject/modify HITL reviews, check/retry callback delivery, and query the audit log.

## What this SDK is not

- **Not** a client for any Enterprise-only capability: RLHF/model training,
  model promotion, proprietary scoring, billing, organizations, SaaS
  auth, or private analytics. None of these exist in the public contract,
  so there is nothing here to call.
- **Not** an agent runtime. This package makes HTTP calls and returns
  typed results; it does not manage agent processes, filesystem instance
  folders, or background polling loops beyond the one opt-in
  `waitForDecision` helper.

## Supported Node.js versions

Node.js **>= 18.17** (the first LTS line with a stable built-in `fetch`
and `AbortSignal.timeout`). This package uses the platform's built-in
`fetch` — no HTTP client dependency — and accepts an injectable `fetch`
implementation for testing or non-standard environments.

## Install

```bash
npm install @inquiryon/sdk
```

## Module format: ESM-only (documented CommonJS decision)

This package is **ESM-first and ESM-only** (`"type": "module"`, no
CommonJS build). Rationale:

- Node.js has supported stable ESM since v12, and every currently
  supported LTS line (18.17+) fully supports `import`.
- Shipping a dual CJS+ESM build roughly doubles the package's surface
  area, build complexity, and chance of subtle `instanceof`/dual-package-
  hazard bugs (e.g. two copies of an error class across the two builds) —
  a real risk for a package whose typed error hierarchy is a core
  feature.
- CommonJS consumers on Node >=18.17 can still use this package via a
  dynamic `import()` (`const { AmpClient } = await import('@inquiryon/sdk')`),
  which works from a `.cjs` file or a `require`-based project without any
  transpilation.

If a genuine need for a CJS build emerges (e.g. a major bundler/runtime
that cannot consume ESM at all), that would be evaluated as a `0.x` minor
addition, not a breaking change — see the versioning policy.

## Quickstart

```ts
import { AmpClient } from '@inquiryon/sdk';

const client = new AmpClient({
  baseUrl: 'http://127.0.0.1:8080',
  token: process.env.AMP_TOKEN!, // never hardcode a real token
});

// Import a policy (reviewer role required server-side).
await client.importPolicy('invoice-governance', {
  policy_id: 'invoice-governance',
  schema_version: 'v0',
  action_governance: {
    criteria: [{
      criterion_id: 'c-high-amount', tool: 'pay_invoice', action: '*',
      hardness: 'hard', evaluator: { type: 'compute', formula: 'amount > 1000' },
    }],
  },
});

// Submit a governed tool call. Always pass a requestId for safe retries.
const submitted = await client.submitGovernedRequest({
  policyId: 'invoice-governance', tool: 'pay_invoice', action: 'submit',
  params: { amount: 5000 }, requestId: 'req-fictional-0001',
});

if (submitted.status === 'pending_review') {
  // ... a reviewer later calls client.approve/reject/modify(submitted.hitl_id) ...
  const decision = await client.waitForDecision(submitted.request_id, { timeoutMs: 60_000 });
  console.log(decision.status, decision.executed_params);
}
```

See `examples/` for complete, runnable programs (policy evaluation, a
governed tool call, HITL polling, approve/reject/modify, callback-delivery
handling, and an audit-history query) using only fictional data.

## Errors

Every failure is a typed subclass of `AmpError` carrying the HTTP status
(when applicable), the server's stable error code, the correlation
`requestId` (when the server supplied one), whether the SDK considers it
retryable, and bounded structured details:

```ts
import { NotFoundError, ConflictError, ValidationError } from '@inquiryon/sdk';

try {
  await client.getReview('hitl-does-not-exist');
} catch (err) {
  if (err instanceof NotFoundError) { /* ... */ }
}
```

See `src/errors.ts` for the complete, exact mapping from server error code
to SDK error type and retry classification.

## Retries and idempotency

GET requests are retried automatically (bounded exponential backoff with
jitter, honoring `Retry-After`, within a total timeout budget). Mutations
are retried automatically **only** when they are transport failures for an
operation the caller has marked idempotent — `submitGovernedRequest` when a
`requestId` was supplied, or a delivery retry (idempotent by construction).
A received 4xx response is never retried. See the baseline document for
the full policy and its rationale.

## Security notes

- The bearer token is only ever sent in the `Authorization` header — never
  logged, never placed in the `User-Agent` string, never included in an
  error message.
- HTTPS is required for any non-loopback `baseUrl` by default (opt out
  explicitly with `requireHttpsForRemote: false` for deliberate local/dev
  use only).
- This client never follows an HTTP redirect automatically — a 3xx
  response is surfaced as an error rather than silently forwarding the
  Authorization header to a possibly different origin.
- Response bodies are capped at 10 MiB; no telemetry is collected or sent
  anywhere by default.

## Versioning policy

This package is `0.1.0`, tracking the `v0` API contract.
During `0.x`, any change to request/response shapes, error classification,
or retry semantics may ship in a minor version and will be called out
under **Breaking** in `CHANGELOG.md`.

## License

Apache-2.0 — see `LICENSE` and `NOTICE`.
