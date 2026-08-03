# Contributing to amp-sdk-ts

Thanks for your interest in contributing.

## Developer Certificate of Origin (DCO)

Every commit must be signed off, certifying you wrote the change or
otherwise have the right to submit it under this project's license
(Apache-2.0):

```
git commit -s -m "your message"
```

This adds a `Signed-off-by: Your Name <you@example.com>` trailer. PRs with
unsigned commits will be asked to amend before merge.

## Development setup

```
npm install
npm run typecheck
npm run test:unit
```

The live compatibility suite (`npm run test:compat`) requires a running
`amp-community` server (see that repository's README) — it is not required
for most contributions and is primarily a CI gate.

## Before opening a PR

- `npm run typecheck` and `npm run test:unit` pass locally.
- `npm run build` succeeds and `npm run build && npm pack --dry-run` shows
  no unexpected files (see the package-content checklist in the README).
- New public API surface is documented in the relevant JSDoc comments and,
  for behavior changes, in `CHANGELOG.md`.
- No secrets, production URLs, or non-fictional identifiers appear
  anywhere in the diff, including tests and examples.

## Scope

This SDK intentionally implements a small, stable governance API — the
`amp-community` `v0` REST contract, nothing more. PRs that add
Enterprise-only concepts, platform-specific
filesystem/polling behavior, or hidden telemetry will not be accepted —
see the project's `README.md` "What this SDK is not" section.

## Reporting bugs vs. security issues

Functional bugs: open a GitHub issue. Security vulnerabilities: see
`SECURITY.md` — do not open a public issue.
