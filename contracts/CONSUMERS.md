# Consumers of these contracts (hub-side conformance)

This repository is the contract hub. It is deliberately **not** a monorepo (frozen decision D,
2026-10-16): consumers stay separate repositories and the two sides check each other.

| Consumer | Kind | What the hub re-checks on every contract PR |
|---|---|---|
| `shiki-yusuke/release-evidence` | live (reads `contracts/release-evidence/v0` at test time) | its contract-dependent tests against this PR's contract, plus a negative probe that must fail |
| `shiki-yusuke/spec-lane` | vendored (`measure/v1`, `design-options/v1`, `shared/derive-independence.mjs`) | pinned upstream commit is an ancestor of HEAD; every vendored file is byte-identical to the pin; no unlisted files |
| `shiki-yusuke/agent-metrics-harvester` | vendored (`agent-metrics/v1`) | same as above |

The pins live in [`consumers.json`](./consumers.json) (validated by
[`consumers.schema.json`](./consumers.schema.json)). That file carries **data only**: shas, dates
and file manifests. Which repositories may be checked out and which commands run are fixed in
[`shared/consumer-conformance.mjs`](./shared/consumer-conformance.mjs), so editing the JSON cannot
make CI run arbitrary code.

## Rules

- **Breaking changes go add -> migrate -> remove.** A contract directory that a consumer
  references at the PR's base revision may not be deleted in that PR (the gate reads the *base*
  `consumers.json`, so dropping the reference and the directory together does not bypass it).
  Migrate the consumer, merge the reference removal, then remove the contract.
- **Vendored consumers are not failed by contract edits.** A fixed copy does not consume the PR.
  The job emits a `::warning::` when a PR touches a vendored path and a `::notice::` for drift
  since the pin; re-vendoring is a consumer-side change.
- **Pins are advanced by a human** after the consumer's own merge: bump `sha` and `pinned_at`
  in `consumers.json` in a hub PR. A pin older than 90 days warns on every run; a consumer
  default branch that moved past the pin is reported as a notice. Owner: the hub maintainer.
- **Locally** the same entry point runs as in CI:

  ```sh
  node contracts/shared/consumer-conformance.mjs --validate
  node contracts/shared/consumer-conformance.mjs --consumer spec-lane --checkout ../lane --base <sha>
  node contracts/shared/consumer-conformance.mjs --consumer release-evidence --checkout ../release-evidence --break-contract
  ```

  `--base` defaults to `merge-base origin/main HEAD`; CI passes the PR base sha. Every
  subprocess has a fixed timeout (git 60 s, install 600 s, tests 300 s) and runs in its own
  process group; `CONSUMER_CONFORMANCE_TIMEOUT_SCALE` (1..3) is the only environment knob.

## Consumer-side half

Each consumer verifies its own copy / pin in its own CI (`spec-lane`: `pin-verify.ts` against a
checkout of this repo; `agent-metrics-harvester`: vendored `verify-fixtures.mjs` oracle;
`release-evidence`: sets `RELEASE_EVIDENCE_CONTRACTS_DIR` to a pinned checkout -- tracked as a
consumer-side follow-up, its schema-backed tests were skipped in its CI before 2026-10-16).
