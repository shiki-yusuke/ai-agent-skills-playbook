# measure/v1

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
contract's accept fixtures the same way it already vendors `trace`/`attribution`/`estimate`'s
(`packages/adapters/test/fixtures/measure/UPSTREAM` records the pinned commit) and replays them
against its own production `AgentCostMeasureResultSchema` (Zod) -- proving spec-lane's own
parsing agrees with this schema's accept/reject calls, not just that the schema is internally
self-consistent.

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
unconditionally, on every fixture.

## Verification

Fixtures: [`contracts/measure/v1/fixtures/`](../../contracts/measure/v1/fixtures/), verified by
[`contracts/measure/v1/verify-fixtures.mjs`](../../contracts/measure/v1/verify-fixtures.mjs)
(`node verify-fixtures.mjs`, no install step, no network access). `expected-results.json` in
that directory is the machine-readable table of which fixture is expected to be accepted or
rejected (with which reason code). Every fixture is a full `measure --format json` payload,
produced by actually running `agent-cost measure` (accept fixtures verbatim; reject fixtures as
one deliberate mutation of an accept fixture), not hand-authored from a description.

Beyond schema validation, six semantic MUSTs neither schema alone can fully express (see the
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
- Recompute every `totals` object from its own `rows`, and `total.totals` from every requested
  session's own `totals` -- never carry a stale or independently-tracked total forward.
- Never introduce a per-actor identity field (author/reviewer/email/... -- the full forbidden
  set is `contracts/shared/personal-dimensions.mjs`) anywhere in the payload.

**A `measure/v1` consumer MUST:**

- Check `protocol_version === "measure/v1"` before trusting the shape below it (agent-cost's
  own `MEASURE_PROTOCOL_VERSION` comment states this explicitly) -- a value like `"measure/v0"`
  or `"measure/v2"` means the shape this schema describes does not apply.
- Tolerate additional top-level or nested keys it does not recognize (see "Open vs. closed
  schema" above) -- treating an unrecognized additive field as a hard parse failure defeats the
  whole point of the additive-changes-don't-bump-the-version policy.
- Treat `sessions[id].matched === false` as a valid, representable answer ("this session had no
  usage"), not an error -- `measure` itself exits `0` for this case.

## Versioning

`measure/v1`'s version number is owned by agent-cost (`agent_cost/cli.py`'s
`MEASURE_PROTOCOL_VERSION`), not by this repo -- this repo's job is to keep
`measure-output.schema.json` and its fixtures in sync with whatever agent-cost's `measure`
actually emits under that version, not to decide when the version changes. In practice:

- **agent-cost changes first.** An additive field ships in agent-cost without a version bump
  (per its own stated policy); this repo's schema is updated in a follow-up change to describe
  the new field (adding it to `properties` and, if it is unconditionally present, `required`) --
  this is *not* a breaking change to this schema's own consumers, since the schema was already
  open (no `additionalProperties: false` to relax).
- **A breaking change bumps agent-cost's `MEASURE_PROTOCOL_VERSION`** (field removed, or a
  field's meaning changes) to `measure/v2` or later. This repo then adds a
  `contracts/measure/v2/` directory alongside (not replacing) `v1` -- exactly the
  side-by-side-versions convention `trace-v1.md`/`attribution-v1.md` already use for their own
  v1/v2 boundaries -- once a v2 exists to describe.
- The personal-dimension closed set's own "MAY extend; MUST NOT shrink" exception
  (`agent-metrics-v1.md` section 7, carried into `trace-v1.md`/`attribution-v1.md`'s Versioning
  sections) applies here too, for the same reason: widening the forbidden set can only narrow
  what is already disallowed, so it is not a version-relevant change to this schema either.

## Rejected designs

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
