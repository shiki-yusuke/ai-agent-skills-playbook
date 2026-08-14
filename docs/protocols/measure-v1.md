# measure/v1

**Status: versioned tracking (compatibility floor)** -- deliberately not "immutable freeze," the
status every other protocol in this directory carries. See Versioning below for exactly what
that means and does not mean; it is not a weaker guarantee, it is a *different* one, chosen to
match a contract this repo does not itself own the producer of.

Cross-language conformance contract for `agent-cost measure --format json` -- the JSON payload
a build orchestrator or delivery-lane tool consumes as a subprocess to attribute token/cost
usage to a specific unit of work it already knows the session id(s) for (D11: this platform's
v1 answer to "how does a multi-language stack -- Python producer, TypeScript consumer -- agree
on one wire contract without re-deriving it independently on each side").

**This document is not the contract's normative source.** Unlike every other protocol in
`docs/protocols/` (`trace-v1.md`, `attribution-v1.md`, `estimate-v2.md`, `agent-metrics-v1.md`
via its own home), `measure/v1` is owned end-to-end by
[agent-cost](https://github.com/shiki-yusuke/agent-cost) itself, not by this repo:

- **Prose contract and implementation**: agent-cost's own `README.md`, "Machine consumption:
  `agent-cost measure`" section, and `agent_cost/cli.py`'s `cmd_measure` /
  `MEASURE_PROTOCOL_VERSION`. That is where field meanings, exit-code semantics, and the
  versioning policy are decided and change first.
- **Schema SSOT**: *this repo*,
  [`contracts/measure/v1/measure-output.schema.json`](../../contracts/measure/v1/measure-output.schema.json).
  agent-cost's README documents the shape in prose and a hand-written example; this repo is
  where that shape is pinned as a machine-checkable schema with fixtures, because agent-cost is
  a single-language (Python) repo with no cross-language conformance-fixture convention of its
  own, and this repo (ai-agent-skills-playbook) is already where `trace`/`attribution`/
  `estimate` live for exactly that purpose.

Concretely: **this repo never edits agent-cost's README**, and agent-cost's own test suite is
the one place a producer-side regression against this shape gets caught first
(`tests/test_cli.py::test_measure_json_schema_is_locked`, mirroring its existing
`test_report_json_schema_is_locked`). This schema is a *transcription* of agent-cost's real,
current output (written by actually running `agent-cost measure --format json` and reading
`agent_cost/cli.py`/`aggregate.py`/`facts.py` directly), kept in sync by whichever side changes
first re-vendoring/re-checking against the other -- see Versioning below for what "in sync"
means given the two repos' different release cadences.

The other known consumer, [spec-lane](https://github.com/shiki-yusuke/spec-lane)'s
`AgentCostTelemetryAdapter` (`packages/adapters/src/telemetry/agent-cost.ts`), vendors this
contract's fixtures the same way it already vendors `trace`/`attribution`/`estimate`'s
(`packages/adapters/test/fixtures/measure/UPSTREAM` records the pinned commit) and replays them
against its own production `AgentCostMeasureResultSchema` (Zod) plus the same `protocol_version`
check and personal-dimension scan its `AgentCostTelemetryAdapter.measure()` runs in production --
proving spec-lane's own parsing agrees with this schema's accept/reject calls *at the schema/
contract floor level*. That qualifier matters: agreeing on the floor does not mean every
consumer-side USE of a floor-conformant payload behaves identically across repos -- see "Known
token_kind values are producer/contract/consumer, not one shared verdict" below for the concrete
case (an unrecognized `token_kind`) where this repo's schema and spec-lane's own `AgentCostRowSchema`
both accept a value that a specific spec-lane *feature* (its metrics emitter) still chooses to
fail closed on, correctly, for its own product reasons unrelated to contract conformance.

## Format

Schema: [`contracts/measure/v1/measure-output.schema.json`](../../contracts/measure/v1/measure-output.schema.json).
See that schema's own `description` for the full field-by-field account (top level:
`protocol_version`, `generated_at`, `window`, `timezone`, `agent`, `rates`, `session_ids`,
`sessions`, `total`, `data_quality`) and agent-cost's README for the prose walkthrough with a
worked example. Not duplicated here to avoid a second copy drifting from either source.

## Open vs. closed schema

**`measure/v1`'s schema does not set `additionalProperties: false` anywhere** -- the one
deliberate structural difference from every other schema in this repo. `trace-v1`/
`attribution-v1`/`estimate-v2` are protocols this repo itself designs and freezes (see each
one's own Versioning section: "no change of any kind ... is permitted within v1 after
freeze"). `measure/v1` is not that: agent-cost's README states its real policy in so many
words -- "Within a major version, only additive changes (new fields) are made; a field being
removed or changing meaning bumps the version." A closed schema would reject a legitimately
current `measure/v1` payload the instant agent-cost ships an additive field under that policy,
which is a false-positive conformance failure against the actual producer, not a real
contamination. `required` is still enforced in full (a fixture can still fail for a *missing*
documented field, see `invalid-totals-missing-key`); only the "no extra keys at all" half of a
closed schema is intentionally absent. This mirrors spec-lane's own `AgentCostRowSchema`/
`AgentCostMeasureResultSchema` (`packages/schemas/src/agent-cost.ts`), which already chose
`.passthrough()`/unknown-key-tolerant parsing for the identical reason, independently, before
this schema existed.

One consequence: the personal-dimension scan (below) is not backed up by
`additionalProperties: false` the way it is in every other contract here -- for `measure/v1` it
is the *only* thing standing between a contaminated payload and a false accept, not a
defense-in-depth backstop. `measure/v1` has no legitimate reason to ever carry one (it is a
pure token/cost digest keyed only by an opaque `session_id`), so this is checked
unconditionally, on every fixture (including in production, not only in tests -- see below).

Because personal-dimension contamination has no legitimate reason to exist for this specific
payload shape, spec-lane's own `AgentCostTelemetryAdapter.measure()` (the production subprocess
boundary, not only its own fixture-conformance test) runs this same scan
(`scanAgentMetricsPersonalDimensions`, its existing agent-metrics/v1 11-key denylist -- the same
list `contracts/shared/personal-dimensions.mjs` uses) against the raw parsed JSON and throws
before returning, fail-closed, if it finds anything. This is deliberately a *production* code
change, not just a test double proving the check is possible -- an open schema with no
`additionalProperties: false` backstop means the boundary that actually receives untrusted
subprocess output is exactly where this needs to run, not only in a fixture-replay test that
never sees a real agent-cost process's stdout.

For `token_kind` specifically, the same "open" shape is deliberately narrower in what it
promises: the schema and every parser accept an unrecognized value, but nothing says every
*use* of that value downstream must succeed.

### Known token_kind values are producer/contract/consumer, not one shared verdict

`token_kind` is the one field in this schema that is a `string` rather than a closed `enum`
(see the schema's own `properties.token_kind` description for the reasoning) -- this repo,
agent-cost, and spec-lane's own `AgentCostRowSchema` (`token_kind: z.string()`, not
`z.enum(...)`, independently already written that way before this document existed) all agree
an unrecognized `token_kind` is not, by itself, a contract violation. That three-way agreement
is a floor, not a ceiling, and the three repos have three different, equally correct roles on
top of it:

- **Producer (agent-cost)**: MAY emit a new `token_kind` value additively, within `measure/v1`,
  without a version bump -- exactly like any other additive field (see Versioning below).
- **Contract (this schema/`verify-fixtures.mjs`)**: MUST accept it. An unrecognized value logs
  a warning (informational only) and never appears in a fixture's rejection `reasons` --
  rejecting it here would make the schema itself the breaking change agent-cost's own additive
  policy is supposed to prevent.
- **Consumer (any parser, including spec-lane's own)**: MUST accept it too, at the parsing/
  schema-validation layer -- exactly like the contract. But a specific downstream *feature* atop
  that successfully-parsed payload is free to have its own, stricter business rule, and
  fail-closed there for reasons that have nothing to do with contract conformance. spec-lane's
  metrics emitter (`packages/core`, `aborts with unknown_token_kind ...`) is exactly this: it
  refuses to price or silently drop an unrecognized `token_kind` when building a KPI-facing
  metrics record, because a wrong or missing price for an unrecognized token kind would corrupt
  a number people make decisions from -- a correct, unrelated-to-this-contract safety rule for
  *that one feature*, not evidence that spec-lane's parsing of `measure/v1` itself is stricter
  than this schema. Contradicting this schema's own acceptance would be a bug; a downstream
  feature choosing to be more conservative than "parses successfully" is not.

## Verification

Fixtures: [`contracts/measure/v1/fixtures/`](../../contracts/measure/v1/fixtures/), verified by
[`contracts/measure/v1/verify-fixtures.mjs`](../../contracts/measure/v1/verify-fixtures.mjs)
(`node verify-fixtures.mjs`, no install step, no network access). `expected-results.json` in
that directory is the machine-readable table of which fixture is expected to be accepted or
rejected (with which reason code), and its own top-level `description` states this directory's
exact provenance (every accept fixture's content is a real, actually-captured `agent-cost
measure` run; `generated_at` is the one deliberately-substituted field, for reproducibility).
Every reject fixture is one deliberate mutation of an accept fixture, with one documented
exception (`invalid-personal-dimension`, which plants all 11 forbidden keys at once on purpose).

Beyond schema validation, nine semantic MUSTs neither schema alone can fully express (see the
schema's own `description` for the same list with more detail):

1. **Every row's `tokens` MUST equal `priced_tokens + unpriced_tokens`.**
2. **A row's `pricing_status` MUST be `"unpriced"` if and only if its `unpriced_tokens > 0`** --
   `agent_cost/aggregate.py`'s `build_rows` ranks `unpriced` as the worst status among the facts
   in a bucket, and it wins outright the moment any one fact is unpriced.
3. **A `totals` object (a session's or the top-level `total`'s) MUST equal the recomputed sum
   of its own `rows`.** The declared total is recomputed, never trusted as given -- same
   principle as `attribution-v1.md`'s `tokens.exact_attributed` check.
4. **The top-level `total.totals` MUST equal the sum, across every requested session, of that
   session's own `totals`.** `measure`'s `total` is the union of exactly the requested
   `session_ids`, never a broader report over everything locally recorded.
5. **`session_ids` and the keys of `sessions` MUST be the same set**, both directions.
6. **`data_quality.unpriced_tokens` MUST equal the sum of `total.rows[].unpriced_tokens`.**
7. **A session entry with `matched: false` MUST have an empty `rows` array and all-zero
   `totals`.** "No usage matched this session_id" and "usage matched but happened to net to
   zero" are different facts; nothing else here compares `matched` against its own siblings.
   See `invalid-matched-false-non-zero`.
8. **The top-level `total.rows` MUST equal the `(agent, model, token_kind)`-dimensional
   re-aggregation of the union of every `sessions[*].rows`** -- not just a scalar totals sum
   (check 4 above). Two payloads can share an identical `total.totals`, `estimated_cost_usd`
   included, while `total.rows` attributes the exact same tokens to the wrong `agent`/`model`/
   `token_kind` bucket; check 4's scalar comparison cannot see that, only a bucket-by-bucket
   recomputation can. See `invalid-total-rows-wrong-dimension`, which demonstrates precisely
   this: every `total.totals` scalar is untouched and correct while `total.rows[].agent` has
   been relabeled.
9. **The personal-dimension scan** (`contracts/shared/personal-dimensions.mjs`) -- `measure/v1`
   carries no per-actor identity at all, so any forbidden key anywhere in the payload is a
   contamination. Unlike every closed-schema contract in this repo, this is not a
   defense-in-depth backstop here (see "Open vs. closed schema" above) -- it is the only thing
   standing between a contaminated payload and a false accept, which is why spec-lane also runs
   it in production, not only in its own fixture-conformance test (see above).

Fixed-point/floating-point note: `estimated_cost_usd` and `credits` are compared with a small
epsilon (`1e-9`), not exact equality -- agent-cost sums these as `Decimal` internally and only
converts to `float` once at the end (`agent_cost/aggregate.py`'s `rows_totals` docstring), but a
JSON fixture is still a `float` on the wire, and re-summing floats in JavaScript is not
bit-identical to summing `Decimal`s in Python. `tokens`/`priced_tokens`/`unpriced_tokens` are
integers and compared exactly.

**A `measure/v1` producer MUST:**

- Never omit a requested `session_id` from `sessions`, whether or not it matched any usage.
- Emit `generated_at`/`window.since`/`window.until` as a numeric-UTC-offset ISO 8601 string
  (`+00:00`), or `null` for an unbounded window bound -- never a bare date, a `Z` suffix, or a
  sentinel date standing in for "no bound."
- Recompute every `totals` object from its own `rows`, `total.totals` from every requested
  session's own `totals`, and `total.rows` as the `(agent, model, token_kind)`-dimensional
  re-aggregation of every requested session's own `rows` -- never carry a stale or
  independently-tracked total (scalar or per-row) forward.
- Give a `matched: false` session entry an empty `rows` array and all-zero `totals`, never a
  non-empty or non-zero one.
- Never introduce a per-actor identity field (author/reviewer/email/... -- the full forbidden
  set is `contracts/shared/personal-dimensions.mjs`) anywhere in the payload.

**A `measure/v1` consumer MUST:**

- Check `protocol_version === "measure/v1"` before trusting the shape below it (agent-cost's
  own `MEASURE_PROTOCOL_VERSION` comment states this explicitly) -- a value like `"measure/v0"`
  or `"measure/v2"` means the shape this schema describes does not apply.
- Tolerate additional top-level or nested keys, and any non-empty-string `token_kind`, it does
  not recognize (see "Open vs. closed schema" and "Known token_kind values are producer/
  contract/consumer, not one shared verdict" above) at the parsing/schema-validation layer --
  treating an unrecognized additive field or `token_kind` as a hard *parse* failure defeats the
  whole point of the additive-changes-don't-bump-the-version policy. A specific downstream
  feature built atop a successfully-parsed payload MAY still have its own stricter, unrelated
  business rule (e.g. refusing to price an unrecognized `token_kind` in a KPI-facing record) --
  that is a feature-level choice layered on top of successful parsing, not a contract violation.
- Treat `sessions[id].matched === false` as a valid, representable answer ("this session had no
  usage"), not an error -- `measure` itself exits `0` for this case.
- Scan for the personal-dimension denylist (`contracts/shared/personal-dimensions.mjs`'s keys,
  or an equivalent local copy -- e.g. spec-lane's `scanAgentMetricsPersonalDimensions`) and
  fail closed if found, in the actual code path that receives untrusted `measure` output, not
  only in a fixture-conformance test -- an open schema means no `additionalProperties: false`
  is doing this for you.

## Versioning

`measure/v1`'s version number is owned by agent-cost (`agent_cost/cli.py`'s
`MEASURE_PROTOCOL_VERSION`), not by this repo -- this repo's job is to keep
`measure-output.schema.json` and its fixtures in sync with whatever agent-cost's `measure`
actually emits under that version, not to decide when the version changes. This is why "Status"
at the top of this document says **versioned tracking (compatibility floor)**, not "immutable
freeze" -- a genuinely different policy from `trace-v1`/`attribution-v1`/`estimate-v2` (whose own
Versioning sections say "no change of any kind ... is permitted within v1 after freeze"), chosen
because this repo does not control the producer's release cadence the way it controls its own
protocols.

**REQUIRED-FLOOR POLICY (sol review, corrects an earlier, wrong version of this section):**
every key currently listed in any `required` array in `measure-output.schema.json` is fixed --
a *floor* -- for the entire lifetime of `measure/v1`:

- A key already in `required` MUST NOT be removed from it within v1 (a payload silently
  dropping a field an existing consumer depends on is exactly the kind of breaking change that
  requires a version bump on agent-cost's own side first, per its README's stated policy).
- A key that is optional today (i.e. present in `properties` but not `required`) MUST NOT
  *become* required within v1 either. **This is the specific mistake an earlier version of this
  document made** -- it said a newly-added field could be added to `required` "if
  unconditionally present," which is wrong: agent-cost's own additive-changes policy means an
  OLDER, still-`measure/v1`-labeled producer build legitimately does not have that field yet,
  and promoting it to `required` would make this schema reject that older build's perfectly
  valid output. A schema that can reject a still-conformant producer isn't tracking the
  contract, it's inventing a stricter one nobody agreed to.
- A brand-new field from a future additive agent-cost change is added to `properties` as
  **optional only** -- never to `required` -- until/unless a `measure/v2` promotes it to the
  floor deliberately, as part of a version bump agent-cost itself makes first.
- Growing the `required` set is therefore always a `measure/v2`-or-later change, exactly like
  removing a field or changing one's meaning -- it goes in a new `contracts/measure/v2/`
  directory alongside (not replacing) `v1`, the same side-by-side-versions convention
  `trace-v1.md`/`attribution-v1.md` use for their own v1/v2 boundaries, once a v2 exists to
  describe.

In practice, day to day:

- **agent-cost changes first.** An additive field ships in agent-cost without a version bump
  (per its own stated policy); this repo's schema is updated in a follow-up change to describe
  the new field as an **optional** addition to `properties` -- this is *not* a breaking change
  to this schema's own consumers, both because the schema was already open (no
  `additionalProperties: false` to relax) and because the new field is never required.
- The personal-dimension closed set's own "MAY extend; MUST NOT shrink" exception
  (`agent-metrics-v1.md` section 7, carried into `trace-v1.md`/`attribution-v1.md`'s Versioning
  sections) applies here too, for the same reason: widening the forbidden set can only narrow
  what is already disallowed, so it is not a version-relevant change to this schema either.

## Rejected designs

- **Promoting a newly-added optional field to `required` within v1** (sol review must1,
  corrects this document's own earlier text). Considered because it seemed harmless once every
  currently-observed producer build already emitted the field unconditionally -- rejected once
  it was clear that "every build I've observed" is not the same claim as "every
  `measure/v1`-labeled build, past and future, is guaranteed to" (an older producer build
  predating the field is still validly `measure/v1`), and a schema that rejects a still-valid
  older producer isn't tracking the contract, it's silently narrowing it. See the
  REQUIRED-FLOOR POLICY above.
- **A closed enum for `token_kind`** (sol review must3). Rejected for the same reason a closed
  `additionalProperties: false` was rejected below: agent-cost's additive-changes policy permits
  a new `token_kind` value within v1, so a closed enum would make this schema itself the
  breaking change that policy exists to avoid. See "Known token_kind values are producer/
  contract/consumer, not one shared verdict" above for what stays true instead.
- **A closed (`additionalProperties: false`) schema, matching this repo's other contracts.**
  See "Open vs. closed schema" above -- rejected because it does not match agent-cost's actual,
  stated versioning policy for this specific protocol, and would produce false-positive
  rejections against real, current agent-cost output.
- **Duplicating agent-cost's README prose into this document.** Two prose descriptions of the
  same wire shape will drift; this document intentionally says *less* about field meaning than
  the schema's own `description` and agent-cost's README, and instead documents the
  cross-repo ownership split, the open-schema rationale, and the semantic checks a plain JSON
  Schema validator cannot express on its own.
- **Vendoring agent-cost's README into this repo (or vice versa) instead of a schema.** A
  vendored prose copy still requires a human to re-read it and manually decide whether a
  fixture needs to change; a schema plus `verify-fixtures.mjs` makes the same check
  automatic and CI-enforced, which is the entire reason this cross-language conformance
  fixture exists.
