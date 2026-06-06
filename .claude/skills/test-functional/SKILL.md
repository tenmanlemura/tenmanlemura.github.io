---
name: test-functional
description: "Design and run functional tests for yuco logic — unit, integration, invariants, and property-based — especially before changing money-related behavior. Use when verifying that code does the right thing without driving a screen. Enforces backtest-before-implementation for money flows, invariant checks, and honest reporting of what was skipped (no silent caps). Pairs with test-ui for screen interaction. Keywords: テスト, 単体, 結合, 不変条件, invariant, property-based, backtest, ロジック検証, 機能テスト, /hypo."
version: 0.1.0
user-invocable: true
argument-hint: "[テスト対象]"
---

# 機能テスト専門（ロジックが正しいかを確かめる）

画面を触らずに「コードが正しい結果を出すか」を確かめる専門スキル。単体・結合・不変条件・property-based を扱う。画面操作のテストは `test-ui` の担当。

## いつ使うか

- 関数・スクリプト・データ変換のロジックを検証する時
- 金銭挙動（閾値・注文・PnL・サイズ計算）を変更する前後
- エッジケース・不変条件を網羅したい時

## 手順

### 1. money flow は実装前に backtest（最優先）

閾値変更・新規金銭フロー・サイズ計算の変更は、**実装前に backtest / シミュレーションで挙動を確認**してから着手する（`feedback_backtest_before_implementation`）。重い計算（backtest / OOS / grid search）はメイン Mac でなく Mac mini に回す判断を検討。

### 2. テスト種別を選ぶ

| 種別 | 使う場面 |
|---|---|
| 単体 | 純粋関数・変換・パース |
| 結合 | 複数モジュール連携・I/O 境界 |
| 不変条件（invariant） | 「常に成り立つべき性質」（PnL 保存・残高非負・件数一致など） |
| property-based | 入力を自動生成して反例を探す（yuco は slash command `/hypo <target>`） |

### 3. 不変条件を明文化

「この変更後も絶対に壊れてはいけない性質」を先に言葉にしてからテストを書く。例：PnL invariant monitor、件数一致、冪等性。性質が言えないテストは値の固定化になりがち。

### 4. 副作用テストの後始末（必須）

state ファイル / 環境変数 / リポジトリ外ファイル（`~/.config/yuco/` 配下等）を意図的に書き換えるテストをしたら、**元値復元 + 1 サイクル空転確認**まで完了の前提。各 tool の外部状態は `tools/<name>/STATE-LOCATIONS.md` を参照。テスト中にセッションが終わるなら handoff 冒頭に「未復元の副作用」を必ず書く。

### 5. 削った範囲を黙らない（no silent caps）

サンプリング・top-N・retry 無し・時間制約で網羅を絞ったら、**何を削ったかを必ず報告**する。「全部通った」と読めて実は一部だけ、を作らない。

## 報告

1. 対象とテスト種別
2. 明文化した不変条件 / 確認したエッジケース
3. 結果（pass / fail を生の出力で。fail は隠さない）
4. 削った範囲（あれば）と理由
5. 副作用の後始末状況（復元済 / 未復元→handoff 記載）

## 注意

- 結果は**実行した生の出力でのみ**報告（真正性ルール：exit code + 出力本文の実在確認）。通っていないのに「通った」と書かない
- money_exposure: true のコードのテスト**実行**は read-only 相当だが、テストのために本番 state を触らない
