# Spec: shared schema-validator への oneOf 評価の追加

Intent: `I-2026-08-23-shared-validator-oneof` / declared_risk: medium

> **Human-review band: applicable.** 全13契約の検証が共有する infrastructure（contracts/shared/
> schema-validator.mjs）への新しいガードの導入 = cross-cutting 変更。下記 cross-check 表・TEST-ID
> 対応にユーザーの明示承認を得るまで Phase 3 へ進まない。

## 背景

sol architect レビュー（F lane 3巡目、2026-08-23）が発見: validator は oneOf を評価しないため、
`lane_ref: 42` の release-evidence bundle が schema 検証を通過する（実機再現済み = premise_evidence）。
F lane では release-approval verifier 内の補完（laneRefMatchesUnion/reviewMatchesUnion）で対処したが、
schema が約束する制約が validator で強制されないのは横断的欠陥（F lane の test_gaps priority: high）。
oneOf の実使用箇所は release-evidence の2 schema のみ（grep 確認済み）。anyOf は全契約で使用ゼロ。

## EARS 要求

- **R1** `validateAgainst` SHALL evaluate `oneOf`: instance が **ちょうど1つ**の subschema に一致
  しなければ error（0件一致・2件以上一致のいずれも invalid）。error 文言は既存形式に合わせ
  `"${pathStr}: oneOf expected exactly one subschema to match, matched ${N}"`。
- **R2** oneOf の各分岐の試行は **隔離されたエラーリスト**で評価し、非一致分岐のエラーを呼び出し側の
  `errors` に漏らさない（既存 `if`/`not` と同じ規律）。
- **R3** oneOf は同一 schema object の他 keyword と compose し early return しない（既存 `allOf` と
  同じ規律）。`$ref` を含む分岐でも `currentDoc` の解決が壊れない。
- **R4** ファイル冒頭のサポート keyword 一覧コメントに `oneOf` を追記する。
- **R5** self-test `contracts/shared/schema-validator.selftest.mjs`（zero npm deps）を新設し、
  `contracts/shared/repo-checks.mjs` から実行されるよう配線する（CI は repo-checks を実行済みのため
  CI 経路に自動で載る）。self-test は最低限: (a) inline schema での exactly-one / zero-match /
  multi-match、(b) sibling keyword との compose、(c) 分岐内 `$ref`、(d) エラー隔離（非一致分岐の
  エラー文言が結果に混入しない）、(e) **実 schema 回帰**: release-evidence-bundle.schema.json に対し
  `lane_ref: 42` / `review: 42` が invalid になり、既存 accept fixture（read-only 参照）が valid の
  ままであること。
- **R6** 全13契約の verify-fixtures.mjs と repo-checks.mjs は変更後も exit 0 で、既存 fixture の
  期待結果は1件も変わらない（回帰ゼロ）。
- **R7** release-approval/v0/verify-fixtures.mjs の union 補完は**削除しない**（防御の重層として維持）。
  コメントのみ「shared validator が oneOf を評価するようになった（本 lane）。本補完は defense-in-depth
  として維持」に更新する。

## Gherkin シナリオ

```gherkin
Scenario: どの分岐にも一致しない instance は invalid                    # TEST-01
  Given oneOf を持つ schema と lane_ref: 42 の bundle
  Then validate が oneOf エラーを返す

Scenario: 2分岐以上に一致する instance も invalid                       # TEST-02
  Given 重複して一致しうる2分岐の inline schema
  Then matched 2 のエラーを返す

Scenario: 正当な instance は影響を受けない                              # TEST-03
  Given release-evidence の既存 accept fixture
  Then validate はエラーゼロのまま (回帰なし)

Scenario: 非一致分岐のエラーは漏れない                                  # TEST-04
  Given 1分岐に一致する instance
  Then 他分岐の試行エラー文言が結果に含まれない
```

## Dependency and path cross-check

**Applicability: applicable**（共有 infra への新ガード）。

| DEP | 内容 |
|---|---|
| DEP-01 | validateAgainst への oneOf 評価の追加 |
| DEP-02 | self-test 新設 + repo-checks への配線 |
| DEP-03 | release-approval 補完コメントの更新（挙動変更なし） |

| PATH | DEP-01 | DEP-02 | DEP-03 |
|---|---|---|---|
| PATH-01 全13契約の verify-fixtures.mjs（validator 消費者） | 挙動影響あり得る → R6 の全回帰で担保 | — | — |
| PATH-02 release-evidence の2 schema（唯一の oneOf 使用者） | 検証が**厳格化**される（意図どおり）→ R5(e) で正負両方確認 | 参照のみ | — |
| PATH-03 repo-checks.mjs | — | 配線追加 | — |
| PATH-04 release-approval union 補完 | 冗長化するが維持 | — | コメントのみ |
| PATH-05 vendored copy（lane repo 等の UPSTREAM pin） | commit pin のため本変更の影響なし。再 vendor 時に追随（別タスク） | — | — |

TEST 対応: TEST-01/02/04 = self-test 内 inline ケース、TEST-03 = self-test の実 schema 回帰 + R6 全 verifier。

## 実装ノート

- 挿入位置は既存 `not` ブロックの直後（if/not の隔離評価パターンを踏襲）
- self-test は `node contracts/shared/schema-validator.selftest.mjs` 単体でも実行可能にし、
  repo-checks からは child process でなく import + 関数呼び出しでも spawn でも可（既存 repo-checks の
  流儀に合わせる）
