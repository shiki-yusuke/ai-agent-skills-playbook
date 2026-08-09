# estimate/v2

Normative protocol for the cost-estimate honesty schema: a contract-first artifact, shipped
ahead of spec-lane's own estimator implementation (the "D4 estimate 正直さ schema" design
note). A decision about a specific `target` is always either `predicted` (a point estimate
exists) or `abstained` (it does not, with `reason_codes` explaining why) — there is no third
"best guess anyway" state.

This document is the contract for `contracts/estimate/v2/estimate-decision.schema.json`.
Conformance fixtures live in [`contracts/estimate/v2/`](../../contracts/estimate/v2/); see the
Verification section below.

## Purpose

Every cost/effort estimate this platform ever produces carries the same risk: a point number
with no stated confidence quietly gets treated as ground truth by whoever reads it next. This
schema exists to make three things structurally impossible to omit:

- **Silent guessing.** A `predicted` decision always carries a `predicted{p50, p80,
  value_status}` object; an `abstained` decision always carries at least one reason. There is
  no shape representing "a number, but we're not sure how we got it."
- **Self-contradictory decisions.** The tagged union (`decision.status` plus `predicted`,
  plus `applicability.status`) is enforced as an actual state machine — see "Tagged-union
  state machine" below — not just two independently-optional fields that happen to usually
  agree.
- **Silently dropped exclusions.** `population.excluded_by_reason` must always fully account
  for every candidate the population math threw out — see "excluded_by_reason counting rule"
  below.

It does not carry, and is not a substitute for:

- The calibration math itself (leave-one-out error samples, k-NN distance computation, etc.).
  This schema describes the *shape* of a decision's output, not the algorithm that produces
  the numbers inside it.
- A numeric confidence score standing in for a closed status. `applicability.status`,
  `decision.status`, `predicted.value_status`, and `drift.status` are all closed enums — see
  `attribution-v1.md`'s "Rejected designs" for why this platform avoids ad hoc probabilistic
  fields wherever a closed status/enum will do.

## Format

