---
name: test-ui
description: "Drive the actual screen to verify yuco UI — load the page, click, fill, snapshot, and capture proof — instead of asking the user to check manually. Use when a change is observable in the browser preview. Uses the preview workflow (start, reload, console/network/snapshot, interact, screenshot) and never delegates verification back to the user. Pairs with test-functional for logic. Keywords: 画面テスト, UI, E2E, 操作, クリック, スクショ, ブラウザ, プレビュー, 動作確認, レスポンシブ, ダークモード."
version: 0.1.0
user-invocable: true
argument-hint: "[確認したい画面・操作]"
---

# 画面操作テスト専門（実際に画面を触って確かめる）

ブラウザで実際に画面を開き・クリックし・入力して「ちゃんと動く・正しく見える」を確かめる専門スキル。**yuko に手で確認させない**。ロジックの検証は `test-functional` の担当。

## いつ使うか

- ブラウザプレビューで観察できる変更をした時（画面が描画・表示する変更）
- レイアウト・配色・ダークモード・レスポンシブの確認
- フォーム入力・クリック等の操作フローの確認

## 検証フロー（preview_* ツールを使う）

> dev server の起動・検証には **preview_* ツールのみ**。Bash や "Claude in Chrome" は使わない（yuco 規約）。プレビューで観察できない変更（別ランタイム・型・ツーリング）はこのスキルの対象外 → `test-functional` へ。

1. サーバ起動（必要なら `preview_start`）
2. 必要ならリロード（`preview_eval` で `window.location.reload()`。HMR が効いていれば不要）
3. エラー確認：`preview_console_logs` / `preview_logs` / `preview_network`
4. 内容・構造：`preview_snapshot`
5. CSS 値：`preview_inspect`（配色・余白の確認時）
6. 操作：`preview_click` / `preview_fill` → 再度 `preview_snapshot` で結果確認
7. レスポンシブ / ダークモード：`preview_resize`
8. 問題があればソースを読んで原因特定 → ソース修正 → 3 から再確認

## 証拠を残す（yuko への報告）

直してから、動いている証拠を自分で示す。yuko に「確認してください」と丸投げしない。

- 見た目の変更 → `preview_screenshot`
- API の変更 → `preview_network`
- サーバ挙動 → `preview_logs`

関係ないステップは飛ばす（CSS でないなら inspect 不要・レイアウト/テーマ変更がないなら resize 不要）。

## yuco の UI 注意点

- 大きい和文文字（hero 等）を多用しない（`feedback_no_large_japanese_text`）
- AI 同質化デザインを避ける（`reference_ai_design_sameness_2026_05` の avoid-list）
- 実装時の reflex check は `feedback_ui_implementation_reflex_checklist`

## 報告

1. 確認した画面・操作
2. 実行したステップ（飛ばしたものは理由）
3. 結果（snapshot / console / network の生出力）
4. 証拠（screenshot / network / logs）
5. 見つけた問題と修正（あれば）

## 注意

通っていないのに「動いた」と書かない。snapshot / console を実際に取ってから報告する（真正性ルール）。
