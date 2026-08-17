# design-options/v1 CHANGELOG

This is the first CHANGELOG.md in this repo (no other contract has needed one yet). It exists
because the entry below is a **breaking, in-place revision of an already-published contract** --
see "Why revised in place rather than as v2" below for the judgment call that required.

## 2026-08-18: `independence_status` becomes a derived value; three fields split out of it

### What changed

- **Removed** `criticReview.independence_status` (the closed 5-value enum) and
  `criticReview.critic_engine` (the free-form reviewer string).
- **Added**, top-level on the document (not per-review): `artifact_shapers[]` -- every
  participant (model or human) who helped form the option set, each an `engine_ref`
  (`{kind: model|human, provider/family/model_id or human_ref/is_decision_maker, session_ref?,
  unknown_fields?}`) plus `how` (`authored | reviewed_brief | reviewed_predecessor_options |
  other`).
- **Added**, per criticReview: `critic` (same `engine_ref` shape, replacing `critic_engine`),
  `prior_involvement` (`shaped_options | reviewed_predecessor | none_observed_in_recorded_scope |
  unknown`), `observation_scope_ref` (required exactly when `prior_involvement` is
  `none_observed_in_recorded_scope`), and `review_output_ref` (required -- see below).
- `independence_status` is now **derived**, not stored: `contracts/shared/derive-independence.mjs`
  computes it from `artifact_shapers[]` + a review's own `critic`, and combines it with
  `prior_involvement` via a conjunctive gate into a `qualifying` boolean. Nothing in this schema
  persists `independence_status` any more; a producer that writes it is rejected
  (`additionalProperties: false` on `criticReview`, see
  `invalid-independence-status-in-producer-input.json`).
- `same_lineage_different_order` is **deprecated**: kept in
  `contracts/shared/derive-independence.mjs`'s `DEPRECATED_STATUS_VALUES` for read-compatibility
  with any prose that still names it, but the derivation never emits it -- the distinction it
  tried to draw ("same engine, only reading order changed") is not observable from `engine_ref` +
  `session_ref` comparison, and guessing it would repeat the exact mistake this revision fixes.
- Two new derived values not in the old enum: `same_family_different_model` (same provider+family,
  different `model_id`) and `same_provider_different_family` (same provider, different family).
  `unknown` is also new, and is the honest result whenever a needed `engine_ref` field is missing
  (and declared as such via `unknown_fields`) rather than a value being guessed.

### Why: the defect this closes

The field's own real fixture (`accept-living-twin-discovery-scope-options.json`, drawn from the
one real I-shadow case this repo has recorded) shipped with two `independence_status` values that
were **individually plausible but jointly inconsistent**: `gpt-5.6-terra`'s review was labeled
`different_lineage` and `gpt-5.6-sol`'s was labeled `same_lineage_different_order` -- but terra and
sol are the same provider and the same model family (`gpt-5.6`), differing only in variant. Under
the schema's own definition of `different_lineage` ("a genuinely separate model family/provider"),
the two labels cannot both be true measured against one single reference point.

They weren't measured against one reference point. `sol`'s label was implicitly measured against
"has sol itself been used before on this material" (it had -- sol had adversarially reviewed the
same brief that shaped these very options), while `terra`'s label was implicitly measured against
"is terra a different lineage from sol." One field was being asked to answer two different
questions, plus a third the enum had no word for at all: whether a critic had **prior
involvement** in shaping the very options it is now reviewing (`prior_involvement` below). sol's
review of options it had already helped shape is not independent verification no matter what
lineage label is attached to it -- and the old schema had no field capable of recording that fact
separately from lineage distance.

**Root cause: one field was conflating three orthogonal questions** -- (A) lineage distance from
whoever shaped the artifact, (B) redundancy between critics reviewing the same document (still not
modeled here -- see "Not solved by this revision" below), and (C) prior involvement. This revision
splits (A) out into a mechanical derivation and (C) into its own producer-declared-but-gated field;
(B) remains open.

### `prior_involvement` cannot be asserted as an absolute `none`

The architect ruling that shaped this revision (gpt-5.6-sol, 2026-08-18) was explicit on this
point: a producer may assert **positive** involvement (`shaped_options`, `reviewed_predecessor`)
because that can be evidenced, but may never assert a bare `none` -- universal non-involvement
cannot be proven, only "no involvement was observed within a stated, checkable scope"
(`none_observed_in_recorded_scope`, paired with a required `observation_scope_ref` naming what was
actually examined). The default, when this has genuinely not been checked, is `unknown` -- the
schema has no default value for this field precisely so a producer is forced to write `unknown`
rather than have silence stand in for it.

### `review_output_ref` becomes required

