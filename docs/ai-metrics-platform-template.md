# AI-Assisted Development Metrics Platform — Reference Template

A reference design for measuring the effect of AI coding agents (review bots, spec/implementation assistants, cost-tracking CLIs) on a team's delivery process. This is distilled from an internal deployment that ran on a weekly operating cadence for several months across multiple repositories, with all organization-specific naming removed. It is not a product to install — it is a schema and a set of design decisions you re-derive in your own environment.

Read this if you are starting the same kind of measurement effort from zero: which tables to create, how to collect data into them without asking every developer to carry an API key, and — most importantly — which design choices exist specifically to stop the measurement system from being gamed or from being read as a personal-performance tool.

## 1. What this is

The reference deployment answered three questions on a recurring basis:

- Is AI-assisted review/implementation actually moving lead time, merge rate, and review turnaround, compared to a baseline?
- What is it costing, broken down by delivery phase and by model/agent?
- What unresolved issues or judgment calls has the AI reviewer surfaced that a human still needs to close out?

Those three questions map to five small database tables (below), fed by a collection pipeline that developers never have to interact with directly, and constrained by a handful of guardrails that were added — not as an afterthought, but as load-bearing design decisions — specifically to prevent the data from turning into an individual scoreboard.

None of this requires a specific database product. The reference deployment used a no-code database (property-typed tables with select/multi-select/relation columns), but a Postgres schema or a set of CSV files would express the same design.

## 2. The five database schemas

Every table has exactly one **upsert key** — a column whose value is recomputed deterministically from the record's own content, so a harvester (§3) can re-run against the same source data any number of times without ever producing a duplicate row. This is the single most important structural property of the whole design; without it, a "collect on a schedule" pipeline either drifts (missed runs silently lose data) or duplicates (rerun-after-crash creates twins).

### 2.1 Metric Records

The raw evidence for every headline metric, one row per `(metric, time window)` pair.

| Property | Type | Meaning |
|---|---|---|
| Title | title | human-readable summary (metric + window, for display) |
| Record Key | text, **upsert key** | `<metric_id>:<metric_path>` — must be unique |
| Metric Path | text | dotted metric identifier (e.g. `lead_time.created_to_merge`, `review_completion_rate`) |
| Aspect Tags | multi-select | your own taxonomy of what this metric is evidence for (e.g. quality, speed, cost) — organization-defined, keep it open-ended |
| Period | select | `current_week` / `previous_week` / `rolling_30d` / `all` |
| Window Start / Window End | date | the aggregation window this row covers |
| Generated At | date | when this row was computed, not when the underlying events happened |
| Product / Workstream | select | which product or workstream this metric belongs to, if you track more than one |
| Team | select | which team, if you track more than one |
| Repository | text | repo identifier |
| Value Unit | select | `minutes` / `days` / `count` / `percent` / `tokens` / `USD` / `ratio` |
| Value Mean / Value Median / Value p90 | number | see §4.3 for why median + p90 and not just mean |
| Baseline Value | number | populated only for metrics that have a defined pre-comparison baseline; null otherwise |
| Improvement Rate (%) | number | see §4.4 — sign is normalized so positive always means "better" |
| Sample Count | number | how many observations actually went into this row |
| Total Count | number | the candidate population size (lets you compute a coverage ratio) |
| Source Evidence | text | links/IDs of the underlying PRs or events, for audit |
| Data Status | select | `ok` / `partial_failure` / `data_insufficient` — see §4.5 |

### 2.2 PR Records

One row per pull request that went through the AI review/assist pipeline.

