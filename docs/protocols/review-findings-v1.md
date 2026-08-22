# review-findings/v1

> **Status: DRAFT (draft_revision 1) — NOT FROZEN.** Part of the Evidence-Closed Delivery
> Shadow Evidence Contracts (Milestone F). No reference implementer exists yet; lane's
> intended role is vendor + verify only (never a model call from this contract). Freezing
> follows this repo's freeze-after-exercise discipline (see `release-evidence/v0`'s own
> Status note) — not before a real reviewer emits a real record and a real receipt consumes it.

Normative protocol for a **review-findings record**: an immutable observation of what a
reviewer found (or explicitly did not find, or could not determine) in one recorded
`scan_scope` of one subject digest. Grounded in the Evidence-Closed Delivery plan's
Authority DAG (`review-findings → promotion-receipt → release-approval`) — this contract
carries **no promotion authority whatsoever**. It only records what was observed; it never
decides anything.

Conformance fixtures: [`contracts/review-findings/v1/`](../../contracts/review-findings/v1/)
— run `node contracts/review-findings/v1/verify-fixtures.mjs` (zero dependencies, no network).

## Naming: `reviewer` → `assessor`

The source spec's EARS requirements name this field `reviewer`. This schema uses `assessor`
instead, naming the exact same concept (what kind of thing produced the finding — never a
person), because `contracts/shared/personal-dimensions.mjs`'s forbidden-key set already
contains `reviewer`: a record with a top-level `reviewer` object would fail the mandatory
personal-dimension scan on every single accepting fixture, permanently. `decision/v1` hit the
identical collision with `reviewer`/`critic_engine` and resolved it the same way — see that
protocol's own note on `engine_ref`/`critic`/`decision_channel`. This is a builder-time
correction to the spec, not a semantic change to what the field means.

## Identity: subject digest binds the scan, not the repository

`subject.digest` is a `sha256:`-prefixed digest binding `repository_ref` + the normalized
`scan_scope` (paths, commit range, lenses) at scan time — **not** recomputed by this
contract's own verifier (there is no bundle-style artifact here to recompute it from; unlike
`promotion-receipt/v0`'s `semantic_digest` or `release-approval/v0`'s `event_id`, which
*are* recomputed). A record's findings are valid evidence only for that exact digest. When a
fix changes the scanned tree, the next scan produces a **different digest**, and the old
record's findings do not silently migrate forward to it — they are stale for the new subject
by construction. `promotion-receipt/v0` predicates that cite a review-findings record as
evidence must cite the record whose `subject.digest` actually matches; `release-approval/v0`'s
composite ledger fixture is where that resolution is checked (see that protocol's TEST-09).

## `outcome`: three honest states, one dishonest non-option

- `findings_observed` — at least one finding; `abstention` is null.
- `none_observed_in_recorded_scope` — findings is `[]`; `abstention` is null. This can **only**
  mean "scanned this recorded scope and found nothing" — `scan_scope.paths` and `.lenses` are
  both non-empty by schema (`minItems: 1`), so a record cannot claim `none_observed` while
  secretly having scanned nothing. There is no fourth state for "didn't look" masquerading as
  "looked and it was clean."
- `abstained` — findings is `[]`; `abstention: {code, params}` is required. Use this when the
  scan itself could not complete or could not reach a verdict — never silently fold it into
  `none_observed`.

## `assessor.independence`: structured, never scored

`independence` is a `{code, params}` record — the exact shape
`contracts/shared/derive-independence.mjs` already emits (e.g. `{code:
"different_provider", params: {...}}`). It is never a numeric score. `model_cohort` is `null`
exactly for `kind: human | deterministic_tool` and a non-empty string exactly for
`kind: model | hybrid` (schema-enforced both directions) — and it is a cohort label, never an
execution ID or a person's name, the same discipline `agent-metrics/v1` already established.

## Findings: one verifiable claim each, no confidence

Each finding's `category` and `severity` are closed sets (9 × 4 — see the schema for the
literal enums); `claim` is a single verifiable statement, never a bundle of unrelated
observations. `locations[].start_line`/`.end_line` are `≥1` integers **or** `null` —
null-not-zero: a genuinely unknown line is `null`, never `0`. `evidence_gate` names what would
have to hold for this finding to be *promoted* to evidence (`oracle_kind`, `oracle_ref`, a
`{code, params}` `predicate`, and `required_verdict: "proven"` — always `"proven"`, because a
finding can never self-declare that it has already been proven).

**No numeric confidence field exists anywhere in this schema**, and none may be smuggled into
the two intentionally-open `{code, params}` bags (`assessor.independence.params`,
`findings[].evidence_gate.predicate.params`) either — `verify-fixtures.mjs` scans both for a
`confidence` key with a numeric value and rejects it, since `additionalProperties: false`
cannot reach inside an open bag by design.

## Append-only correction

`supersedes_record_id` names the record this one corrects, if any. Superseding never edits or
deletes the prior record — the old record remains exactly as it was recorded, correct for the
subject digest it named.

## Relationship to `promotion-receipt/v0`

A `review-findings/v1` record has no opinion about promotion. `promotion-receipt/v0`'s
`review_admissibility` predicate is the only place a record's findings become inputs to a
promotion decision, and even there, admissibility is evaluated deterministically against
recorded scope and outcome — never by re-running or re-scoring the review.

## What v1 deliberately leaves out

- **No cross-record referential integrity within this contract's own fixtures.** Whether a
  `record_id` named elsewhere (a `supersedes_record_id`, or a `promotion-receipt`'s
  `evidence_refs[].ref`) resolves to a real record is checked only where that OTHER contract's
  own verifier has the full picture — `release-approval/v0`'s composite fixture, for the
  `promotion-receipt` case.
- **No finding→evidence promotion mechanism.** `evidence_gate` names the required verdict; the
  actual oracle call and the accept/reject decision belong to the consuming contract or tool,
  not to this record.
- **No auto-fix loop.** This contract records what a review observed once. Milestone I
  (auto-fix) is a separate, gated, not-yet-implemented mechanism per the source plan.

## Verification

`node contracts/review-findings/v1/verify-fixtures.mjs` checks every fixture against
`review-findings.schema.json` plus: `finding_id` uniqueness within one record (a single-record
schema cannot see its own siblings), the numeric-confidence scan described above, and the
personal-dimension scan (`contracts/shared/personal-dimensions.mjs`). See the fixtures
directory's `expected-results.json` for the declared outcome of each fixture.
