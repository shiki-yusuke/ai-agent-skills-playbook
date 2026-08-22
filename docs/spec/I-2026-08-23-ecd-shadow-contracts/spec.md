# Spec: Evidence-Closed Delivery F — Shadow Evidence Contracts (draft_revision)

Intent: `I-2026-08-23-ecd-shadow-contracts` / declared_risk: medium

> **Revision 2 (2026-08-23)**: sol architect レビュー（must 5件）を反映。`reviewer`→`assessor`
> 改名（shared/personal-dimensions.mjs の禁止キー `reviewer` との衝突。decision/v1 の前例に従う）、
> `locations[].path` 必須化、R21〜R24 追加、R19 拡張。ask 3件の裁定を R21/R22/R23 に凍結。

> **Human-review band: applicable.** 本変更は新しい契約（= 新しいガード・状態）を3本導入する
> cross-cutting 変更である。下記「Dependency and path cross-check」の表・TEST-ID 対応・軸の選択に
> ユーザーの明示承認を得るまで Phase 3 (implement) へ進まない。

## 設計の出自（このspecが発明しない事項）

契約の意味設計は正本プラン `~/.claude/plans/users-a13714-oss-space-https-claude-ai-scalable-scone.md`
（Codex sol 6ラウンド収束、Round 6 凍結可判定、2026-08-23 ユーザー承認）で確定済み。
本 spec はそれを playbook の既存契約パターン（`contracts/<name>/<version>/` =
schema + fixtures + verify-fixtures.mjs、zero npm deps、shared validator 再利用）に落とす。

- Authority DAG: `review-findings 記録 → promotion-receipt（人間承認以外を評価する pre-approval
  receipt）→ release-approval（人間、exact digest 束縛、唯一の authority）`
- receipt の verdict は `ready_for_approval | ineligible | abstained`。`eligible` は存在しない
  （Round 5 の authority 循環修正）
- 3契約とも **draft_revision**（freeze しない。freeze は freeze-after-exercise 規律で実運用後）

## EARS 要求

### review-findings/v1

- **R1** The schema SHALL require: `schema_version`(literal), `record_id`, `recorded_at`(UTC `Z` のみ、offset 拒否 — release-evidence/v0 と同一規律), `supersedes_record_id`(string|null), `subject{repository_ref, digest("sha256:"+64hex)}`, `scan_scope{paths(min 1), commit_range{base,head}, lenses(min 1)}`, `assessor{kind, model_cohort, independence{code,params}}`（`reviewer` は personal-dimensions 禁止キーのため使用不可 — Revision 2）, `outcome`, `abstention`, `findings`。`additionalProperties: false`。
- **R2** WHEN `outcome=findings_observed` THEN `findings` SHALL have ≥1 entries AND `abstention` SHALL be null.
- **R3** WHEN `outcome=none_observed_in_recorded_scope` THEN `findings` SHALL be `[]` AND `abstention` SHALL be null（走査 scope は R1 により常に非空 — 「見なかった」を「見て無かった」と偽装できない）。
- **R4** WHEN `outcome=abstained` THEN `findings` SHALL be `[]` AND `abstention{code,params}` SHALL be present.
- **R5** Each finding SHALL carry: `finding_id`(record 内一意), `category`(closed 9値: correctness|security|reliability|performance|type_safety|test_quality|maintainability|documentation|lint_format), `severity`(closed 4値: critical|high|medium|low), `claim`(non-empty), `locations`(min 1; 各要素は `path` 必須、`start_line`/`end_line` は ≥1 の integer か null — 0 禁止、両方 null か両方 non-null、`end_line >= start_line`), `suggested_fix`(string|null), `evidence_gate{oracle_kind(external_outcome|evigate), oracle_ref, predicate{code,params}, required_verdict(literal "proven")}`。
- **R6** WHEN `assessor.kind` ∈ {human, deterministic_tool} THEN `model_cohort` SHALL be null; WHEN ∈ {model, hybrid} THEN `model_cohort` SHALL be a non-empty string。`assessor.independence` は `{code, params}` 構造化 record（derive-independence.mjs の出力形式と同形）で、数値スコアを持たない。
- **R7** The record SHALL NOT contain numeric confidence fields anywhere; personal-dimension scan (`contracts/shared/personal-dimensions.mjs`) SHALL be applied to every fixture（assessor の人名・実行 ID・email 等は fail-closed 拒否）。