| Property | Type | Meaning |
|---|---|---|
| PR Key | title, **upsert key** | `<repository>#<pr_number>` |
| PR URL / Number / Title | url / number / text | basic identification |
| Repository | text or select | keep a catch-all "other" bucket if the repo list is long, to avoid unbounded enum growth |
| Author | text | GitHub-style login or equivalent |
| Bot Reviewed? | checkbox | whether the AI review pipeline actually ran and finalized a judgment on this PR |
| Latest Tier | select | an ordinal quality/risk tier your review pipeline assigns (e.g. S/A/B/C/U) — the specific scale is yours |
| Tier Finalized At | date | when the tier became final (bots may revise a tier as new commits land) |
| Created At / Merged At | date | PR lifecycle timestamps |
| Lead Time | formula | derived, not stored redundantly |
| Reviewers | text | bot + human reviewers |
| Total Tokens / Total Turns | number | token and back-and-forth cost of the AI interaction on this PR, over a fixed rolling window |
| Linked Metrics | relation | link to §2.1 rows this PR contributed evidence to |
| Last Sync At | date | freshness marker for the harvester run that last touched this row |

### 2.3 Phase Cost Records

Cost broken down by delivery-pipeline phase (intent / spec / implement / verify / done — see the `spec-lane` link in §6), one row per phase-occurrence.

| Property | Type | Meaning |
|---|---|---|
| Ledger Entry ID | title, **upsert key** | `<prefix>_<sha256[:12]>` of the entry's own content — a short hash-derived ID is enough for idempotent upsert without a central sequence counter |
| Pipeline Run ID | text | which delivery-pipeline run (ticket/intent) this phase belongs to |
| Phase | select | `intent` / `spec` / `implement` / `verify` / `done` / `total` |
| Source | select | `agent_log_import` / `manual` — where the numbers came from |
| Confidence | select | `imported_windowed` / `imported_scoped` / `estimated` / `manual` — be honest about how the number was derived |
| Data State | select | `has_usage` / `zero_tokens` / `no_data` / `import_failed` / `superseded` |
| Input Tokens / Output Tokens | number | |
| Cost USD Estimate | number | |
| Cost Credits | number | for credit-billed providers; `credits = cost_usd_estimate ÷ credit_unit_price`, where `credit_unit_price` is provider- and plan-specific and changes over time — keep it in a versioned pricing file, never hardcode it |
| Currency | select | |
| Pricing Version | text | which version of your pricing catalog produced this row — makes every cost figure traceable back to the rate that produced it |
| Started At / Ended At | date | phase duration |
| Imported At | date | |
| Included in KPI? | checkbox | whether this row counts toward the headline KPI rollup |
| KPI Exclusion Reason | text | required if the above is false |
| PR Reference | text (not relation) | store as a plain URL string, not a relation — a relation column here tends to trigger unwanted rollup aggregation in no-code DB tools |
| Evidence URL | url | |

### 2.4 Token Cost Records

A more granular cross-tab: cache kind × agent × model × month.

| Property | Type | Meaning |
|---|---|---|
| Record Key | title, **upsert key** | |
| Agent | select | which coding-agent tool (e.g. `claude`, `codex`) |
| Model | select | the specific model identifier string; include an `(all)` aggregate bucket for roll-ups |
| Cache Kind | select | `input_nocache` / `cache_read` / `cache_write` / `output` / `(all)` |
| Cost Basis | select | `api_estimate` / `seat_actual` |
| Grain | select | `base` / `phase` / `agent_month` / `phase_detail` / `repo` / `pr` / `pipeline_run` |
| Scope | select | `individual` / `team_aggregate` — see §4.1, this is where the anonymization guardrail lives |
| Phase / Activity | select | a taxonomy combining delivery-pipeline phases (aligned with §2.3) with invocation-context buckets (interactive session, scheduled/non-interactive execution, subagent, tool-protocol round-trip, spawned subprocess, IDE-integrated, other) — the split lets you separate "cost belonging to a delivery phase" from "cost belonging to how the agent was invoked" |
| Repository | text | |
| Month | date | |
| Token Count / Cost USD / Cost Credits | number | |
| Emitted Cost USD | number | the raw cost value as originally emitted by the collection marker (§3), kept alongside the repriced `Cost USD` so a price-catalog update doesn't silently overwrite the original evidence |
| Seat Count | number | for `seat_actual` cost basis |
| Developer Label | text | **only present at `team_aggregate` scope**; an alphabetic, order-independent label (`dev_A`, `dev_B`, …) reassigned per aggregation window — never a stable mapping back to a real identity. See §4.1. |
| Pipeline Run ID | text | |
| PR URL | url | |
| Data Status | select | `ok` / `price_unknown` / `seat_unknown` |
| Pricing Version | text | |
| Metric Family | select | |
| Generated At | date | |

