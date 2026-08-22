# release-evidence/v0 — DRAFT

> **Status: DRAFT, deliberately unfrozen.** v1 freezes only after the first deploy adapter has
> been exercised against a real deployment (the Pages adapter against the agent-metrics
> dashboard, per the 2026-08-22 re-plan). Freezing an implementation-shaped contract before any
> implementation has consumed it is the premise_evidence mistake this repo's own history warns
> about — release-observation/v0's protocol document said exactly this about the present
> contract, and it applies to the present contract too.

Normative protocol for D5's **deployment state machine v1**: the Release Evidence Bundle
assembled before any deploy, and the append-only event ledger that carries one bundle's digest
through preview → (staging) → production. This is the E-phase half of the observation chain;
`release-observation/v0` (observation-only, no state machine) remains valid and untouched for
releases that happened outside this machine.

Conformance fixtures: [`contracts/release-evidence/v0/`](../../contracts/release-evidence/v0/)
— run `node contracts/release-evidence/v0/verify-fixtures.mjs` (zero dependencies, no network).

## The two record types

**Release Evidence Bundle** (`release-evidence-bundle.schema.json`) — everything known about a
release *before* it is deployed anywhere: `source` (repo / commit / **tree digest** — the tree,
not the commit, is what survives a squash merge), `lane_ref` (digest pins of every lane
artifact, or `null` **with a required reason** for lane-less releases such as scheduled
dashboard rebuilds), `review` (PR provenance, same null-with-reason convention), `artifacts[]`
(sha256 digests; static sites carry a content-root digest over a canonical path→sha256 manifest
rather than a tarball digest), `build` (recipe + toolchain digests: what was run, and what ran
it), `known_deviations`, `rollback.previous_release_id`, and `integrity` (v0: `digest_only`,
`signature: null` — a solo operator whose CI and deploy credentials share one trust domain
gains nothing from signing; the field exists so `signed` can be added without reshaping).

**Release event** (`release-event.schema.json`) — one transition of the state machine, one line
of an append-only `release-events.jsonl`. Current state is always **derived by folding**; no
event stores a computed state; corrections are new events. `bundle_digest` on every event is
the same-artifact invariant: build once, promote the same evidence everywhere.

## The state machine (enforced at collection level)

```
(none) → prepared → preview_deployed → preview_verified
                                          ├→ staging_deployed → staging_verified ┐
                                          └──────────────────────────────────────┴→ production_deployed
production_deployed → production_verified | failed | rolled_back
production_verified → failed | rolled_back
failed, rolled_back  → (terminal)
```

Three semantic MUSTs live in `verify-fixtures.mjs` (and in any implementation), not in the
schemas, because they are cross-record: **transition legality** (above), **same
`bundle_digest` per release**, and **no dangling `rollback_to_release_id`**.

## What v0 deliberately leaves out

- **Automatic anything.** `actor` has no `agent` member; automatic promotion and automatic
  rollback are out of scope exactly as D5 defers them.
- **Signed integrity**, SLSA, SBOM — until the CI/deploy trust domains separate.
- **Gate predicates as schema.** "production requires preview_verified + lane done overlay +
  tree match" is implementation logic the fixtures pin behaviorally; encoding policy into the
  schema would freeze policy at v0's maturity.
- **trace/v1 relation promotion.** `incident_observed` / `rolled_back_to` stay reserved names
  in trace/v1 documentation; giving them identity/payload shape is trace/v2 work, not v0's.

## Relationship to release-observation/v0

Naming is a strict superset by construction: `release_id`, tree digests, `sha256:` artifact
digests, and rollback references mean the same thing in both. An observation event can be
mechanically derived from a bundle + a terminal machine state; the reverse is impossible
(observation events carry no lane/review/build evidence), which is the entire reason this
contract exists.

## Fixture provenance

`accept-bundle-spec-lane-0-6-0.json` carries **real measured values** (2026-08-22: git
commit/tree from the `v0.6.0` tag, npm tarball sha256 fetched and hashed live, recipe/toolchain
digests hashed from the tag's own files). `accept-bundle-static-site-synthetic.json` and all
event fixtures are **synthetic shapes**; the static-site placeholders are to be replaced with
real measured values by the first Pages adapter exercise — the same exercise that gates v1.
