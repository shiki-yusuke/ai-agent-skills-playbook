# Spec-based Impact Analysis

仕様変更・要件追加・バグ修正・UI変更・計測変更・権限変更の影響範囲（コード / UI / テスト / ログ / 計測 / データ / 運用）を、確信度と証拠付きで列挙するための仕組み。専用ツールはなく、**構造化恒久仕様（specs/）+ AI エージェントが実行する分析手順（procedure.md）+ Issue/PR コメント運用**で構成する。

## 設計原則

**リンクを「宣言すること」と「現在も正しいこと」を分ける**（Declared / Verified）。分析の価値はリンク台帳の存在ではなく、現在のコードに対する検証可能な証拠にある。

- `specs/` — 構造化された恒久仕様の正本。第一読者は AI だが人間がレビューする
- `procedure.md` — AI エージェントが実行する影響範囲分析の標準手順
- GitHub Issue / PR のコメント運用 — 分析結果を投稿し、人間が判定する

## 使い方 3 手順

1. **影響を調べたい**: 変更要求（Issue / チケット / 自由記述）を AI エージェントに渡し、`procedure.md` の手順で分析を依頼する。結果は `templates/impact-report.md` 形式で元 Issue / PR のコメントに投稿される
2. **仕様を確認したい（インシデント時等）**: `specs/` を `rg` で検索する。イベント名・symbol からの逆引きは frontmatter の trace を検索する
3. **仕様に触れる変更をする**: 同一 PR で該当 `specs/` を更新し、PR テンプレートの仕様影響欄を記入する。新しい SPEC の採番は `registry.md` の採番表に追記する

## 導入手順（新しいプロダクトで使う場合）

1. **Phase 0: 骨組み設置 + リポジトリマッピング**
   - 対象リポジトリの所有境界を調査する（owned / submodule / vendored / generated の4区分。実際のディレクトリ構成に合わせて `schema.md` の scope 境界表を確定させる）
   - `registry.md`（領域コード台帳）・`schema.md`・`procedure.md`・`templates/` を配置する
   - 既存の開発規約（チケット管理ワークフロー等）との役割分担を明確にする（詳細は `docs/lane-integration-notes.md` 参照）
2. **Phase 1: パイロット領域で replay 評価**
   - 影響範囲・変更頻度が中程度の1領域を選び、SPEC を1〜2件書く
   - その領域の過去の修正5〜10件を選び、変更要求だけを与えてAIにブラインド分析させ、実際の diff（gold set）と突き合わせる
   - 重大見落とし（severity=Highのコアロジック完全見落とし）がないか確認する
3. **Phase 2: live パイロット**
   - 実際の未着手チケット2〜3件で分析→Issue/チケットにコメント投稿
   - 実PRが少ない場合、trace の健全性チェック（宣言済みファイルが全部解決するか）を独立に実施する（新規PRを待つ必要がない）
   - Go/No-Go 判定: 重大見落としゼロ + trace健全性が高ければ本採用
4. **運用フェーズ**: trace健全性チェックを定期実行、実PR発生の都度分析、対象領域の拡大判断

## ディレクトリ構成

```
docs/spec-impact/            # 配置例。プロダクトの規約に合わせて配置場所は調整してよい
├── README.md
├── registry.md               # 唯一の手動台帳（領域コード + 採番表）
├── schema.md                 # 仕様書 frontmatter のフィールド規則
├── specs/<area>/SPEC-*.md    # 恒久仕様の正本
├── rationale/<area>.md       # 任意。背景・意思決定リンク集
├── procedure.md              # 影響範囲分析の標準手順
└── templates/                # 仕様書・rationale・影響レポート・敵対的レビュー依頼のテンプレート
```

## 運用ルール（要点）

1. 仕様に触れる PR は同一 PR で `specs/` を更新する
2. 履歴はこのファイル群に書かない（Git / PR が正本。version/updated フィールドは持たない）
3. `@spec SPEC-<AREA>-<NNN>` アノテーションは owned コードのみ、①エントリポイント ②仕様分岐・閾値参照 ③イベント発火箇所の3箇所限定。生成物・vendored・submoduleには置かない
4. 分析レポートと人間判定は元 Issue / PR のコメントで完結させる
5. 変化軸チェック（LTR/RTL・タブレット・権限・構成条件等）の `unknown` は残してよいが、根拠なき `no-impact` は差し戻す

詳細は `schema.md` / `procedure.md` / `templates/` を参照。
