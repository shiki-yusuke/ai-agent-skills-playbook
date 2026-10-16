# promotion-receipt/v0 CHANGELOG

Same convention as `contracts/design-options/v1/CHANGELOG.md`: an entry here records an
**in-place revision of a still-DRAFT contract** and why it was not cut as a new version.

## 2026-10-16: draft_revision 2 — deterministic reviewer-independence evaluation (B1)

### What changed

- **Added**, receipt top-level (all required): `independence_policy_digest` (JCS sha256 of the
  frozen independence policy), `promotion_id: {run_id, run_attempt}`, and
  `session_ledger_digest` (JCS sha256 of the orchestrator session ledger, or `null`).
- **Added**, per `predicates[].evidence_refs[]`: `independence: {required, observed, check}`.
  Required on every evidence_ref of an applicable predicate that has a policy rule for the
  receipt's `effective_risk`; forbidden everywhere else (the not_applicable half in the schema,
  the policy-dependent half in `evaluate.mjs`).
- **Added** `policy/independence-policy.json` (frozen) + `policy/independence-policy.schema.json`
  — explicit `(effective_risk, predicate_id) → acceptable {code, attestation}` set, no numeric
  ordering — and `orchestrator-session-ledger.schema.json` (`orchestrator-session-ledger/0`; not
  a separate contract directory).
- **Added** `evaluate.mjs`: `evaluateReceipt(envelope, {expectedPromotionId, resolveLedger,
  policy})`, `checkPolicy`, `checkSessionLedger`, `deriveBlockers`, `inlineStubResolver`
  (fixture-only), and the rule-key manifest `INDEPENDENCE_RULE_KEYS`.
- **Changed** `deriveVerdict`: declared independence checks join the aggregation (unsatisfied →
  ineligible, unknown → abstained, unsatisfied wins when mixed). Predicate `status` is never
  rewritten by independence.
- **Added** to `checkReceipt`: one predicate may not cite the same `{kind, ref, digest}` twice.
- **Changed** fixture format (`fixture_format_version` 2): every receipt fixture is an envelope
  `{context: {expected_promotion_id}, receipt, findings, session_ledger}`; every pre-existing
  fixture was re-wrapped (its `invalid-*` / `reject-*` intent unchanged), and its placeholder
  `review_finding` digests replaced by the real JCS sha256 of the carried records. New
  `type: policy` fixtures check candidate policies.
- **Added** (implementation review follow-up): `envelope.context.expected_promotion_id` must
  equal the caller's `expectedPromotionId` (`context_promotion_id_mismatch`); a throwing resolver
  is rejected (`ledger_resolver_error`) and a resolver result other than `null` / a plain object
  is rejected (`ledger_resolver_invalid_response`) — only `null` means "unavailable"; real-date
  checks (`evaluated_at`, ledger `started_at`) reconstruct the UTC fields with `Date.UTC`, so
  `2026-02-29` / `2026-04-31` are rejected. Manifest rows (`fixture_format_version` 2) may carry
  `expected_promotion_id` and `resolver: "inline" | "throw" | "other_ledger"`.

### Code names

The design draft named the classes `technical = [different_provider, different_model_family,
different_session]`, `principal = [different_human, different_organization]`. Where
`contracts/shared/derive-independence.mjs` already emits a code for the same concept, that name
is used: `different_model_family` → `same_provider_different_family`, `different_session` →
`different_session_ref`, `different_human` → `human_third_party`. `different_provider` matched
already; `different_organization` has no existing counterpart and is kept as drafted (reserved:
principal codes never satisfy anything in this revision).

### Changing the policy

The policy's digest is bound into every receipt, so any edit is visible. Adding or removing a
`(effective_risk, predicate_id)` rule key additionally requires editing `INDEPENDENCE_RULE_KEYS`
in `evaluate.mjs` (the policy must match it exactly — a dropped rule must never silently mean
"no requirement") and an entry here. Changing `acceptable` tuples or `code_classes` requires an
entry here and a review of the new digest.

### Why revised in place rather than as v1

The contract is DRAFT, not frozen, and has no live runtime consumer (no reference implementer
exists). The only consumer is a **conformance** consumer — `release-approval/v0`'s composite
verifier, which imports this contract's checkers — and it is updated in the same change (its
composites now carry `context` and `session_ledger` and re-run `evaluateReceipt()`). So: no
impact on a live runtime consumer, but release-approval/v0 had to follow, and did.
