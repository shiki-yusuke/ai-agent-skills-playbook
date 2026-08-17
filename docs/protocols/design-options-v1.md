# design-options/v1

Normative protocol for a **design-options document**: the frozen set of options placed in front
of a decision maker, together with the independent critic passes that reviewed them and the
explicit question(s) being asked. This is the platform design's D10 "intent-to-design" artifact
chain -- `design/options-draft.yaml` -> `design/critic.yaml` -> `design/options-final.yaml` --
consolidated into **one** artifact type for v1, and grounded in the one real I-shadow case this
repo has recorded, `i-shadow-record-01-living-twin-2026-08-17.md` (an external, private working
document -- not vendored in this repo; see "Provenance" under Verification below for how its
findings are cited without copying it in).

Conformance fixtures live in
[`contracts/design-options/v1/`](../../contracts/design-options/v1/); see the Verification
section below.

## Purpose

A design-options document answers: *what options were actually considered, who independently
reviewed them, and what question is being asked of the decision maker?* It exists **before** a
decision (see [`decision/v1`](decision-v1.md)) is made -- a `decision/v1` record's
`options_ref`/`critic_ref` point back at one of these documents.

**v1 guarantees:**

- Every option carries a full counterfactual freeze: `key_assumptions`, `falsifiers`,
  `observable_proxies`, `predicted_outcomes`, and `rollback_strategy`, all required. The last two
  are required specifically because the recorded real case shows they are the two fields that do
  **not** get written naturally without being enforced (`i-shadow-record-01` section 3, "finding
  2") -- `falsifiers`/`key_assumptions`/`observable_proxies` were written unprompted in the real
  case, so requiring them costs nothing; `predicted_outcomes`/`rollback_strategy` were not, so
  requiring them is where this schema actually changes behavior.
- At least one independent critic pass is recorded (`critic_reviews`, minItems 1), each carrying
  a closed `independence_status` enum that cannot be summed naively into an "independence count"
  (see below).
- A non-empty `decision_request` -- the gate this contract exists to enforce
  (`i-shadow-record-01` section 2(b)): a document cannot claim to be ready for a decision while
  leaving `open_questions`/`option_ids`/`what_would_change_the_answer` empty.
- `decision_request.option_ids` referential integrity: every id there MUST resolve to an
  `options[].option_id` in the same document (semantic check, `verify-fixtures.mjs`).
- `options[].option_id` uniqueness within one document (semantic check, `verify-fixtures.mjs`).
- The personal-dimension denylist (`contracts/shared/personal-dimensions.mjs`), same as every
  other contract in this repo.

**v1 explicitly does NOT guarantee:**

- That every `options[]` entry is covered by `decision_request.option_ids`. A later option can be
  added to `options[]` after the original question was framed (the recorded case's own
  decision-03-to-decision-04 supersession did exactly this -- see "Versioning and re-asking"
  below) without that later option retroactively appearing in the original `decision_request`.
- That `critic_reviews[].target_option_ids` covers every option. A critic pass that only had time
  for the two contested options is still a real, recordable review of those two.
- Cross-contract referential integrity. This contract's own `verify-fixtures.mjs` validates only
  within its own fixtures directory; it does not, and cannot, check that some `decision/v1`
  record's `options_ref` actually resolves to a real design-options/v1 document elsewhere. See
  "Relationship to decision/v1" below.
- That `intent_ref` is digest-pinned. See "The intent_ref content_digest gap" below.

## Format

Schema: [`contracts/design-options/v1/design-options.schema.json`](../../contracts/design-options/v1/design-options.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `schema_version` | yes | Literal `"design-options/v1"`. |
| `design_options_id` | yes | Stable identifier for this document (e.g. `"living-twin-discovery-scope-2026-08-17"`). |
| `intent_ref` | yes | `$defs/artifact_ref`: `{logical_id, uri?, source_repo?, content_digest?, digest_omitted_reason?}` -- what intent these options serve. `uri` is required whenever `content_digest` is present; `source_repo` names the external repo `uri` is relative to when it isn't this one (this directory's own living-twin-sourced accept fixtures set it to `"living-twin"`). See "The intent_ref content_digest gap" below for why `content_digest` itself is optional here specifically, and decision/v1's own "`artifact_ref` vs `decision_ref`" section for why this is `artifact_ref` (an external-document reference) rather than the ledger-internal `decision_ref` decision/v1 also declares (this schema has no ledger-internal reference of its own, but keeps an identical `$defs` shape to decision/v1 for consistency). |
| `options[]` | yes, minItems 1 | Each: `option_id`, `summary`, `key_assumptions[]`, `falsifiers[]`, `observable_proxies[]`, `predicted_outcomes[]`, `rollback_strategy` -- all required, all non-empty. |
| `critic_reviews[]` | yes, minItems 1 | Each: `independence_status` (closed enum, see below), `critic_engine`, `reviewed_at`, `target_option_ids[]`, optional `notes_ref` (also `$defs/artifact_ref`). |
| `decision_request` | yes | `open_questions[]`, `option_ids[]`, `what_would_change_the_answer[]` -- all non-empty. |

### The `independence_status` enum and why review counts cannot be summed

`independence_status` is one of `different_lineage | same_lineage_different_order |
same_lineage_different_session | same_session | human_third_party`. This closes D10's own
free-form `same_generation` note into an enum, per
`i-shadow-record-01` section 2(d) -- the real case's central finding on this point, in the
reviewing engine's own words: *"手続的な盲検性はあるが epistemic な独立性はない。同じ sol を二巡
させ読む順序だけ変えても、訓練由来の盲点・検索傾向・推論癖は強く相関する。独立した追試が二件ある
とは数えない"* (procedural blindness exists, but not epistemic independence; running the same
engine twice with only reading order changed still correlates strongly through shared training
blind spots, search tendencies, and reasoning habits -- this does not count as two independent
replications). **Reviews at `same_lineage_different_order`, `same_lineage_different_session`, or
`same_session` MUST NOT be counted as additional independent verification passes, no matter how
many exist.** `same_lineage_different_session` was added after this contract's own
`accept-living-twin-pivot-options.json` fixture was found mislabeling exactly this case as
`same_session`: its second review is a genuinely separate session's blind re-analysis (K1/K2/K3),
not a self-critique inside the generating session itself -- same engine lineage, but not the same
session, and not merely a reordering of the same session's own review. The distinction does not
change which reviews count (both values are still excluded from the independence count), only
whether the label accurately describes what actually happened. A consumer (including any future
dashboard) that sums `critic_reviews.length` as an "independence count" without first filtering
to `different_lineage`/`human_third_party` is misusing this field. The recorded case's own
`accept-living-twin-discovery-thresholds-options.json` fixture demonstrates why this
distinction has teeth: the one `different_lineage` pass (terra, deriving thresholds independently
without seeing sol's numbers) found a systematic divergence from two rounds of `same_lineage_
different_order` review (sol) that never caught it.

### The `intent_ref` `content_digest` gap

Every other digest-bearing ref in this repo's contracts (`trace/v1`'s `from_ref`/`to_ref`,
`release-observation/v0`'s `artifact_digest`) treats "no digest" as something a producer must
actively state is impossible (null-not-zero), or as a fact that never legitimately happens.
`intent_ref` is different: the one real case's own intent was a prose brief the user wrote outside
any versioned file at all (`i-shadow-record-01` section 1: *"lane の intent.yaml ではなく散文。
digest 参照が不可能な形"*). There was no file to hash. `content_digest` is therefore genuinely
OPTIONAL on this one ref (not required-nullable) -- but `logical_id` is still required, so a
producer must always name what the intent was, even when it cannot be pinned to a revision.

## Verification

Fixtures: [`contracts/design-options/v1/fixtures/`](../../contracts/design-options/v1/fixtures/),
verified by
[`contracts/design-options/v1/verify-fixtures.mjs`](../../contracts/design-options/v1/verify-fixtures.mjs)
(`node verify-fixtures.mjs`, no install step, no network access).

Three accept fixtures, all drawn from the one real I-shadow case
(`i-shadow-record-01-living-twin-2026-08-17.md` and the living-twin repo's own decision documents
-- an external, private working repo; not vendored here, cited for provenance only):

1. `accept-living-twin-pivot-options` -- the Pivot/Discovery-GO decision's four options.
2. `accept-living-twin-discovery-scope-options` -- the Discovery-scope decision's options A/B/C/D.
3. `accept-living-twin-discovery-thresholds-options` -- the sol-vs-terra threshold cross-check.

Every option's `key_assumptions`/`falsifiers`/`observable_proxies`/`predicted_outcomes`/
`rollback_strategy` is a paraphrase of that real source text, not invented content; see each
fixture's own entry in `fixtures/expected-results.json` for exactly which source passage it
traces to. Six reject fixtures exercise: the personal-dimension scan (all 11 forbidden keys),
a missing `decision_request` (structural), a missing `predicted_outcomes` on one option
(structural -- the specific field this contract enforces per "finding 2" above), a missing
`rollback_strategy` on one option (structural, the other half of "finding 2"), a
`decision_request.option_ids` entry that resolves to no option in the document (semantic,
dangling-reference), and an `independence_status` value outside the closed five-value enum
(structural).

`verify-fixtures.mjs` also runs every `intent_ref`/`notes_ref` (`$defs/artifact_ref`) through
`contracts/shared/verify-artifact-digests.mjs` (see decision/v1's own "`artifact_ref` vs
`decision_ref`" section for the incident this closes): a `content_digest` whose `uri` resolves to
a real file inside this repo (and carries no `source_repo`) is verified byte-for-byte; the two
living-twin-sourced `intent_ref`s in this directory's own accept fixtures carry `uri` +
`source_repo: "living-twin"` and are therefore reported `unverifiable` every run -- CI cannot
resolve a path into an external, unvendored repo -- printed in full, not silently accepted.

## Relationship to decision/v1

A [`decision/v1`](decision-v1.md) record's `options_ref` and `critic_ref` both point at a
design-options/v1 document -- and, per this repo's v1 consolidation, MAY legitimately point at
the **same** document (its `critic_reviews[]` field already carries what D10's separate
`critic.yaml` would have). This contract does not itself validate that a `decision/v1` record's
`options_ref`/`selected_option_id` actually resolve into a real design-options/v1 document; that
cross-contract check is out of scope for both contracts' `verify-fixtures.mjs` scripts, which each
validate only within their own fixtures directory (the same scoping every other pair of contracts
in this repo uses -- e.g. `attribution/v1` does not validate against `trace/v1`'s actual ledger).

## Versioning and re-asking

A design-options/v1 document is not required to be re-issued from scratch every time a new option
is added to its `options[]` array. The recorded case's own decision-03-to-decision-04
supersession added a genuinely new option (`option_d_two_stage_wave`) to what had been a
three-option (A/B/C) document, without a fresh `decision_request` round -- `decision_request.
option_ids` in that fixture intentionally still lists only A/B/C, reflecting the question as it
was actually framed at the time, not retrofitted to cover every option that ever ends up in the
document. This is a documented real-process gap (`i-shadow-record-01` section 2(a): "後の決定が
前を上書きした"), not a modeling error this schema tries to paper over.

design-options/v1 itself is not yet frozen. A future v2 MAY split `critic_reviews[]` back into a
separate artifact type if a case is observed where a critic pass genuinely needs its own
independent freeze point (e.g. committed before the option author can see it) -- v1's
consolidation is a decision made from the one case available, not a claim that consolidation is
permanently correct.

## Rejected designs

- **Keeping D10's three-file split (`options-draft.yaml` / `critic.yaml` / `options-final.yaml`)
  as three separate contracts.** Rejected for v1: the one real case never produced three separate
  frozen files, and inventing the split points where none existed in the actual data would be
  fabricating structure this task's own fixture-sourcing rule ("推測・合成で埋めない") forbids.
- **A free-form string for `independence_status`** (D10's original `same_generation` note).
  Rejected once the real case showed a free-form field cannot prevent double-counting two
  same-lineage passes as independent verification -- see the enum discussion above.
- **Requiring `intent_ref.content_digest`.** Rejected once the real case showed a genuine
  prose-brief-with-no-file scenario that a required digest would either fabricate (hashing
  something that was never the actual intent artifact) or block recording entirely.
