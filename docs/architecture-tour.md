# Architecture tour

A one-pass walk through how the tools in [`getting-started.md`](getting-started.md) connect. This is not a tutorial for any single tool — see that page's Recipes for runnable commands, and each tool's own README for its full command surface. This page exists to answer one question: **when a change moves through the whole pipeline, what does each stage actually check, and what does it just pass along?**

Every example below is either a fixture already checked into this repository (`contracts/**/fixtures/`) or a synthetic value invented for this page — never real usage data.

## The measurement pipeline

```
agent-cost              spec-lane                 agent-metrics:v1        agent-metrics-harvester   agent-metrics-report
(local log read)  --->  (work binding,       ---> (PR comment marker) --> (collect + store)    -->  (aggregate)
                         usage-import,
                         attribution audit,
                         emit-metrics)
```

| Stage | What it verifies | What it does *not* verify |
|---|---|---|
| **agent-cost** reads `~/.claude/projects/**/*.jsonl` / `~/.codex/state_5.sqlite` | That a given `usage` block was actually written to disk by Claude Code / Codex CLI, and prices it against a versioned rate catalog | Whether the *session itself* corresponds to any particular task — agent-cost has no concept of tasks, only logs |
| **`lane work bind` / `lane work run`** binds a `session_id` to a `task_run` | That a binding record exists, is schema-valid, and (per `attribution/v1`) that at most one binding is active per task_run at a time | That the bound session was *actually* the one doing the work — `lane work run` (which spawns the process itself) closes this gap; `lane work bind` (a manual, after-the-fact declaration) does not |
| **`lane usage-import`** matches bound sessions against agent-cost | That token totals for a `session_id` inside the task_run's time window came from agent-cost, not invented | Completeness — agent-cost has no session-enumeration API, so a session it never logged (or one outside the import window) is reported `MEASUREMENT_INCOMPLETE`, not silently zero |
| **`lane attribution audit`** classifies every bound/imported session | That the ledger's own internal accounting is consistent — `exactly_attributed` + `mixed` + `orphan_usage` + `measurement_incomplete` are disjoint categories with schema-checked totals (see `contracts/attribution/v1/fixtures/`) | That the underlying binding was honest — this is a consistency check on records already made, not a fraud detector |
| **`lane emit-metrics`** builds an `agent-metrics:v1` snapshot | That the payload's own fields satisfy the schema, and stamps a `sha256` **checksum** over the payload so a corrupted comment is detectable | Who is allowed to post it — the protocol document is explicit that `sha256` is a checksum, not a signature; authentication is a transport-layer decision made downstream |
| **`agent-metrics-harvester`** reads the PR/issue comment | That the comment's actual author (or posting GitHub App) is on an explicit allowlist, and that the payload's own `repository`/`change` fields match where the comment actually appeared | The truth of the numbers inside the payload — if every upstream stage was honest, the harvester trusts the checksum-verified content; it has no independent measurement of its own |
| **`agent-metrics-report`** aggregates the store | That its output is a deterministic function of what's already in the store | Anything about the pipeline upstream of the store — this is read-only aggregation |

The `lane work` / `usage-import` / `attribution audit` rows above reflect real, verified output
from the globally installed `spec-lane` CLI (`0.5.2`) at the time this page was written. This
repository's own README currently marks `trace/v1` and `attribution/v1` as **contract-only** (no
declared reference implementation yet) — see [Public interoperability
protocols](../README.md#public-interoperability-protocols) for the authoritative status of each
protocol before depending on this table for anything beyond a behavioral preview.

Two schema-level guardrails apply at every stage that touches a payload, not just one: **`measure/v1`, `agent-metrics/v1`, `attribution/v1`, and `trace/v1` all reject a personal-identifier dimension outright.** For example, `contracts/measure/v1/fixtures/invalid-personal-dimension.json` is a structurally valid measurement snapshot that additionally carries an `author`/`user_id`/`email`/... field — every one of the fixtures in this repo's `contracts/*/v1/fixtures/invalid-personal-dimension.json` is rejected by that schema's own `verify-fixtures.mjs` (all four currently pass 100% in this repo's fixture suite — 9/9 for `measure/v1`, 11/11 for `agent-metrics/v1`, 21/21 for `attribution/v1`, 26/26 for `trace/v1`, run directly: `node contracts/<name>/v1/verify-fixtures.mjs`). This is a process-telemetry pipeline, not an individual-performance one, and that constraint is enforced in schema, not just policy.

## The other axis: verification and evaluation

These three tools don't sit in the cost pipeline above — they answer a different question (did the work actually happen as claimed / is a claim's provenance real / does a judge react correctly to a meaningful change) and can be adopted independently of it.

| Tool | What it verifies | What it does *not* verify |
|---|---|---|
| **evidence-docs** re-checks a claim's `content_digest` against the git blob at its declared commit | That a claim's cited source file *actually contained* the referenced content at that commit — not the current worktree, not a stale hash | The truth of the claim's prose statement itself, or whether `affected_paths` is complete — see its own `docs/schema.md` for the full list |
| **evigate** compares an agent's declared claims against tool-observed events in the same transcript | That a `test_pass`/`build_ok`/... claim has a matching, successful, unresolved-failure-free command in the event stream before the report — deterministically, via detectors `D1`–`D3` | File edits made via a raw shell command (`sed -i`, a redirect) rather than a structured `Edit`/`Write` tool call — invisible to the scope detector; `task_done` claims are never marked `proven` at all, by design |
| **acyclic-eval** compares a judge's recorded output against expected verdicts computed *without ever calling that judge* | That generation, judgment, and comparison stayed structurally separate for a given corpus + operator set (its own worked example: evigate's 113-case, 8-operator mutation suite) | Semantic correctness of the judge on real-world data, or that a corpus/operator set was well-chosen — it evaluates *sensitivity to structural change*, not accuracy |

`evigate` is, in fact, the connection between the two halves of this page: its own mutation-testing harness (`evigate mutate` / `evigate eval`) is an adapter built on top of `acyclic-eval`, used to measure evigate's own detector precision without the detector influencing which test cases exist. See evigate's README, "Evaluation" section, for that worked example in full.

## Reading the fixtures yourself

Every `accept-*` / `invalid-*` pair under `contracts/*/v1/fixtures/` is a minimal, hand-written example of exactly one thing a schema allows or rejects — they are the actual conformance suite each protocol's `verify-fixtures.mjs` runs, not illustrative snippets. If you want to see a specific trust-boundary claim above in schema form rather than prose, that directory is the place to look before reading the TypeScript/Python source of any consuming tool.
