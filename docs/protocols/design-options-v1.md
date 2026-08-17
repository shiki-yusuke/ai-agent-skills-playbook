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
section below. Breaking-but-in-place revisions to this already-published v1 contract are recorded
in [`contracts/design-options/v1/CHANGELOG.md`](../../contracts/design-options/v1/CHANGELOG.md) --
see that file for the 2026-08-18 `independence_status` derivation revision this document already
describes below.

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
- At least one critic pass is recorded (`critic_reviews`, minItems 1, `artifact_shapers` minItems
  1). Whether any given pass actually counts as INDEPENDENT verification is a DERIVED value (see
  "The three independence dimensions" below) -- `critic_reviews.length` is never itself an
  independence count, and this contract's own real recorded case has zero qualifying reviews
  among six recorded ones (see below).
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
| `artifact_shapers[]` | yes, minItems 1 | Every participant (model or human) who helped form `options[]`. Each: `engine_ref` (`$defs/engine_ref`), `how` (`authored \| reviewed_brief \| reviewed_predecessor_options \| other`), `how_note` (required iff `how` is `other`). See "The three independence dimensions" below. |
| `critic_reviews[]` | yes, minItems 1 | Each: `critic` (`$defs/engine_ref`), `prior_involvement` (closed enum, see below), `observation_scope_ref` (required iff `prior_involvement` is `none_observed_in_recorded_scope`), `review_output_ref` (`$defs/artifact_ref`, required), `reviewed_at`, `target_option_ids[]`, optional `notes_ref`. `independence_status` is NOT a field here -- it is derived, see below. |
| `decision_request` | yes | `open_questions[]`, `option_ids[]`, `what_would_change_the_answer[]` -- all non-empty. |

### `$defs/engine_ref`

Identifies one participant, model or human: `{kind: "model", provider, family, model_id,
session_ref?}` or `{kind: "human", human_ref, is_decision_maker}`, plus an optional
`unknown_fields[]` naming any of that kind's own required fields that could not be determined.
Schema-level `required` covers only `kind` -- the per-kind fields are enforced by
`verify-fixtures.mjs`'s own semantic check (`contracts/shared/derive-independence.mjs`'s
`engineRefIssues`): a field must be present OR named in `unknown_fields`, never simply absent. A
field left unknown makes every derivation comparison that would need it resolve to `unknown`
rather than guess.

### The three independence dimensions (2026-08-18 revision)

D10's own `independence_status` field started as a single free-form `same_generation` note, then
became a closed 5-value enum (per `i-shadow-record-01` section 2(d)), then was found on
2026-08-18 to be **internally inconsistent in its own real fixture**:
`accept-living-twin-discovery-scope-options.json` labeled `gpt-5.6-terra`'s review
`different_lineage` and `gpt-5.6-sol`'s review `same_lineage_different_order` -- but terra and sol
share the same provider (openai) and model family (gpt-5.6), so those two labels cannot both be
true against one single reference point. They were measured against two different, unstated
reference points, and a third question the enum had no word for at all was hiding inside the
`sol` label: **prior involvement** -- sol had already adversarially reviewed the very brief that
shaped these options, so its later "review" of them is not independent verification no matter
what lineage label is attached.

This contract now recognizes three orthogonal dimensions instead of one field:

- **(A) Lineage distance** from whoever shaped the artifact being reviewed. DERIVED (never
  producer-asserted) from `artifact_shapers[]` + a review's own `critic`, by
  `contracts/shared/derive-independence.mjs`.
