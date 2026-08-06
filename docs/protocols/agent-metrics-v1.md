# agent-metrics/v1

Normative protocol for carrying AI-agent token/cost telemetry inside a PR (or equivalent
change) comment, and for a scheduled harvester to collect it into a metrics store without
requiring any developer-held credential.

This document is the contract. [`ai-metrics-platform-template.md`](../ai-metrics-platform-template.md)
is the pattern this contract implements one instance of (its §3 "Collection pipeline"
section describes the same marker-plus-harvester shape at a higher level; this document is
the concrete, machine-verifiable version of it). If the two ever disagree on a normative
point, this document wins for anything tagged `agent-metrics:v1` / `token-usage/v1`.

Conformance fixtures live in [`contracts/agent-metrics/v1/`](../../contracts/agent-metrics/v1/);
see section 10.

## 1. Purpose & scope

This protocol carries **one kind of information**: a snapshot of token-usage/cost records
for one measured subject (a delivery-pipeline run, a review run, or any other unit of work
an emitter chooses to measure), attached to a PR/change comment as a hidden marker.

It does not carry, and is not a substitute for:

- Human identity of any kind (see section 7 — this is enforced as a MUST, not a convention).
- Review findings, quality tiers, or any other non-cost telemetry (those are a different
  `schema` kind, out of scope for `token-usage/v1`; see section 9).
- A general-purpose event stream. Each marker is a complete snapshot for one subject, not
  one entry in an append-only log (section 5).

## 2. Envelope framing

```
<!-- agent-metrics:v1 payload_b64=<RFC 4648 base64> sha256=<lowercase 64-hex> -->
```

- This is an HTML comment. It is not rendered in a PR/change's rendered view — that is the
  entire reason the mechanism piggybacks on a comment the pipeline was already going to post
  rather than requiring a new surface.
- Fields are whitespace-separated `key=value` pairs. Unknown fields MUST be ignored by a
  reader (forward compatibility) — a reader only requires `payload_b64` and `sha256`.
- `sha256` is computed over the **decoded payload byte sequence** (the UTF-8 bytes that
  `payload_b64` decodes to), not over the base64 text itself.
- An HTML comment that does not open with the literal tag `agent-metrics:v1` is not a
  marker this protocol defines. A reader MUST ignore it (not error on it) — other tools are
  expected to post their own hidden comments on the same PR, and this protocol does not own
  the HTML-comment namespace. See `legacy-marker-ignored` in the fixture set.
- **`sha256` is a checksum, not a signature.** It detects accidental corruption and lets a
  harvester cheaply skip re-processing an unchanged comment. It proves nothing about who
  wrote the comment. See section 7 for where authentication actually lives.

## 3. Payload common fields (envelope-level)

Every `agent-metrics/v1` payload, regardless of kind, has this shape:

| Field | Required | Meaning |
|---|---|---|
| `protocol_version` | yes | Literal `"agent-metrics/v1"`. |
| `schema` | yes | Kind identifier, e.g. `"token-usage/v1"`. Governs how `data` is interpreted (section 4). |
| `upsert_key` | yes | `am1_<sha256 hex>` — see section 5. A harvester MUST NOT trust the declared value; it MUST recompute it and reject the payload on mismatch. |
| `emitter` | yes | `{name, version}` — provenance ("who produced this payload"), never an authentication claim. |
| `subject` | yes | `{namespace, type, id}` — what is being measured. Kept separate from `emitter` (who measured) and `repository`/`change` (where it happened) so those three concerns are never conflated into one ambiguous field. |
| `repository` | yes | `{provider, id}` — e.g. `{"provider": "github", "id": "owner/repo"}`. |
| `change` | no | `{type, number, url, head_sha}` — present when the subject was measured in the context of a specific change (e.g. a pull request). Not every subject has one; a scheduled, change-independent measurement omits it. |
| `generated_at` | yes | ISO 8601 UTC timestamp of when this payload was produced. |
| `data` | yes | Kind-specific body; see section 4 for `token-usage/v1`. |

JSON Schema: [`contracts/agent-metrics/v1/envelope.schema.json`](../../contracts/agent-metrics/v1/envelope.schema.json).

## 4. `token-usage/v1` schema

