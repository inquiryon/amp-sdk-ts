# Changelog

All notable changes to this project are documented in this file. Format
loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project is `0.x`: minor versions may contain breaking changes, always
called out below under an explicit **Breaking** heading (see the
versioning policy in `README.md`'s "Versioning policy" section).

## [0.1.0] — Unreleased

Initial release. Implements the `v0` Community governance API contract.

### Added

- `RestClient`: low-level typed HTTP client (bearer auth, conservative
  retry with bounded exponential backoff + jitter + `Retry-After`,
  timeout, `AbortSignal` cancellation, redirect-refusal, response-size
  cap, malformed-JSON handling).
- `AmpClient`: governance convenience façade — `evaluate`,
  `submitGovernedRequest`, `getRequest`, `waitForDecision`, `listReviews`,
  `getReview`, `approve`, `reject`, `modify`, `getDeliveryStatus`,
  `retryDelivery`, `retryAllDeliveries`, `listAuditEvents`, and policy
  lifecycle methods (`listPolicies`, `getPolicy`, `importPolicy`,
  `validatePolicy`).
- Typed error hierarchy: `AuthenticationError`, `AuthorizationError`,
  `NotFoundError`, `ConflictError`, `ValidationError`,
  `PolicyRejectedError`, `ServerError`, `TransportError`, `TimeoutError`,
  `CancellationError`, `UnsupportedVersionError`, `MalformedResponseError`.
- Typed models for every v0 wire shape, with the five distinct decision/
  status vocabularies kept as separate types (see the compatibility
  report).
