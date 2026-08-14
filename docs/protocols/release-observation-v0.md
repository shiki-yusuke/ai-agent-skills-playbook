# release-observation/v0

Normative protocol for a single **release-observation event**: the recorded fact that one
release of one artifact reached one environment, with whatever verification/quality/rollback
information is known about it at the time it is recorded. This is the first, deliberately
minimal piece of the `intent -> decision -> implementation -> cost -> release ->
incident/rollback` observation chain the platform design calls for — started here, on purpose,
well before the rest of that chain (a real deployment state machine, automatic promotion,
automatic rollback) exists.

Conformance fixtures live in
[`contracts/release-observation/v0/`](../../contracts/release-observation/v0/); see the
Verification section below.

## Purpose

A release-observation event answers exactly one question: *what happened when this release
reached this environment?* It is written **after** a release has already happened — by a human
running a CLI, or by an incident-response skill recording what it found — never something this
schema drives or executes itself.

**v0 is observation only.** It deliberately does **not**:

- Define or enforce a deployment **state machine**. There is no `prepared -> preview_deployed ->
  ... -> production_deployed` transition graph here, no notion of "the current state of a
  release" derived from a sequence of events, and no schema-level relationship between one
  event and the next event for the same release. Each event is a self-contained fact.
- Drive or gate **automatic promotion** (preview to staging, staging to production) or
  **automatic rollback**. Recording `verification_status: "failed"` does not cause anything to
  happen; a human or a separate tool decides what to do about it.
- **Execute a deploy.** Nothing under `contracts/release-observation/v0/` builds, publishes, or
  ships an artifact. The event is a record of something that already occurred through some
  other means (an `npm publish`, a `twine upload`, a CI job, a manual step).

All of that is explicitly **D5's job** (the platform design's "deployment state machine v1"),
which lives in the release-evidence / E-phase track, not here. See "Relationship to a future
release-evidence contract" below for exactly what carries forward and what does not.

## Format