The predecessor field `notes_ref` was optional, which let a schema-valid `criticReview` exist with
a `reviewed_at` timestamp and a `target_option_ids` list but nothing citable backing it at all.
`review_output_ref` is now required on every review. When no raw output file was ever preserved
for a specific review, this MUST still be present using `digest_omitted_reason` to say so honestly
(see `accept-living-twin-pivot-options.json`'s second review, and
`accept-living-twin-discovery-thresholds-options.json`'s second review, for two real cases where
this happened) -- pointing it at an unrelated file that happens to exist would be a fabricated
reference, not an honest gap, and this revision's own fixture-migration work found and rejected
exactly that temptation twice.

### The real case, re-evaluated, has zero qualifying reviews

Re-deriving `independence_status` for all three real living-twin fixtures under the new model
(`node contracts/shared/derive-independence.mjs contracts/design-options/v1/fixtures/accept-living-twin-*.json`)
finds **zero of the six recorded critic_reviews qualify as independent verification**:

| Document | Critic | Derived status | prior_involvement | Qualifying |
|---|---|---|---|---|
| pivot-options | gpt-5.6-sol | `same_session` (vs. itself as a shaper) | `shaped_options` | No |
| pivot-options | independent-review-session (human, is_decision_maker=true) | `unknown` | `unknown` | No |
| discovery-scope-options | gpt-5.6-terra | `same_family_different_model` (vs. sol shaper) | `none_observed_in_recorded_scope` | No |
| discovery-scope-options | gpt-5.6-sol | `same_session` (vs. itself as a shaper) | `shaped_options` | No |
| discovery-thresholds-options | gpt-5.6-terra | `same_session` (vs. itself as a shaper) | `shaped_options` | No |
| discovery-thresholds-options | independent-review-session (human, is_decision_maker=true) | `unknown` | `unknown` | No |

This is a **correction to the previously-asserted labels**, not a new fact about the underlying
real events -- the events (sol reviewing material it helped shape; terra being the same provider
and family as sol; a human decision-maker channel compiling a cross-check) were always true. What
changed is that the old schema let those events be mislabeled as more independent than they were.
`accept-zero-qualifying-reviews.json` (byte-identical to
`accept-living-twin-discovery-scope-options.json`) exists specifically so this outcome is a named,
separately-checkable fixture rather than something a reader has to already know to look for.

### Downstream effect on `decision/v1`

`decision/v1`'s own schema does not reference `independence_status` at all (confirmed by
`grep -rl "independence_status" contracts/decision/`, zero hits before this revision) -- no schema
or fixture change was needed there for the field removal itself. However, editing the three real
`design-options/v1` fixtures' byte content changed their sha256, and four `decision/v1` fixtures
hold a `content_digest` pinned to those exact bytes (`accept-living-twin-decision-01-pivot.json`,
`-02-thresholds.json`, `-03-discovery-scope.json`, `-04-two-stage-discovery.json`, plus three
`invalid-*` fixtures that reuse the same real digest value as a stand-in for "some real-looking
digest" in an unrelated test). All were recomputed and updated in the same change -- this was not
called out in advance by the task that produced this revision, but `contracts/shared/
verify-artifact-digests.mjs` verifies these byte-for-byte for any in-repo `uri`, so leaving them
stale would have made `decision/v1`'s own `verify-fixtures.mjs` fail.

### Why revised in place rather than as v2

`design_options.schema.json`'s `schema_version` const (`"design-options/v1"`) was not bumped.
Grounds for revising v1 in place, recorded here per this repo's own norm of writing down why a
compatibility-breaking judgment call was made:

- The contract carrying `independence_status` was published only hours before this defect was
  found and fixed (both on 2026-08-18).
- This repo had 0 forks and 1 star at the time of this change.
- Every reference to `design-options` inside this repo is self-contained
  (`grep -rl "design-options" .` matches only this repo's own contracts/docs/fixtures).
- **Limitation, stated rather than hidden**: a GitHub code-search check for external usages
  outside this repo returned HTTP 503 and could not be completed. "Zero external users" is
  therefore an **inference** from fork count and elapsed time, not a proof. If an external
  consumer of the pre-2026-08-18 `independence_status` field exists and is reading this: that
  field no longer exists in the schema, and any producer input containing it will now be rejected.

### Not solved by this revision

- **Dimension (B), redundancy between critics.** This module derives lineage distance from
  shapers and gates on prior involvement, but does not detect e.g. two `different_lineage` critics
  who happen to be strongly correlated with each other for some other reason. Out of scope for
  this revision.
- **The `critic.kind=human && is_decision_maker=true` case.** `deriveIndependenceStatus` reports
  `unknown` for a human critic who is also the decision maker, rather than asserting
  `human_third_party` or any other value -- this case is not covered by the derivation table the
  architect ruling specified, and is flagged rather than resolved. See
  `docs/protocols/design-options-v1.md`'s "Open questions" section.
- **Whether `same_provider_different_family` is actually needed.** It was added for symmetry with
  `same_family_different_model` (both fill in the gap between "same model_id" and "different
  provider"), but no real fixture in this repo currently produces it. Flagged for the next
  reviewer to confirm it earns its place rather than being schema surface with no observed case
  behind it.