### promotion-receipt/v0

- **R8** The schema SHALL require: `schema_version`(literal), `receipt_id`, `evaluated_at`(UTC Z), `evaluation_phase`(pre_promotion|post_deploy), `subject{bundle_digest, selection_manifest_digest, target(preview|staging|production)}`, `policy_digest`, `effective_risk`(low|medium|high — 評価開始時に凍結した値の記録), `predicates`(min 1), `verdict`。
- **R9** Each predicate SHALL carry: `predicate_id`(closed set), `applicability`(applicable|not_applicable), `status`(satisfied|contradicted|unknown), `evidence_refs`(array of `{kind(review_finding|release_evidence|other), ref, digest}`; `status=satisfied|contradicted` では **resolvable kind（review_finding | release_evidence）の ref を min 1** — `other` は補助情報のみで単独では satisfied を成立させられない), 任意の `notes`。`applicability=not_applicable` では `status` は `unknown` 固定（評価していないものに satisfied を与えない）。
- **R10** The verifier SHALL enforce verdict derivation semantically: applicable な `contradicted` が1件でもあれば `verdict=ineligible`; さもなくば applicable な `unknown` が1件でもあれば `verdict=abstained`; さもなくば（applicable 全て satisfied）`verdict=ready_for_approval`。導出と一致しない verdict の fixture は reject。
- **R11** `predicate_id` closed set は phase で分割される: pre_promotion = {artifact_identity, review_admissibility, verification_coverage, preview_verified, rollback_target_valid, privilege_boundary}; post_deploy = {deployed_artifact_readback}。**`human_release_approval` はどちらの set にも存在しない**（authority 循環の排除 — 人間承認は述語ではなく release-approval event）。phase と predicate の不一致は reject。
- **R12** The verifier SHALL recompute `semantic_digest` = `"sha256:" + sha256hex(canonicalize(receipt から evaluated_at と receipt_id と semantic_digest 自身を除いた object))` and reject a mismatch（TOCTOU 再評価の同一性判定に使う digest。時刻を含めない）。
- **R13** `verdict` の値域は `ready_for_approval | ineligible | abstained` のみ。`eligible` / `break_glass_authorized` は schema レベルで存在しない（break-glass は release-approval 側の人間 event）。

### release-approval/v0

- **R14** The ledger event schema SHALL define `kind` ∈ {approval_granted, approval_rejected, approval_revoked, break_glass_approve} 。全 kind が `subject{receipt_digest, receipt_semantic_digest, bundle_digest, selection_manifest_digest, target}` を必須で持つ（**exact 束縛 — どの kind もこの束縛を免除されない**）。
- **R15** `approval_granted` と `break_glass_approve` SHALL additionally require `expires_at`(UTC Z)。`approval_revoked` SHALL reference exact `revoked_approval_event_id`。
- **R16** `break_glass_approve` SHALL additionally require `bypassed_predicate_ids`(min 1, promotion-receipt の closed set の部分集合) AND `incident_ref`(non-empty)。artifact 束縛・target・expiry の免除は schema 上不可能である。
- **R17** `principal` SHALL be `{principal_id, issuer, role_snapshot}` — `principal_id` は pattern `^[a-z0-9][a-z0-9_-]{0,63}$`（`@` や空白を含む値 = email・人名の直接記入を schema レベルで拒否する pseudonymous 制約）。personal-dimension scan も全 fixture に適用。
- **R18** `event_id` SHALL be recomputed by the verifier from `JCS(event without event_id)`（release-evidence/v0 の event_id 規約と同一形式）; 重複 `event_id` は ledger fixture で reject。
- **R19** Cross-record: ledger fixture 内の approval event の `receipt_digest` は、同 fixture に含まれる実際の promotion-receipt の JCS sha256 と一致しなければ reject（文字列の繰り返しは証明にならない — release-evidence sol must-2 と同じ規律）。receipt の `subject.bundle_digest` と approval の `subject.bundle_digest` の不一致（= stale approval の形）も reject。R19 対象の conformance ledger は composite 形式（findings + receipt + approval_events）に統一する。`approval_revoked.revoked_approval_event_id` は同一 ledger 内の approval_granted / break_glass_approve の event_id に解決され、subject が一致し、`occurred_at` が対象 grant より後でなければ reject（dangling / wrong-kind / 時系列逆転の拒否）。


### Revision 2 追加要求（sol architect レビュー反映）

