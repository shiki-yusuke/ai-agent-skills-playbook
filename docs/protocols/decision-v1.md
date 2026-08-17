# decision/v1

Normative protocol for a **decision record**: the platform design's D10 `decision.yaml`, extended
with four fields the one real I-shadow case exposed as missing. Grounded in
`i-shadow-record-01-living-twin-2026-08-17.md` (an external, private working document -- not
vendored in this repo; see "Provenance" under Verification for how its findings are cited without
copying it in) and its own source decisions in the living-twin repo.

Conformance fixtures live in [`contracts/decision/v1/`](../../contracts/decision/v1/); see the
Verification section below.

## Purpose

A decision/v1 record answers: *which option was chosen, by what rationale, through which channel,
and against what evidence* -- for exactly one decision, made by a human, in I-shadow's shadow-mode
process (generate options -> independent critic -> **human decides** -> no autonomous execution).
`decision_maker` is fixed to the literal `"human"` for the whole of v1 for this reason: an
autonomously-made decision is out of this contract's scope entirely, not a value this field needs
to represent.

**v1 guarantees:**

- `intent_ref`, `options_ref`, `critic_ref`, `selected_option_id`, `decided_at`, `decision_maker`,
  `rationale`, `accepted_assumptions`, `accepted_unknowns`, `rejected_options`,
  `evidence_snapshot_digest`, `status` -- D10's own fields, all required.
- `no_action_option_id` (D10's own field) is nullable, paired with a REQUIRED
  `no_action_rationale` that must be present either way -- see "null-not-zero for no_action"
  below.
- `estimate_refs[]` (D10's own field) may be empty, but MUST then carry
  `estimate_refs_omitted_reason` -- null-not-zero, per `i-shadow-record-01` section 4 ("finding
  3"): the real case has zero `estimate_refs` because `estimate --adopt` was never run, and this
  contract forces that to be stated rather than silently defaulted.
- `status: "superseded"` MUST carry `superseded_by`; `status: "active"` MUST NOT (schema
  conditional, both directions).
- `decision_items[]` (NOT a D10 field, added in v1) decomposes a decision into named sub-items,
  so that:
- `retractions[]` (D10 gap, per `i-shadow-record-01` section 2(a), "finding 1") can name a
  `retracted_item_ref` that resolves to a real `decision_items[]` entry marked `"retracted"` --
  semantically checked both directions (dangling reference, and status-consistency) by
  `verify-fixtures.mjs`.
- `decision_channel` + `conflicts_with[]` (D10 gap, `i-shadow-record-01` section 2(c), **called
  the single most important finding**): every record states which channel/session its instruction
  actually arrived through, and an explicit (possibly empty) list of conflicts detected against
  other decisions. See "Why decision_channel exists" below.
- The personal-dimension denylist, same as every other contract in this repo. `critic_engine` (on
  the design-options/v1 side) and `decision_channel`/`conflict` field names were deliberately
  chosen to avoid the forbidden `reviewer`/`author` key names entirely, rather than relying on the
  scanner alone.

**v1 explicitly does NOT guarantee:**

- Cross-contract referential integrity against a real design-options/v1 document. `options_ref`,
  `critic_ref`, `selected_option_id`, `no_action_option_id`, and `rejected_options[].option_id`
  are not checked against any design-options/v1 fixture by this contract's own
  `verify-fixtures.mjs` -- each contract in this repo validates only within its own fixtures
  directory. See design-options/v1's own "Relationship to decision/v1" section for the same point
  from the other side.
- That `superseded_by` resolves to another record within a checked collection. Unlike
  `conflicts_with[].conflicting_decision_ref` (checked, see below) and unlike
  `release-observation/v0`'s `rollback_of` (also checked), `superseded_by` follows `trace/v1`'s
  own `supersedes_event_id` precedent instead: it explicitly tolerates an unresolved reference,
  because a decision chain is expected to grow past whatever fixture collection happens to be
  checked at any one time, and a superseding decision genuinely may not exist yet in the same
  batch a reader is validating.
- That `decision_channel.channel_id` resolves to anything. It is a free string tag, not a ref --
  see "Why decision_channel exists" below for why that is deliberate, not a missed opportunity for
  a stricter check.
- That a decision was actually checked for conflicts before `conflicts_with` was written. An empty
  array is the honest value for "checked, none found" -- this contract cannot mechanically
  distinguish that from "never checked, defaulted to empty," the same limit every other
  honest-not-checked field in this repo's contracts (e.g. `release-observation/v0`'s
  `verification_status: "not_measured"`) already has.

## Why `decision_channel` exists

D10's own `decision_maker: human` field says *who* decided, but not *through which channel* the
instruction arrived. The real recorded case's central failure (`i-shadow-record-01` section 2(c)):
on the same day, one session received "no, 25 people cannot be gathered" while a **different**
agent received a direct instruction to proceed with a 12-then-25 two-wave design -- two
contradictory decisions existed in parallel until the discrepancy was caught and reconciled by a
human. `decision_maker: human` was true of both instructions and could not have told them apart.
`decision_channel.channel_id` names the session/route an instruction arrived through;
`conflicts_with[]` lets a later decision explicitly name an earlier one it was found to conflict
with, the OTHER channel involved, and how it was resolved. `conflicting_channel_id` is
deliberately a free string, not a ref requiring resolution, because the real conflicting channel
in this case (the direct instruction to the other agent) never produced its own citable
`decision/v1` record at all -- only surfaced once the conflict was detected. Requiring it to
resolve to something would make that exact real scenario impossible to record honestly. This
repo's own guidance (`~/.claude/CLAUDE.md`'s cross-cutting-risk note) generalizes the same lesson:
**a solo developer running multiple agents in parallel will always face this problem**, so this
field exists for any I-shadow case, not just the one it was sourced from.

## `artifact_ref` vs `decision_ref`

`$defs/ref` (a single shared `{logical_id, content_digest?}` shape) was split into two distinct
types after a real PR's fixtures were found to carry a formally-valid but fabricated
`content_digest` -- the schema-level pattern `^sha256:[0-9a-f]{64}$` cannot tell a real hash from
one that merely looks like one, and a reviewer had to catch the fabrication by hand (three of
seven digests in that PR matched no file on disk at all; two others were copy-pasted across
fields that name different documents). An independent-review directive (this repo calls this
"sol architect-review") required closing that gap with two changes:

- **`$defs/artifact_ref`** -- points at a file OUTSIDE this ledger (`intent_ref`, `options_ref`,
  `critic_ref`, `estimate_refs[]`). Adds an optional `uri` alongside the existing
  `{logical_id, content_digest?, digest_omitted_reason?}` shape, and makes `content_digest` /
  `digest_omitted_reason` **mutually exclusive** (previously only "at least one" was enforced --
  a ref claiming both "here is the digest" and "the digest is missing because X" at once was
  accepted). `contracts/shared/verify-artifact-digests.mjs` independently sha256's the file a
  `uri` resolves to (when that file is reachable inside this repo) and rejects a mismatch --
  actually checking the claim, not just its shape.
- **`$defs/decision_ref`** -- points at ANOTHER decision/v1 record within the same ledger
  (`superseded_by`, `conflicts_with[].conflicting_decision_ref`). Resolved by `logical_id` alone
  against the target's `decision_id` (verify-fixtures.mjs's existing cross-record checks);
  deliberately carries no `content_digest` / `digest_omitted_reason` at all (rejected by
  `additionalProperties: false` if present) -- a forward reference like `superseded_by` is
  written before the decision it names exists, so no digest could ever be computed for it, and
  "digest of a decision record" is not well-defined the way "digest of a frozen file" is.

