# estimate/v2 CHANGELOG

`estimate/v2` itself is not yet frozen (no producer has emitted a real record against it -- every
fixture in `fixtures/` is a hand-authored example of a decision shape, per
`fixtures/expected-results.json`'s own description). This CHANGELOG exists because the entry below
is a **breaking, in-place revision of an already-published contract**, following the precedent and
format `design-options/v1/CHANGELOG.md` set for exactly this situation -- see "Why revised in place
rather than as v3" below for the judgment call that required.

## 2026-08-20: `cohort_provenance` added; the three cohort digest fields gain a `sha256:` prefix

### What changed

- **Added**, required, inside `cohort`: `cohort_provenance`, an object with one entry per cohort
  digest field (`routing_policy_digest`, `prompt_policy_digest`, `execution_profile_digest`). Each
  entry's `kind` is `inline` (the pre-normalization policy object is embedded; `contracts/shared/
  verify-cohort-provenance.mjs` recomputes `sha256(JCS(object))` via `contracts/shared/jcs.mjs` and
  compares it against the sibling digest field), `locator` (a `uri`, optionally paired with
  `source_repo`, names where the object lives but is not fetched or hashed by this repo's CI --
  reported `unverifiable`, never silently treated as passing), or `unavailable` (a required `reason`
  says why no locator or inline object can be recorded, e.g. a policy object that lives in a private
  repo). See `$defs/digest_provenance_entry` in `estimate-decision.schema.json` for the full shape.
- **Breaking**: `routing_policy_digest`, `prompt_policy_digest`, and `execution_profile_digest` now
  require a `sha256:` prefix (`^sha256:[0-9a-f]{64}$`, was bare `^[0-9a-f]{64}$`) -- for consistency
  with every other content-digest field in this repo (`decision/v1`'s `artifact_ref.content_digest`,
  `release-observation/v0`'s `artifact_digest`, `trace/v1`'s `ref.content_digest`, all
  `sha256:<64 hex>`), and because a bare hex string never states which hash algorithm produced it.
  All 23 existing fixtures updated in place; `invalid-cohort-digest-not-hex.json`'s violation is
  inverted (see below).
- **Added**, descriptions on all three digest fields stating exactly what each is a digest OF and
  how it is computed (`sha256(JCS(object))`, `contracts/shared/jcs.mjs`'s repo-local RFC 8785
  subset) -- previously undocumented (`docs/protocols/estimate-v2.md` had zero mentions of any of
  the three fields' meaning before this round, confirmed by `grep -c` against the pre-round file).

### Why: the defect this closes

`cohort`'s `additionalProperties: false` gave a producer no field to record what a digest was a
digest OF. All three digest fields are `required` (so, unlike `decision/v1`'s
`digest_omitted_reason`, they can never legitimately be absent), yet nothing in the schema let a
producer name the routing/prompt/execution policy object each digest actually hashes -- a `cohort`
carrying `routing_policy_digest: "aaaa...aaaa"` gives a later reader no way to recover, months
later, what policy that was, nor any way to check two decisions' matching digests actually came
from the same policy rather than a coincidence or a copy-paste. This matters specifically because
the cohort identity tuple (`model_generation`, `routing_policy_digest`, `prompt_policy_digest`,
`token_basis`, `execution_profile_digest`) is the basis for "these two decisions drew from the same
comparison population" -- the calibration pipeline's whole reason for existing is learning from
that comparison, so an unrecoverable digest referent silently undermines it.

The `sha256:`-prefix change is a smaller, mechanically-motivated companion to the same round: it
was flagged while writing `cohort_provenance`'s own description (which has to state exactly how
each digest is computed) that the bare-hex pattern was the one digest shape in this repo that
didn't say which algorithm produced it.

### Why revised in place rather than as v3

`estimate-decision.schema.json`'s `schema_version` const (`"estimate/v2"`) was not bumped. Grounds
for revising v2 in place, recorded here per this repo's own norm of writing down why a
compatibility-breaking judgment call was made:

- **No real producer has emitted estimate/v2 yet.** `spec-lane`'s own estimator implementation this
  contract was written ahead of (see `estimate-decision.schema.json`'s own top-level `description`)
  does not exist yet either. Every one of the 23 pre-round fixtures carries a placeholder digest
  (`aaaa...`/`bbbb...`/`cccc...`/`dddd...`/`eeee...`/`ffff...`, never a real sha256), confirmed by
  inspecting every fixture's `cohort.*_digest` value before this round -- so the actual-value impact
  of both the prefix change and the new required field is zero real records affected.
- The contract was first added 2026-08-09; this revision lands 2026-08-20 (11 days later) -- longer
  than `design-options/v1`'s same-day precedent, but still well inside "before any real producer
  exists," which is the actual criterion this repo's other in-place revisions have used, not elapsed
  time by itself.
- This repo had 0 forks and 1 star at the time of this change (`gh repo view --json
  stargazerCount,forkCount`).
- A GitHub code search for `estimate-decision.schema.json` returned 0 results outside this repo
  (`gh api search/code -f q='estimate-decision.schema.json'`).
- **Limitation, stated rather than hidden**: as `design-options/v1/CHANGELOG.md` notes for its own
  equivalent check, GitHub code search coverage and indexing lag mean "0 external hits" is
  **evidence**, not proof, of zero external consumers. If an external consumer of the pre-2026-08-20
  bare-hex `cohort` digest fields exists and is reading this: those three fields now require a
  `sha256:` prefix, `cohort_provenance` is now required, and any producer input missing either will
  be rejected.

### `invalid-cohort-digest-not-hex.json`'s violation inverted

Pre-round, this fixture's `routing_policy_digest` carried an unwanted `"sha256:"` prefix against
the then-bare-hex-only pattern. Post-round, the pattern requires that same prefix, so the old value
would now be **accepted** -- the fixture is kept (same id, same
`$.cohort.routing_policy_digest` `reason_code` path in `expected-results.json`) but its violation is
inverted: `routing_policy_digest` is now bare hex with no `sha256:` prefix, which the new pattern
rejects. The id (`...-not-hex`, i.e. "not a bare hex string") still honestly names the new
violation shape, so it was not renamed.

### Migration

Not applicable -- there is no real producer to migrate (see "Why revised in place" above). Any
future producer implementation must, from its first commit, emit `sha256:`-prefixed digests and a
`cohort_provenance` entry for each.
