// schedule-guard.js — 予約を active に戻す（復活）全経路で共有する物理制約チェック。
//
// v1.1 (2026-06-12): 予約が active に戻る経路は 3 つある:
//   (1) home-tab.js restoreLastCancelled（6 秒トースト Undo）
//   (2) settings-tab.js handleRestore（最近キャンセルした予約）
//   (3) undo.js executeUndo（操作履歴 Undo・cancel の inverse_operation 適用）
// これらが別々の検証を持っていると、キャンセル後に店休/イベント/別店舗/同枠予約/受付停止が
// 入った状態で active 復帰でき、物理制約（1 日 1 店舗・時間重複禁止）を破る（Codex review HIGH-NEW-1）。
// 検証ロジックを本モジュールに集約し、全経路から呼ぶ。
//
// すべて pure 関数（Firestore 読み取りは呼び出し側が行い、結果を渡す）→ unit テスト容易。

// ── 時刻ヘルパ ──
export function isValidTime(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(v); }
export function strToMin(v) { if (!isValidTime(v)) return 0; const [h, m] = v.split(":").map(Number); return h * 60 + m; }
export function timeOverlap(s1, e1, s2, e2) { return strToMin(s1) < strToMin(e2) && strToMin(e1) > strToMin(s2); }

// 復活時のスケジュール整合チェック（店休 / イベント / 別店舗ロック）。
// schedule data が無い or active=false / deleted_at なら拒否しない（null 返却）。
// 拒否時は「画面に表示する拒否理由文字列（日付プレフィクスは呼び出し側が付ける）」を返す。
export function checkRestoreScheduleConflict(item, scheduleData) {
  if (!scheduleData) return null;
  if (scheduleData.active === false || scheduleData.deleted_at) return null;
  const planned = scheduleData.planned_store;
  if (planned === "closed") {
    return "は店休日に設定されています。先に「この日のお店」を変更してから復活してください。";
  }
  if (planned === "event" && item.store_code !== "event") {
    return "はイベント出店日に設定されています。店舗の予約は復活できません。";
  }
  if ((planned === "tanushimaru" || planned === "dazaifu") && planned !== item.store_code) {
    return `はすでに別の店舗（${planned}）に設定されています。1日1店舗の制限により復活できません。`;
  }
  return null;
}

// 復活の包括チェック。schedule / 別店舗 active 予約 / 同店舗時間重複 / 受付停止(block) を一括判定。
// 引数:
//   reservation: 復活対象（visit_date / store_code / start_time / end_time / reservation_id|id）
//   scheduleData: schedules/{visit_date} の data（無ければ null）
//   otherActiveReservations: 同日の他 active 予約配列（自分を含んでいてもよい・id で除外する）
//   blocks: 同日の active な受付停止配列（start_time / end_time）
// 返り値: { ok: true } または { ok: false, message: "<日本語・日付プレフィクスなし>" }
export function findRestoreConflicts({ reservation, scheduleData, otherActiveReservations = [], blocks = [] }) {
  // 1. schedule（店休 / イベント / 別店舗）
  const schedDenial = checkRestoreScheduleConflict(reservation, scheduleData);
  if (schedDenial) return { ok: false, message: schedDenial };

  const selfId = reservation.reservation_id || reservation.id || null;
  const start = reservation.start_time;
  const end = reservation.end_time;

  // 2. 別店舗の active 予約（1 日 1 店舗）
  const crossStore = otherActiveReservations.find((r) => {
    const id = r.reservation_id || r.id;
    if (selfId && id === selfId) return false;
    return r.store_code && r.store_code !== "event" && r.store_code !== reservation.store_code;
  });
  if (crossStore) {
    return { ok: false, message: "には別の店舗の予約があります。1日1店舗の制限により復活できません。" };
  }

  // 3. 同店舗の時間重複
  if (isValidTime(start) && isValidTime(end)) {
    const timeHit = otherActiveReservations.find((r) => {
      const id = r.reservation_id || r.id;
      if (selfId && id === selfId) return false;
      return timeOverlap(start, end, r.start_time, r.end_time);
    });
    if (timeHit) {
      return { ok: false, message: `には ${timeHit.start_time}〜${timeHit.end_time} の予約が入っているため復活できません。` };
    }
    // 4. 受付停止（block）との重複
    const blockHit = (blocks || []).find((b) => timeOverlap(start, end, b.start_time, b.end_time));
    if (blockHit) {
      return { ok: false, message: `には ${blockHit.start_time}〜${blockHit.end_time} の受付停止が入っているため復活できません。` };
    }
  }

  return { ok: true };
}

// 営業予定（planned_store）の変更時の検証。
// active 予約が入っている日は、planned_store を現在値（current）以外へ変更不可。
// UI 側の選択肢 disabled だけでは API 呼び出し / 別経路 / state 不整合で bypass されうるため、
// 保存直前にも本関数を通して防壁とする（single source of truth）。
//
// 引数:
//   newStore: 変更先（"tanushimaru" | "dazaifu" | "event" | "closed" | ""）
//   currentStore: 現在値（resolveDayStore の解決値・null 可）
//   hasActiveReservations: 同日に active 予約が 1 件以上あるか
// 返り値: { ok: true } または { ok: false, message: "<日本語>" }
export function checkScheduleChangeConflict({ newStore, currentStore, hasActiveReservations }) {
  if (!hasActiveReservations) return { ok: true };
  if (!newStore) return { ok: true };
  if (newStore === currentStore) return { ok: true };
  return { ok: false, message: "この日は予約があるため、お店の設定を変更できません。先に予約をキャンセルすると変更できるようになります。" };
}

// 営業予定（schedule）の削除（解除）時の検証。
// active 予約が入っている日は schedule 削除を拒否する。
// INC-2026-034 Codex final review NG-1: deleteStore() に active 予約チェックがなく
// manual.html C-5「予約がある日は解除できない」と乖離していた問題の修正（実装側を一致させる方針）。
// 引数:
//   hasActiveReservations: 同日に active 予約が 1 件以上あるか
// 返り値: { ok: true } または { ok: false, message: "<日本語>" }
export function checkScheduleDeleteConflict({ hasActiveReservations }) {
  if (!hasActiveReservations) return { ok: true };
  return { ok: false, message: "この日は予約があるため、お店の設定を解除できません。先に予約をキャンセルすると解除できるようになります。" };
}