Fixtures exercising this split: `accept-self-referential-digests.json` (real files inside this
repo, actually digest-verified) and `invalid-artifact-digest-mismatch.json` (schema-valid, but
digest-verification catches the mismatch) prove `verify-artifact-digests.mjs` actually works;
`invalid-artifact-ref-digest-and-reason-both.json`,
`invalid-artifact-ref-neither-digest-nor-reason.json`, and `invalid-decision-ref-with-digest.json`
exercise the three new constraints above directly.

## null-not-zero for `no_action`

`no_action_option_id` is nullable (D10 names the field but not this nullability -- v1 adds it).
`no_action_rationale` is required unconditionally, whether the option id is a real string or
`null`: when set, it explains why that option is the right stand-in for "do nothing further"
(e.g. why a Kill option counts); when `null`, it explains why no distinct do-nothing option was
ever framed. The recorded case shows both are real: `decision-01`'s Kill option cleanly serves as
`no_action_option_id`, while `decision-02` (choosing between two independently-derived numeric
threshold sets) has no natural "freeze nothing" alternative once the decision to pre-register
thresholds at all was made elsewhere -- forcing a fabricated no-action option onto that decision
would misrepresent it. See `docs/protocols/release-observation-v0.md`'s own `artifact_digest`
section for the same null-not-zero principle applied to a different field.

## Format