### 2.5 Review Memory Records

A dual-purpose table: it doubles as (a) a TODO/finding tracker for issues the AI reviewer surfaced and a human hasn't closed out, and (b) a denormalized snapshot of §2.1 rows for dashboard convenience. A `Record Kind` / `Type` discriminant column tells you which shape a given row is; most columns will be null depending on which kind a row is.

TODO/finding side:

| Property | Type | Meaning |
|---|---|---|
| Memory ID | text | e.g. `mem_<YYYYMMDD>_<HHMMSS>_pr<number>_<seq>` |
| Type | select | e.g. `TODO`, `DETAIL` |
| Status | select | e.g. `open` / `resolved` / `wontfix` |
| Tags | text (JSON array) | |
| Files | text | affected file path(s) |
| Detail | long text | the finding itself, in prose |
| PR Title / PR URL / PR Number | | |
| Created / Resolved | date | |

Metric-snapshot side: reuses the same columns as §2.1 (Metric Path, Period, Value Mean/Median/p90, Baseline Value, Improvement Rate, Sample/Total Count, Data Status, …).

Implementation note: if your backing store is a no-code database (Notion, Airtable, etc.), date-typed properties commonly export as three flattened columns (`start`, `end`, `is_datetime`) rather than one. Account for this in your harvester's upsert logic rather than fighting the export format.

## 3. Collection pipeline: PR-comment markers, no developer-side credentials

The design goal: a developer using the AI coding agent should never have to run a separate tool, hold an API key, or remember to report anything for the metrics to show up. The collection mechanism piggybacks entirely on something the AI pipeline is already doing — posting a comment on the pull request.

1. When the AI review/assist pipeline finishes acting on a PR, it appends a hidden marker to the comment it was already going to post — e.g. an HTML comment the rendered PR view doesn't show, containing a base64-encoded JSON payload plus a sha256 hash of that payload: `<!-- metrics:v1 payload=<base64> sha256=<hash> -->`.
2. The payload is a self-describing record: which table it belongs to, its own upsert key, its values, a schema version, and a generation timestamp.
3. A scheduled **harvester** (a cron-style job, run on a fixed interval during working hours is enough — sub-minute freshness is rarely worth the added complexity) scans PRs/comments across the target repositories for that marker tag, decodes the payload, verifies the hash, and **upserts** into the matching table using the payload's own declared key.
4. The sha256 is not just integrity-checking: comparing it against the hash already stored for that upsert key lets the harvester skip re-processing unchanged comments cheaply, without re-parsing or re-writing anything.

This section describes the *pattern*; [`docs/protocols/agent-metrics-v1.md`](protocols/agent-metrics-v1.md) is the concrete, machine-verifiable *protocol* one implementation of it follows — normative envelope/payload schemas, an RFC 8785-based upsert-key recipe, and JSON fixtures a harvester implementation can conform against.

Why this shape, specifically:

- **No developer-side credential.** The only credential that exists is the harvester's own read access to PR comments and write access to the metrics store — held once, centrally, not distributed to every developer's machine.
- **Idempotent by construction.** Because the upsert key is derived from the record's own content (§2's tables all follow this), a harvester crash, a missed schedule tick, or a manual rerun can never produce a duplicate row — it can only overwrite a matching row with (hopefully identical, otherwise `superseded`) data.
- **Corrections are representable.** If a value needs to be recomputed after the fact, the corrected payload upserts over the same key and the old value is gone rather than living on as a second, stale row — this is exactly what `Data State: superseded` (§2.3) exists to make legible when it does happen.

