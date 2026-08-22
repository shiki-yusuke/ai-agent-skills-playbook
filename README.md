# ai-agent-skills-playbook

AIエージェント（Claude / Codex等）を使った開発で再利用してきた **スキル / ガードレール** を、特定プロダクトに依存しない形で蓄積する個人用リポジトリ。

各スキルは「実際にプロダクションリポジトリで運用し、複数ラウンドのレビュー・複数回のブラインド評価を経て磨いたもの」の一般化版。プロダクト固有の実装詳細（ファイルパス・閾値・ビジネスロジック）は含めず、パターン・手順・テンプレートのみを収録する。

スキル集が中心のリポジトリだが、他の公開OSSが依拠する標準仕様（protocol）の正本（SSOT）を1本含む（→ [Public interoperability protocols](#public-interoperability-protocols)）。

**初めての場合**: [`docs/getting-started.md`](docs/getting-started.md) に、目的別に使うツールを選ぶための入り口（Recipes、実行確認済みの最小コマンド）がある。全体がどう繋がるかは [`docs/architecture-tour.md`](docs/architecture-tour.md) を参照。

## 収録スキル

| スキル | 一言で言うと | 詳細 |
|---|---|---|
| [`spec-based-impact-analysis`](skills/spec-based-impact-analysis/) | 恒久仕様(SPEC)をコード/テスト/ログ/計測に紐付け、変更要求が来た時にAIが確信度付きで影響範囲を予測する仕組み | [README](skills/spec-based-impact-analysis/README.md) |
| [`pre-implementation-impact-scan`](skills/pre-implementation-impact-scan/) | 実装着手前に、シンボル参照・依存方向・テスト波及をその場で動的に調査するskill | [SKILL.md](skills/pre-implementation-impact-scan/SKILL.md) |

## この2つの関係

- **spec-based-impact-analysis**: 事前に書いた恒久仕様(SPEC)を参照する。対象領域を絞ってSPECを整備する初期投資が要るが、一度書けば「閾値」「不変条件」「過去のバグの再発防止ルール」のような**蓄積された知識**を分析に使える
- **pre-implementation-impact-scan**: SPECの整備を待たず、コードベース全体をその場で（シンボル参照グラフ経由で）動的に調査する。蓄積知識はないが、どんな変更にも即座に使える

**併用パターン**: pre-implementation-impact-scan の「docs/spec 更新要否」ステップから spec-based-impact-analysis のSPECを参照させる（該当領域にSPECがあれば深い分析、なければ動的探索のみ）。両者は置き換えではなく補完関係にある。

## 設計の背景

これらのスキルは、正誤判定ロジック（教育系プロダクトのプログラミング学習コンテンツ採点機能）を対象にしたパイロット導入で磨かれた。導入プロセスでは:

1. Codex（上級ソフトウェアアーキテクト役）による設計レビューを複数ラウンド実施
2. 過去の修正7件をAIにブラインドで分析させ、実際の修正内容と突き合わせてrecall/precisionを計測（Phase 1: replay評価）
3. 実際の未着手チケットで分析を実施し、本番のIssue/PRコメントとして投稿（Phase 2: liveパイロット）
4. 複数の独立した分析が同じ見落としに収束した箇所をSPECの改善点として反映

という段階を踏んでいる。この経験から得た「精度を上げるための設計判断」（Declared/Verifiedの分離、confirmed/candidates/unknownsの3区分、trace健全性チェックの手法等）は各スキルのドキュメントに反映済み。

## 使い方

各スキルディレクトリの README / SKILL.md を、導入先プロダクトの実際の構成（ディレクトリ構造・依存関係ルール・使用ツール）に合わせて具体化してから使う。テンプレートの `<placeholder>` 部分を実プロジェクトの値に置き換えること。

## 収録ドキュメント

| ドキュメント | 一言で言うと |
|---|---|
| [`docs/ai-metrics-platform-template.md`](docs/ai-metrics-platform-template.md) | AI支援開発の効果計測基盤（5テーブルスキーマ + PRコメントマーカー収集 + Goodhart回避ガードレール）の参照設計テンプレート |
| [`docs/protocols/agent-metrics-v1.md`](docs/protocols/agent-metrics-v1.md) | 上記テンプレートの「PRコメントマーカー収集」パターンを具体化した、機械検証可能な normative protocol（次節参照） |

## Public interoperability protocols

このリポジトリはスキル集が主目的だが、他の公開OSSが実装として依拠する protocol の正本（SSOT）としての役割も一部持つ。リポジトリ全体を metrics 専用にする意図はなく、あくまで収録物の1つという位置づけ。

### agent-metrics:v1

AIエージェントのトークン使用量・推定コストのテレメトリを、PR（変更）コメント経由で運ぶための normative protocol。

- 凍結契約: `agent-metrics-v1.0.0`
- Reference emitter: [spec-lane](https://github.com/shiki-yusuke/spec-lane)
- Reference harvester: [agent-metrics-harvester](https://github.com/shiki-yusuke/agent-metrics-harvester)
- Protocol document: [`docs/protocols/agent-metrics-v1.md`](docs/protocols/agent-metrics-v1.md)
- Conformance fixtures: [`contracts/agent-metrics/v1/`](contracts/agent-metrics/v1/)

設計原則（詳細はprotocol文書側の記述が正本。ここでは複製せず要点のみ）:

- snapshot、not delta — 訂正は同一 `upsert_key` への完全な置き換えとして表現する
- checksum、not signature — `sha256` は改ざん検知用であり、認証の代わりにはならない
- 認証は transport 層の責務（comment author の allowlist 照合等）であり、payload 自身は何も証明しない
- `coverage` / `omissions` を明示し、測れなかったものを黙って落とさない
- 個人識別次元を持たない（schema レベルで禁止） — この telemetry は個人評価ではなく、プロセス改善のための work/process telemetry

### trace:v1

Decision–Evidence Graph の正本エッジ（append-only JSONL、1行=1イベント）を表す normative protocol。`declares` / `session_bound` / `usage_imported` / `supersedes` 等の closed relation set と、決定的・冪等な `event_id` 生成規則（JCS + sha256）を定義する。

- Status: **contract-only**（M0時点。schema/fixture/protocol文書はこのリポジトリがSSOTだが、emitter/reader の reference 実装はまだ無い — spec-lane 側の実装は今後の作業）
- Protocol document: [`docs/protocols/trace-v1.md`](docs/protocols/trace-v1.md)
- Conformance fixtures: [`contracts/trace/v1/`](contracts/trace/v1/)

### attribution:v1

「1 session = exactly 1 task」の会計原則を、session-to-task の binding 記録（`binding-record`）と時間窓ごとの audit 結果（`audit-result`）として機械検証可能にした normative protocol。trace:v1 の `session_bound` / `usage_imported` / `attributed_to` relation の上に構築される。

- Status: **contract-only**（M0時点。Claude/Codex の binding-feasibility spike で実測した非対称性を `binding_method` closed set に焼き込んでいるが、reference 実装はまだ無い）
- Protocol document: [`docs/protocols/attribution-v1.md`](docs/protocols/attribution-v1.md)
- Conformance fixtures: [`contracts/attribution/v1/`](contracts/attribution/v1/)

### review-findings:v1 / promotion-receipt:v0 / release-approval:v0

Evidence-Closed Delivery の Shadow Evidence Contracts（3本組）。「何を観測したか（review-findings）→ 人間承認以外の述語をどう機械評価したか（promotion-receipt）→ 誰が exact digest に対して承認したか（release-approval、唯一の promotion authority）」という Authority DAG を構成する。3本とも **DRAFT — NOT FROZEN**。

- Status: **DRAFT（draft_revision 1）**。schema/fixture/protocol文書はこのリポジトリがSSOTだが、reference 実装（emitter/receipt evaluator/approval ledger consumer）はまだ無い。freeze はこのリポジトリの freeze-after-exercise 規律に従う（`release-evidence/v0` 同様、実際の shadow/live 運用実証が先）
- Protocol documents: [`docs/protocols/review-findings-v1.md`](docs/protocols/review-findings-v1.md) / [`docs/protocols/promotion-receipt-v0.md`](docs/protocols/promotion-receipt-v0.md) / [`docs/protocols/release-approval-v0.md`](docs/protocols/release-approval-v0.md)
- Conformance fixtures: [`contracts/review-findings/v1/`](contracts/review-findings/v1/) / [`contracts/promotion-receipt/v0/`](contracts/promotion-receipt/v0/) / [`contracts/release-approval/v0/`](contracts/release-approval/v0/)
- KPI・数値解禁条件・外部根拠・運用上限などの正本値: [`docs/evidence-closed-delivery-frozen-decisions.md`](docs/evidence-closed-delivery-frozen-decisions.md)

設計原則（詳細はprotocol文書側の記述が正本。ここでは複製せず要点のみ）:

- `promotion-receipt` の `verdict` は `ready_for_approval | ineligible | abstained` のみ。`eligible` は authority 循環のため存在しない。`human_release_approval` は述語として存在しない（`release-approval` の event が唯一の promotion authority）
- `promotion-receipt` 評価は決定論的（LLM呼び出し0）。`effective_risk` / `policy_digest` は評価開始時に凍結し、評価結果から再導出しない
- `release-approval` の全 kind（`break_glass_approve` を含む）が exact digest 束縛（receipt/bundle/selection manifest/target）を免除されない
- 個人識別次元を持たない（`review-findings` の `reviewer` は `contracts/shared/personal-dimensions.mjs` の禁止キーと衝突するため `assessor` に改名済み）。数値 confidence フィールドは3契約とも一切持たない

### impact-scan:v1

[`pre-implementation-impact-scan`](skills/pre-implementation-impact-scan/) skill が定める、実装着手前レポート末尾の構造化出力 block（```impact-scan:v1```フェンス）の機械可読schema。生の観測値のみを運び、集約スコアや digest は含めない（消費側が自分で再計算する）。

- Status: **稼働中**。Consumer: [spec-lane](https://github.com/shiki-yusuke/spec-lane)（`packages/core/src/impact-scan.ts` が本schemaのblockをパースする）
- Normative spec: skills/pre-implementation-impact-scan/SKILL.md の「Structured output block」節（この schema はその機械可読な写し）
- Conformance fixtures: [`contracts/impact-scan/v1/`](contracts/impact-scan/v1/)

### estimate:v2

コスト見積もりの「正直さ」を保証する schema。予測は常に `predicted`（点推定あり）か `abstained`（reason_codes 付きで見送り）のいずれかであり、無言のベストゲスは存在しない。spec-lane 自身の estimator 実装に先行する contract-first の設計。

- Status: **contract-only**（M0時点。spec-lane 側の estimator実装は今後の作業）
- Protocol document: [`docs/protocols/estimate-v2.md`](docs/protocols/estimate-v2.md)
- Conformance fixtures: [`contracts/estimate/v2/`](contracts/estimate/v2/)

### measure:v1

`agent-cost measure --format json` の cross-language conformance contract（D11: 多言語スタック対応の v1 やり方）。他の protocol と異なり、このリポジトリは producer（[agent-cost](https://github.com/shiki-yusuke/agent-cost)、Python）を所有していない — schema/fixture の SSOT はこのリポジトリだが、散文契約・実装・バージョニング判断は agent-cost 側にある。

- Status: **versioned tracking (compatibility floor)**（他の protocol の "immutable freeze" とは異なる方針。required 集合は v1 内で固定 floor、将来の追加フィールドは optional のみ — 詳細は protocol 文書の Versioning 節）
- Protocol document: [`docs/protocols/measure-v1.md`](docs/protocols/measure-v1.md)
- Conformance fixtures: [`contracts/measure/v1/`](contracts/measure/v1/)

### この protocol を含む計測パイプラインでの責務分担

同じパイプラインを構成する各リポジトリは責務が独立しており、重複しない:

| リポジトリ | 責務 |
|---|---|
| [agent-cost](https://github.com/shiki-yusuke/agent-cost) | ローカルのagent実行ログからトークン使用量・推定コストを計測する |
| [spec-lane](https://github.com/shiki-yusuke/spec-lane) | delivery workflowの制御・活動の帰属付け・`agent-metrics:v1` payloadの生成とPRコメントへのoptionalな投稿（reference emitter） |
| **ai-agent-skills-playbook（このリポジトリ）** | `agent-metrics:v1` / `token-usage/v1` の正規仕様（SSOT）を保持する。protocolの実装（emit/harvest/report）自体は行わない |
| [agent-metrics-harvester](https://github.com/shiki-yusuke/agent-metrics-harvester) | PRコメント中のmarkerを検証・収集し、ストア（JSONL/SQLite）へ永続化する（reference harvester） |
| agent-metrics-harvester リポジトリ内の agent-metrics-report | ストアから merged PR あたりの推定コスト等を集計・レポートする（同一リポジトリ内の read-only binary） |

## License

MIT License. 詳細は [LICENSE](LICENSE) を参照。
