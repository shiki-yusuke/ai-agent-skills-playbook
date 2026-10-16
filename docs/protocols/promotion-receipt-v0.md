# promotion-receipt/v0

> **Status: DRAFT (draft_revision 2) — NOT FROZEN.** Part of the Evidence-Closed Delivery
> Shadow Evidence Contracts (Milestone F). No reference implementer exists yet; receipt
> evaluation is intended to be fully deterministic (zero LLM calls) whenever it is
> eventually implemented. Freezing follows this repo's freeze-after-exercise discipline —
> not before a real promotion (shadow or live) exercises this contract.

Normative protocol for a **promotion-receipt**: a deterministic, machine-evaluated verdict over
every predicate a release must satisfy **except human approval**. A receipt carries **no
promotion authority by itself** — authority belongs exclusively to `release-approval/v0`,
whose event binds to this receipt's exact digest. This is the middle link of the
Evidence-Closed Delivery Authority DAG:

```
review-findings/v1  →  promotion-receipt/v0  →  release-approval/v0
   (records what          (evaluates every            (the ONLY authority —
    was observed,          predicate except            a human, or an
    no authority)          human approval,              authorized emergency
                           no authority)                 principal, binds
                                                          exact digests)
```

Conformance fixtures: [`contracts/promotion-receipt/v0/`](../../contracts/promotion-receipt/v0/)
— run `node contracts/promotion-receipt/v0/verify-fixtures.mjs` (zero dependencies, no network).
draft_revision 2 (in place, see [`CHANGELOG.md`](../../contracts/promotion-receipt/v0/CHANGELOG.md))
adds the deterministic reviewer-independence evaluation described in
["Independence evaluation"](#independence-evaluation-draft_revision-2) below.

## Naming: `verdict`, never `decision`

This contract's outcome field is `verdict`, and the word `decision` does not appear anywhere
in its schema. This is deliberate, not incidental: `contracts/decision/v1` already exists and
means something entirely different — a **human's** design decision, made through
`decision_channel`, with `rationale` and `accepted_assumptions`. A `promotion-receipt` is the
opposite kind of thing: a **machine's** deterministic evaluation of a predicate vector, with no
rationale to record because there is no judgment being exercised — only recorded evidence being
checked against closed rules. The source plan's own naming history makes the same point: an
earlier draft of this contract was called `decision-receipt/v0` and was renamed specifically to
avoid this collision (Codex sol Round 3 arbitration). If you are looking for "why did a human
approve this," that is `release-approval/v0`'s event, never this record.

## `verdict`: exactly three values, and `eligible` is not one of them

`ready_for_approval | ineligible | abstained` — closed at the schema level. Earlier design
rounds used `eligible`, but that value implied the receipt itself could grant eligibility to
promote, which is an authority circularity this contract must not have: a receipt only ever
says "I have evaluated everything except human approval, and here is what I found." Whether
that state is *actually* eligible for promotion is `release-approval/v0`'s call, made by a
human (or an authorized emergency principal via `break_glass_approve`) binding to this exact
receipt. `break_glass_authorized` is likewise not a receipt verdict — break-glass is a kind of
**approval event**, never a machine verdict; the predicate vector inside a receipt always
records its real, unmodified status even when a human later chooses to bypass some of it.

`release-approval/v0` additionally restricts *which* approval kind may bind to a non-ready
receipt (sol architect ask-1/R22, enforced there, not here): `approval_granted` is valid only
against a receipt whose `verdict` is `ready_for_approval`; only `break_glass_approve` may bind
to an `ineligible` or `abstained` receipt, and it must carry the audit fields (`incident_ref`,
`bypassed_predicate_ids`) that make the exception visible rather than silent.

## Verdict derivation is enforced by the verifier, not asserted by the fixture

Given a receipt's `predicates[]`, restricted to those with `applicability: "applicable"`:

1. If **any** applicable predicate has `status: "contradicted"` → the verdict **must** be
   `ineligible`.
2. Else, if **any** applicable predicate has `status: "unknown"` → the verdict **must** be
   `abstained`.
3. Else (every applicable predicate is `satisfied`) → the verdict **must** be
   `ready_for_approval`.

`verify-fixtures.mjs` recomputes this derivation independently and rejects any fixture whose
declared `verdict` does not match it — a fixture cannot simply assert a favorable verdict while
carrying an unfavorable predicate vector. `not_applicable` predicates never influence the
derivation (their `status` is schema-forced to `unknown`, but they are excluded from the
"applicable" filter above, so an inapplicable predicate can never itself cause `abstained`).

draft_revision 2 extends this derivation with the declared independence checks (an `unsatisfied`
check joins `contradicted` on the ineligible side, an `unknown` check joins `unknown` on the
abstained side); see [Independence evaluation](#independence-evaluation-draft_revision-2) rule 6.

## `predicate_id`: closed per phase, complete per phase, and `human_release_approval` exists in neither

- `evaluation_phase: "pre_promotion"` → predicates are drawn only from `artifact_identity`,
  `review_admissibility`, `verification_coverage`, `preview_verified`, `rollback_target_valid`,
  `privilege_boundary`.
- `evaluation_phase: "post_deploy"` → predicates are drawn only from
  `deployed_artifact_readback`.
- **`human_release_approval` is not a member of either set, or of this contract's
  `predicate_id` enum at all.** Human approval is never something this receipt evaluates — it
  is the entire reason `release-approval/v0` exists as a separate authority. Mixing the two
  sets in one receipt, or naming `human_release_approval` as a predicate, is rejected at the
  schema level.

**A receipt must carry its ENTIRE phase's predicate set, exactly once each — no fewer, no
duplicates** (sol architect must-1, R21): a `pre_promotion` receipt is rejected unless it
contains all six `pre_promotion` predicate_ids; a `post_deploy` receipt is rejected unless it
contains `deployed_artifact_readback`. This is enforced by `verify-fixtures.mjs`, not the
schema (a single array item's schema cannot see its siblings). Additionally, **the three
always-on `pre_promotion` predicates (`artifact_identity`, `review_admissibility`,
`verification_coverage`) and post_deploy's own `deployed_artifact_readback` can never be
`not_applicable`.** This closes an escape hatch a design round flagged: marking every predicate
`not_applicable` leaves zero *applicable* predicates, and the verdict derivation above then
defaults to `ready_for_approval` by vacuous truth (no applicable predicate is ever
`contradicted` or `unknown` if there are no applicable predicates at all). Forcing these four
predicates to always be evaluated removes that vacuous-pass path entirely.

A predicate whose `status` is `satisfied` or `contradicted` must carry at least one
`evidence_refs[]` entry of a **resolvable kind** — `review_finding` or `release_evidence`.
`kind: "other"` is auxiliary information only: an `other`-only reference can never, by itself,
back a `satisfied` or `contradicted` status (sol architect must-2a). This half of the rule is
checkable without a ledger and is enforced by this contract's own `verify-fixtures.mjs`; whether
the cited evidence *actually resolves* to something real is `release-approval/v0`'s composite
fixture's job (see below).

## `evidence_refs`: what this contract can check alone, and what it can't

Each `evidence_refs[]` entry is `{kind, ref, digest}`.

- `kind: "review_finding"` names a `review-findings/v1` record as
  `"<record_id>#<finding_id>"` (must resolve to a real finding in that record) or
  `"<record_id>#scope"` (valid only when that record's `outcome` is
  `none_observed_in_recorded_scope`). `digest` is bound to the **WHOLE record's** JCS (RFC 8785)
  sha256 (sol architect must-2b/R23) — **not** `subject.digest`. This distinction matters:
  editing a finding's `claim`, `severity`, or `outcome` after the fact changes the record's own
  digest even though `subject.digest` (bound to the scanned tree, not the record's content) can
  stay the same. A reference recorded against the pre-edit digest is stale the instant the
  content changes (TEST-12).
- `kind: "release_evidence"` names a `release-evidence/v0` release/bundle by `release_id`.
- `kind: "other"` is opaque and never resolved by any verifier in this repo.

**This contract's own `verify-fixtures.mjs` does not resolve `evidence_refs` against a real
review-findings record or a real release-evidence bundle** — a bare receipt fixture does not
carry either alongside it; it can only check the *structural* rule above (a resolvable-kind ref
must exist). The *actual* resolution — recomputing the real record/bundle digest and confirming
the reference's anchor and digest both check out — is `release-approval/v0`'s composite ledger
fixture's job, which bundles review-findings records, an optional array of embedded
release-evidence bundles, one receipt, and approval events together (see that protocol's
TEST-06/TEST-09/TEST-12). A `release_evidence` reference to a bundle that isn't embedded in a
given composite fixture is not itself an error — it simply doesn't count as resolved, and a
predicate backed *only* by such a reference is rejected as unresolved there (must-2c). A receipt
that references a stale or non-existent digest will pass this contract's own fixture check and
fail in the composite instead.

## `semantic_digest`: what TOCTOU actually compares

`semantic_digest` is `sha256:` + the JCS (RFC 8785) sha256 of this receipt with `evaluated_at`,
`receipt_id`, and `semantic_digest` itself removed. `verify-fixtures.mjs` recomputes it and
rejects a mismatch. Time is deliberately excluded: the compare-and-promote step
`release-approval/v0` performs immediately before promotion re-evaluates the current state and
compares its semantic digest against the one an approval bound to — a change to *when* the
receipt happened must never itself invalidate an otherwise-unchanged approval, but a change to
*what* the receipt found must.

## `effective_risk` and `policy_digest` are frozen at evaluation start

Both are recorded values, not values the receipt derives from its own verdict — a receipt that
lowered its own risk classification after seeing a favorable predicate vector would be a
self-consistency loop the source plan explicitly rules out (Codex sol Round 2 arbitration).

## Independence evaluation (draft_revision 2)

A receipt's `review_admissibility` used to say nothing about *who* reviewed. draft_revision 2
evaluates reviewer independence deterministically, as a vector **separate from** predicate
`status` (a predicate's declared status is never rewritten by it), from three inputs:

- the **frozen independence policy** —
  [`policy/independence-policy.json`](../../contracts/promotion-receipt/v0/policy/independence-policy.json)
  (schema `policy/independence-policy.schema.json`): `code_classes: {technical: [...],
  principal: [...]}` plus `rules: [{effective_risk, predicate_id, acceptable: [{code,
  attestation}]}]`. It is an explicit set, with **no numeric ordering**: lookup is the exact key
  `(effective_risk, predicate_id)` and membership of the exact tuple `(code, attestation)` — no
  risk fallback, no "high implies medium", no inheritance, no first-match. The receipt binds the
  policy's JCS sha256 as `independence_policy_digest`; the verifier recomputes it from the policy
  it was given and rejects a mismatch. `policy_digest` stays the (opaque) general promotion
  policy; `independence_policy_digest` names only this tuple set.
- the **review-findings/v1 records** the receipt cites, each carrying
  `assessor.independence.params.attestation` (`orchestrator_observed | self_reported | unknown`)
  and, for `orchestrator_observed` only, `params.session_ref` (see
  [review-findings/v1](review-findings-v1.md)).
- the **orchestrator session ledger** (below), resolved through an injected resolver.

`checkPolicy()` rejects a policy whose `(effective_risk, predicate_id)` keys repeat, differ from
the rule-key manifest `INDEPENDENCE_RULE_KEYS` in `evaluate.mjs` (exact equality — a rule deleted
from the policy would otherwise silently mean "no requirement", i.e. fail-open), whose
`code_classes` arrays repeat a code or share one, whose `acceptable` is empty or repeats a tuple,
or whose `acceptable` names a code that is unclassified **or principal-class** (a principal tuple
could never be satisfied in this revision, so listing one is a dead setting and rejected).
Adding or removing a rule key is a contract change: edit the manifest and the policy together,
recompute the digest, and record it in `CHANGELOG.md`.

Initial policy: `technical = [different_provider, same_provider_different_family,
different_session_ref]`, `principal = [human_third_party, different_organization]` (code names
follow `contracts/shared/derive-independence.mjs` where it already has one; see CHANGELOG);
`review_admissibility` at `high` and `medium` accepts each technical code with
`orchestrator_observed` only, and at `low` with `orchestrator_observed` or `self_reported`. No
other predicate has a rule, i.e. no other predicate requires independence.

### Evaluation input and `evaluateReceipt()`

A consumer never evaluates a bare receipt. The evaluation input is the envelope
`{context: {expected_promotion_id}, receipt, findings: [review-findings records],
session_ledger: ledger | null}` and the one entry point is
`evaluateReceipt(envelope, {expectedPromotionId, resolveLedger, policy})` in
[`evaluate.mjs`](../../contracts/promotion-receipt/v0/evaluate.mjs), returning
`{ok, reasons[], blockers[], derivedVerdict}`. It first runs `checkReceipt()` (schema, R21, R9,
dates, R10, R12), then:

1. **Promotion identity.** `envelope.context.expected_promotion_id` must equal
   `expectedPromotionId` (JCS), else reject (`context_promotion_id_mismatch`) — a context that
   names another promotion is never silently overridden by the caller's value. Then
   `receipt.promotion_id` (`{run_id, run_attempt}`) must equal `expectedPromotionId`, else reject. In production the **calling workflow** fixes
   `expected_promotion_id` and passes it in — it is never read from the receipt. The ledger is
   requested as `resolveLedger(expectedPromotionId, receipt.session_ledger_digest)`: the
   namespace is the expected id.
2. **Ledger resolution.** A resolver result of `null` (unavailable / not found) makes every
   `orchestrator_observed` attestation `unknown` — never satisfied. Only `null` means
   unavailable: a resolver that throws is rejected (`ledger_resolver_error: <message>`), and one
   that returns anything other than `null` or a plain JSON object (`undefined`, an array, a
   Promise) is rejected (`ledger_resolver_invalid_response`). A resolved ledger that is
   malformed, schema-invalid, of an unsupported `ledger_version`, whose JCS digest differs from
   `receipt.session_ledger_digest`, whose `promotion_id` differs from the expected one, or that
   differs from a carried inline copy, is **rejected** (corrupt input, not "unavailable"). The
   inline copy is never used as a fallback.
3. **Verified attestation.** A record declaring `orchestrator_observed` verifies as
   `orchestrator_observed` only when the ledger has the entry whose `review_record_digest` is that
   record's whole-record JCS sha256; that entry must also agree on `session_ref` (all of
   `session_id`, `started_at`, `args_digest`) and `independence_code`, else reject (the record's
   digest covers both, so a disagreement can only be a corrupt ledger). No such entry / no ledger
   → `unknown`. `self_reported` → `self_reported`. `unknown` → `unknown`. A missing attestation
   already failed review-findings/v1's schema, so the record — and the envelope — is rejected; it
   is never read as `unknown`.
4. **Per-(predicate × evidence_ref) derivation.** For an `applicable` predicate with a policy rule
   for the receipt's `effective_risk`, **every** `evidence_refs[]` entry must carry
   `independence: {required, observed, check}`; anywhere else it is forbidden (the not_applicable
   half is schema-enforced). `required` is the rule's `acceptable` array verbatim. For
   `kind: review_finding`, the record is resolved by `record_id` from `findings` (absent → reject:
   independence cannot be evaluated; digest ≠ the record's JCS sha256 → reject) and
   `observed = {code: assessor.independence.code, attestation: verified}`. For any other kind,
   `observed = null` and `check = unknown`. Declared `required` / `observed` / `check` must equal
   the derived values exactly, else reject. `findings` with a repeated `record_id` are rejected
   before any lookup. One predicate may not cite the same `{kind, ref, digest}` twice.
5. **Check order.** Code in no `code_classes` entry → reject. Verified attestation `unknown` →
   `unknown` (before any membership test). Principal-class code → always `unknown` (draft_revision
   2 has no authenticable reviewer-principal source; the approver's `principal` in
   release-approval/v0 is **not** an input — approver authentication is not reviewer-independence
   authentication). Technical-class code → `satisfied` iff `{code, attestation}` ∈ `required`,
   else `unsatisfied`.
6. **One verdict derivation.** Over applicable predicates: any `independence.check =
   unsatisfied` or `status = contradicted` → `ineligible`; else any `check = unknown` or
   `status = unknown` → `abstained`; else `ready_for_approval`. Mixed checks: unsatisfied wins.
   The declared verdict must match.
7. **Blockers.** `{p.predicate_id | p applicable ∧ (p.status ∈ {contradicted, unknown} ∨ some
   rule-target evidence_ref has check ∈ {unsatisfied, unknown})}`. release-approval/v0 requires a
   `break_glass_approve`'s `bypassed_predicate_ids` to equal this set exactly.

Degradation never upgrades: wherever evidence is missing or unverifiable the check is `unknown`
(→ `abstained`), never `satisfied`.

### Session ledger (`orchestrator-session-ledger/0`)

Shape: [`orchestrator-session-ledger.schema.json`](../../contracts/promotion-receipt/v0/orchestrator-session-ledger.schema.json)
— deliberately not its own contract directory. `{ledger_version:
"orchestrator-session-ledger/0", promotion_id: {run_id, run_attempt}, entries: [{session_id,
started_at, args_digest, independence_code, review_record_digest}]}`, closed objects. Semantic
rules (`checkSessionLedger()`): `session_id` non-empty; `started_at` a real UTC `Z` timestamp;
`args_digest` / `review_record_digest` are `sha256:<64 hex>`, the latter the whole-record JCS
sha256 of the review-findings record that session produced; `review_record_digest` unique (one
record has at most one entry, which also rules out exact duplicate entries); one `session_id`
never appears with two different `(started_at, args_digest)`; entries sorted strictly ascending
by `review_record_digest`. Entry order therefore carries no meaning — the sort only makes the
ledger's JCS digest (`receipt.session_ledger_digest`) a canonical representation. An unsupported
`ledger_version` is rejected. The storage unit is one ledger per `promotion_id`.

**What a ledger proves:** that the orchestrator wrapper itself launched a review session with
those arguments and that the session produced that record — technical execution separation, and
nothing more. It proves nothing about a human or an organization.

### Trust boundary

- A **production verifier never grounds `orchestrator_observed` in an inline ledger** carried
  alongside the receipt. It injects a resolver that reads a **wrapper-only, append-only** store —
  one with no writer other than the wrapper — keyed by the caller's `expected_promotion_id`.
- The envelope's `session_ledger` is a **transport copy**: when present, its digest must equal
  the resolver's result, and it is never consulted when the resolver returns `null`.
- Resolver implementation is the **adapter's** responsibility; this playbook defines only the
  interface `resolveLedger(expectedPromotionId, sessionLedgerDigest) → ledger | null`.
- The conformance fixtures inject `inlineStubResolver(envelope)` — **fixture-only, not a
  production path**: it returns the envelope's inline ledger when asked for the envelope's
  `context.expected_promotion_id` namespace and `null` otherwise. That is the single injection
  point (promotion-receipt's own verifier and release-approval/v0's composite verifier both use
  it).
- **Authenticity limit.** Nothing is signed. The root of trust is write control over the
  wrapper-only store. This design does not defend against a principal able to generate or
  replace the receipt, the records, and the ledger together.

## Caveats this contract is honest about

- **`subject.selection_manifest_digest` is opaque in v0.** The selection-manifest contract this
  digest is meant to pin does not exist yet (an open question carried forward from the source
  plan, Codex sol Round 3). This receipt only carries the value; a consumer defines its own
  shape and how to recompute it. Do not assume this digest means the same thing across two
  different consumers until a selection-manifest contract exists to say so.
- **`privilege_boundary`'s static scan is a necessary condition, not a sufficient one.** Even
  when every other predicate is `satisfied`, a `privilege_boundary: satisfied` verdict reflects
  only what a decidable, static configuration scan (SHA-pinned actions, no `pull_request_target`
  misuse, no privileged-secret exposure to untrusted event bodies, fork isolation, minimal
  `permissions`, etc.) can prove. It cannot prove the absence of a compromised action internally,
  a tampered pinned commit, or a prompt-injection payload smuggled through a field the scan does
  not interpret semantically. Treat a `satisfied` privilege_boundary predicate as "the
  configuration does not exhibit any of the known-bad shapes," not as "this workflow is secure."

## What v0 deliberately leaves out

- **No cross-record resolution of `release_evidence` refs in this contract's own verifier** (see
  above). draft_revision 2 does resolve `review_finding` refs of independence-rule predicates
  against the envelope's `findings`, for the independence evaluation only.
- **No authenticable reviewer principal.** principal-class independence codes always evaluate
  to `unknown` in draft_revision 2.
- **No approval, revocation, or expiry state.** All of that is `release-approval/v0`'s.
- **No LLM-generated rationale or explanation text.** A receipt's predicates are evaluated
  deterministically; there is nothing here for a model to explain.

## Verification

`node contracts/promotion-receipt/v0/verify-fixtures.mjs` first requires the frozen
`policy/independence-policy.json` to pass `checkPolicy()`, then runs every `type: envelope`
fixture through `evaluateReceipt()` with `inlineStubResolver` (the independence evaluation
above) and every `type: policy` fixture through `checkPolicy()`. The receipt-level part checks
`promotion-receipt.schema.json` plus: predicate-set completeness and always-applicable
enforcement (above, R21), the structural half of resolvable-evidence-kind (above, R9),
real-calendar-date validity for `evaluated_at` and every ledger `started_at` (a value the pattern accepts is split into its year/month/day/hour/minute/second fields and must survive a `Date.UTC` round trip unchanged — so `"2026-99-99T00:00:00Z"`, and also `"2026-02-29T00:00:00Z"` / `"2026-04-31T00:00:00Z"` (which `Date.parse` silently rolls into the next month), are rejected), verdict
derivation (above), `semantic_digest` recomputation (above), the broadened numeric-confidence
scan (matches any key whose lowercased name *contains* `"confidence"`), and the
personal-dimension scan (`contracts/shared/personal-dimensions.mjs`). See the fixtures
directory's `expected-results.json` for the declared outcome of each fixture.