## 4. Guardrails: the design choices that stop the numbers from being gamed

These are the decisions that mattered most in practice — not because they're clever, but because omitting any one of them turns a measurement system into either noise or a weapon.

**4.1 The individual dimension is mechanically excluded, not just policy-excluded.** No schema field carries a raw per-person identifier at the reporting layer. Where a per-person breakdown is technically unavoidable (the team-aggregate cost cross-tab, §2.4), it is replaced by an alphabetic label (`dev_A`, `dev_B`, …) reassigned per aggregation window rather than a stable mapping to a real identity.
*Why:* once a number is known to be visible to a manager, people optimize the number, not the thing it stands for (Goodhart's law). Removing the identity axis at the schema level — not as a dashboard filter someone could remove later — makes gaming an individual's numbers structurally impossible, because no query, present or future, can reconstruct "how did person X do."

**4.2 No individual ranking, anywhere, ever.** All rollups are at team, repository, or product granularity.
*Why:* a ranking is the single highest-leverage way to turn a measurement into a performance-review instrument. Keeping the schema aggregate-only removes that possibility even under future repurposing of the data by someone who wasn't part of the original design conversation.

**4.3 Median + nearest-rank p90, not mean, not interpolated percentile.**
*Why:* a mean is dominated by one outlier PR; a small sample's mean tells you about that one PR, not the team. Nearest-rank p90 (the actual observed value at rank `ceil(0.9 × n)`, not a linear interpolation between two neighboring observations) avoids implying a precision the sample size doesn't support — this matters a lot when `n` is in the single digits, which review-adjacent metrics usually are.

**4.4 Improvement rate is sign-normalized per metric's polarity.** Some metrics are "lower is better" (lead time, cost, tokens); others are "higher is better" (merge rate, review-completion rate). The improvement-rate computation is not a single formula applied uniformly — each metric definition carries a polarity flag, and:
```
improvement_rate =
  polarity == "lower_is_better" ? (baseline − value) / baseline
                                 : (value − baseline) / baseline
```
*Why:* applying `(value − baseline) / baseline` uniformly means "improvement" silently flips sign depending on which metric a reader happens to be looking at, and a naive downstream consumer (a dashboard tile, an alert threshold) will read a lower-is-better metric's healthy decrease as a regression. With sign normalization, a positive number always means "actually got better," with no exceptions a reader has to remember.

**4.5 `data_insufficient` propagates as null, never as zero or a suppressed row.** When `Sample Count` falls below a threshold, the pipeline does not compute a ratio/percentage anyway (a 1-of-1 sample producing a real-looking "100%" is worse than no number), and it does not silently drop the row either (that would hide "we don't have enough data" behind "nothing happened").
*Why:* the row is always written, with `Data Status = data_insufficient` and the value fields left null, so a dashboard can render "insufficient data" explicitly. The null is then expected to propagate through any downstream aggregate that touches it, rather than being silently coerced to zero.

## 5. Minimal bootstrap: what to actually build first

Do not start by building the five tables and a harvester bot. That was not how the reference deployment came to exist, and building the collection infrastructure before you know which numbers matter produces a system nobody looks at.

1. **Individual measurement, day one.** Install a local, zero-network usage-reading CLI (see `agent-cost`, §6) and just read the numbers yourself. No table, no bot, no organizational buy-in required — this alone tells you whether AI-assisted work is showing up in token/cost terms at all.
2. **Weekly manual sync.** Once you have a hypothesis about which metrics matter (lead time? review turnaround? cost per merged PR?), copy that week's numbers into a single lightweight table by hand — a spreadsheet is enough. The point of this step is to validate that the metric definitions are actually useful and interpretable *before* investing in automation around them. Skipping straight to automation risks automating the collection of a number nobody ends up looking at.
3. **Automate collection only once the target repositories and the metric/phase taxonomy have stabilized.** Add the PR-comment-marker + scheduled-harvester pattern (§3) for the tables that need continuous freshness (PR Records, Metric Records). Keep the cost tables (§2.3, §2.4) fed by your CLI tool's own structured export/measure command rather than trying to make an LLM agent narrate its own cost into a PR comment — the CLI already computed the number correctly; don't re-derive it from unstructured text.
4. **Build the bot last, not first.** Each step above validates that the previous step's definitions were worth automating. A collection bot built before step 2 tends to encode a metric taxonomy nobody has actually used yet.

## 6. Related building blocks in this ecosystem

Two existing OSS projects are the implementation parts this template assumes you already have, or can adopt directly, rather than reinvent:

- **[spec-lane](https://github.com/shiki-yusuke/spec-lane)** — a phase-based delivery-pipeline CLI (intent → spec → implement → verify → done) with a Telemetry port that shells out to a usage-measurement CLI by session ID and records cost/duration per phase into a ledger. That ledger is a direct implementation of §2.3's Phase Cost Records.
- **[agent-cost](https://github.com/shiki-yusuke/agent-cost)** — reads local Claude Code / Codex CLI logs (zero network calls), prices token usage against a versioned, sourced rate catalog, and exposes both a human-readable `report` and a machine-readable `measure --session-id ... --format json` contract (explicitly versioned via `protocol_version`) for attributing cost to a specific unit of work — exactly the need §2.3/§2.4's cost tables exist to serve.

Also see this repository's [`spec-based-impact-analysis`](../skills/spec-based-impact-analysis/) skill: it is not a metrics tool, but the same "PR/Issue comment as the interface, no new developer-facing surface" pattern used in §3 recurs there for posting impact-analysis results.

---

## 日本語サマリ

AI支援開発（レビュー bot / 実装アシスタント / コスト計測CLI）の効果計測基盤を、複数リポジトリで数ヶ月間週次運用した実績から、組織固有情報を除いて一般化した参照設計です。導入するツールではなく、「自分の環境で再導出すべきスキーマと設計判断」として書かれています。

- **5テーブル構成**: Metric Records（証左メトリクス生データ）/ PR Records（PR単位のbotレビュー実績）/ Phase Cost Records（工程別コスト）/ Token Cost Records（cache種別×agent×model×月の内訳）/ Review Memory Records（TODO追跡+メトリクス snapshot の兼用テーブル）。各テーブルは内容から決定的に導出される upsert key を1本持ち、これが再実行しても重複しないための構造的な鍵になっています。
- **収集パイプライン**: PRコメントに base64+sha256 の隠しマーカーを埋め込み、定期実行の harvester が回収して upsert する方式。開発者側は API key もツール実行も不要（AI パイプラインが既にPRコメントを投稿する動作に相乗りするだけ）。sha256 は改ざん検知だけでなく、未変更コメントの再処理スキップにも使えます。
- **Goodhart回避のガードレール**（最重要）: 個人識別子をレポート層のスキーマから機械的に排除（チーム集計側でも dev_A/B... の匿名ラベルに置換）、個人ランキングは一切作らない、mean でなく median + nearest-rank p90、指標の極性に応じた改善率の符号正規化、`data_insufficient` は 0 でも行削除でもなく null として伝播、という5点。それぞれ「なぜそうしたか」を明記しています。
- **最小ブートストラップ**: テーブルとbotから作り始めない。①agent-costで個人計測から始める→②仮説が固まったら週次手動で1枚のシートに転記→③対象repoと指標が安定してから自動収集を追加、の順で、bot は最後に作ります。
- 実装部品として `spec-lane`（工程別コストの実装）と `agent-cost`（トークン使用量とコストの計測CLI）へのリンクを含みます。