- **R21** A pre_promotion receipt SHALL contain **all six** pre_promotion predicate_ids exactly once（重複・欠落は reject）; a post_deploy receipt SHALL contain deployed_artifact_readback exactly once。常設3述語（artifact_identity / review_admissibility / verification_coverage）と deployed_artifact_readback は `applicability=applicable` でなければならない（全 not_applicable で ready_for_approval になる経路の遮断）。
- **R22** `approval_granted` SHALL be valid only against a receipt whose `verdict=ready_for_approval`。ineligible / abstained receipt への approval_granted は reject。non-ready receipt を越えられるのは `break_glass_approve` のみ（監査フィールド必須の例外経路）。
- **R23** review_finding evidence ref の `digest` は record **全体**の JCS sha256（record_digest）に束縛される（claim / severity / outcome の差し替えは digest を変える）。ref の anchor は `<record_id>#<finding_id>`（実在 finding に解決必須）または `<record_id>#scope`（outcome=none_observed_in_recorded_scope の record のみ有効）。release_evidence ref は fixture 内に bundle が埋め込まれている場合は実 JCS digest 解決を行い、解決できない ref は resolvable と数えない。
- **R24** Conformance ledger 内の duplicate `event_id` は reject（producer は同一 event を再 append してはならない）。同一 `event_id` で payload が異なる場合は hard conflict として reject。consumer が読み取り時に byte-identical な重複行へ遭遇した場合の扱いは idempotent no-op（読み飛ばし）だが、これは fixture の合格条件ではない。

### 凍結事項ドキュメント

- **R20** `docs/evidence-closed-delivery-frozen-decisions.md` SHALL record: F/G/H の KPI の母数・観測期間・FP 判定者、H の起動条件と証拠源、マイルストーン I の解禁数値表（category × 受理率/最低件数/FP上限/収束率）、外部根拠の出典・日付・適用範囲（SWE-Review 系を不使用とした判断を含む）、運用上限と縮退順序。

## Gherkin シナリオ（fixture 対応）

```gherkin
Scenario: 走査scopeを記録した「finding なし」だけが none_observed になれる   # TEST-01
  Given outcome=none_observed_in_recorded_scope の record
  When scan_scope.paths が空 (または lenses が空)
  Then schema validation は失敗する

Scenario: applicable unknown は必ず abstained に落ちる                      # TEST-02
  Given predicates に applicability=applicable, status=unknown が1件ある receipt
  When verdict が ready_for_approval と記載されている
  Then verifier は verdict_derivation_mismatch で reject する

Scenario: contradicted 1件は他が全部 satisfied でも ineligible              # TEST-03
  Given applicable な contradicted 1件 + satisfied 多数の receipt
  When verdict が ready_for_approval または abstained
  Then verifier は reject する

Scenario: 人間承認は述語として書けない                                      # TEST-04
  Given predicate_id=human_release_approval を含む receipt
  Then schema validation は失敗する (closed set 外)

Scenario: approval は exact digest 束縛から逃れられない                     # TEST-05
  Given subject.bundle_digest が同 ledger 内 receipt の bundle_digest と異なる approval_granted
  Then verifier は stale_approval_binding で reject する

Scenario: receipt_digest は実在する receipt の実 JCS digest でなければならない # TEST-06
  Given ledger fixture 内のどの receipt の JCS sha256 とも一致しない receipt_digest
  Then verifier は reject する

Scenario: break-glass も束縛と期限を免除されない                            # TEST-07
  Given expires_at または bypassed_predicate_ids または incident_ref を欠く break_glass_approve
  Then schema validation は失敗する

Scenario: 個人次元と数値 confidence は fail-closed                          # TEST-08
  Given reviewer/principal に email 形式の値、または confidence: 0.9 を含む fixture
  Then schema pattern / personal-dimension scan / additionalProperties が拒否する

Scenario: fix 後の record は別 digest = 旧 finding の失効                   # TEST-09
  Given subject.digest が異なる2つの review-findings record
  Then 同一 subject と見なされない (verifier は digest 一致でのみ finding を receipt の evidence_refs に解決する)

Scenario: pre_promotion receipt は6述語を1回ずつ全部持つ                    # TEST-10 (R21)
  Given pre_promotion の receipt
  When predicate が欠落・重複、または常設3述語が not_applicable
  Then verifier は reject する

Scenario: approval_granted は ready_for_approval の receipt にしか効かない  # TEST-11 (R22)
  Given verdict=abstained または ineligible の receipt を含む composite ledger
  When approval_granted がその receipt_digest に束縛されている
  Then verifier は reject する (break_glass_approve のみ有効)

Scenario: finding の内容差し替えは record_digest を変える                    # TEST-12 (R23)
  Given composite ledger の review_finding evidence ref
  When 参照先 record の claim/severity を差し替える
  Then record_digest が一致せず verifier は reject する

Scenario: dangling / wrong-kind / 時系列逆転の revoke は拒否                # TEST-13 (R19拡張)
  Given approval_revoked を含む composite ledger
  When revoked_approval_event_id が未解決・非 grant 対象・grant より前
  Then verifier は reject する
```

