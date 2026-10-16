# Evidence-Closed Delivery — frozen decisions

> **Status: reference record, not a contract.** This document fixes, in one place, the numeric
> thresholds, KPI definitions, and operational limits that the Evidence-Closed Delivery
> milestones (F/G/H/I) were designed against, so a future implementer does not have to reopen
> arbitration already settled. Source: `Evidence-Closed Delivery — 次期マイルストーンプラン`
> (Codex 5.6 `sol`, six arbitration rounds, user-approved 2026-08-23). The three shadow evidence
> contracts (`review-findings/v1`, `promotion-receipt/v0`, `release-approval/v0` — Milestone F)
> implement only the schema/fixture/verifier layer; none of the KPIs, gates, or numeric
> thresholds below are enforced by those contracts themselves. This document does not change
> when those contracts change; if a number below is revised, it is revised here by addendum,
> never silently.

## Authority DAG (what F/G/H/I connect to)

```
review-findings/v1 (records observations, no authority)
        │
        ▼
promotion-receipt/v0 (evaluates every predicate EXCEPT human approval,
        │              verdict: ready_for_approval | ineligible | abstained,
        │              deterministic, zero LLM calls)
        ▼
release-approval/v0 (the ONLY authority — human or authorized emergency
        │             principal, binds exact digests: receipt, bundle,
        │             selection manifest, target)
        ▼
final promotion gate (receipt + approval + freshly re-fetched state,
        │              combined atomically at promotion time — TOCTOU)
        ▼
promotion_result_recorded → post_deploy predicate evaluation
```

## Milestones F / G / H / I — one-line scope

- **F — Shadow Evidence Contract.** The three contracts exist (schema/fixtures/verifier only);
  lane vendors + verifies, makes no model calls, blocks nothing. Not introduced into any live
  R-pilot cohort task.
- **G — Digest-bound Human Promotion.** `release-approval/v0` events become the real production
  gate: stale/wrong-digest/rejected/revoked/unknown approvals are refused by an actual adapter,
  with atomic compare-and-promote at the moment of promotion (TOCTOU).
- **H — Selective Preview Promotion** (conditionally started — see "H's launch condition"
  below). Same bundle digest deployed to preview, read back live, human-approved, then promoted
  to production without rebuilding, with production read-back after.
- **I — Auto-fix** (unlocked per category — see "Milestone I unlock thresholds" below). Gated
  automatic review→fix→re-review loop; auto-fix output never bypasses G's human approval.

## F/G/H one-year KPIs — definitions, denominators, and who judges false positives

Each KPI pair below is evaluated **only after the D13 baseline (next section) is frozen**, over
whichever release population the milestone has actually been exercised against at the time of
review (shadow or live, as scoped by that milestone's own launch rule) — **not** against every
release in the repository's history, and **not** aggregated across unrelated repositories.
**A human operator is the sole judge of what counts as a false positive or false allow** in
every KPI below; no automated classifier's self-report satisfies these KPIs.

- **F**:
  - Shadow false-allow rate on **critical** evidence gaps = **0** (any single observed instance
    fails this KPI outright; there is no acceptable non-zero rate).
  - Evidence-caused rework count per release < the D13 baseline's rework anchor (2 incidents per
    the fixed baseline window — see below).
- **G**:
  - Digest-unbound or unbound-promotion incidents = **0** (any single instance fails this KPI).
  - Additional manual operations introduced by G ≤ 2 per release, and no worse than the current
    (pre-G) manual-operation count for that release type.
- **H**:
  - Preview execution count and direct cost ≤ the counterfactual of "always preview" (i.e. H
    must not make preview *more* expensive than deploying to preview on every release would
    have been).
  - Incidents or leaks caused by a false preview-skip = **0**.

Observation period for each KPI: from the milestone's own introduction (per its launch rule
above) through one full year of continuous operation at that milestone's scope, or until the
milestone's own withdrawal condition fires — whichever comes first. A milestone withdrawn before
one year has elapsed has its KPI reported as **not yet exercised**, never backfilled or
estimated.

## H's launch condition

Milestone H does not start on a calendar date. It starts the first time **any** of the
following three conditions is observed, with the evidence source that condition requires:

| Condition | Required evidence source |
|---|---|
| A predicate appears whose only satisfiable evidence is a human confirming a UI or migration state that can only be observed *before* production (i.e. a `preview_verified`-class predicate becomes `applicable` for the first time in a real release) | The `promotion-receipt/v0` record showing that predicate as `applicable` |
| A failure is confirmed to have been preventable specifically by a preview deploy (not by any other check already in place) | An incident record or postmortem explicitly attributing the miss to the absence of a preview step |
| A production read-back detects a defect that is structurally irreversible once live (cannot be corrected by a subsequent deploy without externally-visible harm already having occurred) | The `release-evidence/v0` ledger's `verified\|production` or `failed\|post_verification` event for that release, plus the incident record describing the irreversibility |

## Milestone I unlock thresholds

Unlocked **per `(category, model_cohort, auto_fix_policy_version)` tuple** — cohorts are never
aggregated together, and a category unlocked for one model cohort does not unlock for another.

| Category | Acceptance rate | Minimum finding/fix count | FP rate ceiling | Convergence rate |
|---|---:|---:|---:|---:|
| `lint_format` (unlocks first) | ≥ 90% | 200 findings / 100 fixes | ≤ 2% | ≥ 98% |
| `type_safety` | ≥ 85% | 200 / 100 | ≤ 3% | ≥ 97% |
| `documentation` | ≥ 80% | 150 / 75 | ≤ 5% | ≥ 95% |
| `test_quality` | ≥ 80% | 200 / 100 | ≤ 5% | ≥ 95% |
| `maintainability` | ≥ 80% | 250 / 125 | ≤ 5% | ≥ 95% |
| `performance` | ≥ 85% | 300 / 150 | ≤ 3% | ≥ 97% |
| `correctness` | ≥ 90% | 400 / 200 | ≤ 2% | ≥ 98% |
| `reliability` | ≥ 90% | 400 / 200 | ≤ 2% | ≥ 98% |
| `security` (unlocks last) | ≥ 95% | 500 / 250 | ≤ 1% | ≥ 99% |

**Metric definitions:**

- **Acceptance rate** = digest-bound `approved / (approved + rejected)`, with the constraint
  that ≥ 90% of proposed fixes must reach a judged (approved or rejected) state at all — an
  unjudged backlog cannot be excluded from the denominator to inflate this rate.
- **FP rate** = `contradicted / (proven + contradicted)` outcomes from the finding's own
  `evidence_gate`, with the constraint that the `unknown` rate must stay ≤ 10% (an
  under-resolved gate cannot be hidden by narrowing the denominator).
- **Convergence rate** = the fraction of fixes for which an independent re-review of the new
  digest (a) does not reproduce the original finding, (b) surfaces no new finding of equal or
  greater severity, and (c) passes every machine-checkable verification for that change — all
  three conditions required. Convergence must hold on **both** the full historical sample **and**
  a held-out newer half of it independently — a category that converges only on its earliest
  data does not qualify.
- Post-promotion rollback rate attributable to an auto-fixed change must stay ≤ 1% (`security`:
  ≤ 0.5%); a single critical or high-severity regression triggers immediate re-lock of that
  category, regardless of how the aggregate rate looks.
- **Break-glass approvals never count toward a category's success statistics** in any of the
  above metrics.
- **Auto-fix output only ever reaches `preview`.** Milestone G's digest-bound human approval is
  never bypassed by an unlocked category, at any threshold.

**Why these numbers**: the external baseline for AI-review acceptance (CodeRabbit, 31,073 real
reviews: 36.4% accepted / 7.3% discussed / 56.3% rejected — see "External evidence" below) is
too noisy to wire directly into automatic promotion. The thresholds above start from the
categories where mechanical verification is strongest (formatting, type errors) and where a
false positive is cheapest to detect and revert, and only extend to weaker-verification,
costlier-to-revert categories (`correctness`, `reliability`, `security`) at successively higher
bars, each requiring a larger observed sample before it can unlock at all.

## D13 baseline (frozen 2026-08-23, null-not-zero)