Schema: [`contracts/decision/v1/decision.schema.json`](../../contracts/decision/v1/decision.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `schema_version` | yes | Literal `"decision/v1"`. |
| `decision_id` | yes | Stable identifier. One conceptual D10 decision MAY span several decision/v1 records over time (see Versioning). |
| `intent_ref` / `options_ref` / `critic_ref` | yes | `$defs/artifact_ref`: `{logical_id, uri?, content_digest?, digest_omitted_reason?}`, with `content_digest`/`digest_omitted_reason` mutually exclusive (see "`artifact_ref` vs `decision_ref`" above). `options_ref`/`critic_ref` MAY point at the same design-options/v1 document (see that contract's own consolidation note). |
| `selected_option_id` | yes | The chosen option_id. |
| `no_action_option_id` | yes (nullable) | See "null-not-zero for no_action" above. |
| `no_action_rationale` | yes | See above. |
| `decided_at` | yes | UTC, literal `Z` suffix. |
| `decision_maker` | yes | Fixed `"human"` for all of v1. |
| `decision_channel` | yes | `{channel_id, description}`. See "Why decision_channel exists". |
| `conflicts_with[]` | yes (may be empty) | Each: `conflicting_decision_ref`, `conflicting_channel_id`, `detected_at`, `resolution`, `resolution_notes`. |
| `rationale` | yes | Free text. |
| `accepted_assumptions[]` / `accepted_unknowns[]` | yes, minItems 1 | D10's own fields. |
| `rejected_options[]` | yes (may be empty) | Each: `option_id`, `reason_codes[]` (closed enum, see schema description), `notes`. |
| `decision_items[]` | yes, minItems 1 | This decision's own named sub-items (NOT a D10 field -- see Purpose). |
| `retractions[]` | yes (may be empty) | Each: `retracted_item_ref`, `retracted_at`, `reason`, optional `superseded_by_item_ref`. |
| `estimate_refs[]` | yes (may be empty) | See null-not-zero note. |
| `estimate_refs_omitted_reason` | required iff `estimate_refs` is empty | Free text. |
| `evidence_snapshot_digest` | yes | `sha256:<64 hex>`, non-nullable (unlike `release-observation/v0`'s `artifact_digest`: v1 has not yet observed a real decision made on no hashable evidence at all). |
| `status` | yes | `active \| superseded`. |
| `superseded_by` | required iff `status == "superseded"`, forbidden iff `status == "active"` | `$defs/decision_ref`: `{logical_id}` only -- see "`artifact_ref` vs `decision_ref`" above for why it carries no digest field at all. |

## Verification

Fixtures: [`contracts/decision/v1/fixtures/`](../../contracts/decision/v1/fixtures/), verified by
[`contracts/decision/v1/verify-fixtures.mjs`](../../contracts/decision/v1/verify-fixtures.mjs)
(`node verify-fixtures.mjs`, no install step, no network access). Beyond schema validation and the
personal-dimension scan, three semantic checks neither schema alone can express:

1. `retractions[].retracted_item_ref` MUST match a `decision_items[].item_id` in the same record
   (dangling check, within one record).
2. That matched item's `status` MUST be `"retracted"` (consistency check, within one record).
3. `conflicts_with[].conflicting_decision_ref` MUST resolve to some OTHER record's `decision_id`
   within a checked collection of records (cross-record check, mirroring
   `release-observation/v0`'s own `rollback_of` check -- the `"collection"` fixture type).
4. Every `$defs/artifact_ref` (`intent_ref` / `options_ref` / `critic_ref` / `estimate_refs[]`)
   whose `content_digest` names a `uri` reachable inside this repo is actually verified
   byte-for-byte against that file's real sha256
   (`contracts/shared/verify-artifact-digests.mjs`) -- see "`artifact_ref` vs `decision_ref`"
   above. A ref whose `uri` is absent or points outside this repo (every living-twin-sourced ref
   in this directory's own fixtures, by design -- `docs/decisions/*.md` is an external, unvendored
   repo) is reported as **unverifiable**, printed in full every run, never silently treated as
   passing.

### Provenance

Four individual accept records (`decision-01` through `decision-04`) are drawn from the one real
I-shadow case: living-twin's own `decision-01-pivot-and-scope-2026-08-17.md`,
`decision-02-thresholds-2026-08-17.md`, `decision-03-discovery-scope-2026-08-17.md`, and
`decision-04-two-stage-discovery-2026-08-17.md` (an external, private repo; not vendored here).
`evidence_snapshot_digest` on each is a real `sha256sum` of an actual source markdown file this
task independently recomputed. `options_ref`/`critic_ref` digests are real `sha256sum` values of
this same PR's own `design-options/v1` fixture files.

> **Unresolved discrepancy found during the artifact_ref/decision_ref split (flagged, not
> silently fixed):** the claim in the paragraph above does not match what these four fixtures'
> `options_ref`/`critic_ref` digests actually hash to. Re-verified byte-for-byte against the
> living-twin repo: `decision-01`'s `options_ref`/`critic_ref` match
> `decision-input-4points-2026-08-17.md` / `independent-review-diff-2026-08-17.md`; `decision-02`'s
> match `decision-input-4points-2026-08-17.md` / `terra-independent-threshold-derivation.txt`
> (critic dir); `decision-03`/`decision-04`'s both match
> `decision-03-input-discovery-can-it-kill-2026-08-17.md` /
> `sol-round2-self-attack.txt` -- all six are real living-twin source files, not fabricated (0
> mismatches when checked against the correct target), but NONE of them are `design-options/v1`
> fixture file hashes as this paragraph claims. Left as-is (values are not content_digest
> rewrites this task is authorized to make -- see this contract's own Versioning note on
> immutability-adjacent caution) pending a human decision on which target `options_ref`/
> `critic_ref` are actually meant to pin: the design-options/v1 JSON document in this repo (what
> the schema's own field description literally says), or the living-twin source material a round
> of options was built from (what these six values actually are).

A fifth fixture
(`accept-conflict-resolves-collection`) reuses `decision-03`/`decision-04` verbatim as a
`"collection"`, demonstrating `conflicts_with` resolving correctly against REAL data (decision-04
really does conflict with decision-03). The dangling-reference reject fixture
(`invalid-dangling-conflicting-decision-ref`) is the one exception: two clearly-labeled synthetic
`demo-decision-*` records, invented because no real recorded decision in this case exhibits a
dangling `conflicts_with` reference -- mirroring `release-observation/v0`'s own synthetic
`demo-release@*` precedent for the identical reason.

### Known source-material inconsistency (recorded, not smoothed over)

`decision-03`'s own text names its selection "選択肢C", but the design it actually freezes (a
one-sided kill-criterion addition) is a hybrid that does not exactly match decision-03-input's
originally catalogued option C (deferring the kill judgment entirely to a post-Pilot external
cohort). The `accept-living-twin-decision-03-discovery-scope` fixture's own `rationale` field
states this mismatch explicitly rather than silently reconciling it, per this task's own
fixture-sourcing rule against inventing agreement the source material does not actually contain.

## Relationship to design-options/v1

See design-options/v1's own "Relationship to decision/v1" section -- the relationship is
symmetric and documented once, there.

## Versioning

decision/v1 records are immutable once recorded: a re-decision is always a **new** decision/v1
record (`status: "active"`, a fresh `decision_id`) with the earlier record updated to
`status: "superseded"` and `superseded_by` pointing at the new one -- never an edit to the earlier
record in place. This is why the real recorded case produced four separate decision/v1 records
rather than one revised document (`i-shadow-record-01` section 2(a)): the platform design's
original expectation of a single `decision.yaml` per topic is not how the real process actually
unfolded, and v1 does not force that expectation onto the data.

decision/v1 is not yet frozen in the sense `trace/v1` is (no change of any kind after freeze). A
future v2 revisiting the `reason_codes` closed set, or the `conflicts_with.resolution` enum, is
possible if a real case exercises a value neither currently covers.

## Rejected designs

- **A single `decision.yaml` per topic, matching D10 literally.** Rejected: the real case shows
  decisions get revisited and partially retracted in ways a single mutable file cannot honestly
  represent without either rewriting history or accumulating undated edits.
- **Cross-checking `superseded_by` for dangling references, the same way `conflicts_with` and
  `release-observation/v0`'s `rollback_of` are checked.** Rejected for v1: unlike a rollback
  (always a well-known fact at deploy time) or a detected conflict (both sides already exist when
  the conflict is recorded), a superseding decision is often written well after the superseded
  one and may legitimately not exist yet in whatever collection is being validated -- the same
  reasoning `trace/v1` already applied to its own `supersedes_event_id`.
- **Requiring `conflicting_channel_id` to resolve to a decision_channel.channel_id actually
  recorded somewhere.** Rejected: the real case's own conflicting channel never produced a
  citable decision/v1 record at all, only surfaced once the conflict was noticed. A resolution
  requirement would make the actual, real scenario this field exists for impossible to record.
- **Treating `no_action_option_id` as required-non-null.** Rejected once `decision-02` showed a
  real decision with no naturally-occurring do-nothing option; forcing one would fabricate
  structure the source material does not contain.
