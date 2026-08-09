# attribution/v1

Normative protocol for the accounting principle a delivery pipeline's cost/telemetry data
depends on: **1 session binds to exactly 1 task_run; 1 task_run may have N sessions over its
lifetime** (resumptions, subagents, follow-up fixes are all still the same task). This
document formalizes how a binding is recorded (`binding-record`) and how a time window's
sessions are audited for whether that principle actually held (`audit-result`).

This document is the contract. It builds directly on
[`trace-v1.md`](trace-v1.md)'s `session_bound` / `usage_imported` / `attributed_to` relations
— a `binding-record` is the durable, queryable projection of a `session_bound` trace event;
an `audit-result` is derived by scanning a window of trace events and binding-records
together. Read `trace-v1.md` first if you haven't.

Conformance fixtures live in [`contracts/attribution/v1/`](../../contracts/attribution/v1/);
see the Verification section below.

## Purpose

Every cost/telemetry number this platform produces (agent-metrics/v1 records, estimate/v2
predictions) is only as trustworthy as the session-to-task binding underneath it. This
protocol exists to make that binding, and its failure modes, explicit and auditable rather
than assumed:

- A **binding-record** answers "which session was bound to which task_run, and by what
  method." One record per binding; a re-bind is a new record with `binding_status:
  "superseded"` on the old one (mirroring `trace-v1.md`'s append-only/`supersedes` model —
  see Identity below).
- An **audit-result** answers, for one time window, "how many sessions were cleanly bound,
  and for every one that wasn't, why." It is the thing that gates whether that window's usage
  is eligible for research use at all (`research_eligible`, see Verification).

It does not carry, and is not a substitute for:

- A cost/usage number itself (that's `agent-metrics/v1`'s job; this protocol only says
  *whether* a given session's usage can be trusted as belonging to one task).
- A confidence score. Every determination here is a closed status/enum, never a number
  standing in for "how sure we are" — see Rejected designs.
- A partial-credit apportionment of a session that touched more than one task. A `mixed`
  session's usage is flagged, not split (see Rejected designs).

## Format

### `binding-record`

Schema:
[`contracts/attribution/v1/binding-record.schema.json`](../../contracts/attribution/v1/binding-record.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `schema_version` | yes | Literal `"attribution/v1"`. |
| `task_run_id` | yes | The task_run this session is bound to. |
| `phase_run_id` | no | The specific phase_run within that task_run, if the pipeline tracks phase granularity. |
| `lane_id` / `intent_id` | yes | Which lane/intent this task_run belongs to. |
| `agent` | yes | `"claude"` \| `"codex"`. |
| `binding_method` | yes | Closed set, see below. |
| `session_id` | yes | The session being bound. |
| `bound_at` | yes | UTC timestamp, literal `Z` suffix. |
| `binding_status` | yes | `"bound"` \| `"superseded"`. |
| `actor` | conditionally | Who performed the binding. **Required, with `kind == "human"`, when `binding_method == "manual_bind"`** — schema-enforced via `if`/`then` (sol architect-review must5), with a matching semantic check in `verify-fixtures.mjs` kept as a defense-in-depth backstop. Optional otherwise. |

`binding_method` closed set — this asymmetry is not an oversight, it is the *measured* result
of a binding-feasibility spike run before this contract was written:

- **`pre_assigned_session_id`** — Claude: the wrapper generates a UUID nonce up front and
  passes it *as* the session_id itself, via `claude -p --session-id <nonce>`. The nonce **is**
  the session_id; there is no separate join step.
- **`self_reported_thread_id`** — Codex: the wrapper cannot pre-assign a session_id. It reads
  one from `codex exec --json`'s leading `{"type":"thread.started","thread_id":...}` event,
  obtained *after* the process starts. A stderr banner is never used for this — it is not a
  structured, parseable source.
- **`manual_bind`** — an interactive session bound by explicit human action (e.g.
  `lane work bind --session-id`). Requires `actor.kind == "human"`: this method exists
  specifically for the case where no automated wrapper observed the binding, so it must be an
  attested human fact, not a system's inference about one.

### `audit-result`

Schema:
[`contracts/attribution/v1/audit-result.schema.json`](../../contracts/attribution/v1/audit-result.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `schema_version` | yes | Literal `"attribution/v1"`. |
| `generated_at` | yes | UTC timestamp this audit was produced. |
| `window.since` / `window.until` | yes | The audited time range, both UTC. |
| `sessions.exactly_attributed[]` | yes | `{session_id, tokens}` pairs — sessions cleanly resolved to exactly one task_run, the set this whole protocol exists to maximize. There is deliberately **no separate `sessions.measured` count field** anywhere: the total number of sessions audited is always `exactly_attributed.length` plus the four lists below's combined length, derived, never independently declared (sol architect-review must4 — a separately-declared count is a second source of truth that can silently drift from the lists it's supposed to summarize). |
| `sessions.unbound[]` / `.mixed[]` / `.orphan_usage[]` / `.measurement_incomplete[]` | yes | Disjoint session_id lists explaining every session **not** in `exactly_attributed`. Pairwise disjoint with each other and with `exactly_attributed`'s session_ids (a semantic check — see Verification). Every session_id here MUST have a matching `violations[]` entry with the corresponding `reason_code`, and vice versa — no session silently sits in a list with no recorded reason, and no violation references a session absent from its list. |
| `tokens.exact_attributed` / `.total_measured` | yes | Token totals. `exact_attributed` MUST equal the sum of `sessions.exactly_attributed[].tokens` (independently recomputed, never trusted as declared). `total_measured` MUST be `>= exact_attributed` (sol architect-review 2nd round — exactly_attributed's usage is a subset of everything measured, so the total can never be smaller than that subset). **Both null, not 0, when all five `sessions` lists are empty** (see Verification's null-not-zero check). `total_measured` is a measured total across every session, not a claim that all of it is attributable — only `exact_attributed` is. |
| `research_eligible` | yes | Boolean. **MUST be `false` whenever `violations` is non-empty** — see Verification. |
| `violations[]` | yes | `{reason_code, session_id, task_run_id?, detail}`. `session_id` is **required** (sol architect-review 2nd round must A1) — this schema's `reason_code` closed set is entirely session-keyed, so a violation without one could never be checked against the correspondence rule above and would slip through unverified. |

`violations[].reason_code` closed set:

```
UNBOUND_SESSION, MULTI_TASK_BINDING, ORPHAN_USAGE, MEASUREMENT_INCOMPLETE
```

## Identity & idempotency

A `binding-record` has no separate `event_id` of its own in v1 — its identity is the
underlying `trace-v1.md` `session_bound` event's `event_id` (`{task_run_id, session_id}`), and
a re-bind of the same session to the same task_run is idempotent for exactly the reason
`session_bound`'s identity table entry says it is. A re-bind of a session to a *different*
task_run is not idempotent by design: it produces a new binding-record and marks the old one
`binding_status: "superseded"`, and is itself evidence a `MULTI_TASK_BINDING` violation should
look for.

An `audit-result` is not upserted or corrected in place; it is a snapshot for one
`{window.since, window.until}` pair, regenerated fresh each time that window is audited. Two
audit runs over the same window may legitimately differ if new binding-records or usage
arrived between them — the later one is simply more complete, not a "correction" of the
earlier one in the `trace-v1.md` `supersedes_event_id` sense.

## Verification

Fixtures: [`contracts/attribution/v1/fixtures/`](../../contracts/attribution/v1/fixtures/),
verified by
[`contracts/attribution/v1/verify-fixtures.mjs`](../../contracts/attribution/v1/verify-fixtures.mjs)
(`node verify-fixtures.mjs`, no install step, no network access). `expected-results.json` in
that directory is the machine-readable table of which fixture is expected to be accepted or
rejected (with which reason code).

Beyond schema validation, eight semantic MUSTs neither schema alone can fully express:

1. **A `manual_bind` binding-record MUST carry `actor.kind == "human"`** (schema-enforced via
   `if`/`then`; `verify-fixtures.mjs` re-checks it as a defense-in-depth backstop).
2. **No `session_id` may have more than one binding-record bound to a DISTINCT `task_run_id`
   with `binding_status == "bound"` at the same time.** A cross-record check — a single
   record's own validity says nothing about whether some *other* record concurrently claims
   the same session for a different task. Deduped to distinct `{task_run_id, session_id}`
   pairs first (sol architect-review 2nd round must A2): the identical pair appended twice
   (e.g. an idempotent retry re-emitting the same record) is the same fact recorded twice, not
   two active bindings — row count alone would false-positive on that replay. See
   `binding-collection-idempotent-replay` (accept) vs. `binding-collection-multiple-active`
   (reject, genuinely distinct task_run_ids).
3. **An `audit-result` MUST have `research_eligible == false` whenever `violations` is
   non-empty.** This is fail-closed, not advisory — a producer's own judgment call that "the
   violations are probably fine" is never sufficient to declare a window research-eligible.
4. **An `audit-result`'s five `sessions` lists (`exactly_attributed`'s session_ids plus the
   four plain lists) MUST be pairwise disjoint.** No session_id may appear in more than one.
5. **Every session_id in `unbound`/`mixed`/`orphan_usage`/`measurement_incomplete` MUST have a
   matching `violations[]` entry with the corresponding `reason_code` — and every violation
   MUST correspond to a session_id actually present in its list.** This is the exact gap a sol
   architect-review round found: an audit-result with `sessions.mixed` non-empty, `violations`
   empty, and `research_eligible: true` passed every *other* check here vacuously (violations
   being empty trivially satisfied rule 3) — a mixed session could be silently un-flagged. See
   `invalid-mixed-without-violation`. A second round closed the remaining escape hatch: a
   violation with no `session_id` at all previously bypassed this check entirely (it was only
   ever compared against violations that HAD one) — `session_id` is now schema-required on
   every violation (must A1). See `invalid-violation-missing-session-id`.
6. **`tokens.exact_attributed` MUST equal the sum of `sessions.exactly_attributed[].tokens`.**
   The declared total is recomputed, never trusted as given.
7. **`tokens.total_measured` MUST be `>= tokens.exact_attributed`** (sol architect-review 2nd
   round must A3). `exactly_attributed`'s usage is a subset of everything measured; a total
   smaller than its own subset (e.g. `total_measured: 50` alongside an exact-attributed sum of
   100) is incoherent. See `invalid-total-measured-below-exact`.
8. **`tokens.exact_attributed`/`.total_measured` MUST be `null`, not `0`, when all five
   `sessions` lists are empty** (null-not-zero: "nothing was measured" and "zero tokens were
   measured" are different facts, and collapsing them would make an empty window
   indistinguishable from a window that genuinely measured zero usage).

**A binding writer MUST:**

- Use exactly one of the three v1 `binding_method` values; never invent a fourth.
- Attach a human `actor` for every `manual_bind` record.
- Mark a superseded binding's `binding_status` as `"superseded"` rather than deleting it, and
  never leave two records for the same session bound to different task_run_id values at once
  (re-emitting the identical binding record, e.g. on retry, is fine).

**An auditor MUST:**

- Set `research_eligible: false` whenever it records any `violations` entry, unconditionally.
- Give every session_id placed in `unbound`/`mixed`/`orphan_usage`/`measurement_incomplete` a
  matching `violations[]` entry, and give every such violation a `session_id` — never place a
  session in one of these lists "for now" without also recording why, and never record a
  violation without saying which session it's about.
- Recompute (never just carry forward) `tokens.exact_attributed` as the sum of
  `sessions.exactly_attributed[].tokens`, and ensure `tokens.total_measured` is at least that
  sum.
- Represent a fully-unmeasured window's token totals as `null`, never `0`.
- Never apportion a `mixed` session's usage by time ratio or any other heuristic between the
  tasks it touched — record it as `mixed` and exclude it from `exact_attributed`, full stop.
- Run with `--require-coverage 1.0` (or equivalent) before treating a window's data as fit for
  a research conclusion — a downstream consumer's job, but this document's fail-closed
  `research_eligible` field is what makes that gate possible to build at all.

## Versioning

**`attribution/v1` is fully immutable once frozen (sol architect-review round, main裁定),
matching [`trace-v1.md`](trace-v1.md)'s policy exactly.** No change of any kind — a new
optional field on either schema, a fourth `binding_method`, a fifth `reason_code`, a widened
`enum` anywhere — is permitted within v1 after freeze. Adding a fourth `binding_method` (e.g. a
future hook-based method, if its spike-measured failure mode is ever independently fixed)
requires `attribution/v2`, not a version-preserving addition. As in trace/v1: every object in
both schemas is `additionalProperties: false`, so there is no such thing as a
backward-compatible additive change a strict reader would even accept — a version number that
can still mean two different shapes isn't doing its job.

**Exception (main裁定):** the personal-dimension closed set's own "MAY extend this set; MUST
NOT shrink it" rule ([`agent-metrics-v1.md` section 7](agent-metrics-v1.md#7-trust-model)) is
explicitly carried over as **the one designated exception** to this immutability, exactly as
in [`trace-v1.md`](trace-v1.md)'s Versioning section — extending that set (in
`contracts/shared/personal-dimensions.mjs`) is not a version bump, since a personal-dimension
key is forbidden either way and widening the forbidden set can only narrow what's already
disallowed. There is no other "extensions" namespace in either schema for future growth to
land in without a version bump.

## Rejected designs

- **Hook-based session binding.** Considered before this contract was written and cut after a
  binding-feasibility spike found it fails silently: when the invoking agent's trust
  registration is missing, the hook simply does not fire, and there is no distinguishable
  signal between "correctly nothing to bind" and "the hook was supposed to fire and silently
  didn't." A closed-form join (`pre_assigned_session_id`, `self_reported_thread_id`) or an
  explicit human action (`manual_bind`) both fail loudly (a missing binding shows up as
  `UNBOUND_SESSION` in an audit) instead of failing invisibly. Hook-based binding may return in
  a future version once that silent-skip failure mode has an independent detection mechanism;
  v1 does not ship it.
- **Time-ratio apportionment of a mixed session's usage between its tasks.** A session that
  touched two task_runs (e.g. via `lane work switch`) has usage that cannot be
  attributed to either task without fabricating a split that no measurement actually
  supports. This protocol treats a mixed session as a *detection*, never a calculation input —
  its usage is excluded from `exact_attributed` and counted only in `total_measured`, in
  `sessions.mixed[]`, and as a `MULTI_TASK_BINDING` violation.
- **A numeric confidence score in place of closed status fields.** Neither `binding_status`
  nor `research_eligible` nor `reason_code` is ever a number expressing "how sure" a producer
  is. A closed enum/boolean forces every producer to actually resolve ambiguity into one of a
  fixed set of named states (or into an explicit `violations` entry) rather than passing a
  vague 0.73 downstream for every consumer to threshold differently. If a genuinely
  probabilistic signal is ever needed, it is a new, explicitly-named field with its own
  documented semantics — not a retrofit onto a field that today means "this either happened
  cleanly or it didn't."
- **A `cwd`-based "binding for the next session" marker file.** Considered as a lighter-weight
  alternative to passing an explicit session_id/nonce through `lane work run`'s environment.
  Rejected because two tasks started concurrently in different worktrees can race on the same
  marker location, silently binding the wrong session to the wrong task. `pre_assigned_session_id`
  and `self_reported_thread_id` both thread the identifier through the specific process
  invocation instead, which has no shared-mutable-state race to lose.
- **Tool-call-level attribution instead of session-level.** Consistent with
  `trace-v1.md`'s "Rejected designs" cut-line: this protocol's accounting unit is the session,
  not the individual tool invocation. A session that is cleanly bound to one task is
  `exactly_attributed` regardless of how many tool calls it made; sub-session attribution is
  not a v1 goal.
