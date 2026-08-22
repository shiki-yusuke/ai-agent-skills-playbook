# release-approval/v0

> **Status: DRAFT (draft_revision 1) — NOT FROZEN.** Part of the Evidence-Closed Delivery
> Shadow Evidence Contracts (Milestone F/G). No reference implementer exists yet. Freezing
> follows this repo's freeze-after-exercise discipline — not before a real approval (shadow
> or live) exercises this contract against a real deploy adapter, same bar `release-evidence/v0`
> was held to.

Normative protocol for a **release-approval event**: the append-only ledger of the ONLY
promotion authority in the Evidence-Closed Delivery Authority DAG. A human (or an authorized
emergency principal, via `break_glass_approve`) binds exact digests — the receipt being
approved, that receipt's own semantic content, the release bundle, the selection manifest, and
the target environment — to an approval, rejection, or revocation. No `promotion-receipt/v0`
verdict, however favorable, can substitute for this event; `human_release_approval` is not, and
never will be, a predicate `promotion-receipt/v0` evaluates.

Conformance fixtures: [`contracts/release-approval/v0/`](../../contracts/release-approval/v0/)
— run `node contracts/release-approval/v0/verify-fixtures.mjs` (zero dependencies, no network).

## `kind`: four events, one exact-binding shape, no exemptions

`approval_granted | approval_rejected | approval_revoked | break_glass_approve`. **Every kind**
carries the same `subject` shape — `{receipt_digest, receipt_semantic_digest, bundle_digest,
selection_manifest_digest, target}` — required, with no field ever omitted regardless of kind.
This is the point of the contract: there is no code path, including the emergency one, where an
approval can exist without being bound to an exact receipt, bundle, selection manifest, and
target. `approval_granted` and `break_glass_approve` additionally require `expires_at`;
`approval_revoked` additionally requires an exact `revoked_approval_event_id` naming the event
it revokes.

## `break_glass_approve`: the exception that changes nothing about the binding

Break-glass is a kind of **human approval event**, never a machine verdict rewritten to look
like a pass. `bypassed_predicate_ids` (non-empty, drawn from `promotion-receipt/v0`'s own
`predicate_id` closed set — never `human_release_approval`, which is not a member of that set
at all) names exactly which predicates this emergency approval chose to override, and
`incident_ref` names the incident that justified it. **Artifact binding, target, and expiry are
not exempted for break-glass** — the schema makes this structurally impossible, not merely
discouraged: `expires_at` is required exactly as for `approval_granted`, and `subject` is the
same shape every other kind carries. `recorded_after_side_effect: true` (optional) lets an
operator honestly record that the ledger append happened after the promotion side effect
already occurred (e.g. the ledger itself was unavailable at the moment of the emergency action)
— the event stays truthfully marked rather than silently backdated. The design intent from the
source plan: break-glass must "not erase the exception, not disguise it as a pass, and not hide
that it was recorded after the fact."

## `principal`: pseudonymous by construction

`principal_id` matches `^[a-z0-9][a-z0-9_-]{0,63}$` — a pattern that rejects `@` and whitespace
at the schema level, so an email address or a free-text human name cannot even be written here,
before the personal-dimension scan ever runs. `issuer` and `role_snapshot` record the
authenticated identity provider and the role the principal held *at approval time* (a snapshot,
because roles can change later without invalidating the historical record of who approved
what, under what authority, when).

## `event_id`: recomputed, not asserted

`event_id` must equal `sha256:` + the JCS (RFC 8785) sha256 of the event with `event_id` itself
removed — the same convention `release-evidence/v0` already established. `verify-fixtures.mjs`
recomputes it independently for every event and rejects a mismatch; a duplicate `event_id`
within one ledger fixture is likewise rejected. Idempotent re-emission of the exact same event
is therefore a no-op by construction, not an error a producer needs to guard against separately.

## Cross-record truth: the composite fixture is where the real checks live

A bare `release-approval` event, by itself, cannot prove it is bound to anything real — its
digests are just strings until checked against the receipt and bundle they claim to describe.
This contract's fixtures therefore include a **`composite`** fixture type:
`{findings: [...review-findings/v1 records], receipt: {...one promotion-receipt/v0},
approval_events: [...release-approval/v0 events]}`. `verify-fixtures.mjs`'s composite check:

1. Re-validates every embedded record and the receipt using **their own contracts' checkers**
   (imported directly from `review-findings/v1` and `promotion-receipt/v0`'s own
   `verify-fixtures.mjs` — never reimplemented here, so the three verifiers can never silently
   drift apart on what "valid" means).
2. Recomputes the receipt's REAL JCS sha256 and requires every approval event's
   `subject.receipt_digest` to resolve to it. A digest that merely repeats a string proves
   nothing — the same discipline `release-evidence/v0` already applies to `bundle_digest`
   (sol must-2 there).
3. Requires `receipt_semantic_digest` / `bundle_digest` / `selection_manifest_digest` / `target`
   to match the embedded receipt's **current** values exactly. Any drift is a **stale approval
   binding** — for example, the bundle was replaced by a new attempt after this approval's
   receipt was evaluated, and the approval no longer describes anything real.
4. Resolves every `review_finding` evidence reference in the receipt's predicates against the
   embedded findings records by `record_id`, and requires the reference's `digest` to equal
   that record's **actual** `subject.digest`. A finding recorded against a different (e.g.
   pre-fix) subject digest cannot back a predicate about the current subject — this is the
   mechanical form of "a fix produces a new digest, and the old finding does not follow it
   forward" that `review-findings/v1` states in prose.

Only the composite fixture type can exercise checks 2–4, because they are inherently
cross-contract: a bare receipt or a bare event, checked alone, has nothing real to resolve
against.

## What v0 deliberately leaves out

- **No full approval-priority state machine.** This contract enforces the per-kind field
  requirements (R14–R17) and the digest-binding checks above; it does not yet encode a complete
  ordering rule across `approval_granted → approval_revoked → break_glass_approve` sequences
  beyond what `revoked_approval_event_id` and the exact-binding checks already require. A
  richer state machine (mirroring `release-evidence/v0`'s attempt-folding transition graph) is
  v1 work, informed by a first real multi-event case.
- **No automatic promotion.** This ledger only records human (or authorized emergency) approval
  events; the actual promotion side effect and its own `promotion_result_recorded` event are
  outside this contract's scope.

## Verification

`node contracts/release-approval/v0/verify-fixtures.mjs` checks every fixture against
`release-approval-event.schema.json` plus: `event_id` recomputation, duplicate `event_id`
detection across a ledger, the composite cross-record checks above, the numeric-confidence
scan, and the personal-dimension scan (`contracts/shared/personal-dimensions.mjs`). See the
fixtures directory's `expected-results.json` for the declared outcome of each fixture.