```json
{
  "protocol_version": "agent-metrics/v1",
  "schema": "token-usage/v1",
  "upsert_key": "am1_...",
  "emitter": { "name": "spec-lane", "version": "0.2.0" },
  "subject": { "namespace": "spec-lane", "type": "delivery-run", "id": "intent-2026-0417-telemetry-export" },
  "repository": { "provider": "github", "id": "owner/repo" },
  "change": { "type": "pull_request", "number": 42, "url": "https://...", "head_sha": "..." },
  "generated_at": "2026-08-07T00:00:00Z",
  "data": {
    "mode": "snapshot",
    "records": [
      {
        "activity": { "namespace": "spec-lane", "name": "3_implement" },
        "agent": "claude",
        "model": "claude-sonnet-5",
        "token_kind": "cache_write_5m",
        "tokens": 100,
        "priced_tokens": 100,
        "unpriced_tokens": 0,
        "estimated_cost_usd": 0.0003,
        "credits": 0,
        "pricing_status": "priced"
      }
    ],
    "coverage": {
      "status": "complete",
      "eligible_entries": 1,
      "measured_entries": 1,
      "excluded_entries": 0,
      "omissions": []
    }
  }
}
```

`data.mode` is always `"snapshot"` in v1 (there is no delta mode — see section 9).

`data.records[]` fields:

| Field | Required | Meaning |
|---|---|---|
| `activity.namespace` / `activity.name` | yes | What the tokens were spent on, e.g. a delivery-pipeline phase. This is a dimension of *work*, never of *person* — see section 6. |
| `agent` | yes | Which coding-agent tool, e.g. `"claude"`, `"codex"`. |
| `model` | yes | The specific model identifier string. |
| `token_kind` | yes | One of `input_nocache`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `cache_write_unknown`, `output`. This is the closed set a token/cost measurement CLI (e.g. `agent-cost`) natively produces. **These are never collapsed** into a single generic `cache_write` bucket in this protocol — an earlier, unpublished harvester did that collapse and lost real information a downstream cost-attribution consumer needed; this protocol does not repeat it (see section 9). |
| `tokens` | yes | Non-negative integer. |
| `priced_tokens` / `unpriced_tokens` | no | How many of `tokens` could/couldn't be priced. |
| `estimated_cost_usd` | no | Priced cost estimate. |
| `credits` | no | For credit-billed providers. |
| `pricing_status` | yes | `priced` \| `unpriced` \| `unknown`. |