Fixed window: **2026-08-08 to 2026-08-22**, the 11 most recent releases across this ecosystem's
own repositories at the time of freezing — 10 git-tagged releases (`lane` v0.4.0 / v0.5.0 /
v0.5.1 / v0.5.2 / v0.6.0 / v0.7.0, `evidence-docs` v0.1.0 / v0.2.0, `agent-cost` v0.1.0,
`release-evidence` v0.1.0) plus one `release-evidence/v0` ledger-recorded scheduled release
(`agent-metrics-dashboard@32572501427-1`, actor: `ci`). Data sources: each repository's git tag
dates, the harvester `metrics-data` branch's `release-events.jsonl` (3 events, 1 attempt), and
`~/ai_bus/tasks.md`'s contemporaneous record.

| Metric | Observed value | How absence is handled |
|---|---|---|
| Manual operations per release | Recorded for **2 of 11** only: `lane` v0.7.0 = 8 steps (`npm publish` + OTP, both human, per the contemporaneous `tasks.md` record); the dashboard daily release = 0 (every event's actor was `ci`) | The remaining 9 releases are **null (absent)** — no mechanism existed to record this. Not estimated, not defaulted to 0. |
| Missing-evidence categories | Only **1 of 11** releases has a machine-recorded release-evidence chain (sealed bundle + read-back) at all; the other 10 tagged releases have no bundle, no manifest, and no read-back (one partial exception: `lane` v0.7.0 has a prose record of a clean-room verify) | `absent` dominates. `stale` / `unattributed` / `schema-invalid` / `integrity-mismatch` have **no observation target at all** in this window and are recorded as **null**, not zero. |
| Rework | 2 release-related rework incidents recorded in this window (2026-08-22: `spec-lane` CI `generate:json-schema` drift, one occurrence; `agent-metrics-harvester` CI `biome format` drift, one occurrence — both fixed same-day) | Rework for the other releases in the window is **not recorded** — **null**, not zero. |
| False allow | **not_applicable** | No gate mechanism that declares "allow" exists yet in this window; PR merge and `npm publish` are not gated by any evaluated predicate. F's introduction is the first point at which this KPI's denominator exists at all. |
| Abstain reason distribution | **0 observed** abstain events tied to release work in this window | `estimate`'s abstain wiring was completed 2026-08-22 but had not yet been exercised in this window — recorded as **null (not_yet_exercised)**, not zero. |

**Baseline conclusion**: the fact that only 1 of 11 releases in this window is machine-measured
at all **is** the baseline. F's KPI comparator "evidence-caused rework below baseline" is
therefore frozen against: rework = 2 incidents / window, manual-operations anchor = 8 steps vs.
0 steps (the only two releases with any record at all), and evidence-chain coverage = 1/11.
These numbers do not change retroactively; a correction, if ever needed, is appended below this
section, never edited in place.

## `privilege_boundary` — the decidable checklist and its explicit limit

Statically decidable via YAML + reusable-workflow + local-action resolution (an unresolvable
external action or a dynamic `${{ }}` expression the scanner cannot resolve fails the check
closed, not open):

- Every `uses:` pinned to a full commit SHA; container references pinned to a digest.
- No `pull_request_target` trigger on a job that also checks out untrusted content or exposes
  secrets.
- No path from `issues`, `issue_comment`, `discussion`, `repository_dispatch`, or `workflow_run`
  triggers into a job holding secrets, a write token, or a privileged runner.
- `permissions` explicit everywhere, defaulting to read-only; no blanket `write-all`;
  `id-token: write` restricted to jobs pinned to a fixed ref.
- No PAT, cloud credential, or `secrets: inherit` passed into any agent-executed job.
- Fork PRs: read-only token, no secrets, no shared artifact/cache with privileged jobs.
- A privileged job never checks out a fork's HEAD, and sets `persist-credentials: false`.
- **Event body content — issue/comment/PR title, body, diff, filenames, or
  `toJSON(github.event)`— is never passed directly into a secret- or write-permission-bearing
  agent's prompt or shell.** `${{ github.event.* }}` is never interpolated directly into a
  shell step.
- No self-hosted runner, Docker socket, or unrestricted network access granted to a job that
  processes untrusted input.
- No unverified artifact is promoted via a `workflow_run` trigger without independent
  verification.
- No `curl | sh` or floating (unpinned) install step; every install is lock-file- or
  hash-pinned.

**This is a necessary condition, not a sufficient one**, and every `promotion-receipt/v0`
carrying a `privilege_boundary: satisfied` predicate should be read that way: the static scan
cannot prove the absence of a compromise inside an action's own implementation, a tampered
already-pinned commit, or a prompt-injection payload smuggled through a field the scan does not
semantically interpret. `docs/protocols/promotion-receipt-v0.md`'s own caveats section states
the same limit from the contract side.

## Operational limits and degradation order

- Additional manual operations: ≤ 2 per release (3 triggers simplification review; 4 or more
  triggers full D13 withdrawal of the milestone that introduced them).
- Contract maintenance budget: the smaller of 2 hours/month or 25% of directly related work
  time.
- Manual remediation: ≤ 2 occurrences per month.
- Review generation: ≤ 1 per release; agent-cost increase should stay within 10% of the same
  release type's baseline cost as a watch line (not a hard gate).
- Receipt evaluation: **0 LLM calls**, always — this is a structural property of
  `promotion-receipt/v0`, not a budget to spend down.

Degradation order when any limit above is exceeded (each step is a full stop of that
milestone's added behavior, not a partial throttle):

1. Stop Milestone I's auto-fix (all categories, regardless of individual category standing).
2. Strip duplicate reviews and any generated explanation text; keep only the deterministic
   receipt evaluation.
3. Stop Milestone H (selective preview promotion).
4. Stop Milestone G, retaining only Milestone F's shadow evidence (**never** revert to
   digest-unbound promotion — this floor is never crossed regardless of pressure).
5. Narrow Milestone F to critical-severity findings only; if still over budget, remove F
   entirely.

## Addendum 2026-10-16 — verification-loop stop rule (how "review generation ≤ 1" is applied)

Source: 意図駆動開発基盤ブラッシュアップ 合意文書 (2026-10-16, §B2; Codex `sol` 6 rounds +
`gpt-6.1-sol` adversarial cross-check, user-approved). This addendum does not change any number
above; it fixes how the "Review generation: ≤ 1 per release" limit is applied to the
review→fix→re-review loop, so the loop cannot be re-run until it happens to report nothing.

- **"Two consecutive zero-finding reviews" is not a gate.** A clean review is an observation
  about one digest under one recorded scope, not evidence that the change is complete; repeating
  reviews until one is clean optimises for the reviewer's silence (Goodhart). It is never used as
  a stop condition, a KPI, or an unlock input.
- **At most one review generated per release; normal approval needs that one review bound to
  the final digest.** The review that counts is the one whose `review-findings/v1` record is bound to the bundle digest that is actually
  being promoted and to the exact frozen independence policy of `promotion-receipt/v0` (B1). Its
  required independence strength is whatever that policy demands for the effective risk; this
  document does not rank reviewers.
- **Stop condition** (all of the following, on that same digest):
  1. every in-scope blocker finding is resolved — fixed, or dispositioned with an evidence
     reference; never "will fix later";
  2. the machine verifications the receipt predicates require have passed;
  3. areas the review did cover without findings are recorded as
     `none_observed_in_recorded_scope` together with the recorded scope, so that "no findings
     here" never reads as "no findings anywhere"; areas outside that scope stay unknown;
  4. when the one review has been spent for this release and a further review would be needed,
     the receipt verdict is `abstained` and the decision escalates to a human — a second review
     is never run silently.
- **A change after the counted review means a new digest and a held release — not a reset.**
  The limit is per release, and the budget is not restored by re-labelling the candidate (new
  candidate ID with the same content, or new content under the old ID) or by producing a new
  digest. The new digest has no counted review bound to it, so its receipt verdict is
  `abstained` and a human decides: hold, revise the limit by addendum here, or proceed under the
  release-approval break-glass path with the reason recorded. A review record whose subject
  digest differs from the candidate's digest is not evidence for that candidate.
- **Adding reviewers is a revision of this document.** A second reviewer per release (human or
  model) is only admissible after the "Review generation" limit above is explicitly revised by
  addendum here; a lane-local or project-local override is not a valid path.

Enforcement status at this addendum: the three contracts record scope (`none_observed_in_recorded_scope`),
the receipt verdict (`abstained`), and digest bindings, but **none of them records the review
count per release, the candidate ID, or blocker dispositions**, and the receipt does not yet
check that a review record's subject digest equals the candidate's. Until a contract revision
adds those, conditions 1 and 4, the per-release count, **and the subject-digest check** are
applied by the orchestrating lane and recorded in prose, with this document as the reference. The
lane treats a review record whose subject digest is not the candidate's digest as review
admissibility `unknown`, which yields verdict `abstained` — never `ready_for_approval` — and
hands the decision to a human exactly as in the bullet above.

Relation to Milestone I: I's gated review→fix→re-review loop and its convergence KPI consume
reviews, and this addendum does not settle how that loop fits inside "≤ 1 per release". That is
an open item to be resolved by addendum **before** any Milestone I category is unlocked; until
then the limit above applies to I as written. This addendum also does not decide which reviewer
is independent enough (B1), how rework caused by the review is classified (B3), or any stability
KPI (B4).

## External evidence — sources, dates, and where they do and do not apply

| Source | Date | What it supports | Scope limit |
|---|---|---|---|
| CodeRabbit, 31,073 real AI code reviews | cited 2026-08-23 in the source plan's research pass | Empirical AI-review acceptance: 36.4% accepted / 7.3% discussed / 56.3% rejected (rejection causes: false positives, duplicates, out-of-scope, intent mismatch) | Supports "do not trust an AI reviewer's approve as promotion authority" and the Milestone I unlock thresholds' conservatism. Does not itself validate any specific numeric threshold above — those are this plan's own design choices informed by it. |
| DORA, *State of AI-assisted Software Development 2025* | published 2026-02 | AI is an amplifier: without an observability foundation, throughput gains trade against delivery stability | Supports requiring `release-evidence/v0`-style observation as a precondition for any Delivery-OS-style automation; not a source for any numeric threshold in this document. |
| Black Hat USA, harness-vs-CI-secrets disclosure | 2026-08-05 (public), CSA research note 2026-08-08 | An unauthenticated GitHub issue reached CI runner secrets for Claude Code / Gemini CLI / Codex; root cause was agent-harness permission design, not the model | Directly informs the `privilege_boundary` checklist above (event-body isolation, no untrusted-trigger path to secrets). Not evidence about model behavior or review quality. |
| GitHub artifact attestations / SLSA | current standard as of 2026-08-23 | Widely deployed tooling reaches SLSA v1.0 Build Level 2; Level 3 requires a reusable workflow, Level 4 is not realistic for this scale | Sets the realistic ceiling for "immutable release candidate" claims — the release-evidence approach (digest + read-back) is scoped to L2-equivalent, not higher. |
| Agile V (arXiv 2602.20684, Koch & Wellbrock) | published 2026-02-24 | Compliance-ready framework for AI-augmented engineering: audit trail generated per task cycle, human-approval checkpoints | Prior art for the surrounding structure of Evidence-Closed Release (CE-01 / CE-02 in `docs/claims/register.json`). Describes no cryptographic binding of evidence to artifacts; supports no number in this document. |
| Attesting LLM Pipelines (arXiv 2603.28988, Tan, Singer & Anagnostopoulos) | published 2026-03-30 | Attestation-aware promotion gate (allow / quarantine / block); names the lack of cryptographic binding between claims and artifacts as the core gap | Prior art that states the gap `release-evidence/v0`'s sealed bundle digest addresses; the binding itself is not implemented there. Supports no number in this document. |
| Agentic Agile-V (arXiv 2605.20456, Koch) | published 2026-05-19 | SCOPE-V loop, conversation-to-contract gate, evidence-bundle acceptance model | Prior art at the process level; no digest binding in the abstract. Supports no number in this document. |
| Meta-Engineering Harnesses for AI-Native Software Production … with Early Deployment Report (arXiv 2605.25665, Sengupta, Briggs & Myshakivskyi) | published 2026-05-25 | Contract-driven, independent adversarial verification; four-way failure arbiter; 17 features in production | Prior art for separating generation from deterministic checking (CE-04). Not a source for review-acceptance or KPI numbers here. |
| NovaFabric (arXiv 2609.12582, Seyedkazemi Ardebili) | published 2026-09-11 | Tamper-evident, replayable evidence for agent runs; proposal and approval linked by canonical digest; approver key distinct from proposer key | Later than this repository's 2026-08-22 publication; compared, not relied on. Its approver-key separation is one reading of the independence policy this repository has not defined (CE-06). |
| ZeroGate (arXiv 2609.25443, Wang) | published 2026-09-21 | Admission receipt separated from effect evidence; matching two old hashes does not show the approval's premise still holds | Later than 2026-08-22; compared, not relied on. Motivates the freshness check this repository has not defined (CE-06). |
| Agile-V Assurance Spine / From Agent Output to Authorized Transition (arXiv 2609.28216, Koch) | published 2026-09-23 | Evidence bound to source profile, exact artifact, and frozen policy baseline; independence levels I0–I4 and authority matched to risk; receipts carrying approval references; scoped, time-limited, single-use approvals re-checked at effect boundaries | Later than 2026-08-22 and cites only sources up to 2026-07; compared, not relied on. Closest published design: same receipt / approval / effect-boundary shape with the opposite authority placement (its receipt references approvals; `promotion-receipt/v0` cannot). Single-use consumption, risk-linked independence, and dependency freshness are present there and absent here (CE-06). |
| **SWE-Review (arXiv 2607.06065)** | — | — | **Not used.** This paper's existence could not be independently confirmed during the source plan's research pass. Any claim about generate→review→revise loop effectiveness that traces back to this citation is explicitly withdrawn and must not be reintroduced without independent verification that the source actually exists. |

No citation in this document or in any Evidence-Closed Delivery contract's own documentation
may be added without recording its source, publication date, and the specific scope it is being
used to support — the same discipline this table itself follows.

## Addendum 2026-10-16 — public-record dates and prior art

This addendum records, by date, what this repository made public and what it does not claim.
The canonical register is [`docs/claims/register.json`](claims/register.json) (entries change only by
human approval; every entry is `pending` until a named reviewer approves it, and a pending entry is not
citable outside this repository);
[`docs/prior-art.md`](prior-art.md) is generated from it and must not be edited by hand.

What can be stated, and all that can be stated:

1. On 2026-08-22 this repository published the schema, fixtures, and verifier for three contracts
   (`review-findings/v1`, `promotion-receipt/v0`, `release-approval/v0`) in PR #17; the diff
   identifies the functional units (register element CE-01).
2. On the same day it published the `release-evidence/v0` implementation, with a sealed bundle
   digest and production read-back, and a GitHub Pages adapter demonstration (workflow run
   32572501427; register element CE-02).

Those publication dates precede the three September 2026 papers in the table above
(NovaFabric, ZeroGate, Assurance Spine) and follow the four papers published between February
and May 2026. Nothing here is described as first, as independently converged, or as an
integrated release gate at that date; the earlier internal candidate claim to that effect was
withdrawn on 2026-10-16 (see the register's `withdrawn_claims`).

Design differences recorded against the later design compared here (Assurance Spine), as
differences and not as advantages:

| Element | This repository (2026-08-22 baseline) | Assurance Spine (2026-09-23) | Register |
|---|---|---|---|
| Authority placement | `promotion-receipt/v0` carries no approval reference; `release-approval/v0` is the sole authority | Receipt carries approval references; eligibility includes an authority-valid term | CE-03 |
| LLM calls in receipt evaluation | 0 (frozen operational limit) | Not fixed | CE-04 |
| Unmeasured quantities | null, never zero (D13 baseline) | Not addressed | CE-05 |
| Single-use approval consumption | **not implemented** | Present | CE-06 |
| Risk-linked required independence | **not defined** (`review-findings/v1` records independence as `{code, params}`; no policy consumes it) | Present (I0–I4) | CE-06 |
| Dependency freshness | **not defined** | Present | CE-06 |

Evidence for the two dated statements is GitHub platform metadata (PR #17 created
2026-08-22T20:01:03Z and merged 20:04:04Z; the `release-evidence` repository created
2026-08-22T10:42:32Z; run 32572501427 created 2026-08-22T12:15:28Z). All three are in one trust
domain and are not three independent third-party timestamps. Git history rewritten after the fact
(filter-repo) is not used as evidence. The USPTO permit-before-commit patent family reported during
the research pass was not retrieved and is recorded as unresolved; no novelty, priority, or
freedom-to-operate claim is made, so no legal prior-art search was performed.
