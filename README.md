# ai-agent-skills-playbook

AIエージェント（Claude / Codex等）を使った開発で再利用してきた **スキル / ガードレール** を、特定プロダクトに依存しない形で蓄積する個人用リポジトリ。

各スキルは「実際にプロダクションリポジトリで運用し、複数ラウンドのレビュー・複数回のブラインド評価を経て磨いたもの」の一般化版。プロダクト固有の実装詳細（ファイルパス・閾値・ビジネスロジック）は含めず、パターン・手順・テンプレートのみを収録する。

スキル集が中心のリポジトリだが、他の公開OSSが依拠する標準仕様（protocol）の正本（SSOT）を1本含む（→ [Public interoperability protocols](#public-interoperability-protocols)）。

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
- Reference emitter: [spec-lane](https://github.com/shiki-yusuke/lane)
- Reference harvester: [agent-metrics-harvester](https://github.com/shiki-yusuke/agent-metrics-harvester)
- Protocol document: [`docs/protocols/agent-metrics-v1.md`](docs/protocols/agent-metrics-v1.md)
- Conformance fixtures: [`contracts/agent-metrics/v1/`](contracts/agent-metrics/v1/)

設計原則（詳細はprotocol文書側の記述が正本。ここでは複製せず要点のみ）:

- snapshot、not delta — 訂正は同一 `upsert_key` への完全な置き換えとして表現する
- checksum、not signature — `sha256` は改ざん検知用であり、認証の代わりにはならない
- 認証は transport 層の責務（comment author の allowlist 照合等）であり、payload 自身は何も証明しない
- `coverage` / `omissions` を明示し、測れなかったものを黙って落とさない
- 個人識別次元を持たない（schema レベルで禁止） — この telemetry は個人評価ではなく、プロセス改善のための work/process telemetry

### この protocol を含む計測パイプラインでの責務分担

同じパイプラインを構成する各リポジトリは責務が独立しており、重複しない:

| リポジトリ | 責務 |
|---|---|
| [agent-cost](https://github.com/shiki-yusuke/agent-cost) | ローカルのagent実行ログからトークン使用量・推定コストを計測する |
| [spec-lane](https://github.com/shiki-yusuke/lane) | delivery workflowの制御・活動の帰属付け・`agent-metrics:v1` payloadの生成とPRコメントへのoptionalな投稿（reference emitter） |
| **ai-agent-skills-playbook（このリポジトリ）** | `agent-metrics:v1` / `token-usage/v1` の正規仕様（SSOT）を保持する。protocolの実装（emit/harvest/report）自体は行わない |
| [agent-metrics-harvester](https://github.com/shiki-yusuke/agent-metrics-harvester) | PRコメント中のmarkerを検証・収集し、ストア（JSONL/SQLite）へ永続化する（reference harvester） |
| agent-metrics-harvester リポジトリ内の agent-metrics-report | ストアから merged PR あたりの推定コスト等を集計・レポートする（同一リポジトリ内の read-only binary） |

## License

MIT License. 詳細は [LICENSE](LICENSE) を参照。