`data.coverage` fields (honesty about what was and wasn't measured — a record set that
silently omits work it couldn't attribute is worse than one that says so explicitly):

| Field | Required | Meaning |
|---|---|---|
| `status` | yes | `complete` \| `partial` \| `no_data`. |
| `eligible_entries` | yes | Candidate population size. |
| `measured_entries` | yes | How many of those actually produced a record. |
| `excluded_entries` | yes | `eligible_entries - measured_entries`, tracked explicitly rather than left to be recomputed (and potentially miscomputed) downstream. |
| `omissions[]` | no | `{entry_id, reason, detail}` — one entry per excluded item, with a machine-readable `reason` code. A consumer that needs to know *why* something is missing reads this, rather than the absence being unexplained. |

The **only allowed dimensions** are the fields enumerated above. There is deliberately no
free-form `dimensions: {}` escape hatch — every schema object in this protocol declares
`additionalProperties: false` (see [`token-usage.schema.json`](../../contracts/agent-metrics/v1/token-usage.schema.json)).
Adding a new dimension requires a schema change (section 5), not a new key nobody agreed on.

## 5. Upsert identity & correction semantics

```
identity     = JCS({ "schema": ..., "repository": {...}, "subject": {...} })   # RFC 8785
upsert_key   = "am1_" + hex(sha256(UTF-8(identity)))
```

- `identity` is built from exactly three fields: `schema`, `repository`, `subject`. Nothing
  else. In particular, `generated_at`, the PR number/URL/`head_sha` in `change`, all token
  and cost values, and `emitter.version` are **excluded on purpose**: a re-measurement, a
  price-catalog update, or the PR's head moving to a new commit are all corrections to the
  *same* subject, and MUST resolve to the same `upsert_key` so a store upserts over the
  previous row instead of creating a new one next to it.
- **Snapshot replacement, not delta merge.** A payload with a given `upsert_key` fully
  replaces whatever a store holds for that key. If a corrected payload's `data.records`
  drops a record that was present in the previous payload, that record is gone — a harvester
  MUST NOT carry it forward as a leftover. See `correction-record-removed` in the fixture
  set: it demonstrates that dropping a stale record needs no explicit tombstone, only a
  smaller `data.records` in the replacing payload.
- **A harvester MUST recompute `upsert_key` and reject the payload if it does not match the
  declared value.** The declared value exists for human/tooling readability, not as
  something to trust. See `invalid-upsert-key` in the fixture set.
- Canonicalization is RFC 8785 JSON Canonicalization Scheme (JCS), chosen specifically
  because it is language-independent and has existing implementations in most ecosystems —
  an emitter and a harvester written in different languages must derive byte-identical
  canonical output from the same identity object.

## 6. Versioning rules

Two independent version axes:

- **`agent-metrics:v1` → `v2`**: a change to the envelope framing, base64 encoding, or hash
  convention (section 2) — anything that would break a reader before it even gets to parse
  a payload as JSON.
- **`token-usage/v1` → `v2`**: a change to this kind's required fields, field meaning, or
  the `upsert_key` recipe (section 5) — anything that would silently change what an existing
  consumer computes from the same bytes.

Within one version of either axis, only **additive, optional** field changes are allowed.
A harvester MUST normalize a known schema's payload to that schema's own fields and MUST
NOT carry an unrecognized field into its store — unknown-but-present fields are dropped, not
preserved as opaque data.

A payload whose `schema` value is not one a given harvester's implementation recognizes
MUST be routed to a rejection/audit log, not partially interpreted by guessing at which
fields might mean what a known kind's fields mean. See `invalid-unsupported-kind` in the
fixture set.

## 7. Trust model

- `sha256` (section 2) is **checksum, not signature**. It proves the payload wasn't
  corrupted in transit and lets a harvester skip re-processing unchanged comments; it proves
  nothing about who posted the comment.
- **Authentication is a transport-layer concern, not a payload-layer one.** A harvester MUST
  verify the comment's actual author against an allowlist (or an equivalent transport-level
  identity check, e.g. a GitHub App's bot identity) and MUST cross-check that the payload's
  own `repository`/`change` fields match the change the comment actually appeared on. A
  payload's internal fields are never sufficient proof of where it's allowed to land.
- **The comment author is never stored as metric data.** It is used once, at ingestion, for
  the authentication check above, and then discarded — it does not appear in any field this
  protocol defines, and a harvester MUST NOT add it as an extra column/property when
  persisting a record.
- **Personal-dimension keys are forbidden, as a MUST, anywhere in a payload.** The closed set
  a harvester and an emitter both check for (case-sensitive key match, anywhere in the nested
  structure, not just at the top level):

  ```
  author, reviewer, assignee, owner,
  user_id, username, email, display_name, handle, chat_id, real_name
  ```

  This set generalizes a personal-dimension guard already load-bearing in an existing,
  unpublished cost-telemetry pipeline; it is written here as the version anyone can depend
  on and extend, without depending on that pipeline's internals. Implementers MAY extend
  this set for their own deployment's identity conventions; they MUST NOT shrink it.
- **The check runs twice, independently: once in the emitter (before serializing a payload)
  and once in the harvester (before writing to a store).** Neither side is allowed to assume
  the other already did it. See `invalid-personal-dimension` in the fixture set — note that
  because every schema object here already declares `additionalProperties: false`, this
  fixture is also caught by ordinary schema validation; the dedicated scan is a second,
  schema-independent backstop so a future optional-field addition can't accidentally reopen
  the door.
- *Why this matters:* token/cost telemetry is a process-improvement signal. The moment it
  carries an identity dimension, it becomes usable as an individual-performance instrument,
  which changes what people optimize for (Goodhart's law) and is not what this protocol is
  for. Removing the identity axis at the schema level, rather than trusting every consumer's
  dashboard to filter it out, is what makes that misuse structurally impossible rather than
  merely discouraged.

## 8. Limits

Tunable; the values below are v1's initial defaults, not derived from a hard technical
ceiling — they exist to bound a runaway or malfunctioning emitter, not to be precisely
optimal:

| Limit | v1 default |
|---|---|
| Payload size (decoded bytes) | ≤ 64 KB |
| `data.records[]` length | ≤ 500 |
| JSON nesting depth | ≤ 8 |

A payload exceeding any of these MUST be rejected, not truncated — silent truncation would
produce a snapshot that looks complete but isn't.

## 9. Rejected designs

- **Flat `source_id` instead of `{emitter, subject, repository, change}`.** Collapses four
  independent concerns (who measured / what was measured / where / in what change context)
  into one string a consumer has to re-parse by convention. Splitting them is one extra
  field's worth of verbosity and removes a whole category of parsing ambiguity.
- **Mixing multiple `schema` kinds or multiple subjects in one payload.** A payload is one
  kind, one subject, one snapshot. Mixing kinds/subjects would make `upsert_key` ambiguous
  (whose identity does it describe?) and would force every consumer to branch on content
  rather than on the declared `schema`.
- **Delta/append records instead of full snapshots.** A delta model requires a consumer to
  replay an ordered history correctly to reconstruct current state, and any missed or
  duplicated delta silently corrupts that state with no local way to detect it. A snapshot
  is self-correcting: the latest payload for a given `upsert_key` is simply the whole truth,
  and a missed harvester run just means slightly stale data, never corrupted data.
- **Per-record `upsert_key` instead of one per payload.** Would require the emitter to carry
  stable per-record identity across re-measurements (e.g. "is this the same activity/agent
  breakdown row as last time, or a new one?") — a much harder problem than giving the whole
  snapshot one identity and letting the snapshot's own contents be the full answer to "what
  does this subject's usage look like right now."
- **Collapsing `cache_write_5m`/`cache_write_1h`/`cache_write_unknown` into one `cache_write`
  bucket.** An earlier, unpublished harvester did this to match a narrower internal
  consumer's needs. It threw away real information (cache TTL) a different downstream
  consumer legitimately needs, for no protocol-level reason. This protocol keeps the
  measurement CLI's native granularity and lets consumers aggregate it themselves if they
  want the coarser view.

## 10. Conformance

Fixtures: [`contracts/agent-metrics/v1/fixtures/`](../../contracts/agent-metrics/v1/fixtures/),
verified by [`contracts/agent-metrics/v1/verify-fixtures.mjs`](../../contracts/agent-metrics/v1/verify-fixtures.mjs)
(`node verify-fixtures.mjs`, no install step, no network access). `expected-results.json` in
that directory is the machine-readable table of which fixture is expected to be accepted,
rejected (with which reason code), or ignored.

**An emitter MUST:**

- Serialize a payload matching section 3/4's schema exactly (no extra fields; see
  [`token-usage.schema.json`](../../contracts/agent-metrics/v1/token-usage.schema.json)).
- Compute `upsert_key` via section 5's exact recipe.
- Run the personal-dimension scan (section 7) before serializing, and refuse to emit if it
  finds a violation rather than emitting anyway.
- Respect the limits in section 8.

**A harvester MUST:**

- Ignore any HTML comment not tagged `agent-metrics:v1` (section 2).
- Verify `sha256` against the decoded payload bytes before parsing JSON; reject on mismatch
  (`invalid-hash` fixture).
- Reject payloads whose `payload_b64` does not decode as valid base64 (`invalid-base64`
  fixture).
- Recompute `upsert_key` independently and reject on mismatch (`invalid-upsert-key` fixture).
- Run the personal-dimension scan independently of the emitter's own check (section 7,
  `invalid-personal-dimension` fixture).
- Route an unrecognized `schema` value to a rejection/audit log without partial
  interpretation (`invalid-unsupported-kind` fixture).
- Authenticate the comment's actual author against a transport-level allowlist/identity
  check and cross-verify against the payload's own `repository`/`change` fields (section 7)
  — this is not exercised by a JSON fixture, since it is a property of the transport, not of
  the payload; it is normative here regardless.
- Treat a payload with an already-seen `upsert_key` as a correction (upsert), never as a
  new, additional row (`correction-same-key`, `correction-record-removed` fixtures).