## Dependency and path cross-check

**Applicability: applicable**（新契約 = 新しいガード・状態の導入。fail-closed で本節を実施）。

導入する依存/変更:

| DEP | 内容 |
|---|---|
| DEP-01 | `contracts/review-findings/v1/`（schema + fixtures + verifier）新設 |
| DEP-02 | `contracts/promotion-receipt/v0/` 新設（verdict 導出・semantic_digest・phase 分割の semantic MUST 付き） |
| DEP-03 | `contracts/release-approval/v0/` 新設（event ledger + cross-record 検証） |
| DEP-04 | `contracts/shared/`（schema-validator / personal-dimensions / jcs）の**消費**（変更なし） |
| DEP-05 | `docs/protocols/*.md` 3本 + `docs/evidence-closed-delivery-frozen-decisions.md` + README の契約一覧更新 |

影響を受けうる既存 path:

| PATH | DEP-01 | DEP-02 | DEP-03 | DEP-04 | DEP-05 |
|---|---|---|---|---|---|
| PATH-01 `contracts/shared/schema-validator.mjs` | 参照する | 参照する | 参照する | 変更しない | — |
| PATH-02 `contracts/shared/personal-dimensions.mjs` | 参照する | 参照する | 参照する | 変更しない | — |
| PATH-03 `contracts/shared/jcs.mjs` | — | 参照する(digest) | 参照する(event_id) | 変更しない | — |
| PATH-04 `contracts/release-evidence/v0`（bundle digest 規約・event_id 規約・UTC Z 規律） | 規約を踏襲 | `subject.bundle_digest` が参照する | 規約を踏襲 | — | — |
| PATH-05 `contracts/decision/v1`（命名隣接） | — | **相互参照なし**（promotion-receipt は decision という語をフィールドに使わない: verdict） | — | — | protocol doc に区別を明記 |
| PATH-06 `contracts/shared/derive-independence.mjs`（{code,params} 形式） | assessor.independence が同形式を踏襲（参照のみ） | — | — | 変更しない | — |
| PATH-07 `README.md` の契約一覧 | — | — | — | — | 追記する |

「参照する」セルはすべて**既存ファイル無変更の消費**であり、破壊的変更はない。unknown セルはない。
上記 TEST-01〜09 が全 DEP の拒否経路を担保する（DEP-04 は既存の shared テストが担保、DEP-05 は
R20 の存在チェックと目視）。

軸の選択: fixture の軸は「5系統の replay 欠陥」（none_observed 偽装 / authority 不足 /
digest mismatch / contradiction 無視 / unknown の握り潰し）+「禁止事項」（個人次元・数値
confidence・human_release_approval 述語化・break-glass 免除）とした。網羅の根拠は正本プラン
F の DoD（replay fixture 5系統）である。

## 実装ノート（Phase 3 向け）

- 各契約 dir は release-evidence/v0 と同型: `<name>.schema.json`（event 系は複数 schema 可）+ `fixtures/accept-*|invalid-*|reject-*.json` + `verify-fixtures.mjs`（zero npm deps、shared validator 再利用、fixture 名で期待結果を宣言）
- protocol doc（docs/protocols/<name>-<version>.md）冒頭に `Status: DRAFT (draft_revision 1) — NOT FROZEN` を明記し、既存 doc の体裁（normative MUST 列挙 + fixtures への参照）に従う
- timestamps はすべて UTC `Z` 限定（offset fixture は invalid）
- `recorded_at`/`evaluated_at` は semantic_digest / event_id の対象から除外しない（event_id は event 全体から event_id を除いた JCS。semantic_digest のみ時刻除外 — R12 の定義に従う）