- **(B) Redundancy between critics reviewing the same document.** Not modeled by this contract --
  an explicitly open gap, not solved here (see design-options/v1's own CHANGELOG.md "Not solved by
  this revision").
- **(C) Prior involvement** -- whether THIS critic already had a hand in shaping the very options
  it is now reviewing. Producer-declared, via `prior_involvement`, but gated: see below.

#### (A) Lineage distance: the derivation table

For a critic that is `kind: model`, `deriveIndependenceStatus` (`contracts/shared/
derive-independence.mjs`) compares it against **every** entry in `artifact_shapers[]` and takes
the CLOSEST (least independent) relationship found, in this order:

| Relationship (closest to farthest) | Condition |
|---|---|
| `same_session` | Same `model_id`; same `session_ref`, or `session_ref` recorded on NEITHER side (no evidence distinguishes them, so the closest possibility is assumed) |
| `same_lineage_different_session` | Same `model_id`, different `session_ref` -- OR `session_ref` recorded on only ONE side (a recorded value is never assumed to coincidentally equal an unrecorded one) |
| `same_family_different_model` | Same `provider` + `family`, different `model_id` |
| `same_provider_different_family` | Same `provider`, different `family` |
| `different_lineage` | Different `provider` (or shaper/critic kinds differ -- a human and a model share no engine lineage by construction) |

**`unknown` (2026-08-18 refinement) means "qualifying cannot be ruled out", not "a field happens to
be missing".** `provider` is the one field whose unresolved value could still hide the qualifying
outcome (`different_lineage`), so an unknown `provider` genuinely yields `unknown`. Once `provider`
is confirmed EQUAL, `different_lineage` is impossible regardless of `family`/`model_id`/
`session_ref` -- every relationship reachable from there is already non-qualifying, so an unknown
value at any of those fields is SKIPPED (treated as "possibly equal, keep narrowing") rather than
blocking the derivation; the comparison finds the closest relationship still consistent with what
is confirmed. This was found wrong in the real recorded case before this fix: a critic whose
`family` matched a shaper's but whose exact `model_id` was never recorded derived to `unknown`
under the original (overly conservative) rule, when the correct answer -- `same_lineage_
different_session` -- was already knowable to be non-qualifying regardless of the missing
`model_id`. If ANY shaper comparison is still `unknown` after this narrowing (i.e. some shaper's
`provider` is itself unresolved), the overall result for that critic is `unknown` -- the true
closest relationship across all shapers cannot be shown to be no closer than what is already
known.

Two critic-level short-circuits apply before any shaper comparison, for `kind: human` critics:
`is_decision_maker: false` -> `human_third_party` (independent of `artifact_shapers[]`);
`is_decision_maker: true` -> **`unknown`, by an explicit choice this revision does not resolve
further** -- see "Open questions" below.

`same_lineage_different_order` (the old enum's fourth value) is **deprecated**: recognized in
prose/history, never derived.

#### (C) Prior involvement: `shaped_options | reviewed_predecessor | none_observed_in_recorded_scope | unknown`

`shaped_options` = this same engine_ref also appears in `artifact_shapers[]`.
`reviewed_predecessor` = reviewed an earlier/related round without itself shaping the final
options. `none_observed_in_recorded_scope` = no prior involvement found within a stated,
checkable scope (`observation_scope_ref`, required together with this value) -- **not** a claim
of universal non-involvement. A bare `none` is deliberately absent from the enum: positive
involvement can be evidenced, its universal absence cannot (the architect ruling that shaped this
revision was explicit on this point). `unknown` is the honest default whenever this has not
actually been checked -- the field is required precisely so "not checked" cannot collapse into
silence.

#### The qualifying gate is a conjunction

A review counts as independent verification ("qualifying") only if **both**:

1. its derived lineage status is `different_lineage` or `human_third_party`, **and**
2. its `prior_involvement` is `none_observed_in_recorded_scope`.

`unknown` on either dimension is never qualifying. `contracts/shared/
derive-independence.mjs`'s `evaluateCriticReview` returns `{derived_status, qualifying, reasons}`
-- `reasons` always explains which dimension(s) passed or failed, never just the boolean.
**`critic_reviews.length` is not an independence count and MUST NOT be reported as one** -- see
the next section for why the real recorded case makes this concrete rather than hypothetical.

#### The real case has zero qualifying reviews

Re-deriving all three real living-twin fixtures under this model
(`node contracts/shared/derive-independence.mjs contracts/design-options/v1/fixtures/accept-living-twin-*.json`)
finds **zero of the six recorded `critic_reviews` qualify**: every review is either `same_session`
(vs. itself as a shaper) with `prior_involvement: shaped_options`, `same_family_different_model`
(terra vs. the sol shaper) with `prior_involvement: none_observed_in_recorded_scope` -- clearing
the involvement dimension but not the lineage one -- or `same_lineage_different_session` (the
Claude session that ran two more rounds of sol as a blind-reanalysis tool, per decision-01 D-4,
vs. the Claude authoring shaper) with `prior_involvement: none_observed_in_recorded_scope`, backed
by `review-criteria-preregistered-2026-08-17.md`'s own record that this reviewing session read
results only after freezing its judgment criteria. `accept-zero-qualifying-reviews.json`
(byte-identical to `accept-living-twin-discovery-scope-options.json`) exists specifically so this
is a named, separately-checkable fixture. This is a correction to the previously-asserted labels,
not a new fact about what actually happened -- see design-options/v1's own CHANGELOG.md for the
full account (including a same-day correction pass that fixed an engine_ref misattribution: this
reviewing session is a Claude session, not a human, and the actual decision maker throughout is
the user) and for why this was revised in place rather than deferred to a v2 (including the stated
limit that a GitHub code-search check for external usages returned HTTP 503 and could not be
completed -- "zero external users of the old field" is an inference from fork count and elapsed
time, not a proof).

### Open questions (flagged, not resolved, by this revision)

- **A human critic who is also the decision maker** (`critic.kind: "human"`,
  `is_decision_maker: true`) derives to `unknown` rather than any more specific value -- the
  architect-specified derivation table does not cover this case, and this revision chose not to
  guess rather than invent an unreviewed sixth category. No real fixture in this repo instantiates
  this case (the pivot/thresholds documents' second critic was originally, incorrectly, typed this
  way -- see CHANGELOG.md's correction pass); `accept-derivation-unknown-human-decision-maker.json`
  is a dedicated synthetic fixture covering it.
- `same_provider_different_family` **is required, not merely added for symmetry** -- the architect
  ruling explicitly named it (alongside missing IDs, human generators, and multiple generators) as
  a case the derivation table must cover. No real fixture in this repo produces it;
  `accept-derivation-same_provider_different_family.json` is a dedicated synthetic fixture.

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

Three real accept fixtures, all drawn from the one real I-shadow case
(`i-shadow-record-01-living-twin-2026-08-17.md` and the living-twin repo's own decision documents
-- an external, private working repo; not vendored here, cited for provenance only), plus three
synthetic accept fixtures and twelve reject fixtures:

1. `accept-living-twin-pivot-options` -- the Pivot/Discovery-GO decision's four options.
2. `accept-living-twin-discovery-scope-options` -- the Discovery-scope decision's options A/B/C/D.
3. `accept-living-twin-discovery-thresholds-options` -- the sol-vs-terra threshold cross-check.
4. `accept-zero-qualifying-reviews` -- byte-identical to (2), added 2026-08-18 as its own named
   fixture so the zero-qualifying-reviews outcome is separately checkable by id.
5. `accept-self-referential-digest` -- synthetic; proves `verify-artifact-digests.mjs` can verify
   an in-repo ref byte-for-byte, since every living-twin-sourced ref above is `unverifiable` by
   design (CI cannot reach an external, unvendored repo).
6. `accept-unknown-not-qualifying` -- synthetic, added 2026-08-18; proves a legitimately-declared
   `unknown_fields` entry derives `independence_status: unknown` (never qualifying) rather than
   being guessed.

Every option's `key_assumptions`/`falsifiers`/`observable_proxies`/`predicted_outcomes`/
`rollback_strategy` on the three real fixtures is a paraphrase of that real source text, not
invented content; see each fixture's own entry in `fixtures/expected-results.json` for exactly
which source passage it traces to. Twelve reject fixtures exercise: the personal-dimension scan
(all 11 forbidden keys), a missing `decision_request` (structural), a missing `predicted_outcomes`
on one option (structural -- the specific field this contract enforces per "finding 2" above), a
missing `rollback_strategy` on one option (structural, the other half of "finding 2"), a
`decision_request.option_ids` entry that resolves to no option in the document (semantic,
dangling-reference), and -- added 2026-08-18 -- a bare `prior_involvement: "none"` (structural, not
in the enum), `none_observed_in_recorded_scope` without `observation_scope_ref` (structural,
schema `allOf`), a missing `review_output_ref` (structural), an empty `artifact_shapers[]`
(structural, `minItems`), a producer writing the old `independence_status` field directly
(structural, `additionalProperties: false`), and an `engine_ref` missing a per-kind required field
with no `unknown_fields` declaration (semantic, `engineRefIssues`).

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
- **A producer-asserted `independence_status` enum, even closed.** Superseded 2026-08-18: the
  closed enum still let a producer assert a lineage label without recording what it was measured
  against, and this contract's own real fixture shipped with two such labels that were
  individually plausible but jointly inconsistent (see "The three independence dimensions" above
  and CHANGELOG.md). `independence_status` is now derived, never stored.
- **A single `generator` field instead of `artifact_shapers[]`.** Rejected 2026-08-18: the real
  case had multiple participants (an authoring session and a model that adversarially reshaped the
  brief) whose content a later critic must be compared against, and a later critic's lineage
  distance is measured against the CLOSEST of all of them -- a single assumed author cannot
  represent that.
- **Requiring `intent_ref.content_digest`.** Rejected once the real case showed a genuine
  prose-brief-with-no-file scenario that a required digest would either fabricate (hashing
  something that was never the actual intent artifact) or block recording entirely.
