# Schema — 仕様書 frontmatter のフィールド規則

現行 `schema_version: 1`。スキーマを変更するときはこの版数を上げ、本ファイルに新旧の読み方を追記する。

## フィールド一覧

| フィールド | 必須 | 型 | 規則 |
|---|---|---|---|
| `schema_version` | ✅ | int | 現行 `1` |
| `id` | ✅ | string | `SPEC-<AREA>-<NNN>`。AREA は registry.md 掲載済みコードのみ（frontmatter の id・ファイル名は大文字、例: `SPEC-JUDGE-001`）。採番は registry.md の採番表追記で行う |
| `title` | ✅ | string | 一言タイトル |
| `status` | ✅ | enum | `draft` / `active` / `deprecated` |
| `superseded_by` | deprecated 時のみ | string \| null | 後継 SPEC ID |
| `owner` | ✅ | string | 責任チーム / ロール |
| `trace` | ✅ | list | canonical declaration（下記）。空なら `[]` を明記（未記入と区別する） |
| `related_specs` | 任意 | list | `{id, rel}`。rel: `depends_on` / `guards` / `renders` / `emits` / `observed_by`。「念のため関連」は書かない |

`version` / `updated` / 変更履歴は**持たない**（Git / PR が履歴の正本）。

### 配置先ディレクトリ名

`specs/<area>/SPEC-<AREA>-<NNN>.md` の `<area>` は **registry.md の領域コードを小文字化したディレクトリ名**（例: 領域コード `JUDGE` → `specs/judge/`）。frontmatter の `id` とファイル名の `<AREA>` 部分は大文字のまま（`SPEC-JUDGE-001.md`）。ディレクトリ名だけ小文字にする。

## trace エントリ

| キー | 必須 | 規則 |
|---|---|---|
| `type` | ✅ | `code` / `test` / `api` / `data` / `permission` / `log` / `tracking` / `config` / `flag` / `cookie` / `infra` / `locale` / `external` |
| `target` | ✅ | パス（repo root 相対）・glob・イベント名・URL。計測イベントは分析ツール固有の locator prefix（例: `gtm:`, `amplitude:`）を付けてよいが、**コード検索時はそのprefixを外し、コード上の実際の送信名で検索する**こと（prefix付きのままコード検索しても送信箇所はヒットしない） |
| `scope` | code/test で必須 | `owned` / `submodule` / `vendored` / `generated` |
| `provenance` | 任意 | `upstream` / `first-party`（submodule / vendored の由来） |
| `symbol` | tracking/log 推奨 | 定義 symbol（例: イベント名定数。alias として wrapper 定数も探索対象に含める） |
| `dashboard` | 任意 | 観測先 URL（GA / Sentry 等のダッシュボード） |
| `note` | 任意 | 1 行補足 |

### scope 境界（プロダクトごとに確定させる）

`owned` / `submodule` / `vendored` / `generated` の4区分は、対象リポジトリの実際の構成調査（Phase 0）で確定させる。以下は記入例:

| scope | 場所（例） | インライン `@spec` |
|---|---|---|
| owned | 自プロダクトが直接所有・変更するソース（例: `src/`, `app/`） | 可（3箇所限定規則に従う。テスト・ビルドスクリプト等は対象外にするか判断） |
| submodule | git submodule 等で取り込んだ外部コード（upstream 由来 / 自社他リポジトリ由来） | 禁止。package-level glob で trace |
| vendored | ビルド成果物やベンダー配布物を tracked している場所 | 禁止。locator は manifest / baseline root を優先 |
| generated | コード生成・型生成・ビルド出力等の自動生成物 | 禁止。生成元を trace する |

### e2e の trace 規則

- 意味的に関連する e2e は `type: test` で**直接宣言する**
- CI 実行制御マップ（例: 変更ファイルから実行対象テストを選ぶ設定）がある場合、それは実行制御の一次ソースであり、**仕様⇔e2e の対応関係の一次ソースにはしない**（役割が異なる）
- 分析時は宣言された e2e の CI 登録状態を照合し、`manual-only` / `nightly-only` / 未登録を verification gap として報告する

## 本文の規則

- 要求は EARS 形式 + 要求 ID（`R1`, `R2`…恒久・削除は欠番）。外部参照は `SPEC-<AREA>-<NNN>.R1`
- 状態 ID は `STATE-<NAME>`。Markdown 見出し anchor での参照は禁止
- 閾値は「あるべき値（normative）」と「実行時の値の所在（runtime source）」を分けて表にする
- 変化軸チェックは三値: `no-impact`（根拠必須）/ `not-applicable`（理由必須）/ `unknown`。軸は対象プロダクトの実態に合わせて確定する（例: LTR/RTL・タブレット/デスクトップ・権限・構成条件[フィーチャーフラグ/環境設定/実行時ユーザーコンテキスト]）
- 該当しない節は削除する（空の節を残さない）
- 分割単位は「独立して変更・廃止・所有できる振る舞い」。150 行超は分割を検討する警告ライン
