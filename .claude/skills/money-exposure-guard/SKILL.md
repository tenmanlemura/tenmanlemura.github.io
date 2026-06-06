---
name: money-exposure-guard
description: "Decide whether a yuco task touches money or other no-go areas before any AI edits code, and fail closed when unsure. Use before delegating work to Gemini or editing any related project. Reads the project ledger to resolve money_exposure, applies the do-not-touch list (secrets / PII / state / machine-guards / security / destructive / public), and routes money or sensitive work to Claude / Codex only. Keywords: money_exposure, お金, 金銭, 委任可否, 禁止リスト, 境界, guard, Gemini 可否, 安全判定."
version: 0.1.0
user-invocable: true
argument-hint: "[対象プロジェクト or 依頼内容]"
---

# お金・危険領域ガード（委任前の安全判定）

AI がコードを編集する前に「これはお金が動くか / 触ってはいけない領域か」を判定し、**迷ったら閉じる（fail closed）**ための skill。Gemini への委任前・関連プロジェクトを編集する前の最終チェック。

## いつ使うか

- Gemini に作業を渡してよいか判断する時
- 住所録（related-projects.json）に載るプロジェクトを編集する前
- `yuco-task-router` の判定をもう一段固めたい時

## 手順

### 1. money_exposure を解決

`yuco-context-loader` が読み込んだ `related-projects.json` で対象プロジェクトの `money_exposure` を引く。

- **true**（crypto-signal / jp-stock-signal 等）→ **Gemini で編集しない**。Claude / Codex のみ。read-only の調査・確認・反証は可
- **false** → 下の禁止リストを通す
- **不明 / 台帳に無い** → **true 扱い**（fail closed）。yuko に確認するか Claude に倒す

### 2. 禁止リスト（money_exposure: false でも Gemini に渡さない）

以下を 1 つでも含めば Claude / Codex のみ：

- secrets / API キー / 個人情報（PII）
- state / 永続データ（DB・台帳・予約・取引記録）の直接操作
- 機械防壁系（hook / pre-commit / sandbox / 権限 deny）
- security ルール / 認証・認可 / CI・CD / インフラ
- 破壊的操作（rm -rf / migration / 履歴書き換え）
- 外部公開（public web / PR body / 外部送信）

### 3. fail closed の原則

- 判定が割れたら **Gemini に渡さない**（迷ったら閉じる）
- money_exposure: true のコードに「ちょっとした調査ついでの編集」をしない。read-only の境界を越えない
- 「閾値変更・新規金銭フロー」は実装前に backtest（`feedback_backtest_before_implementation`）

### 4. 境界は skill では強制できないことを明記

`activate_skill` は system prompt を上書きできるため、**この skill 自体が境界を機械的に守るわけではない**（`SECURITY.md`「Gemini skill レイヤーの取扱い」）。enforcement は wrapper + `--admin-policy` + pre-commit hook の多層 fail-closed が担う。この skill は**説明と判定**であって最終防壁ではない。

## 報告 4 項目

1. 対象プロジェクトと money_exposure（true / false / 不明→true 扱い）
2. 禁止リスト該当の有無（該当した項目名）
3. 委任可否（Gemini 可 / Claude・Codex のみ）と read-only 境界
4. fail closed を適用した点（あれば）・yuko 確認が要る曖昧点

## 注意

迷った時に「たぶん大丈夫」で開けない。**閉じる方がデフォルト**。金銭・secrets・PII は事故が金額・信用に直結する（threat-model 参照）。
