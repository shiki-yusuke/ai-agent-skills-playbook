<!--
============================================================
Codex Review Request テンプレート（影響レポートの敵対的レビュー用）
配置先: docs/spec-impact/templates/codex-review-request.md
用途: 影響レポートを GPT-5.6 sol に敵対的レビューさせる。
実行条件（常時実行しない）:
  - severity=High の confirmed 行がある
  - unknowns が解消できないまま残っている
  - パイロット評価（replay）時
使い方: このテンプレートをコピーし、【】のプレースホルダーを埋めて別ファイル（例: filled-review-request.md）として保存してから実行する
実行例:
  codex exec -m gpt-5.6-sol -c model_reasoning_effort="xhigh" -s read-only \
    -o review-result.md - < filled-review-request.md
  # モデル名・オプションは利用環境の Codex CLI バージョンに合わせて調整する
============================================================
-->

# 影響範囲分析レビュー依頼（敵対的）

あなたは Codex 上の上級ソフトウェアアーキテクトです。
以下の影響範囲分析レポートを**敵対的に**レビューしてください。目的は見落としと過大評価の検出です。

## 前提

- 変更要求: 【種別・現状・期待を貼る】
- 起点仕様: 【SPEC-ID と仕様書本文（frontmatter 含む）を貼る】
- リポジトリ構成の要点: 【owned / vendored / fork 境界を含め 3〜5 行】

## レビュー対象（影響レポート）

【impact-report.md 形式のレポート全文を貼る】

## レビュー観点

1. **見落とし**: confirmed / candidates に載っていない影響先はないか。特に以下を疑うこと
   - LTR/RTL・タブレット・権限・フィーチャーフラグの 4 変化軸
   - ログ・計測イベントの「意味変化」（イベント名は同じでも解釈が変わるケース）
   - fork / vendored コード群（Scratch Blocks / Blockly / Scratch VM 等）のパッケージ間契約
   - データの後方互換性（既存レコードとの整合）
   - config / cookie / CloudFront / 認証まわりの運用面
2. **High 確信度の検証**: 「宣言 + 現存確認済み」の要件を満たしているか。証拠の locator は現在のコードで再確認可能か
3. **severity / verification gap の妥当性**: 過小評価はないか
4. **区分の妥当性**: candidates に置くべき confirmed、unknowns に落とすべき candidates はないか

## 出力形式

- 見落とし候補（表: 影響対象 locator / 影響種別 / 置くべき区分 / 根拠）
- High 確信度への異議（行番号と理由）
- severity / verification gap 再評価の提案（行番号と理由）
- 区分移動の提案（行番号と移動先・理由）
- 総合判定: このレポートを影響宣言として採用してよいか（可 / 条件付き可 / 不可）
