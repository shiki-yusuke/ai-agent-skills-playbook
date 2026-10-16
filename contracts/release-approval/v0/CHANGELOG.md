# release-approval/v0 CHANGELOG

Same convention as `contracts/design-options/v1/CHANGELOG.md`: an entry here records an
**in-place revision of a still-DRAFT contract** and why it was not cut as a new version.

This contract tracks two revisions separately:

- **schema revision** — `release-approval-event.schema.json`, the shape of one event.
  Currently **draft_revision 1**, unchanged by every entry below.
- **conformance-profile revision** — what `verify-fixtures.mjs`'s composite check accepts (the
  cross-record rules over `{context, findings, bundles, receipt, session_ledger,
  approval_events}`). Currently **draft_revision 2**.

## 2026-10-16: conformance-profile draft_revision 2 — follows promotion-receipt/v0 draft_revision 2 (B1)

Schema revision: unchanged (draft_revision 1): no new event field exists and the JSON Schema is
byte-identical. The conformance profile (what the verifier accepts, for composites AND for standalone
events) did change: `occurred_at` / `expires_at` are now checked as real UTC calendar timestamps, so an
event carrying e.g. a non-leap-year `02-29` that `Date.parse` used to normalise is rejected now.

### What changed (conformance profile)

- **Added** composite keys `context: {expected_promotion_id}` and `session_ledger` (object or
  `null`). The composite is now a **closed** object of exactly six keys `{context, findings,
  bundles, receipt, session_ledger, approval_events}`, shape-checked before anything else; any
  other key is rejected (`composite_unexpected_field`).
- **Added** a re-run of promotion-receipt/v0's `evaluateReceipt()` over `{context, receipt,
  findings, session_ledger}` (independence evaluation against the frozen policy and the session
  ledger). A composite can no longer be accepted on the receipt-only `checkReceipt()`; every
  failure is reported as `receipt_evaluation_failed: <reason>`. The caller's expected
  promotion id (a fixture row's `expected_promotion_id`) is passed through, so a `context` naming
  another promotion is rejected (`context_promotion_id_mismatch`).
- **Changed** `break_glass_approve`: `bypassed_predicate_ids` must equal the evaluation's
  blockers **exactly** (`break_glass_bypassed_blockers_mismatch`; previously any non-empty set of
  receipt predicates), may not name a `not_applicable` predicate
  (`break_glass_bypasses_not_applicable`), and is rejected when the receipt has **no** blockers
  (`break_glass_without_blockers` — use `approval_granted`).
- **Added** `findings[]` with a repeated `record_id` are rejected (`duplicate_record_id`) before
  any record map is built.
- **Changed** real-date checks (`occurred_at`, `expires_at`, and those of embedded records and
  the receipt) reconstruct the UTC fields with `Date.UTC`, so `2026-02-29` / `2026-04-31` are
  rejected rather than rolled into the next month by `Date.parse`.

### Why revised in place rather than as v1

The contract is DRAFT, not frozen, and has no live runtime consumer (no reference implementer
exists). The event schema — the part a producer emits — did not change; only the conformance
verifier's acceptance of composites tightened, in the same change as promotion-receipt/v0
draft_revision 2 that it follows.
