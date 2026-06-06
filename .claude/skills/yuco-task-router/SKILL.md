---
name: yuco-task-router
description: "Route a yuco work request to the right domain, the right AI, and check money/security boundaries before starting. Use when a new yuco task arrives and you need to decide what kind of work it is and who should do it. Classifies into coding / code-review / design / test / research, checks money_exposure, and applies the do-not-touch list. Keywords: 振り分け, どの AI, 委任, タスク分類, route, delegate, 担当."
version: 0.1.0
user-invocable: true
argument-hint: "[依頼内容]"
---

# yuco タスク振り分け（受付・仕分け）

新しい依頼が来た時、最初に「どんな仕事か / お金に関わるか / どの AI に任せるか」を仕分ける受付係。`yuco-context-loader` でガバナンスを読み込んだ後に使う。

## 手順

### 1. 領域を分類（5 つのどれか）

| 領域 | 例 |
|---|---|
| coding | 機能実装・スクリプト作成・リファクタ |
| code-review | 差分レビュー・品質チェック |
| design | UI / 配色 / レイアウト / モックアップ |
| test | テスト作成・smoke・動作確認 |
| research | 調査・比較・第二意見・長文読解 |

### 2. money_exposure（お金が動くか）を判定

`yuco-context-loader` が読み込んだ `related-projects.json` で対象プロジェクトを確認：

- **money_exposure: true**（crypto-signal / jp-stock-signal 等）→ **Gemini では編集しない**。Claude / Codex に回す。read-only の調査・確認のみ可
- **money_exposure: false** → 下記の禁止リストに当たらなければ委任可

### 3. 禁止リスト（money_exposure: false でも Gemini に渡さない）

以下を含む作業は Claude / Codex のみ：

- secrets / API キー / 個人情報 (PII)
- state / 永続データ（DB・台帳・予約・取引記録）の直接操作
- 機械防壁系（hook / pre-commit / sandbox / 権限 deny）
- security ルール / 認証・認可 / CI・CD / インフラ
- 破壊的操作（rm -rf / migration / 履歴書き換え）
- 外部公開（public web / PR body / 外部送信）

迷ったら **Claude / Codex に倒す**（迷ったら Gemini に渡さない）。

### 4. AI を振り分け

| 条件 | 担当 |
|---|---|
| 判断・設計・GO/NO-GO・最終 commit/push | Claude |
| 重い読み込み（大量ファイル・transcript） | Sonnet |
| 構造的諮問・ルール整備 | planner |
| 実装・差分 review・テスト追加・単純リファクタ | Codex |
| money_exposure: false かつ禁止リスト非該当の調査・長文読解・反証・下書き | Gemini |

## 報告 6 項目（仕分け結果として返す）

1. 領域（coding / code-review / design / test / research）
2. 対象プロジェクトと money_exposure（true / false）
3. 禁止リスト該当の有無
4. 推奨担当 AI と理由
5. Gemini に渡す場合の作業範囲（触ってよい path / 触ってはいけない path）
6. 確認が要る曖昧点（あれば yuko に聞く）

## 注意

この skill は**仕分けるだけ**。境界の強制（enforcement）は wrapper + policy + hook が担う。この skill の判定は「説明」であって最終的な機械的防壁ではない（`SECURITY.md` の Gemini skill 取扱い参照）。
