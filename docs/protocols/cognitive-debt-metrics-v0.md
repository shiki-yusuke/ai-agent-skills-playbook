# cognitive-debt-metrics/v0

> **Status: DRAFT — NOT FROZEN. authority: none.** Design document (no schema fixtures yet; the
> implementation target is [agent-metrics-harvester](https://github.com/shiki-yusuke/agent-metrics-harvester)).
> Part of the Evidence-Closed Delivery Shadow Evidence Contracts (agreement §F, metrics half).
> Design review: 14 rounds of independent review (gpt-5.6-sol / gpt-5.6-terra), converged 2026-10-19
> (`DESIGN APPROVED`). Inline `rN 高/中:` notes record which review round forced each rule and are kept
> on purpose as rationale.

認知負債（cognitive debt）の指標 **M1 未解決の高リスク impact assertion の経過時間 / M2 予測誤り / M3 abstain 理由** を、
F1（evidence-docs `explanations/`）・F2（`contracts/cognitive-ack/v0`）・lane・release-evidence の**記録済みデータだけ**から
決定論的に出すレポート形式の設計。この文書は規範（normative）ではなく、harvester 実装の受入条件を固定するための設計書。

対象: 合意文書 §F「指標は未解決高リスク impact assertion の経過時間・予測誤り・abstain 理由」。
F1（evidence-docs `explanations/`）と F2（playbook `contracts/cognitive-ack/v0`）の記録を**読むだけ**の決定論レポート。
LLM 呼出しなし、gate なし、authority none。

## 0. 位置づけと非目的

- 出力は `cognitive-debt-metrics/v0` の JSON 1 ファイル、`authority: "none"`。authority 契約 / shared からの参照は
  F2 と同じく mechanically 禁止（文字列 `cognitive-debt` の scan）。
- 「理解の測定」ではない。`self_report` は自己申告のまま集計し、score・ranking・閾値を持たない。
- 個人次元を出さない。`principal` は入力としてのみ読み、出力には件数にも現れない。出力 key が lane design.md §3.6
  PERSONAL_DIMENSION_KEYS と衝突しないことをテストで固定。
- **最小集計単位**: 行の単位は指標ごとに決まる（M1 = episode、M2 = release-lane（r5 高: `(release_id, lane_id)` の組。
  同じ lane が複数 release に現れれば release ごとに別単位。`lanes_distinct` を併記）、ack / coverage = approval_event_id、
  M3 = 評価レコード）。**全体行**は常に出す。**内訳行**は次の 4 種だけ（lane 別行は無い）: M1 = risk_class 別、
  M2 = risk_class 別（`effective_revision.predictors.risk_class`）、ack = release 別、M3 = 月別 `by_month`（r5 中: 単位は
  評価レコード、min_cell を適用）。内訳行は単位の件数が 5 未満なら行ごと省き、代わりに `suppressed_rows` に
  `{"<metric>.<breakdown>.<key>": {"reason": "min_cell", "unit": "<単位名>", "n_lt": 5}}` を key ごとに 1 件書く（件数は
  出さない。r6 中: key は `m1.by_risk_class.high` / `ack.by_release.<release_id>` / `m3.by_month.2026-01` のように名前空間付き）。
  **内訳行は全て object**（r4 高: key = `risk_class` 値 / `release_id` / `YYYY-MM`）で、array にしない。
- 欠測は `null + reason`。「観測なし」を 0 にしない。
- **期待母集団と欠測の併記**: 各指標に `population` と `missing` を並べる。指標を良く見せる逃げ道（解説を作らない・
  消す・risk を unknown にする・評価を生成しない・広い dir 候補）は `missing` / `dropped` / `unmatched` / `dir_width` の
  どれかに現れる。

## 1. 入力と release の結合鎖

| 入力 | 場所 | 使う field |
|---|---|---|
| release 一覧 | 引数 `--release-ids <file>`（JSON 配列。母集団は呼出し側が固定） | `release_id` |
| release 台帳 | release-evidence repo の `release-events.jsonl` と bundle ファイル群（B5 と同じ入力） | event `{release_id, bundle_digest}`、bundle 本文（`release_id`, `lane_ref{lane_id,...} | null`） |
| 承認 | release-approval/v0 のイベント（ack composite の `approval_events[]`） | `event_id`, `subject.bundle_digest`, `kind` |
| ack | 同 composite の `ack_records[]` | `approval_event_id`, `occurred_at`, `record_id`, `self_report`, `scopes[].{scope_digest,risk_class,explanation_id,explanation_present}` |
| lane 見積 | 消費側 repo `docs/spec/<lane_id>/estimate.json` | `revisions[].{revision_id,estimated_at,impact_scan_snapshot?,predictors.{risk_class,files_touched_observed}}` |
| lane 完了 | `--lane-evidence <dir>` 直下の `*.json`（`lane-evidence:v1`。**ファイル名は結合に使わない**、r3 高） | `intent_id`, `artifacts.done_overlay.merge_sha` |
| 解説 | evidence-docs corpus `explanations/EXP-<16hex>.json`（git 履歴） | `explanation_id`, `scope.snapshot.{repo_commit,digest,candidate_paths}`, `body.{covered_paths,uncovered_paths}` |
| shadow 評価 | `--evaluations <repo>` の **git 管理** path `shadow-evaluations/<name>/input.json` + `<name>/evaluation.json`（r8 高: 束縛は git の同一 commit 導入。§1 の「評価ペアの束縛」） | `input.json.subject.bundle_digest`、`evaluation.json`（`release-evidence-shadow replay --out` が書く `shadow-evaluation/v0` wrapper record）の `record_digest`, `evaluation_status`, `unknown_reasons[].code`, `input_errors[].code`, `predicate_observations[].{predicate_id,status,reason.code}`, `candidate_receipt{verdict, subject.bundle_digest} | null` |

**評価レコードの正体（r3 重大）**: replay pack の `expected.json` はテスト期待値であり評価出力ではないので **読まない**。
M3 の母集団は `replay --out` で永続化された wrapper record だけ。`evaluation.json` が無いペアは `missing.no_evaluation_output`。
現時点の release-evidence repo には永続化された出力が無く、**M3 は population 0 + missing 全件から始まる**（§5 の
limit 3 に明記。評価の永続化は release-evidence 側の運用追加で、本設計の外）。読み込んだ `input.json` と `evaluation.json` は束縛検査の後、
**schema 検証**（r4 高: release-evidence の shadow-evaluation-input / shadow-evaluation/v0 schema を harvester に vendored pin
し、既存 `test/contract/vendor/` と同じ UPSTREAM.md 方式で commit を記録。不合格は `missing.evaluation_input_invalid_shape` /
`missing.evaluation_invalid_shape` で、以降の digest 検証と集計に入れない。r10 高: harvester は vendored schema を
**`input_digest` を `required` から外して**適用する = upstream が required にしても欠落は shape 不合格にならず、次段の
`evaluation_input_digest_absent` に到達する。検査順は固定: schema → record_digest → `input_digest` 存在 → `input_digest` 一致 →
同一 commit 束縛 → (a)〜(e) → `evaluation_cut` 実在性。各段で最初に不合格になった 1 code だけを `missing` に数える）。次に `record_digest` を release-evidence
`computeRecordDigest()` と**厳密に同じ式** `"sha256:" + hex(sha256(JCS(record から record_digest を除いたもの)))` で再計算し
（r4 重大: `sha256:` prefix 付き）、不一致は `missing.evaluation_record_digest_mismatch`。
**ペアの束縛（r9 高: 共置は生成の証明ではない。入力全体の digest を wrapper に要求する）**: M3 は
`evaluation.json.input_digest`（`"sha256:" + hex(sha256(JCS(input.json)))`、shadow-evaluation/v0 wrapper への**追加 field**。
release-evidence 側の変更で、本設計はそれを前提条件として待つ）が存在し、harvester が `input.json` bytes から再計算した値と
一致することを**必須**にする。field が無い wrapper は `missing.evaluation_input_digest_absent`、不一致は
`missing.evaluation_input_digest_mismatch`。release-evidence に `input_digest` が入るまで（現状ペアは 0 件なので実害なし）
harvester は M3 を計算しない（r10 高: 出力形は §2.3 の `status`。判定は vendored shadow-evaluation/v0 schema の
`properties` に `input_digest` が**無い**こと、つまり pin した release-evidence commit が field をまだ定義していないこと。
ペアの有無や件数では判定しない）。
加えて、評価ペアは release-evidence repo（または評価専用 repo）の `shadow-evaluations/<name>/` に **同じ commit で**
`input.json` と `evaluation.json` が追加され、選択 commit までに変更されていないことも要求する（他の入力と同じく committed tree の
事実。r9 高: revision 引数を固定）: `git log --first-parent --format=%H --diff-filter=A <selected-commit> -- <dir>/input.json` と同
`evaluation.json` の出力が**どちらも 1 行**で（r12 中: 2 行以上 = 削除後の再追加があれば `evaluation_pair_unbound`）その
導入 commit が一致し、`git log --first-parent --format=%H <selected-commit> -- <path>` の最新 commit が両方とも
その導入 commit であること。違反は `missing.evaluation_pair_unbound`。`<selected-commit>` は `inputs[].commit` に書いた
評価 repo の commit で、HEAD の後続更新は判定に影響しない。
**既存 field による整合条件（全て必須、違反はそれぞれの missing code）**:
(a) `evaluation.json.evaluation_cut == input.json.evaluation_cut` → `evaluation_cut_mismatch`
(b) `evaluation.json.evaluator.playbook_contract_commit == input.json.contract_pin.playbook_commit` → `contract_pin_mismatch`
(c) `evaluation.json.input_manifest.digest` を `input_manifest.records[]` から release-evidence `computeInputManifestDigest()` と
    同一式（同関数と同じ順序に並べた records の `"sha256:" + hex(sha256(JCS(records)))`、実装は vendored pin）で再計算し一致 →
    `input_manifest_digest_mismatch`
(d) `input_manifest.records[]` の `{kind, digest}` が `input.json.records[]` の `{kind, digest}` の**部分集合**（wrapper は cut 後・
    digest 検証後・重複排除後の集合を写すので等号ではなく包含）→ `evaluation_manifest_not_subset`
(e) `candidate_receipt != null` なら receipt の `subject` の **3 field 全部**（`bundle_digest`、`selection_manifest_digest`、`target`）
    が `input.json.subject` と一致（r8 高）→ `evaluation_subject_mismatch`
**有効ペア**: `valid_for_population` = `input_digest` 一致 ∧ 同一 commit 束縛 ∧ schema 検証 ∧ record_digest ∧ (a)〜(e) ∧
`evaluation_cut` の実在性（§2.3）。
`evaluations` と `evaluated_releases` はどちらも有効ペアだけで数える。

**結合鎖**（release 1 件につき）

```
release_id ─(release-events.jsonl: release_id → bundle_digest。event 0 件 = missing.no_release_event。
             **母集団の層（r6 高: 単位を混ぜない）**: トップレベル `population = {requested_releases, resolved_releases}` と
             `missing`（release 単位の鎖の欠測だけ: no_release_event / ambiguous_bundle_digest / no_bundle /
             bundle_release_id_mismatch）。各指標は **自分の単位**で `population` と `missing` を持つ（§2 各節の閉じた shape）。
             M1 は release 非依存。複数 event は同一 digest を要求、
             異なれば missing.ambiguous_bundle_digest)─→ bundle_digest
bundle_digest ─→ bundle 本文: 全 bundle ファイルのうち "sha256:" + hex(sha256(JCS(bundle))) == bundle_digest のもの
             （release-evidence `bundleDigest()` と厳密に同じ式、prefix 付き（r4 重大）。content.release_id の一致は結合条件に
             使わず、一致しなければ missing.bundle_release_id_mismatch。0 件 = missing.no_bundle）
bundle.lane_ref.lane_id ─→ estimate.json（docs/spec/<lane_id>/。その intent_id == lane_id を要求、不一致 =
             missing.estimate_intent_mismatch、r4 高）と lane-evidence（intent_id == lane_id。
             0 件 = missing.no_lane_evidence、2 件以上 = missing.ambiguous_lane_evidence）。lane_ref null = missing.no_lane_ref
bundle_digest ─→ approval_events[] with subject.bundle_digest == bundle_digest（0 件 = approvals_without_event）
approval event_id ─→ ack_records[] with approval_event_id == event_id
bundle_digest ─→ 評価ペア with input.json.subject.bundle_digest == bundle_digest（0 件 = missing.no_evaluation）
```

**release 時刻 `T_release`**: その `release_id` の event 行が `release-events.jsonl` に初めて現れた first-parent commit の
committer date（自己申告値を使わない）。

**lane の有効 revision（r3 重大: 事後 revision を結合しない）**: `impact_scan_snapshot` を持ち、かつ
`estimated_at <= T_release` の revision のうち `estimated_at` 最大、同値なら `revisions[]` の後方。該当なしは
`missing.no_revision_before_release`（M2・coverage の分母に入れない）。`lane_ref` は revision を pin しないので
これは近似であり §5 limit 2 に明記する（`estimated_at` は自己申告値、順序付けにのみ使う）。

**読む場所**: git 管理の入力（解説、estimate.json、release-events.jsonl、bundle）は `git show <commit>:<path>` で
記録済み tree から読む。`<commit>` = **全 repo 共通の唯一の規則**（r12 高: 「committer date 最大」は廃止）:
`git rev-list --first-parent HEAD` の出力順（HEAD から親へ）で**最初に** committer date ≤ `as_of` となる commit。非単調な
履歴でも走査順だけで一意に決まり、`as_of` より新しい commit の下にある古い commit は選ばない。該当が無ければその repo は
`inputs[].commit: null` で全入力 missing（`missing.no_commit_at_as_of`）。
r10 高: **evaluations repo も同じ規則**で `<selected-commit>` を選び `inputs[].commit` に書く。評価ペアの列挙は
`git ls-tree -r --name-only <selected-commit> -- shadow-evaluations/` で、`input.json` と `evaluation.json` の両方が同 dir に
ある dir だけを対象にし、片方しか無い dir は `missing.no_evaluation_output`。
作業ツリーと index は読まない。git 管理外の入力（lane-evidence dir、ack composite、release_ids）は
ファイル名 byte 順で全列挙し `{path, sha256}` を `inputs[].files[]` に全件書く（r3 中: 単一ファイルでも `files[]` 1 要素）。

時刻の根拠は git の committer date と `as_of` だけ。`generated_at` / `occurred_at` / `evaluated_at` / `estimated_at` /
`evaluation_cut` は自己申告値で、順序付けにのみ使う。

## 2. 指標の定義

### 2.1 M1 未解決高リスク impact assertion の経過時間

- 走査: corpus repo を `git rev-list --first-parent --reverse <commit>` で古い順に歩く。各 commit で `explanations/*.json`
  を tree から読み parse。parse 不能（r4 中）: その commit のそのファイルは「状態不明」として **episode を継続も終了も
  させず**読み飛ばし、`m1.malformed = {files: n, commits: n}` に数える（出力 shape に固定）。
- assertion = `(explanation_id, path)`、`path ∈ body.uncovered_paths`。
- episode: 状態列（commit 順）で `uncovered` が連続する極大区間。先頭 commit の committer date が起点。
  `episode_count` = 区間の数、`reopened_count = episode_count − 1`。
- 終点（3 通り、混ぜない。r5 中: 「直後」は**次に parse 可能な状態**を指し、malformed commit は飛ばす）:
  `covered`（次の parse 可能な commit で同 `explanation_id` の `covered_paths` に `path`）/
  `dropped`（その `explanation_id` のファイルが tree から消えた。censored。r4 高: `explanation_id` は snapshot の hash
  なので同一 id 内で `candidate_paths` は変わらない。候補が変わった解説は別 id = 別 assertion として扱う）/
  `open`（最新 commit でも uncovered。経過時間 = `as_of − 起点`）。
- 非単調な時刻: 終点 date < 起点 date なら `age_days: null, reason: "non_monotonic_dates"`、分布から除外し
  `excluded_non_monotonic` に数える。日数 = 秒差 / 86400 を小数 2 桁に切り捨て。
- risk_class の結合: 解説の `scope.snapshot.repo_commit` と `.digest` の両方が一致する lane revision を全 lane・全 revision
  から探す。複数一致の全順序（r3 中）: `estimated_at` 最大 → `lane_id` byte 順で最小 → `revisions[]` index 最大。
  一致なし = `risk_class: "unknown"`。lane の 3 値をそのまま使う。
- 出力（全体 + risk_class 別、min_cell は episode 数。r6 高: 閉じた shape、単位 = episode）: `{population: {episodes,
  assertions, explanations_seen}, open, covered, dropped, excluded_non_monotonic, reopened_count, open_age_days: {p50, p90, max} | null,
  oldest: [{explanation_id, path, since}] (10 件まで), malformed: {files, commits}}`。`missing` は M1 には無い（censored は `dropped`）。
  分位は nearest-rank。`oldest` は `(since asc, explanation_id asc, path asc)`。

### 2.2 M2 impact-scan 予測誤り（lane 単位）

- 予測 = `effective_revision.impact_scan_snapshot.candidate_paths`。effective_revision なし = §1 の `missing.no_revision_before_release`。
- 観測 = `git diff --name-only --no-renames -z <merge_sha>^1 <merge_sha>` を消費側 repo で実行。
  `artifacts.done_overlay` が null → `reason: "done_overlay_null"`（r4 高）、`merge_sha` null → `"merge_sha_null"`、
  到達不能 → `"merge_sha_unreachable"`、root → `"root_commit"`。r13 高: 「到達可能」= `git merge-base --is-ancestor <merge_sha>
  <lane-repo の selected commit>` が真（§3 の規則で選んだ `inputs[kind=lane_estimates].commit`）。object が後から fetch されても
  選択 commit の祖先でなければ `merge_sha_unreachable` のままで、同じ `inputs[]` なら判定は変わらない。
- 候補の分類（排他的な順序）: 候補文字列を重複排除した上で、**先に** `*` `?` `[` のいずれかを含むものを `pattern`、
  次に末尾が `/` のものを `dir`、残りを `file`。`dir` の prefix 一致は「観測 path が `<dir 文字列>` で始まる」。
- **入れ子 dir（r3 中: 固定）**: 観測は最長一致の dir **1 つだけ**に属する。dir が `dir_hit` になるのは、その dir に
  **直接**属する観測が 1 つ以上ある時だけ。配下の子 dir にしか観測が無い親 dir は `dir_unused`。
- 集合演算:
  - `hit = C_file ∩ O`、`unused = C_file − O`
  - `dir_hit` / `dir_unused`、`dir_width[] = [{dir, observed_count}]`（直接属する観測数）
  - `missed = O − C_file − ⋃ prefix(dir)`
  - `pattern` は `unmatched_pattern` に数え、集合演算から外す
- 比率: `missed_ratio = |missed| / |O|`、`unused_ratio = |unused| / |C_file|`、分母 0 は null。precision / recall の語は使わない。
- 件数水準（r6 中: path 水準の成否に関わらず、prediction と `files_touched_observed` が揃う全 release-lane で計算する
  並行の見方）: `|C_file| + |C_dir|` と `predictors.files_touched_observed`。後者 null → `missing.files_touched_observed_null`。
- **M2 の母集団と欠測（r6 中: 閉じた shape、単位 = release-lane）**: `population = {resolved_releases, release_lanes,
  lanes_distinct, units_with_prediction, units_with_observation, units_with_count_level}`、`missing = {no_lane_ref, no_lane_evidence,
  ambiguous_lane_evidence, estimate_intent_mismatch, no_revision_before_release, done_overlay_null, merge_sha_null,
  merge_sha_unreachable, root_commit, files_touched_observed_null}`（前 4 つは release 単位で数え `unit: "release"` を付記、
  残りは release-lane 単位）。
- `rework_commit_count` は併記しない。
- high risk で `missed` 非空の release-lane は行の `high_risk_units_with_missed` に数える（r7 中: 旧名
  `uncovered_without_explanation` は解説の存在を見ていないので改名。行 shape に格納）。
- 出力は全体行 + risk_class 別行（min_cell の単位は §0 と同じ **release-lane** 数、r9 中）。**行の集約（r4 高: micro + 分布）**:
  `{units, lanes_distinct, units_with_prediction, units_with_observation, high_risk_units_with_missed, sums: {observed, candidate_file, candidate_dir, hit, unused, missed,
  dir_hit, dir_unused, unmatched_pattern}, missed_ratio, unused_ratio, per_lane: {missed_ratio: {p50,p90,max}|null,
  unused_ratio: {p50,p90,max}|null}, dir_width: {dirs, observed_count_max}, count_level: {...}}`。
  `missed_ratio = sums.missed / sums.observed`（分母 0 は null）、`unused_ratio = sums.unused / sums.candidate_file`。
  `per_lane` は比率が non-null の release-lane だけの nearest-rank、0 件なら null。
  **count_level（r5 高）**: release-lane ごとに `predicted = |C_file| + |C_dir|`、`observed = files_touched_observed`、
  `signed_error = predicted − observed`。行では `count_level: {units, sums: {predicted, observed}, signed_error:
  {p50, p90, max}|null, abs_error: {p50, p90, max}|null}`（分位は §2.1 と同じ nearest-rank、observed null の unit は units に入れず
  `missing.files_touched_observed_null`）。path の配列は `--detail` 時だけ `m2.detail[]`（r6 中: 要素 =
  `{release_id, lane_id, status, hit[], unused[], missed[], dir_hit[], dir_unused[], unmatched_pattern[], dir_width[]}`、
  `(release_id, lane_id)` の byte 順）に出し、各配列は重複排除後 byte 順昇順。`status` の閉集合（r7 中）= `ok |
  no_revision_before_release | done_overlay_null | merge_sha_null | merge_sha_unreachable | root_commit`。`ok` 以外では
  6 つの配列は全て `[]`、`dir_width` も `[]`（`unmatched_pattern` も含む。予測だけある時も `[]`）。

### 2.3 M3 abstain 理由（評価レコード単位）

shadow-evaluation/v0 wrapper record の 3 層を別々に数える。

1. `evaluation_status` の分布: key は実在値 `evaluated | unknown | invalid_input` の 3 つに固定。
2. 評価全体: `unknown_reasons[].code` → `by_code_evaluation.unknown`、`input_errors[].code` → `by_code_evaluation.input_error`。
3. predicate 単位: `predicate_observations[]` の `status == "unknown"` を `by_predicate[predicate_id][code]`。
   `reason.code == "not_applicable_by_policy"` の observation は `by_predicate` に入れず `not_applicable[predicate_id]` に数える。
4. `abstained` = `candidate_receipt != null && candidate_receipt.verdict == "abstained"` の評価数。
   `no_candidate_receipt` = `candidate_receipt == null` の評価数。

- code の閉集合は `UNKNOWN_REASON_CODES`（5）+ `INPUT_ERROR_CODES`（3）。未知は `other:<code>`。
- **時系列 bucket**: object `by_month`（key = UTC 暦月 `YYYY-MM`、value は上の 4 層と同形）。`evaluation_cut` は
  schema の正規表現だけでなく **実在する UTC 時刻**であること（r7 中: 正規表現の各成分を範囲検査 — 月 1〜12、日はその月の
  日数以内、時 <24、分・秒 <60、小数秒は任意桁、末尾 `Z`。文字列の往復一致は要求しない）を要求し、不合格は
  `missing.evaluation_cut_invalid` で有効ペアから外す（§1 `valid_for_population`）。時刻は `evaluation.json` の `evaluation_cut`（自己申告。評価 repo の committer date は束縛と
  commit 選択にだけ使い、月 bucket には使わない。§5 limit 3 に明記）。同一 release にペアが複数あれば全ペアを評価として数え、
  `population.evaluated_releases` は「`valid_for_population` のペアが 1 つ以上ある release 数」。
- **出力形（r10 高、r12 高: key を全列挙）**: `m3_abstain_reasons = {status: "computed" | "not_computed",
  reason: null | "awaiting_input_digest", population, missing, evaluation_status, by_code_evaluation, by_predicate,
  not_applicable, abstained, no_candidate_receipt, by_month}`。`evaluation_status` = 上の 1、`by_code_evaluation` = 2、
  `by_predicate` / `not_applicable` = 3、`abstained` / `no_candidate_receipt` = 4。`by_month` の value はこの 11 key のうち
  `status` / `reason` / `population` / `missing` / `by_month` 自身を除いた **6 key**（r13 高: 再帰しない）と同形。`status: "not_computed"` の時は
  `reason: "awaiting_input_digest"` で、他の field は**全て `null`**（key は残す）。`not_computed` では評価ペアを一切読まず、
  `missing` の evaluation 系 code も数えない（`missing: null`）。`inputs[]` の `evaluations` entry は `status` に関係なく書く。
  `computed` の時 `reason: null`。
- `population = {resolved_releases: n, evaluated_releases: n, evaluations: n}`、
  `missing = {no_evaluation, no_evaluation_output, evaluation_input_invalid_shape, evaluation_invalid_shape,
  evaluation_record_digest_mismatch, evaluation_input_digest_absent, evaluation_input_digest_mismatch, evaluation_pair_unbound,
  evaluation_cut_mismatch, contract_pin_mismatch,
  input_manifest_digest_mismatch, evaluation_manifest_not_subset, evaluation_subject_mismatch, evaluation_cut_invalid}`
  （閉じた shape、単位 = 評価ペア。`no_evaluation` だけ release 単位）。

### 2.4 F2 由来（approval_event_id 単位）

- 対象 approval = §1 の鎖で release に結び付いた `approval_events[]`（`kind` は問わず、全 kind を `by_kind` に出す）。
- 1 approval に ack record が複数: `occurred_at` 最大 → `record_id` byte 順で最後を採用。`ack.missing.duplicate_ack_records` =
  破棄した ack record の数（unit: ack_record）、`ack.missing.approvals_with_duplicate_ack` = 重複を持った approval の数
  （unit: approval、r7 中）。
  ack の無い approval = `approvals_without_ack`（分母に残す）。**母集団（r6 高）**: `ack.population = {resolved_releases,
  approvals, approvals_with_ack}`、`ack.missing = {approvals_without_ack, duplicate_ack_records (unit: ack_record), approvals_with_duplicate_ack}`、`coverage.population =
  {approvals_in_denominator, approvals_in_denominator_high}`、`coverage.missing = {releases_without_lane_scope (unit: release),
  approvals_without_event (unit: release)}`。
- `self_report` 分布は全体行のみ必須、release 別行は min_cell（approval 数）。`notes` に固定文
  「held / rejected は本人の停止であり不合格ではない」。
- `explanation_present` 率: 採用 record の `scopes[]` で `risk_class == "high"` のうち `explanation_present == true`。
- coverage（F2 C8、r3 高: 単位を approval に固定し release 単位の判定を置かない）: release の lane scope =
  `effective_revision.impact_scan_snapshot.digest`（1 release 1 scope。無ければ `coverage.missing.releases_without_lane_scope`（r7 中: 正規名はこれ 1 つ）、分母に入れない）。
  分母 = lane scope を持つ release に結び付いた approval（採用 ack の有無を問わない）。分子 = 採用 ack の
  `scopes[].scope_digest` に lane scope が現れた approval。`approvals_without_ack` は分母に入り分子に入らない。
  high 限定版は lane 側 `risk_class == "high"` の release の approval だけで同じ式。release 別の coverage は出さない。
- `explanation_missing` を 2 つに分ける: `explanation_never_existed` = §2.1 の走査で `as_of` 以前のどの commit にも無い /
  `explanation_absent_at_as_of` = 過去に在ったが `as_of` 時点の tree に無い。

## 3. 出力の形と決定性

```
{ "schema_version": "cognitive-debt-metrics/v0", "authority": "none", "as_of": "<ISO8601 UTC>",
  "generator": {"name": "agent-metrics-harvester", "version": "<pkg version>", "options": {"detail": true|false}},
  "inputs": [ {"kind": "ack_composite", "dir": null, "files": [{"path": "...", "sha256": "..."}]},
              {"kind": "evaluations", "repo": "<path>", "commit": "<sha>"},
              {"kind": "explanations", "repo": "<path>", "commit": "<sha>"},
              {"kind": "lane_estimates", "repo": "<path>", "commit": "<sha>"},
              {"kind": "lane_evidence", "dir": "<path>", "files": [{"path": "...", "sha256": "..."}]},
              {"kind": "release_ids", "dir": null, "files": [{"path": "...", "sha256": "..."}], "count": n},
              {"kind": "release_ledger", "repo": "<path>", "commit": "<sha>"} ],
  "population": {"requested_releases": n, "resolved_releases": n},
  "m1_open_assertions": {...}, "m2_prediction_error": {...}, "m3_abstain_reasons": {...},
  "ack": {...}, "coverage": {...}, "missing": {...}, "suppressed_rows": {...}, "limits": ["..."] }
```

- **canonicalization（r5 中）**: 出力 bytes は **JCS canonicalizer が直接 serialize** する（harvester 既存の RFC 8785 実装
  `test/contract/vendor/verify-fixtures.mjs` と同型を `src/` に置く）。「key を並べ替えた object を `JSON.stringify`」は
  JS の整数 index 列挙規則で `"2","10"` の順になり RFC 8785 にならないので使わない。数値は整数か「小数 2 桁切り捨て」の値
  だけを出し、`-0` と `NaN` / `Infinity` は出さない（null にする）。
- **byte 順の定義（r4 中）**: 文字列を UTF-8 bytes にし unsigned byte 比較（Node の `Buffer.compare`）。JCS の key 順
  （UTF-16 code unit）とは別物で、object key の並びは JCS、array 要素の並びは byte 順と使い分ける。
- **array の順序（全 array に sort key）**: `inputs[]` は `kind` byte 順。`files[]` は `path` byte 順。path 系の
  array（§2.2）は重複排除後 byte 順。`oldest` は §2.1。`dir_width[]` は `dir` byte 順。`unknown_reasons` 等 code の
  集計は object（key 順で決まる）。`limits[]` は §5 の番号順。内訳行（risk_class 別 / release 別 / 月別）は object（§0）。
  Set / Map から array を作る箇所は必ず明示 sort を通す（テスト: fixture の入力順を逆にしても byte 同一）。
- **決定性の前提（r3 中、r13 中: `--detail` も条件）**: 同じ `inputs[]`（commit / sha256 が同じ）・同じ `as_of`・**同じ `generator.version`**・
  同じ `generator.options.detail`（出力に `"generator": {"name", "version", "options": {"detail": true|false}}` として固定）で
  byte 同一。テスト: 同じ fixture を 2 回走らせ、さらに作業ツリーに未コミット変更を加えてから走らせても同一。

## 4. 実装先と形

- **agent-metrics-harvester**。`src/cognitive-debt/` + CLI（実装は同じ入口を bin `agent-metrics-cognitive-debt` としても公開する。harvester decisions #1）
  `agent-metrics-harvester cognitive-debt --release-ids <file> --release-ledger <repo> --ack <composite.json>
  --lane-repo <repo> --lane-evidence <dir> --explanations <corpus repo> --evaluations <repo> --as-of <iso> --out <file> [--detail]`。
- git は `execFileSync("git", [...])` を PATH 解決で（B5 と同じ規律）。network なし。
- fixture: temp に git init した合成 corpus / lane repo / release-evidence repo（`GIT_COMMITTER_DATE` 固定）、F2 fixtures、
  合成の評価ペア（git init した repo に `replay --out` 相当の wrapper record と input を 1 commit で入れる。`record_digest` / `input_manifest.digest` は実装の JCS で再計算して埋める）。
  negative fixture: 再出現 / 非単調 date / dir 入れ子 / pattern 候補 / merge_sha null / 評価ペア欠落 / `evaluation.json`
  欠落 / 別 commit 導入 / 導入後の変更 / record_digest 不一致 / subject 3 field 不一致 / cut 不一致 / contract_pin 不一致 / ambiguous_bundle_digest / bundle digest 不一致 / lane_ref null /
  lane-evidence 重複 / 事後 revision のみ / min_cell / 入力順反転 / 作業ツリー汚染。
- dashboard 表示は別 PR。

## 5. 主張できないこと（出力 `limits` に固定文、この順）

1. M1 の起点は「解説が初めて uncovered と書いた commit」であって、負債が生じた時刻ではない。
2. M2 と coverage の lane revision は `T_release` 以前の最新 snapshot で近似している。`lane_ref` は revision を pin しない。
   観測は merge_sha の first-parent 差分だけで、follow-up や別 PR は含まない。dir 候補の hit は `dir_width` と併読する。
3. M3 は shadow 評価であり本番 receipt の verdict ではない。母集団は永続化された評価レコードだけで、現状は 0 件から
   始まり、`input_digest` が wrapper に入るまでは null。bucket の時刻は自己申告の `evaluation_cut`。
4. coverage は lane の scope 集合を正とし、scope を記録しなかった release は分母に入らない。
5. 個人・チーム・モデルの評価に使えない。min_cell 抑制は再識別の完全な防止ではない。
6. M3 は wrapper の `input_digest`（release-evidence 側の追加）が前提で、それまで null。`input_digest` が揃っても束縛は
   「評価器がこの入力 bytes を見た」ことまでで、評価器の実装が正しかったことの証明ではない。

## 6. 決定済み（r1〜r3）

- U1 `repo_commit + digest` 完全一致を維持 / U2 `rework_commit_count` 不採用 / U3 harvester。
- 入力は記録済み tree から読む。作業ツリーは読まない。
- 評価は `replay --out` の wrapper record。`expected.json` は読まない。digest 式は release-evidence の関数と prefix まで同一。
- `pair.json` は不採用（r8）。束縛は wrapper の `input_digest`（前提条件、r9）+ committed tree の同一 commit 導入。