Schema:
[`contracts/release-observation/v0/release-observation-event.schema.json`](../../contracts/release-observation/v0/release-observation-event.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `schema_version` | yes | Literal `"release-observation/v0"`. |
| `release_id` | yes | Stable identifier for this specific release (recommended convention for a registry package: `<distribution-name>@<version>`, e.g. `"coding-agent-cost@0.1.0"` — the name actually registered with the registry, which is not always the source repo's own name). |
| `lane_id` | no | The one delivery-lane run this release traces to, when there is exactly one. **Absent, not null,** when it does not — see the field's own schema description for why v0 deliberately does not distinguish "no lane at all" from "more than one lane bundled into this release" (both real cases observed in this contract's own fixtures; see the fixture manifest's provenance note). |
| `source_tree_digest` | yes | The git tree object id this release was built from — literally the output of `git rev-parse <tag-or-commit>^{tree}` (dereferenced through an annotated tag if the release tag is one). 40 hex characters for a SHA-1 repository (git's current default), 64 for SHA-256. |
| `artifact_digest` | yes (nullable) | `sha256:<64 hex>` digest of the artifact this release shipped, or **explicit `null`** meaning "this release form has no single content-addressable artifact." The field itself can never be omitted — see "null-not-zero" below. |
| `environment` | yes | Closed set: `preview \| staging \| production`, reusing D5's own environment vocabulary without importing its transition logic. |
| `deployed_at` | yes | UTC only, literal `Z` suffix (same convention as `trace/v1`'s `occurred_at` / `attribution/v1`'s `bound_at` — see "Timestamp convention" below). The instant the artifact actually became reachable in the named environment, not the merge-commit time and not the moment a human got around to recording this event. |
| `verification_status` | yes | `not_measured \| verified \| failed` — whether the deployed artifact was actually exercised post-deploy (installed and run) and found to work. `not_measured` is an honest, explicit value, never silently defaulted to `verified`. |
| `rollback_of` | no | `release_id` of the release this one rolls back, when this release **is** a rollback. Absent (not null) when it is not — a rollback is a known fact at deploy time, so there is no "forgot to record" ambiguity the way there is for `artifact_digest`. |
| `quality_status` | yes | `not_measured \| pass \| fail` — whether this release's shipped *quality* (as distinct from `verification_status`'s narrower "did it run at all") has been assessed. Named to match the existing dashboard design's own quality-status concept (D9) — v0 does not itself assess quality; every real event recorded so far carries `not_measured` honestly. |

Personal-dimension keys are forbidden anywhere in an event, re-using the exact closed set from
[`agent-metrics-v1.md` section 7](agent-metrics-v1.md#7-trust-model) (`author`, `reviewer`,
`assignee`, `owner`, `user_id`, `username`, `email`, `display_name`, `handle`, `chat_id`,
`real_name`) via `contracts/shared/personal-dimensions.mjs` — the same shared module every
contract after `agent-metrics/v1` reuses, rather than a re-declared inline copy.

### null-not-zero: `artifact_digest`

`artifact_digest` is **required on every event, but its value may be `null`** — and null is not
the same fact as omitting the key (omission is a schema violation here, not a valid "unrecorded"
state). `null` is an explicit, positive claim: *this release form genuinely has no single
content-addressable artifact to digest* (e.g. a deploy that is just a git-tree checkout with no
separate build step). A real digest string is the opposite explicit claim: *here is the one
artifact this release shipped, and its content digest, so a later audit can independently
recompute and compare it.* Forcing every event to make one of these two choices — never leaving
the question simply unanswered — is this contract's application of the same null-not-zero
principle `attribution-v1.md` uses for `tokens.exact_attributed`/`tokens.total_measured`: "this
genuinely doesn't apply" and "someone forgot to record it" must never collapse into the same
absent value.

### Timestamp convention

`deployed_at` uses the literal-`Z`-suffix UTC convention (`trace/v1`'s `occurred_at`,
`attribution/v1`'s `bound_at`), **not** `measure/v1`'s numeric `+00:00`-offset convention.
This is a deliberate choice, not an oversight: `measure/v1` uses `+00:00` because that schema is
a transcription of an external producer's (agent-cost's) actual, unowned output — Python's
`datetime.isoformat()` literally renders that way, and the schema tracks reality rather than
prescribing a style. `release-observation/v0`, like `trace/v1` and `attribution/v1`, is a
protocol this repo itself designs; there is no external producer format to track, so it follows
this repo's own established convention for a protocol it owns.

## Verification

Fixtures: [`contracts/release-observation/v0/fixtures/`](../../contracts/release-observation/v0/fixtures/),
verified by
[`contracts/release-observation/v0/verify-fixtures.mjs`](../../contracts/release-observation/v0/verify-fixtures.mjs)
(`node verify-fixtures.mjs`, no install step, no network access). `expected-results.json` in that
directory is the machine-readable table of which fixture is expected to be accepted or rejected,
and its own top-level `description` states this directory's exact provenance in detail.

Three accept fixtures, each a **real release published the day this contract was written**, not
a hand-authored example:

1. `spec-lane@0.5.2` (npm)
2. `evidence-docs@0.1.0` (PyPI)
3. `coding-agent-cost@0.1.0` (PyPI)

Every field on all three was independently measured, not guessed: `source_tree_digest` from each
release's own `git rev-parse <tag>^{tree}`; `artifact_digest` from the npm tarball's own
downloaded-and-hashed sha256 (cross-checked against the registry's declared sha1) or PyPI's own
recorded wheel sha256; `deployed_at` from the registry's own recorded publish instant;
`verification_status: "verified"` reproduced by actually installing each package from its live
registry into a clean environment and running its CLI. None of the three carries a `lane_id` —
two have no lane involvement in their release tree at all, and the third has *three* distinct
lane-state.json artifacts in its tree with no single one able to claim the release without
misrepresenting the other two (see the fixture manifest's own provenance note for the exact
`git grep`/`git ls-tree` evidence). This is reported here as a genuine v0 scope gap, not
papered over with a picked-arbitrarily value.

Beyond schema validation and the personal-dimension scan, one semantic MUST neither expresses
alone: a `rollback_of` reference **MUST** resolve to some other event's `release_id` within the
same checked collection of events — checkable only across more than one event at a time, the
same reason `attribution/v1` has its own "binding-collection" fixture type. Since none of
today's three real releases is a rollback of anything, this one fixture (`dangling-rollback-of-
collection`) uses two clearly-labeled synthetic `demo-release@...` events instead — the one
fixture in this directory not sourced from real data, and named accordingly.

## Relationship to a future release-evidence contract

`release-observation/v0` is **the observation shell, not the evidence-closed release
implementation**. D5 (the platform design's "deployment state machine v1") describes a full
Release Evidence Bundle — `source(repo, commit_sha, tree_digest)`, `lane_ref` (digests of every
lane artifact), `review(pr, head_sha, decision)`, `artifacts[]`, `build(recipe_digest,
toolchain_digest)`, `known_deviations`, `rollback(previous_release_id)`, and a signed/unsigned
`integrity` level — plus a real state machine (`prepared -> preview_deployed ->
preview_verified -> (staging) -> production_deployed -> production_verified / failed /
rolled_back`) with a CLI (`release prepare/deploy/verify/promote/rollback/status/audit`) that
gates production promotion on same-artifact-digest reuse across environments and various
consensus/verification preconditions. **None of that exists yet.** `release-observation/v0` is
deliberately a strict subset: no state machine, no gating, no promotion CLI, no signed
integrity level. What carries forward when that contract is eventually built:

- `release_id`, `source_tree_digest`, `artifact_digest`, `environment`, and `rollback_of` all
  map directly onto fields the Release Evidence Bundle already names (`source.tree_digest`,
  `artifacts[].digest`, `rollback.previous_release_id`) — v0's naming was chosen so a future
  migration is a schema superset, not a rename.
- `verification_status`/`quality_status` are the seed of that future state machine's terminal
  states (`production_verified`/`failed`), recorded here as flat, non-transitional facts rather
  than as a state a machine computed.

What does **not** carry forward automatically: any inference that a `verified` v0 event implies
a release was safe to promote, or that a `failed` one should trigger a rollback. v0 has no
opinion on either — that judgment (and its automation) is exactly what the E-phase
release-evidence work is for.

## Relationship to trace/v1 (`incident_observed` / `rolled_back_to` reservation)

The platform design's `release-observation:v0` note asks for trace/v1's `incident_observed` and
`rolled_back_to` relation names to be **reserved** ahead of the future work that will actually
define their identity/payload shape. **This PR does not add that reservation to
`trace-v1.md`.**

`trace/v1` is documented as **fully immutable once frozen** (`trace-v1.md`'s own Versioning
section: "No change of any kind ... is permitted within v1 after freeze"), with exactly one
named, already-used-up exception (the personal-dimension denylist's "may extend, must not
shrink" carve-out). `incident_observed` and `rolled_back_to` are *already* reserved, in
documentation only, by that same document (`trace-v1.md`'s Format section: "reserved names, in
documentation only ... not `relation` enum members"). Re-stating an already-reserved reservation
would not be a substantive change, but it would still be an edit to a document whose own stated
policy is that nothing changes within v1 after freeze — and this task's own constraint is the
same: **existing frozen contracts (including their prose protocol documents) do not get touched
by this change, full stop.**

Concretely, there is nothing left to *do* here: the reservation the plan asks for already
exists, was made before this contract was written, and required no action from
`release-observation/v0`. If a future `release-evidence`/D5 contract needs to give
`incident_observed`/`rolled_back_to` an actual identity and payload shape (promoting them from
reserved names to real enum members), that is `trace/v2` work, decided and scoped when that
contract is actually designed — not something `release-observation/v0` should pre-decide or
half-implement by touching `trace/v1` now. **Recommendation: no change to `trace-v1.md` in this
PR; revisit relation promotion only when the release-evidence contract that actually needs
`incident_observed`/`rolled_back_to`'s shape is being designed, as a `trace/v2` change at that
time.**

## Versioning

`release-observation/v0` is **not yet frozen** — the "v0" in its name signals this is the first,
deliberately minimal cut, expected to be superseded (not merely extended) once the
release-evidence/D5 work above is designed. Until then:

- No fixture in this directory should be read as exhaustively describing every field a future
  version will carry; see "Relationship to a future release-evidence contract" above for what is
  already known to be coming.
- Once release-evidence work promotes this into a versioned/frozen protocol (`release-
  observation/v1` or a differently-named successor), this document's own Versioning section
  should adopt the same explicit stance every other repo-owned protocol here takes (`trace-
  v1.md`, `attribution-v1.md`, `estimate-v2.md`) — either "immutable once frozen" or a stated,
  different policy — rather than staying silent on it as v0 does.

## Rejected designs

- **Making `release-observation/v0` a `trace/v1` event directly** (e.g. a new `relation` value
  on the existing ledger) instead of a standalone contract. Rejected for this PR: `trace/v1` is
  frozen with no exceptions beyond the personal-dimension carve-out (see "Relationship to
  trace/v1" above), and a release-observation event's fields (`environment`,
  `verification_status`, `quality_status`, ...) do not fit trace/v1's edge-shaped
  `relation`/`from_ref`/`to_ref` model without either stretching `payload` (schema-unconstrained,
  and this data is exactly the kind of structured fact this repo otherwise prefers to keep
  schema-checked) or waiting for a `trace/v2` that actually defines the shape. A standalone
  contract, following `measure/v1`'s and `attribution/v1`'s own precedent of living alongside
  `trace/v1` rather than inside it, ships the observation now without pre-committing `trace/v2`'s
  design.
- **Requiring `lane_id` to be non-null on every event.** Considered, then rejected once real
  data showed a genuine one-release-to-many-lanes case (`coding-agent-cost@0.1.0`'s three
  lane-state.json artifacts) that a single nullable string cannot represent without picking one
  arbitrarily. An optional field, absent when it does not cleanly apply, is more honest than a
  required-nullable one that would force a producer to either fabricate a canonical lane or lie
  with `null` about a lane genuinely having been involved.
- **A closed enum requiring `verification_status`/`quality_status` to always be non-`not_measured`
  once an event is recorded at all.** Rejected — v0 is observation-only by design; forcing a
  producer to always supply a "real" verification/quality verdict would either invent
  information nobody actually checked, or block recording the release-happened fact until a
  check that may never come is performed. `not_measured` being a first-class, explicit value is
  the entire point (mirrors `measure/v1`'s existing `not_measured`-style honesty for unpriced
  tokens, generalized here to release outcomes).
