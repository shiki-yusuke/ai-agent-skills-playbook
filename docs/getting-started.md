# Getting Started

このリポジトリはスキル / protocol の正本（SSOT）であり、それ自体は測定パイプラインを実装しません。各ツールの実体は別リポジトリにあります。以下は「どのツールを、どの順で、どの最小コマンドで試すか」の入り口です。全部を導入する必要はありません — 自分の目的に合う行だけを選んでください。

This page is the entry point into a set of tools built around one idea — **evidence-bound delivery for coding agents**: a claim a change makes about itself (it works, its estimated cost was this much, it's done) should carry provenance a machine can re-check, not just prose. **You do not need to adopt all of them.** Pick the row that matches what you actually need, run that one recipe, and stop there — every other tool is optional.

## Choose your starting point

| Goal | Tool |
|---|---|
| Measure token usage / estimated cost only | [agent-cost](https://github.com/shiki-yusuke/agent-cost) |
| Manage Intent / Spec / Verification for a change | [spec-lane](https://github.com/shiki-yusuke/spec-lane) |
| Attribute estimated cost to a specific task, not just a time window | spec-lane + agent-cost |
| Transport telemetry to GitHub as a PR comment | [`agent-metrics:v1`](protocols/agent-metrics-v1.md) (the contract lives in this repo; spec-lane is the reference emitter) |
| Collect / store / report that telemetry across a repo | [agent-metrics-harvester](https://github.com/shiki-yusuke/agent-metrics-harvester) |
| Evidence-backed codebase documentation | [evidence-docs](https://github.com/shiki-yusuke/evidence-docs) |
| Verify an agent's "done" claim against what actually happened | [evigate](https://github.com/shiki-yusuke/evigate) |
| Evaluate a judge (LLM or rule-based) without a circular corpus | [acyclic-eval](https://github.com/shiki-yusuke/acyclic-eval) |

If you're unsure where to start: **agent-cost alone (Recipe A) is the smallest possible commitment** — one `pip install`, no repo changes, no schema to learn. Everything else builds on top of it or runs independently.

**Fastest possible verified result, zero installs:** if you've just cloned this repo, `node contracts/measure/v1/verify-fixtures.mjs` runs in under a second against fixtures already checked into `contracts/`, with no dependency beyond Node — see [`architecture-tour.md`](architecture-tour.md#reading-the-fixtures-yourself) for what it's actually checking.

## Recipes

Each recipe below was run end-to-end in a fresh temporary directory while writing this page; the commands and output are real, not illustrative. Each is a short, direct path — the goal is a first verified result within a few minutes of starting, not a full tour of the tool's command surface (see each tool's own README for that). Several recipes deliberately show a **correct rejection** as the first result — an honest "I can't verify this" is exactly what these tools are supposed to say when the input doesn't support a claim, and it's usually the first thing you'll see too.

Two environment variables make it possible to run agent-cost and spec-lane against synthetic data instead of your real history — use them for a first try:

- `CLAUDE_HOME` / `CODEX_HOME` — override where `agent-cost` looks for Claude Code / Codex CLI logs (default `~/.claude`, `~/.codex`).
- `LANE_DATA_DIR` — override where `lane`'s cross-repo trace/attribution ledger lives (default an XDG data dir under your real `$HOME`). Without this, `lane attribution audit` reads **every** lane you've ever run on the machine, not just the one in your temp directory.

### A. Measure only (agent-cost)

**Use when:** you just want to know how many tokens/estimated dollars your Claude Code or Codex CLI sessions used — no delivery workflow, no schema to adopt.

```bash
mkdir -p fake-claude-home/projects/demo-project fake-codex-home
cat > fake-claude-home/projects/demo-project/session1.jsonl <<'EOF'
{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":1200,"output_tokens":340,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"timestamp":"2026-08-01T10:00:00Z"}
{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":800,"output_tokens":210,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"timestamp":"2026-08-01T10:05:00Z"}
EOF
export CLAUDE_HOME="$(pwd)/fake-claude-home"
export CODEX_HOME="$(pwd)/fake-codex-home"

pip install coding-agent-cost
# (the PyPI distribution name differs from the repo name -- `agent-cost` is blocked
#  by PyPI's similarity rule against an unrelated project; the command is still `agent-cost`)
agent-cost doctor
agent-cost report --format table
```

**First verified result** (real output against the two synthetic lines above):

```
$ agent-cost doctor
agent-cost doctor
  version: 0.1.0
  [ok] Claude projects dir: .../fake-claude-home/projects (1 session files)
  [warn] Codex state DB not found: .../fake-codex-home/state_5.sqlite
  [ok] rates.json valid: catalog_version=2026-07-29, 21 models

$ agent-cost report --format table
Month    Agent   Model            Token Kind     Tokens  Priced  Unpriced  Est. Cost (USD)  Credits  Status
-------  ------  ---------------  -------------  ------  ------  --------  ---------------  -------  ------
2026-08  claude  claude-sonnet-5  input_nocache  2000    2000    0         0.0040           -        priced
2026-08  claude  claude-sonnet-5  output         550     550     0         0.0055           -        priced

Total tokens: 2,550   Total estimated cost: $0.0095
```

The `[warn]` line above is itself a correct result: no Codex logs exist in this fixture, and `doctor` says so plainly instead of silently reporting zero. Stop here if this is all you need.

> **Protocol status note (affects Recipe C below):** this repository's own README currently marks
> `trace:v1` and `attribution:v1` as **contract-only** ("reference implementation not yet built" —
> see [Public interoperability protocols](../README.md#public-interoperability-protocols)). The
> `lane work` / `lane usage-import` / `lane attribution audit` commands used in Recipe C are real,
> verified output from the globally installed `spec-lane` CLI (`lane --version` → `0.5.2`) at the
> time this page was written, and that CLI already speaks both schemas end-to-end. Treat Recipe C
> as an accurate preview of that CLI's current behavior, not as this repository's own declaration
> that either protocol has graduated past contract-only — check each protocol document's own
> `Status` field for the authoritative, up-to-date answer.

### B. Pre-implementation gates (spec-lane)

**Use when:** you want a change to be blocked before implementation if its premise, acceptance criteria, or a cross-cutting dependency was never actually checked — independent of estimating cost at all.

```bash
git init demo-repo && cd demo-repo
git config user.email you@example.com && git config user.name you
git commit --allow-empty -m init

lane start I-2026-08-14-demo \
  --business-goal "Reduce onboarding friction in the setup flow." \
  --user-visible-intent "New users see setup steps in the right order." \
  --primary-user "new_user" \
  --risk low

lane validate I-2026-08-14-demo
```

**First verified result** (real output, right after `lane start`, before anything else is written):

```
$ lane validate I-2026-08-14-demo
intent.yaml is valid (phase=1_intent).
[premise_evidence] premise_evidence is not recorded. If this change is AI-originated or the
symptom was never directly observed, and it introduces a new guard/branch/completion
condition, confirm the premise against a real system or data before writing the spec
(design.md §3.9 gate 1) and record it here.
[success_criteria] success_criteria_matrix is not recorded. Cross-check each line of
intent.intent.success against the final diff one at a time and record how it is covered,
with a negation test, before publishing a PR (design.md §3.9 gate 2).
```

Both warnings are correct: nothing has been written yet beyond `intent.yaml`. `lane validate` never blocks by itself — it's early feedback. `lane advance` is the actual gate; see [`spec-lane`'s README](https://github.com/shiki-yusuke/spec-lane#quick-start) for the rest of the intent → spec → implement → verify → done walk (this recipe stops at the first gate on purpose — the full flow is spec-lane's own documentation, not duplicated here).

### C. Task-level attribution of estimated cost (spec-lane + agent-cost)

**Use when:** Recipe A tells you the *estimated cost* in a window, but you need to know *which task* it belongs to.

```bash
export LANE_DATA_DIR="$(pwd)/.lane-data"   # scope the attribution ledger to this demo
export CLAUDE_HOME="$(pwd)/.fake-claude-home"
export CODEX_HOME="$(pwd)/.fake-codex-home"
mkdir -p "$CLAUDE_HOME/projects/demo-project" "$CODEX_HOME"
cat > "$CLAUDE_HOME/projects/demo-project/session1.jsonl" <<'EOF'
{"type":"assistant","sessionId":"demo-session-1","message":{"model":"claude-sonnet-5","usage":{"input_tokens":1200,"output_tokens":340,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"timestamp":"2026-08-14T20:07:00Z"}
{"type":"assistant","sessionId":"demo-session-1","message":{"model":"claude-sonnet-5","usage":{"input_tokens":800,"output_tokens":210,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"timestamp":"2026-08-14T20:07:30Z"}
EOF

lane work start --intent I-2026-08-14-demo --phase 3_implement
lane work bind --intent I-2026-08-14-demo --session-id demo-session-1 --agent claude
lane usage-import --intent I-2026-08-14-demo
lane attribution audit
```

**First verified result** (real output — a session bound to the task, but with no usage-import window that overlaps its actual activity):

```
$ lane attribution audit
1 bound session(s) have no usage_imported event in this window and are excluded from this
audit's session universe entirely (never yet usage-imported): demo-session-1
{
  "schema_version": "attribution/v1",
  ...
  "sessions": {
    "exactly_attributed": [], "unbound": [], "mixed": [], "orphan_usage": [],
    "measurement_incomplete": ["demo-session-1"]
  },
  "tokens": { "exact_attributed": 0, "total_measured": 0 },
  "research_eligible": false,
  "violations": [
    {
      "reason_code": "MEASUREMENT_INCOMPLETE",
      "session_id": "demo-session-1",
      "detail": "agent-cost could not match session demo-session-1 for at least one usage-import window"
    }
  ]
}
```

This is the honest result for a `session_id` that was bound manually rather than through `lane work run` and whose synthetic log timestamps fall outside the bind window: attribution audit correctly refuses to count it as `exactly_attributed`, sets `research_eligible: false`, and names the exact reason code rather than showing a number it can't back up. A real Claude/Codex session started via `lane work run` (rather than `lane work bind` against a fabricated log) does not hit this path.

### D. Full measurement pipeline (emit-metrics → harvester → report)

**Use when:** you want token usage / estimated-cost telemetry to live on the PR itself, collected centrally, without any developer holding a credential.

```bash
lane emit-metrics I-2026-08-14-demo --repository demo-org/demo-repo
```

```
$ lane emit-metrics I-2026-08-14-demo --repository demo-org/demo-repo
built 0 record(s), coverage.status=no_data
<!-- agent-metrics:v1 payload_b64=... sha256=... -->
```

`coverage.status=no_data` is correct here too — the demo lane's cost ledger has no `included_in_kpi` entries yet (Recipe C above ended in `MEASUREMENT_INCOMPLETE`). Pass `--post --pr <n>` to actually upsert this marker as a PR comment once you have real usage.

The harvester side is a separate repository and binary:

```bash
git clone https://github.com/shiki-yusuke/agent-metrics-harvester.git
cd agent-metrics-harvester
npm install && npm run build
node dist/src/cli/main.js
```

```
$ node dist/src/cli/main.js
agent-metrics-harvester: at least one --repo <owner/repo> is required
```

That, too, is a correct refusal — the harvester's own trust model requires an explicit `--repo` and at least one of `--allowed-login`/`--allowed-app-slug`; there is no "trust everyone" default (see its README's "Authentication and token scope"). Running it for real against a repository with markers already posted is a `gh`-authenticated operation outside the scope of this synthetic walkthrough — see the harvester's own [CLI usage](https://github.com/shiki-yusuke/agent-metrics-harvester#cli-usage) section for the full invocation. The read-only reporting binary works the same way:

```
$ node dist/src/cli/report-main.js
agent-metrics-report: unrecognized command "" -- the only supported command is "cost-per-pr"
```

### E. Evidence-backed documentation (evidence-docs)

**Use when:** you want a claim about the codebase ("this always does X") to carry provenance a machine can re-check, instead of trusting prose.

```bash
pip install evidence-docs
evidence-docs init docs/claims
# ... author topics/*.yaml and observations/*.yaml, registering IDs in id-registry.yaml first ...
evidence-docs validate docs/claims --repo-commit <full-git-sha> --repo-root <path-to-repo>
evidence-docs generate docs/claims --generated-at 2026-08-14T21:00:00Z --repo-commit <full-git-sha> --repo-root <path-to-repo>
```

**First verified result — a deliberately broken observation** (the recorded `content_digest` doesn't match what the file actually contained at the declared commit):

```
$ evidence-docs validate docs/claims --repo-commit 79b1b60... --repo-root ./demo-repo
corpus validation failed: OBS-001.provenance[0] content_digest mismatch against git blob
79b1b60...:app.py (declared=000000...0000, blob=03e693d...5824). The declared content_digest
does not match what this file actually contained at repo_commit -- re-verify the claim and
update content_digest.
```

This is exactly the drift `evidence-docs` exists to catch — an edit to `app.py` (or a hand-edited digest) after the claim was authored, kept honest by re-checking against the git blob at the declared commit, not the current worktree. With a correct digest the same command succeeds:

```
$ evidence-docs validate docs/claims --repo-commit 79b1b60... --repo-root ./demo-repo
ok: 1 observations across 1 topics validated

$ evidence-docs generate docs/claims --generated-at 2026-08-14T21:00:00Z --repo-commit 79b1b60... --repo-root ./demo-repo
generated 1 observations across 1 topics
corpus_digest=8c973900...
```

### F. Completion verification (evigate)

**Use when:** an AI agent's session report says "tests pass" / "task complete", and you want that checked against the transcript's actual tool calls instead of taken on faith.

```bash
git clone https://github.com/shiki-yusuke/evigate.git
cd evigate && npm install && npm run build

node dist/cli.js ingest fixtures/synthetic/session-basic.jsonl --db ./evigate.db
node dist/cli.js audit --all --db ./evigate.db --out ./audit-reports
```

(`fixtures/synthetic/` ships in the evigate repo itself — a synthetic transcript, not a real session — which is what was used to produce the output below. `npm link` — exposing the `evigate` command globally — is optional and skipped here to keep the path short; see the repo's own README if you want it.)

**First verified result:**

```
$ node dist/cli.js ingest fixtures/synthetic/session-basic.jsonl --db ./evigate.db
[ok] session-basic events=4 skipped_lines=2/9 redactions=6

$ node dist/cli.js audit --all --db ./evigate.db --out ./audit-reports
[audit] session-basic claims=2 proven=1 unknown=1
Done. sessions=1 claims=2 no_claims_sessions=0
verdict distribution: {"proven":1,"unknown":1}
reason_code distribution: {"D1":1,"NOT-PROVABLE":1}
```

One claim was `proven` against an actual passing command in the transcript; the other came back `unknown` rather than a guessed `proven`/`contradicted` — evigate's detectors are deliberately conservative about exactly this ambiguity (see its README's "How it works").

### G. Verifier evaluation (acyclic-eval)

**Use when:** you're building a judge (an LLM grader, a rule-based detector) and need to know whether it reacts correctly to structurally meaningful changes in its input — without the judge itself influencing which test cases exist.

```bash
npm install acyclic-eval
npx acyclic-eval generate --config ./node_modules/acyclic-eval/dist/examples/toy/config.js --out ./acyclic-eval-out
npx acyclic-eval evaluate --config ./node_modules/acyclic-eval/dist/examples/toy/config.js --out ./acyclic-eval-out --samples 1
npx acyclic-eval score --config ./node_modules/acyclic-eval/dist/examples/toy/config.js --out ./acyclic-eval-out --min-coverage 1
```

**First verified result** (`acyclic-eval@0.1.4` from the npm registry, the bundled toy domain):

```
generated 9 case(s) into ./acyclic-eval-out
"okSamples": 9
- overall: 9/9 passed (100.0%), 0 infra errors, 9 total cases
- gate: PASS
```

This is a reproducibility demonstration on a toy corpus, not an accuracy claim about any real judge — see the acyclic-eval README's "Evaluation and evidence" section for what its own numbers do and don't establish, and [`evigate`](https://github.com/shiki-yusuke/evigate)'s mutation-testing harness (Recipe F's tool) for a real adapter built on top of it.

## Relation to adjacent ecosystems

This stack overlaps in subject matter with a few larger, unrelated efforts. It does not replace any of them, and makes no claim of conformance to them:

| Ecosystem | What it defines | Where this stack is narrower |
|---|---|---|
| [GitHub Spec Kit](https://github.com/github/spec-kit) | An intent → spec → plan → tasks workflow where a specification becomes the artifact an implementation is generated from | spec-lane's Intent/Spec/Verify gates block a change on missing evidence; they don't generate an implementation from a spec |
| [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) | A general-purpose, vendor-neutral span/attribute vocabulary for tracing LLM and agent calls | `trace:v1` here is a closed-relation-set decision/evidence graph scoped to one delivery lane, not a general tracing vocabulary — there is no mapping between the two today |
| [FOCUS](https://focus.finops.org/) (FinOps Open Cost and Usage Specification) | Normalized *billed* usage/cost datasets across cloud, SaaS, and AI vendors | `measure:v1` / `agent-metrics:v1` estimate token-based cost from local agent logs, not billing invoices, and don't claim FOCUS conformance |

What this stack actually decides, per change, is narrower than any of the above: what can be claimed about it, and what remains unknown, backed by evidence a machine can re-check — not tracing, not billing normalization, and not spec-to-code generation.

## Where to go next

- To see how these recipes connect into one pipeline (and what each stage does and doesn't verify), read [`architecture-tour.md`](architecture-tour.md).
- For the normative protocol documents these tools implement, see the main [README](../README.md#public-interoperability-protocols).
