# review-findings/v1 CHANGELOG

Same convention as `contracts/design-options/v1/CHANGELOG.md`: an entry here records an
**in-place revision of a still-DRAFT contract** and why it was not cut as a new version.

## 2026-10-16: draft_revision 2 — `assessor.independence.params.attestation` (B1)

### What changed

- **Added**, required: `assessor.independence.params.attestation` —
  `orchestrator_observed | self_reported | unknown`. A record without it is invalid; it is never
  read as `unknown`.
- **Added**: `assessor.independence.params.session_ref: {session_id, started_at, args_digest}` —
  required exactly when `attestation = orchestrator_observed`, forbidden otherwise (schema
  `allOf` if/then/else). `started_at` must also be a real date (verifier).
- `params` stays an open bag: existing code-specific params coexist with these two keys.
- Every existing fixture gained an `attestation` (`unknown` unless the fixture is about an
  attestation); new fixtures cover a missing attestation, `orchestrator_observed` without
  `session_ref`, a numeric attestation, `session_ref` with `self_reported`, a malformed
  `args_digest`, and an unreal `started_at`.
- **Changed** (implementation review follow-up): the real-date check on `recorded_at` and
  `session_ref.started_at` reconstructs the UTC fields with `Date.UTC` instead of relying on
  `Date.parse` alone, so `2026-02-29` / `2026-04-31` are rejected.

### What it does not mean

`orchestrator_observed` in a record is a claim. It is verified only by promotion-receipt/v0's
`evaluateReceipt()` against the wrapper's session ledger, and even then it proves technical
execution separation only — not human or organizational independence. See
`docs/protocols/review-findings-v1.md`.

### Why revised in place rather than as v2

DRAFT, not frozen, no live runtime producer or consumer. The conformance consumers
(promotion-receipt/v0's evaluation envelopes and release-approval/v0's composites, which embed
review-findings records) were regenerated in the same change.