Schema:
[`contracts/estimate/v2/estimate-decision.schema.json`](../../contracts/estimate/v2/estimate-decision.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `schema_version` | yes | Literal `"estimate/v2"`. |
| `target.metric` / `.unit` | yes | What quantity this decision is (or would be) predicting, e.g. `{"metric": "cost_usd", "unit": "usd"}`. Required even when abstained — the decision was abstaining from estimating a specific named target, not estimating in the abstract. |
| `decision.status` | yes | `"predicted"` \| `"abstained"`. |
| `decision.reason_codes[]` | yes | Closed 12-code set, split into 11 BLOCKING codes and 1 ADVISORY code (`DRIFT_WARNING`) — see "Tagged-union state machine." |
| `predicted.p50` / `.p80` / `.value_status` | conditionally | The point estimate: `p50 <= p80` (semantic check), `value_status` is `"estimated"` \| `"lower_bound"`. Required when `decision.status == "predicted"`; **forbidden entirely** when `decision.status == "abstained"` (schema `if`/`then`/`not`). |
| `applicability.status` | yes | `"in_domain"` \| `"out_of_domain"` \| `"unknown"`, plus optional `nearest_distance` / `distance_threshold`. `out_of_domain` is part of the state machine, not informational — see below. |
| `cohort.*` | yes (9 subfields) | Full comparison-population identity (agent_type, model_provider, model_generation, model_id, three sha256-hex digests, measure_contract_version, token_basis) — required in full even when abstained, since several reason_codes (`MODEL_GENERATION_MISMATCH`, `ROUTING_PROFILE_MISMATCH`, `TOKEN_BASIS_MISMATCH`, `TARGET_BASIS_UNSUPPORTED`) are only meaningful if the cohort they mismatched against is on record. |
| `population.candidate_count` / `.eligible_count` | yes | `eligible_count <= candidate_count` (semantic check). |
| `population.excluded_by_reason` | yes | Map of reason_code to excluded count — see "excluded_by_reason counting rule." |
| `prediction_interval.status` | yes | `"available"` \| `"insufficient_data"`. `"available"` FORCES `decision.status == "predicted"` (sol architect-review 3rd round must2 — an available confidence interval is an interval *around* a point estimate, which an abstained decision doesn't have). When `"available"`: `level`/`lower`/`upper`/`method`/`calibration_sample_size` are ALL required together (schema `if`/`then`), `level` is exclusively `(0, 1)`, `calibration_sample_size >= 1` (0 samples is not a calibration, it's the absence of one), and `lower <= upper` (semantic check). When `"insufficient_data"`: none of those five value fields may be present at all (schema `if`/`then`/`else`, a closed sub-schema) — not merely optional. |
| `coverage_history.frozen_predictions_only` | yes | Always `const true` — a prediction, once recorded, is never retroactively rewritten; only new revisions get appended (mirrors `trace-v1.md`'s append-only `supersedes` model). |
| `drift.status` | yes | `"insufficient_data"` \| `"stable"` \| `"warning"`. |

`decision.reason_codes` closed set (BLOCKING unless marked ADVISORY):

```
INSUFFICIENT_POPULATION, INSUFFICIENT_COMPARABLE_NEIGHBORS, DISTANCE_ABOVE_THRESHOLD,
TOKEN_BASIS_MISMATCH, MODEL_GENERATION_MISMATCH, ROUTING_PROFILE_MISMATCH,
PREDICTOR_SCHEMA_MISMATCH, NOVEL_SURFACE_UNKNOWN, OUT_OF_DOMAIN,
MIXED_OR_UNATTRIBUTED_USAGE, TARGET_BASIS_UNSUPPORTED   -- all BLOCKING
DRIFT_WARNING                                            -- ADVISORY
```

## Tagged-union state machine

`decision.status`, `predicted`, `applicability.status`, and `prediction_interval.status` are
not four independently optional fields — together they form a state machine with exactly two
valid states, all schema-enforced (`allOf`/`if`/`then`/`not`, not left to convention):

- **`abstained`**: `predicted` MUST be absent entirely (not merely omittable — its presence is
  actively forbidden). `reason_codes` MUST contain at least one BLOCKING code; `DRIFT_WARNING`
  alone does not justify withholding a point estimate. `prediction_interval.status` MUST NOT
  be `"available"` (sol architect-review 3rd round must2) — the same reason `predicted` is
  forbidden: an available interval has no point estimate to surround.
- **`predicted`**: `predicted{p50, p80, value_status}` MUST be present. `reason_codes` MUST
  NOT contain any BLOCKING code (only the advisory `DRIFT_WARNING` may accompany a
  prediction). `applicability.status` MUST NOT be `"out_of_domain"` — out-of-domain implies
  the decision must abstain; there is no such thing as a confident point estimate for a
  surface the population math says is out of domain. `prediction_interval.status` MAY be
  either value (a predicted decision can still lack enough calibration history for an
  interval).

Both BLOCKING-code directions are checked in `verify-fixtures.mjs` (set-membership arithmetic
this repo's minimal validator subset has no keyword for); the `predicted`-presence,
`out_of_domain`, and `prediction_interval.status=="available"` directions are all
schema-structural (`not` + `required`/`const`).

## `excluded_by_reason` counting rule

**Exclusive primary-reason counting (main裁定):** each excluded candidate is counted under
exactly ONE `reason_code` — the first one, in `reason_codes`' enum-declared order, that
applies to it. A candidate is never counted under two different reasons even if more than one
technically applies to it. Consequently:

```
sum(population.excluded_by_reason values) == population.candidate_count - population.eligible_count
```

always holds exactly (checked in `verify-fixtures.mjs`). An `excluded_by_reason` that sums to
less than the gap is silently dropping candidates with no recorded reason; one that sums to
more is double-counting. Both are rejected. This is why `excluded_by_reason` cannot be treated
as "extra detail, safe to leave empty or partial" — it is the population accounting's only
record of *why* `candidate_count` and `eligible_count` differ at all.

## Verification

Fixtures: [`contracts/estimate/v2/fixtures/`](../../contracts/estimate/v2/fixtures/), verified
by
[`contracts/estimate/v2/verify-fixtures.mjs`](../../contracts/estimate/v2/verify-fixtures.mjs)
(`node verify-fixtures.mjs`, no install step, no network access). `expected-results.json` in
that directory is the machine-readable table of which fixture is expected to be accepted or
rejected (with which reason code).

Beyond the schema-structural tagged-union rules above, semantic MUSTs in `verify-fixtures.mjs`:

1. `decision.status == "abstained"` requires >=1 BLOCKING `reason_code`.
2. `decision.status == "predicted"` forbids any BLOCKING `reason_code`.
3. `predicted.p50 <= predicted.p80`.
4. `prediction_interval.lower <= prediction_interval.upper` (when `status == "available"`).
5. `population.eligible_count <= population.candidate_count`.
6. `population.excluded_by_reason`: every key is one of the 12 `reason_codes`, every value a
   non-negative integer, and the values sum to exactly `candidate_count - eligible_count`
   (the counting rule above).
7. The personal-dimension scan (`contracts/shared/personal-dimensions.mjs`).

**A producer MUST:**

- Never emit `predicted` alongside `decision.status == "abstained"`, and never omit it
  alongside `"predicted"`.
- Never emit a BLOCKING `reason_code` alongside `decision.status == "predicted"`.
- Never emit `applicability.status == "out_of_domain"` alongside `decision.status ==
  "predicted"` — abstain instead.
- Account for every excluded candidate in `excluded_by_reason` under exactly one reason;
  never leave the gap between `candidate_count` and `eligible_count` unexplained.
- Emit `prediction_interval`'s `"available"` shape in full or not at all — no partial value
  fields under `"insufficient_data"`.

**A consumer MUST:**

- Treat `predicted.value_status == "lower_bound"` differently from `"estimated"` — a lower
  bound is not the same claim as a genuine point estimate, and downstream aggregation (e.g. a
  cost rollup) that doesn't distinguish the two silently overstates its own precision.
- Never compute its own confidence number from anything in this schema other than the
  `prediction_interval` block that's actually present — there's no other numeric field this
  schema offers as a stand-in for "how sure."

## Versioning

`estimate/v2` follows the same immutability posture as `trace-v1.md`/`attribution-v1.md`: no
change of any kind is permitted within v2 after freeze — not a new optional field, not a
13th `reason_code`, not a widened enum anywhere. Every object in this schema is
`additionalProperties: false` (with the deliberate, schema-enforced exception of
`prediction_interval` under `status == "insufficient_data"`, which is closed to `status`
alone, not open to future fields), so there is no backward-compatible additive change a strict
reader would even accept. Any addition requires `estimate/v3`. The personal-dimension
denylist's own "MAY extend, MUST NOT shrink" rule
([`agent-metrics-v1.md` section 7](agent-metrics-v1.md#7-trust-model)) is the one designated
exception to this, exactly as in `trace-v1.md`/`attribution-v1.md`.

## Rejected designs

- **A single `confidence: 0.0-1.0` field instead of the closed `predicted.value_status` /
  `applicability.status` / `drift.status` enums.** Same rationale as `attribution-v1.md`'s
  rejection of a numeric confidence score: a closed enum forces a producer to resolve
  ambiguity into one of a named set of states; a bare float lets every consumer invent its own
  threshold semantics for the same number.
- **Letting `predicted` and `decision.status == "abstained"` coexist "just in case a partial
  estimate is still useful."** Considered and rejected: a point estimate that exists alongside
  an admission that no reliable prediction could be made is not a partial estimate, it's two
  contradictory claims in one record. If a genuinely partial/degraded estimate is ever needed,
  it is a new `value_status` value (a v3 change), not a way to smuggle a number past an
  abstain.
- **Silently treating an empty `excluded_by_reason` as "no exclusions happened."** An empty
  map is only valid when `candidate_count == eligible_count`; when there's a gap, an empty map
  is exactly as dishonest as a `null` field would be for a genuinely unmeasured quantity
  elsewhere in this platform's contracts (see `attribution-v1.md`'s null-not-zero rule) — it
  makes "we don't know why 4 candidates were excluded" indistinguishable from "nothing was
  excluded."
- **Apportioning one excluded candidate's count across multiple applicable reasons (weighted
  or otherwise).** Rejected in favor of exclusive primary-reason counting: an excluded
  candidate might technically match more than one reason_code, but recording a fractional
  count under each would make `sum(excluded_by_reason values)` an approximation instead of an
  exact reconciliation against `candidate_count - eligible_count` — the whole point of the
  counting rule is that the sum is always exact, never approximately right.
