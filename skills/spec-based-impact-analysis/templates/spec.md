---
# ============================================================
# 仕様書テンプレート（正本 / AI 用仕様書）
# 配置先: docs/spec-impact/specs/<area>/<SPEC-ID>.md
#   <area> は registry.md の領域コードを小文字化したディレクトリ名（例: JUDGE -> judge/）。詳細は schema.md 参照
# 第一読者は AI エージェントだが、人間がレビューできる正本である。
# 規約:
# - 1 ファイル = 独立して変更・廃止・所有できる 1 つの振る舞い
#   （150 行超は分割を検討する警告ライン。強制ではない）
# - 該当しない節は削除する（空の節を残さない）
# - 履歴は Git / PR が正本。このファイルに変更履歴を書かない
# - フィールド規則の詳細は schema.md 参照
# ============================================================
schema_version: 1
id: SPEC-<AREA>-<NNN>            # 採番 = registry.md の採番表に追記（同時採番は conflict で検出）
title: <仕様の一言タイトル>
status: draft                 # draft | active | deprecated
superseded_by: null           # deprecated 時に後継 SPEC ID を記入
owner: frontend               # 責任チーム / ロール
trace:                        # canonical declaration（正方向リンクの正本）
  # type: code | test | api | data | permission | log | tracking | config | flag | cookie | infra | locale | external
  # scope: owned | submodule | vendored | generated（Phase 0 のリポジトリマッピングに従う）
  # provenance: upstream | first-party（submodule/vendored の由来。任意）
  - type: code
    target: src/<path/to/file>.ts    # プレースホルダー。実在パスに差し替える
    scope: owned
  - type: code
    target: external/scratch-blocks/**         # submodule/vendored は package-level glob。inline @spec は置かない
    scope: submodule
    provenance: upstream
  - type: test
    target: src/<path/to/test>.test.ts    # プレースホルダー。実在パスに差し替える
    scope: owned
  - type: tracking
    target: gtm:sk_<event_name>                  # プレースホルダー。src/gtm/events.ts の実在イベントに差し替える（送信名は sk_ prefix 付き）
    symbol: GTM_EVENTS.<eventKey>                # 定義 symbol（alias: GTM_EVENT_DEFINITIONS.<key>）
    dashboard: <GA エクスプロレーション URL>       # 任意
  - type: flag
    target: <flag_name>                         # プレースホルダー。実在の rollout flag 名に差し替える（本物の flag がない領域では type: config を使う）
related_specs:                # 関係種別付き 1 ホップグラフ。「念のため関連」は書かない
  - id: SPEC-<AREA>-<NNN>      # プレースホルダー。registry.md 掲載済みの実在 SPEC ID に差し替える
    rel: depends_on           # depends_on | guards | renders | emits | observed_by
---

# SPEC-<AREA>-<NNN>: <仕様の一言タイトル>

## 要求（EARS 形式・要求 ID 付き）

<!-- 要求 ID（R1, R2…）は恒久。削除時は欠番のまま残す。外部からは SPEC-<AREA>-<NNN>.R1 で参照する -->

- **R1**: WHEN <トリガー>, THE SYSTEM SHALL <応答>
- **R2**: WHILE <状態>, THE SYSTEM SHALL <応答>
- **R3**: IF <望ましくない条件>, THEN THE SYSTEM SHALL <応答>

## 判定基準・閾値

<!-- normative requirement（あるべき値・条件）と runtime value source（実行時の値の所在）を分ける -->

| 項目 | あるべき値・条件 (normative) | 実行時の値の所在 (runtime source) |
|---|---|---|
| <閾値名> | <値 or 条件> | ハードコード src/... / flag:<名> / env:<名> / 管理画面 |

## 状態遷移

<!-- 状態 ID（STATE-*）は恒久。UI 状態はこの SPEC 内に書く（独立した画面カタログは作らない） -->

| 状態 ID | 現在状態 | イベント | ガード | 次状態 | 副作用 | 計測 | 関連SPEC |
|---|---|---|---|---|---|---|---|
| STATE-ANSWERING | answering | submit | — | judging | 回答送信 API | `gtm:sk_<event_name>`（実在イベントに差し替える） | SPEC-<AREA>-<NNN> |

## エッジケース

<!-- 「仕様かバグか」の即答に使う。判断に迷った実例を追記していく -->

| ケース | 期待動作 | 根拠（Issue / PR / ADR の locator） |
|---|---|---|
| <入力・状況> | <正しい挙動> | #000 |

## 変化軸チェック（三値。unknown のまま残してよいが、no-impact には根拠が要る）

<!-- 値: no-impact(根拠必須) / not-applicable(理由必須) / unknown -->

| 軸 | 判定 | 根拠・理由 |
|---|---|---|
| LTR / RTL | unknown | |
| タブレット / デスクトップ | unknown | |
| 権限・ロール | unknown | |
| 構成条件（flag / clientConfig / appEnv 等） | unknown | |
