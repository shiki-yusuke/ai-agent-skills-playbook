# trace/v1

Normative protocol for the append-only Decision-Evidence trace ledger: the record of
*relationships between things* (an artifact revision declaring another, a task run being
bound to a session, usage being imported and attributed) that a delivery pipeline can derive
an index from, without that index ever being the thing anyone has to trust.

This document is the contract. It formalizes the "trace ledger (JSONL)" piece of the
Decision-Evidence Graph design: the content of record stays each artifact's own file; the
ledger is the record of *runtime facts and edges between artifact revisions*; any SQLite/graph
index built from it is disposable and re-derivable, never authoritative on its own.

Conformance fixtures live in [`contracts/trace/v1/`](../../contracts/trace/v1/); see the
Verification section below.

Companion protocol: [`attribution-v1.md`](attribution-v1.md) (session-to-task binding and
audit results) is built on top of trace/v1's `session_bound`/`usage_imported`/`attributed_to`
relations — read this document first.

## Purpose

A trace ledger is a sequence of **events** (JSONL, one object per line), each one edge in a
graph whose nodes are either:

- an **artifact_revision** — a specific content revision of a file the repo already tracks
  (e.g. `intent.yaml`, `spec.md`, `decision.yaml`), identified by `<logical_id>@sha256:<digest>`
  (a bare logical_id alone can't tell revision N apart from revision N+1 of the same file); or
- a **runtime_entity** — a run, a session, a release, or similar, which has no content
  revision to pin, identified by its bare logical_id alone (e.g. `run:<id>`, `session:<id>`).

This ledger is the single normative record of every such edge. It does not carry, and is not
a substitute for:

- The content of any artifact (that stays in the artifact's own file; the ledger only records
  that an edge to/from some revision of it exists).
- A mutable/rewritable event log. Every past line stays exactly as it was written forever; a
  correction is a *new* line (see "Identity & idempotency" below), never an edit.
- Fine-grained execution telemetry (per-tool-call events, live branch/file-change monitoring).
  v1's cut line is deliberately coarser than that — see "Rejected designs."

## Format

One event is one JSON object (one line of a `.jsonl` file). Schema:
[`contracts/trace/v1/trace-event.schema.json`](../../contracts/trace/v1/trace-event.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `schema_version` | yes | Literal `"trace/v1"`. |
| `event_id` | yes | `tr1_<sha256 hex>` — see "Identity & idempotency." A reader MUST recompute it and reject the event on mismatch. |
| `relation` | yes | Closed set (below). |
| `from_ref` / `to_ref` | yes | `{logical_id, content_digest?}` — the edge's two endpoints. `content_digest` is present for an artifact_revision endpoint, absent for a runtime_entity endpoint. For `session_bound`/`usage_imported`/`task_run_started`, `logical_id` on the relevant end MUST equal the `"task_run:<task_run_id>"`/`"session:<session_id>"`-derived string (a redundant encoding of `task_run_id`/`session_id`; a reader MUST cross-check the two never silently drift apart — see `invalid-ref-field-mismatch`). |
| `occurred_at` | yes | UTC only, literal `Z` suffix. No local-offset timestamp is representable — a writer MUST convert before emitting. |
| `actor` | yes | `{kind: human\|agent\|cli\|ci, id?, version?}`. |
| `trace_id` / `span_id` / `parent_span_id` | no | Distributed-tracing correlation, orthogonal to the ledger's own identity. |
| `lane_id` / `task_run_id` / `phase_run_id` / `session_id` | conditionally | Delivery-pipeline correlation fields. `task_run_id`/`session_id` become **required** for specific `relation` values per the identity table below (`session_bound`, `task_run_started`, `attributed_to`, `usage_imported`) — enforced structurally via `if`/`then` in the schema, not left as a convention. |
| `causation_event_id` | no | `event_id` of the event that *caused* this one — a different relationship from `supersedes_event_id` (correction, not causation). |
| `payload` | conditionally | Relation-specific body, otherwise unconstrained by this schema (each relation's own shape is informal). Excluded from `event_id` identity as a whole (see below) except for one named exception. **Required, with a required `window: {since, until}` sub-object, when `relation == "usage_imported"`** — the one relation where this schema reaches inside `payload`. |
| `supersedes_event_id` | no | `event_id` of the event this one corrects. **Folded into `event_id` identity when present** (see Identity & idempotency) and **MUST NOT equal this event's own `event_id`** (a self-reference) — the latter isn't expressible as a schema constraint in this repo's validator subset (comparing one field to another, not to a fixed value), so it's enforced in `verify-fixtures.mjs`; see the `invalid-self-supersedes` fixture. |

`relation` closed set:

```
declares, refines, acknowledges, critiques, implements, verifies, produced_by,
incurred_usage, attributed_to, deployed_as, supersedes, invalidates,
session_observed, session_bound, task_run_started, usage_imported,
incident_observed, rolled_back_to
```

`incident_observed` and `rolled_back_to` are **reserved**: valid values a v1 reader MUST
accept, but no v1 fixture exercises them yet (no producer emits them in v1's cut line).

Personal-dimension keys are forbidden anywhere in an event, re-listing the exact closed set
from [`agent-metrics-v1.md` section 7](agent-metrics-v1.md#7-trust-model) (`author`,
`reviewer`, `assignee`, `owner`, `user_id`, `username`, `email`, `display_name`, `handle`,
`chat_id`, `real_name`) — that set may only be extended across every contract that adopts it,
never shrunk. This matters here specifically because `payload` is schema-unconstrained (an
open object), so a personal-dimension key hidden inside it would slip past
`additionalProperties: false` entirely; the dedicated scan (see Verification) is what actually
catches it.

## Identity & idempotency

```
identity   = <relation-specific field subset, see table below>
event_id   = "tr1_" + hex(sha256(JCS({schema: "trace/v1", relation, identity})))   # RFC 8785
```

`identity` is **not** "the whole event minus a few fields" — it is a relation-specific
allowlist, chosen so that re-emitting the *same fact* always resolves to the same `event_id`
(idempotent), while facts that differ mint different ids:

| `relation` | `identity` fields |
|---|---|
| `session_bound` | `{task_run_id, session_id}` |
| `task_run_started` | `{task_run_id}` |
| `usage_imported` | `{task_run_id, session_id, window: {since, until}}` — see note below |
| `attributed_to` | `{from_ref.logical_id, to_ref.logical_id, task_run_id}` (logical_id only, no `content_digest`: attribution binds to a stable logical thing, not one content revision of it) |
| every other relation | `{relation, from_ref: {logical_id, content_digest?}, to_ref: {logical_id, content_digest?}}` (full ref identity on both ends) |

**`occurred_at` and `payload` as a whole are excluded from every relation's identity.** A
re-run at a different wall-clock time, or a payload carrying one extra diagnostic field, MUST
NOT mint a new `event_id` for the same fact — otherwise idempotent re-emission would be
impossible and every retry would silently duplicate the ledger.

**Named exception:** `usage_imported`'s `window.since`/`window.until` live inside `payload`
(there is no top-level `window` field), yet they *do* participate in identity. This is not a
contradiction of the rule above — `window.since`/`until` describe **what period this import
covers**, a stable fact about the import itself, not **when the import ran** (which is what
`occurred_at` and the "exclude payload" rule exist to keep out). Re-importing the same window
twice MUST resolve to the same `event_id`; re-running the import job at a different time for
a *different* purpose must not silently collide with an unrelated window's import. `window.since`
MUST be strictly earlier than `window.until` (both UTC); a reader MUST reject an event whose
window is inverted or zero-width — see `invalid-window-ordering`. **This identity stays exactly
`{task_run_id, session_id, window.since, window.until}` even if the same window is re-imported
under a different `token_basis` or other varying import parameter** — see "Rejected: multi-source
identity" below; that case is a correction (below), not a reason to widen identity.

**Before computing `event_id`, a reader MUST check that every identity field the relation
requires is actually present** (the table above) **and reject with a missing-field reason if
not, rather than attempting the hash anyway.** Feeding a missing field into the JCS
canonicalizer as `undefined` produces a well-defined-looking but meaningless string (JavaScript
coerces it to the six characters `undefined` rather than erroring) — a naive implementation can
silently "succeed" at hashing an incomplete identity and produce a hash nobody could ever
reproduce correctly. See `invalid-missing-session-id` and `invalid-missing-window`.

**Corrections are new events, never rewrites.** A correction carries `supersedes_event_id`
equal to the event it corrects; the original line is never edited or removed. **When
`supersedes_event_id` is present, it is folded into `event_id`'s identity object** (in addition
to the relation's own identity fields above) — a correction that changes nothing else (e.g. a
payload-only fix, same `from_ref`/`to_ref`/`content_digest` as the event it corrects) would
otherwise compute the *same* identity as the original and collide with it, rather than minting
a distinguishable new fact layered on top via `supersedes_event_id`. See the
`supersedes-payload-only-pair` fixture, which exists specifically to prove this. A conformant
`event_id` therefore MUST NOT equal its own `supersedes_event_id` (a self-reference is
meaningless — an event cannot correct itself); see `invalid-self-supersedes`.

A reader MAY encounter a `supersedes_event_id` that doesn't resolve to any event it has loaded
— the ledger may be split across segments/files, and the original could be in one the reader
hasn't read yet. **This MUST NOT be treated as a validation failure at the single-event level**
(see the `cross-segment-supersedes` fixture and Rejected designs' note on referential
integrity).

## Verification

Fixtures: [`contracts/trace/v1/fixtures/`](../../contracts/trace/v1/fixtures/), verified by
[`contracts/trace/v1/verify-fixtures.mjs`](../../contracts/trace/v1/verify-fixtures.mjs)
(`node verify-fixtures.mjs`, no install step, no network access). `expected-results.json` in
that directory is the machine-readable table of which fixture is expected to be accepted or
rejected (with which reason code), including the explicit design-decision note on
cross-segment `supersedes_event_id` references.

Three independent layers, mirroring `agent-metrics/v1`'s redundancy on purpose (none of the
three stands in for another):

1. **Schema validation** against `trace-event.schema.json` (closed `relation` set, two-part
   `from_ref`/`to_ref`, per-relation required fields via `if`/`then`). Every object in the
   schema declares `additionalProperties: false` **except `payload`**, which is deliberately
   left open (each relation's payload shape is informal, not a normative closed set) — the
   personal-dimension scan (layer 3) exists specifically to still police that one open object.
2. **`event_id` recomputation** — a reader MUST independently recompute it via the recipe
   above (checking required-field presence first, never hashing an incomplete identity) and
   reject the event on mismatch; the declared value is never trusted as-is. This layer also
   covers the self-reference check and the `from_ref`/`to_ref` ↔ `task_run_id`/`session_id`
   consistency check, neither of which is a plain schema constraint.
3. **Personal-dimension scan** — independent of schema validation, because `payload` is the
   one schema-unconstrained object (see layer 1).

**A writer MUST:**

- Compute `event_id` via the exact recipe above before appending, including
  `supersedes_event_id` in the identity object whenever the event carries one.
- Never set `supersedes_event_id` equal to the event's own `event_id`.
- Convert `occurred_at` (and, for `usage_imported`, `payload.window.since`/`until`) to UTC
  before emitting; never emit a local-offset timestamp. Ensure `window.since < window.until`.
- Keep `from_ref`/`to_ref`'s `logical_id` consistent with `task_run_id`/`session_id` for
  `session_bound`, `usage_imported`, and `task_run_started`.
- Never rewrite or delete a past line; a correction is always a new line with
  `supersedes_event_id` set.
- Run the personal-dimension scan before appending, and refuse to append if it finds a
  violation.

**A reader MUST:**

- Check every identity field the event's `relation` requires is present before attempting to
  recompute `event_id`; reject with a missing-field reason rather than hashing an incomplete
  identity.
- Recompute `event_id` independently (including `supersedes_event_id` in identity when
  present) and reject the event on mismatch.
- Reject an event whose `supersedes_event_id` equals its own `event_id`.
- Cross-check `from_ref`/`to_ref`'s `logical_id` against `task_run_id`/`session_id` for the
  relations where both are present, and reject on drift.
- Reject a `usage_imported` event whose `payload.window.since` is not strictly earlier than
  `payload.window.until`.
- Accept `incident_observed`/`rolled_back_to` as valid `relation` values even though v1 ships
  no fixture for them (they are reserved, not deprecated-and-forbidden).
- Not treat an unresolved `supersedes_event_id` as a validation failure at the single-event
  level (it may reference a different ledger segment).
- Run the personal-dimension scan independently of any writer-side check.

## Versioning

`trace/v1` → `v2` covers a change to the `event_id` recipe (the identity table above) or to
any *required* field — anything that would silently change what an existing reader computes
from the same bytes, or that would make an existing reader's recomputed `event_id` for
already-written events wrong.

Within v1, only **additive, optional** field/relation changes are allowed: a new optional
field, or a new reserved `relation` value (as `incident_observed`/`rolled_back_to` already are
in this same version), does not require a version bump. The personal-dimension closed set may
only be extended, never shrunk, within v1 or across a version bump.

## Limits

Tunable; not derived from a hard technical ceiling, same posture as
[`agent-metrics-v1.md` section 8](agent-metrics-v1.md#8-limits):

| Limit | v1 default |
|---|---|
| Event size (decoded bytes) | ≤ 16 KB |
| JSON nesting depth | ≤ 8 |

An event exceeding either MUST be rejected, not truncated.

## Rejected designs

- **Multi-source identity for `usage_imported` (sol architect-review round, main裁定).**
  Considered: widening `usage_imported`'s identity to include something like `token_basis` so
  that re-importing the *same window* under a *different* token-accounting basis would mint a
  distinguishable new `event_id` rather than being treated as a correction of the same fact.
  Rejected. `identity` stays exactly `{task_run_id, session_id, window.since, window.until}` —
  a re-import of the same window is always the same fact (usage for that task_run/session over
  that period), no matter which basis it was measured under; the fact that a *different*
  measurement basis was used the second time is exactly what a correction (`supersedes_event_id`,
  see Identity & idempotency) exists to represent. Widening identity to accommodate this would
  turn every varying import parameter into a new identity axis, one per parameter someone
  eventually wants to change independently — multi-source identity, not single-source-of-truth
  identity. A re-import under a new basis is a `supersedes_event_id`-carrying correction of the
  original `usage_imported` event, full stop.
- **`occurred_at` (and `payload` as a whole) in `event_id` identity.** Would make every
  re-emission of the same fact mint a new id, turning an idempotent append into a silent
  duplicate generator on every retry. The one deliberate exception
  (`usage_imported`'s `window.since`/`until`) is named explicitly in the identity table
  precisely so it doesn't get read as license to include more of `payload` by analogy.
- **PreToolUse-per-tool-call event granularity.** Considered and cut at the v1 line (see the
  platform design's trace-ledger cut-line note): every individual tool invocation as its own
  ledger line would make the ledger grow far faster than the accounting principle it exists
  to serve (`1 session -> N tasks over its lifetime`, audited at the session/task_run level)
  actually needs. Tool-call-level attribution is not a v1 goal; if it becomes one, it is a new
  relation and a new fixture, not a retrofit onto existing events.
- **Live branch/worktree monitoring as ledger events.** A ledger event is a fact someone
  explicitly recorded (a bind, an import, a declared edge), not a continuous filesystem
  watcher's opinion. Branch/worktree mismatches are a fail-closed *audit* signal (see
  `attribution-v1.md`), computed at audit time from what was actually recorded — not something
  this ledger's writer is expected to poll for and log continuously.
- **Mutable/delete-based corrections instead of `supersedes_event_id`.** An editable or
  deletable ledger loses the one property that makes "what actually happened" independently
  auditable after the fact: every past claim, including a since-corrected one, stays visible.
  A wrong or stale fact is superseded, not erased — the correction itself becomes part of the
  history rather than hiding that a correction happened.
- **Rejecting an event whose `supersedes_event_id` doesn't resolve locally.** A single-file or
  single-segment validator cannot know whether the original event lives in a segment it
  hasn't loaded; treating "not found here" as "invalid" would make partial-ledger validation
  (e.g. validating one day's new events without the whole history in hand) impossible.
  Referential integrity of `supersedes_event_id`, if ever enforced, belongs to a whole-ledger
  compaction/audit tool, not to per-event validation.
