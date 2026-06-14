import { db } from "./app.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  onSnapshot,
  orderBy,
  limit,
  serverTimestamp,
  deleteField,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { cancelReservation } from "./reservation-modal.js";
import { commitWrite } from "./write-helpers.js";
import { isDegraded } from "./degraded.js";
import { findRestoreConflicts } from "./schedule-guard.js";  // v1.1 HIGH-3v2 / HIGH-NEW-1（復活検証を集約）

/* =========================================================================
   home-tab.js — redesign-2026-06（task ベース）
   カレンダー（店舗色の点 + 件数のみ）+ 選択日ハブ + FAB + ボトムシート群。
   Firestore 配線（subscribe / commitWrite）は従来踏襲。書込は commitWrite 経由のみ。
   ========================================================================= */

const WDAYS = ["日", "月", "火", "水", "木", "金", "土"];
// closed は「店休日」: 店舗ではなく planned_store 専用値（予約の store_code には使えない）
const STORE_FULL = { tanushimaru: "田主丸店", dazaifu: "太宰府店", event: "イベント出店", closed: "店休" };
const STORE_SHORT = { tanushimaru: "田主丸", dazaifu: "太宰府", event: "イベント", closed: "店休" };
const STORE_CSS = { tanushimaru: "tama", dazaifu: "daza", event: "event", closed: "closed" };
const COURSE_MIN = { "40": 40, "60": 60, "80": 80 };
// v1.1: 営業時間は Firestore settings から動的に読み取る（HIGH-2 / Codex review 2026-06-12）。
// default は 9:00-21:00（広めに）で、subscribeBusinessHours() が起動時に settings/store.*/hours_* を
// 読んで OPEN_MIN / CLOSE_MIN を上書きする。両店舗の中で「最も早い start ～ 最も遅い end」を取る
// （ある店舗 10-17 / 別店舗 9-19 でも両方で予約できるよう包括的に）。
let OPEN_MIN = 9 * 60;
let CLOSE_MIN = 21 * 60;
const TIME_STEP = 10;

let built = false;
let initialized = false;
let currentMonth = startOfMonth(parseDateKey(todayKey()));
let selectedDate = todayKey();
let monthReservations = [];
let schedulesByDate = new Map();
let selectedBlocks = [];
let selectedBlocksError = "";
let unsubscribeReservations = null;
let unsubscribeSchedules = null;
let unsubscribeSettings = null;  // v1.1: 営業時間動的読み取り
let unsubscribeSelectedBlocks = null;

// シート編集状態
let editingReservation = null; // 予約編集中の doc（null=新規）
let editingBlock = null;        // 予約不可編集中の doc（null=新規）
let bookingCourse = "60";
let bookingStoreChoice = "";    // 予約0の日に選んだ店（tama 用 code）
let pendingDelete = null;       // 確認ダイアログ対象 {kind, item}
let lastCancelled = null;       // 直前キャンセル {id, snapshot} 復活用
let toastTimer = null;
let fabOpen = false;

/* ============ 初期化 ============ */
export function initHomeTab() {
  const root = document.getElementById("tab-home");
  if (!root) return;

  if (!built) {
    buildHomeDom(root);
    buildOverlays();
    built = true;
  }
  if (initialized) {
    renderHome();
    return;
  }
  initialized = true;
  wireStaticHandlers();
  subscribeMonthData();
  subscribeSelectedBlocks(selectedDate);
  subscribeBusinessHours();  // v1.1: 営業時間を Firestore settings から動的に読み取る
  renderHome();
}

export function teardownHomeTab() {
  unsubscribeReservations?.();
  unsubscribeSchedules?.();
  unsubscribeSelectedBlocks?.();
  unsubscribeSettings?.();
  unsubscribeReservations = null;
  unsubscribeSchedules = null;
  unsubscribeSelectedBlocks = null;
  unsubscribeSettings = null;
  initialized = false;
}

// v1.1: settings collection を購読して OPEN_MIN / CLOSE_MIN を動的に更新する。
// 両店舗の hours_start / hours_end から「予約可能な最広範囲」を計算（店舗が異なる日でも対応）。
// settings doc は doc id = key の構造（例: settings/store.tanushimaru.hours_end）。
function subscribeBusinessHours() {
  unsubscribeSettings?.();
  unsubscribeSettings = onSnapshot(collection(db, "settings"), (snap) => {
    const values = {};
    snap.forEach((doc) => {
      const data = doc.data() || {};
      const key = data.key || doc.id;
      if (key && key !== "degraded_mode" && data.value !== undefined) {
        values[String(key)] = String(data.value);
      }
    });
    const next = computeBusinessHours(values);
    if (next.openMin != null) OPEN_MIN = next.openMin;
    if (next.closeMin != null) CLOSE_MIN = next.closeMin;
    // 既に開いている時刻 pulldown は次回 open 時に反映される（時刻 select は openBookingSheet 内で再生成）
  });
}

// settings の key-value map から「最広範囲の OPEN_MIN / CLOSE_MIN」を計算。
// 両店舗の hours_start / hours_end の min / max を取る。値が無い側は null（既存値維持）。
// pure function なのでテスト容易（HIGH-2 検証用）。
function computeBusinessHours(values) {
  const tanuStart = parseInt(values["store.tanushimaru.hours_start"], 10);
  const tanuEnd = parseInt(values["store.tanushimaru.hours_end"], 10);
  const dazaStart = parseInt(values["store.dazaifu.hours_start"], 10);
  const dazaEnd = parseInt(values["store.dazaifu.hours_end"], 10);
  const starts = [tanuStart, dazaStart].filter(Number.isFinite);
  const ends = [tanuEnd, dazaEnd].filter(Number.isFinite);
  return {
    openMin: starts.length > 0 ? Math.min(...starts) * 60 : null,
    closeMin: ends.length > 0 ? Math.max(...ends) * 60 : null,
  };
}

/* ============ DOM 構築 ============ */
function buildHomeDom(root) {
  root.innerHTML = `
    <section class="rd-cal" aria-label="月次カレンダー">
      <div class="rd-cal-top">
        <div class="rd-cal-title" id="rdCalTitle"><b>--</b>月 <span>----</span></div>
        <div class="rd-cal-nav">
          <button type="button" class="rd-navbtn" id="rdPrevMonth" aria-label="前の月"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg></button>
          <button type="button" class="rd-todaybtn" id="rdToday">今月</button>
          <button type="button" class="rd-navbtn" id="rdNextMonth" aria-label="次の月"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></button>
        </div>
      </div>
      <div class="rd-dow"><span class="sun">日</span><span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span class="sat">土</span></div>
      <div class="rd-grid" id="rdGrid"></div>
      <p class="rd-error-state" id="rdMonthStatus" hidden></p>
    </section>

    <div class="rd-divider"></div>

    <section class="rd-hub" aria-label="選択日の予定">
      <div class="rd-hub-head">
        <div class="rd-hub-date" id="rdHubDate">--</div>
        <div>
          <span class="rd-store-label">この日のお店</span>
          <button type="button" class="rd-store-select none" id="rdStoreSelect" data-write="true">
            <span class="sdot"></span><span id="rdStoreSelName">未設定</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </button>
        </div>
      </div>
      <div class="rd-hub-actions" aria-label="この日の操作">
        <button type="button" class="rd-hub-action" id="rdHubAddBooking" data-write="true"><span class="ai add">${icon("plus", 16, 2.4)}</span>予約を追加</button>
        <button type="button" class="rd-hub-action" id="rdHubAddBlock" data-write="true"><span class="ai block">${icon("noEntry", 16, 2.4)}</span>予約を受けない時間</button>
      </div>
      <div class="rd-day-memo" id="rdDayMemo" hidden></div>
      <div class="rd-count-line" id="rdCountLine"></div>
      <div class="rd-schedule" id="rdSchedule"></div>
    </section>
  `;
}

function buildOverlays() {
  if (document.getElementById("rdOverlayRoot")) return;
  const wrap = document.createElement("div");
  wrap.id = "rdOverlayRoot";
  wrap.innerHTML = `
    <div class="rd-fab-layer">
      <div class="rd-fab-inner">
        <div class="rd-fab-menu" id="rdFabMenu">
          <button type="button" class="rd-fab-action" id="rdFabAddBooking" data-write="true"><span class="ai add">${icon("plus", 17, 2.4)}</span>予約を追加</button>
          <button type="button" class="rd-fab-action" id="rdFabAddBlock" data-write="true"><span class="ai block">${icon("noEntry", 17, 2.4)}</span>予約を受けない時間</button>
        </div>
        <button type="button" class="rd-fab" id="rdFab" data-write="true" aria-label="追加">${icon("plus", 28, 2.4)}</button>
      </div>
    </div>

    <div class="rd-scrim" id="rdScrim"></div>

    <!-- 予約シート -->
    <div class="rd-sheet" id="rdSheetBooking" role="dialog" aria-modal="true">
      <div class="rd-sheet-head"><span class="rd-sheet-title" id="rdBkTitle">予約を追加</span><button type="button" class="rd-sheet-close" data-rd-close>${icon("x", 18, 2)}</button></div>
      <div class="rd-sheet-body">
        <div class="rd-ctx" id="rdBkCtx">${icon("calendar", 16, 1.8)}<span id="rdBkCtxText"></span></div>
        <div class="rd-field"><label>お名前<span class="rd-req">必須</span></label><input class="rd-input" id="rdBkName" placeholder="例：小林 由美" autocomplete="off"></div>
        <div class="rd-field" id="rdBkStoreField" hidden><label>お店<span class="rd-req">必須</span></label>
          <div class="rd-toggle" id="rdBkStorePick"><button type="button" data-s="tanushimaru">田主丸店</button><button type="button" data-s="dazaifu">太宰府店</button></div>
          <p class="rd-lock-note" style="margin-top:7px;">最初の予約で、この日のお店が決まります。</p>
        </div>
        <div class="rd-field"><label>開始時刻<span class="rd-req">必須</span></label><div class="rd-sel-wrap"><select class="rd-select" id="rdBkStart"></select>${icon("chevDown", 18, 2)}</div></div>
        <div class="rd-field"><label>コース<span class="rd-req">必須</span></label><div class="rd-toggle" id="rdBkCourse"><button type="button" data-c="40">40分</button><button type="button" data-c="60">60分</button><button type="button" data-c="80">80分</button></div></div>
        <div class="rd-field"><div class="rd-end-note">${icon("clock", 16, 1.8)}終了時刻 <b id="rdBkEnd">--:--</b>（自動）</div></div>
        <div class="rd-field"><label>電話番号<span class="rd-opt">任意</span></label><input class="rd-input" id="rdBkTel" inputmode="tel" placeholder="例：090-1234-5678" autocomplete="off"></div>
        <div class="rd-field"><label>メモ<span class="rd-opt">任意</span></label><textarea class="rd-input" id="rdBkMemo" placeholder="お客さまについてのメモなど"></textarea></div>
        <p class="rd-form-error" id="rdBkError" hidden></p>
      </div>
      <div class="rd-sheet-foot">
        <button type="button" class="rd-btn rd-btn-primary" id="rdBkSave" data-write="true">この内容で予約する</button>
        <button type="button" class="rd-btn-danger-text" id="rdBkDelete" data-write="true" hidden>この予約をキャンセルする</button>
      </div>
    </div>

    <!-- 予約不可シート -->
    <div class="rd-sheet" id="rdSheetBlock" role="dialog" aria-modal="true">
      <div class="rd-sheet-head"><span class="rd-sheet-title" id="rdBlkTitle">予約を受けない時間</span><button type="button" class="rd-sheet-close" data-rd-close>${icon("x", 18, 2)}</button></div>
      <div class="rd-sheet-body">
        <p style="font-size:13px;color:var(--fg-2);margin:0 0 16px;">この時間は受付を停止します。お客さまは予約できなくなります。</p>
        <div class="rd-field"><label>時間帯<span class="rd-req">必須</span></label>
          <div class="rd-row2">
            <div class="rd-sel-wrap"><select class="rd-select" id="rdBlkStart"></select>${icon("chevDown", 18, 2)}</div>
            <div class="rd-arrow-mid">〜</div>
            <div class="rd-sel-wrap"><select class="rd-select" id="rdBlkEnd"></select>${icon("chevDown", 18, 2)}</div>
          </div>
        </div>
        <p class="rd-form-error" id="rdBlkError" hidden></p>
      </div>
      <div class="rd-sheet-foot">
        <button type="button" class="rd-btn rd-btn-primary" id="rdBlkSave" data-write="true">この時間を受付停止にする</button>
        <button type="button" class="rd-btn-danger-text" id="rdBlkDelete" data-write="true" hidden>この受付停止を解除する</button>
      </div>
    </div>

    <!-- お店設定シート -->
    <div class="rd-sheet" id="rdSheetStore" role="dialog" aria-modal="true">
      <div class="rd-sheet-head"><span class="rd-sheet-title">この日のお店</span><button type="button" class="rd-sheet-close" data-rd-close>${icon("x", 18, 2)}</button></div>
      <div class="rd-sheet-body">
        <div class="rd-store-opts" id="rdStoreOpts">
          <button type="button" class="rd-store-opt" data-s="tanushimaru"><span class="od" style="background:var(--teal-dark)"></span><span><span class="ot">田主丸店</span></span><span class="ck">${icon("check", 20, 2.4)}</span></button>
          <button type="button" class="rd-store-opt" data-s="dazaifu"><span class="od" style="background:var(--teal-light)"></span><span><span class="ot">太宰府店</span></span><span class="ck">${icon("check", 20, 2.4)}</span></button>
          <button type="button" class="rd-store-opt" data-s="event"><span class="od" style="background:#E0A53C"></span><span><span class="ot">イベント出店</span><span class="os">外部の会場などで鑑定する日</span></span><span class="ck">${icon("check", 20, 2.4)}</span></button>
          <button type="button" class="rd-store-opt" data-s="closed"><span class="od" style="background:#8A94A6"></span><span><span class="ot">店休</span><span class="os">お休みの日（公開ページは終日 × になります）</span></span><span class="ck">${icon("check", 20, 2.4)}</span></button>
        </div>
        <div class="rd-lock-note" id="rdStoreLockNote" hidden>${icon("lock", 14, 1.8)}<span>この日はすでに予約が入っているため、お店は変更できません。すべての予約を消すと変更できます。</span></div>
        <div id="rdEventFields" hidden style="margin-top:18px;">
          <div class="rd-field"><label>イベント名<span class="rd-req">必須</span></label><input class="rd-input" id="rdEvName" placeholder="例：夏の癒やしフェア" autocomplete="off"></div>
          <div class="rd-field"><label>会場<span class="rd-opt">任意</span></label><input class="rd-input" id="rdEvVenue" placeholder="例：天神イベントホール" autocomplete="off"></div>
        </div>
        <div class="rd-field" style="margin-top:18px;"><label>この日のメモ<span class="rd-opt">任意</span></label><textarea class="rd-input" id="rdStMemo" placeholder="例：午後は混みやすい"></textarea></div>
        <p class="rd-form-error" id="rdStError" hidden></p>
      </div>
      <div class="rd-sheet-foot">
        <button type="button" class="rd-btn rd-btn-primary" id="rdStSave" data-write="true">保存する</button>
        <button type="button" class="rd-btn-danger-text" id="rdStDelete" data-write="true" hidden>この日のお店設定を解除する</button>
      </div>
    </div>

    <!-- トースト -->
    <div class="rd-toast-layer"><div class="rd-toast" id="rdToast"><span id="rdToastMsg"></span><button type="button" class="undo" id="rdToastUndo" hidden>元に戻す</button></div></div>

    <!-- 確認ダイアログ -->
    <div class="rd-scrim lv2" id="rdScrim2"></div>
    <div class="rd-dialog" id="rdConfirm" role="alertdialog">
      <div class="rd-dlg-icon">${icon("trash", 24, 1.8)}</div>
      <h3 id="rdCfTitle">この予約をキャンセルしますか？</h3>
      <p class="rd-dlg-sum" id="rdCfSum"></p>
      <p class="rd-dlg-note">消したあとでも、すぐ下の「元に戻す」から戻せます。</p>
      <div class="rd-dlg-acts">
        <button type="button" class="rd-btn rd-btn-ghost" id="rdCfCancel">やめる</button>
        <button type="button" class="rd-btn rd-btn-danger" id="rdCfOk" data-write="true">キャンセルする</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
}

/* ============ 静的ハンドラ ============ */
function wireStaticHandlers() {
  byId("rdPrevMonth")?.addEventListener("click", () => moveMonth(-1));
  byId("rdNextMonth")?.addEventListener("click", () => moveMonth(1));
  byId("rdToday")?.addEventListener("click", () => {
    currentMonth = startOfMonth(parseDateKey(todayKey()));
    selectDate(todayKey(), true);
  });

  byId("rdFab")?.addEventListener("click", () => setFab(!fabOpen));
  byId("rdFabAddBooking")?.addEventListener("click", () => { setFab(false); openBookingSheet(null); });
  byId("rdFabAddBlock")?.addEventListener("click", () => { setFab(false); openBlockSheet(null); });
  // tablet 用の常時アクションボタン（CSS で mobile では hidden）
  byId("rdHubAddBooking")?.addEventListener("click", () => openBookingSheet(null));
  byId("rdHubAddBlock")?.addEventListener("click", () => openBlockSheet(null));
  byId("rdStoreSelect")?.addEventListener("click", () => openStoreSheet());

  byId("rdScrim")?.addEventListener("click", closeSheets);
  document.querySelectorAll("[data-rd-close]").forEach((b) => b.addEventListener("click", closeSheets));

  // 予約シート
  byId("rdBkStart")?.addEventListener("change", updateBookingEnd);
  byId("rdBkCourse")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-c]");
    if (btn) setBookingCourse(btn.dataset.c);
  });
  byId("rdBkStorePick")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-s]");
    if (btn) setBookingStoreChoice(btn.dataset.s);
  });
  byId("rdBkSave")?.addEventListener("click", saveBooking);
  byId("rdBkDelete")?.addEventListener("click", () => requestDelete("booking", editingReservation));

  // 予約不可シート
  byId("rdBlkSave")?.addEventListener("click", saveBlock);
  byId("rdBlkDelete")?.addEventListener("click", () => requestDelete("block", editingBlock));

  // お店設定シート
  byId("rdStoreOpts")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-s]");
    if (btn && !btn.disabled) pickStore(btn.dataset.s);
  });
  byId("rdStSave")?.addEventListener("click", saveStore);
  byId("rdStDelete")?.addEventListener("click", deleteStore);

  // 確認ダイアログ
  byId("rdScrim2")?.addEventListener("click", closeConfirm);
  byId("rdCfCancel")?.addEventListener("click", closeConfirm);
  byId("rdCfOk")?.addEventListener("click", confirmDelete);

  // トースト復活
  byId("rdToastUndo")?.addEventListener("click", restoreLastCancelled);

  // 背景タップで FAB を閉じる
  document.addEventListener("click", (e) => {
    if (fabOpen && !e.target.closest(".rd-fab-layer")) setFab(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (isConfirmOpen()) { closeConfirm(); return; }
    if (anySheetOpen()) { closeSheets(); return; }
    if (fabOpen) setFab(false);
  });

  // 時刻 select を 10 分刻みで初期化
  fillTimeSelect(byId("rdBkStart"), OPEN_MIN, CLOSE_MIN - TIME_STEP);
  fillTimeSelect(byId("rdBlkStart"), OPEN_MIN, CLOSE_MIN - TIME_STEP);
  fillTimeSelect(byId("rdBlkEnd"), OPEN_MIN + TIME_STEP, CLOSE_MIN);
}

function moveMonth(delta) {
  currentMonth = addMonths(currentMonth, delta);
  selectDate(dateKey(currentMonth), true);
}

function selectDate(date, resubscribeMonth) {
  selectedDate = date;
  if (resubscribeMonth) subscribeMonthData();
  subscribeSelectedBlocks(selectedDate);
  renderHome();
}

/* ============ Firestore 購読（従来踏襲） ============ */
function subscribeMonthData() {
  unsubscribeReservations?.();
  unsubscribeSchedules?.();
  const range = monthQueryRange(currentMonth);
  monthReservations = [];
  schedulesByDate = new Map();
  setMonthStatus("");

  // active と invalid 両方を fetch。invalid は CalendarSyncService 経由で取り込まれた
  // 「変な予約」（時刻欠落・店舗名不明・コース時間欠落 等）。admin SPA で警告表示して
  // tenman さんが気付ける + 編集／削除できるようにする。
  // visit_date 範囲外（invalid 時 visit_date="" もあり得る）に出る invalid 予約は別途取得。
  unsubscribeReservations = onSnapshot(
    query(
      collection(db, "reservations"),
      where("visit_date", ">=", range.start),
      where("visit_date", "<=", range.end),
      where("status", "in", ["active", "invalid"]),
      orderBy("visit_date"),
      limit(500),
    ),
    (snap) => {
      monthReservations = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderHome();
      setMonthStatus("");
    },
    (err) => {
      console.error("reservations listener failed", err);
      setMonthStatus(jpError(err, "予約の読み込みに失敗しました"));
    },
  );

  unsubscribeSchedules = onSnapshot(
    query(
      collection(db, "schedules"),
      where("date", ">=", range.start),
      where("date", "<=", range.end),
      orderBy("date"),
      limit(80),
    ),
    (snap) => {
      schedulesByDate = new Map(
        snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((s) => s.active !== false)
          .map((s) => [s.date, s]),
      );
      renderHome();
    },
    (err) => {
      console.error("schedules listener failed", err);
      setMonthStatus(jpError(err, "営業予定の読み込みに失敗しました"));
    },
  );
}

function subscribeSelectedBlocks(date) {
  unsubscribeSelectedBlocks?.();
  selectedBlocks = [];
  selectedBlocksError = "";
  unsubscribeSelectedBlocks = onSnapshot(
    query(
      collection(db, "blocks"),
      where("date", "==", date),
      where("active", "==", true),
      limit(100),
    ),
    (snap) => {
      selectedBlocks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      selectedBlocksError = "";
      renderHub();
    },
    (err) => {
      console.error("blocks listener failed", err);
      selectedBlocksError = jpError(err, "予約不可の読み込みに失敗しました");
      renderHub();
    },
  );
}

/* ============ レンダリング ============ */
function renderHome() {
  renderCalendar();
  renderHub();
}

function renderCalendar() {
  const title = byId("rdCalTitle");
  const grid = byId("rdGrid");
  if (!title || !grid) return;

  title.innerHTML = `<b>${currentMonth.getMonth() + 1}</b>月 <span>${currentMonth.getFullYear()}</span>`;
  grid.innerHTML = "";

  const first = startOfMonth(currentMonth);
  const firstDow = first.getDay();
  const daysInMonth = endOfMonth(currentMonth).getDate();
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  // プロトタイプ準拠：月初前は空セル・当月の日付のみ表示（前後月の日付は出さない）
  for (let i = 0; i < firstDow; i += 1) {
    const empty = document.createElement("div");
    empty.className = "rd-day empty";
    grid.appendChild(empty);
  }

  for (let d = 1; d <= daysInMonth; d += 1) {
    const key = dateKey(new Date(year, month, d));
    const dow = (firstDow + d - 1) % 7;
    const reservations = reservationsForDate(key);
    const schedule = schedulesByDate.get(key);
    // 店舗バッジ判定は active 予約のみで決める（invalid は store_code が空文字の可能性があるので含めない）
    const badge = resolveDayStore(schedule, activeReservationsForDate(key));

    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "rd-day";
    if (dow === 0) cell.classList.add("sun");
    if (dow === 6) cell.classList.add("sat");
    if (key === selectedDate) cell.classList.add("sel");
    cell.dataset.date = key;

    const meta = reservations.length > 0 || badge
      ? `<span class="meta">${badge ? `<span class="rd-dot ${STORE_CSS[badge]}"></span>` : ""}${reservations.length > 0 ? reservations.length : ""}</span>`
      : "";
    cell.innerHTML = `<span class="dnum">${d}</span>${meta}`;
    cell.addEventListener("click", () => selectDate(key, false));
    grid.appendChild(cell);
  }
}

function renderHub() {
  const reservations = reservationsForDate(selectedDate);
  const activeOnly = activeReservationsForDate(selectedDate);
  const schedule = schedulesByDate.get(selectedDate);
  // 店舗バッジ判定は active 予約のみで決める（invalid は store_code 不確定なので除外）
  const store = resolveDayStore(schedule, activeOnly);

  const dateNode = byId("rdHubDate");
  if (dateNode) {
    const d = parseDateKey(selectedDate);
    dateNode.innerHTML = `${d.getMonth() + 1}/${d.getDate()}<small>（${WDAYS[d.getDay()]}）</small>`;
  }

  // 店舗セレクト表示
  const sel = byId("rdStoreSelect");
  const selName = byId("rdStoreSelName");
  if (sel && selName) {
    const css = store ? STORE_CSS[store] : "none";
    sel.className = `rd-store-select ${css}`;
    sel.dataset.write = "true";
    if (store === "event") {
      selName.textContent = schedule?.event_name ? `イベント：${schedule.event_name}` : "イベント出店";
    } else if (store) {
      selName.textContent = STORE_SHORT[store];
    } else {
      selName.textContent = "未設定";
    }
    sel.disabled = isDegraded();
  }

  // メモ
  const memo = byId("rdDayMemo");
  if (memo) {
    if (schedule?.note) { memo.textContent = `メモ：${schedule.note}`; memo.hidden = false; }
    else memo.hidden = true;
  }

  // 件数：active 数 + invalid 数を分けて表示（tenman さんが「要修正」と気付ける）
  const invalidCount = reservations.length - activeOnly.length;
  const countLine = byId("rdCountLine");
  if (countLine) {
    let text = `ご予約 ${activeOnly.length}件`;
    if (invalidCount > 0) text += ` ・ 要修正 ${invalidCount}件`;
    if (selectedBlocks.length) text += ` ・ 受付停止 ${selectedBlocks.length}件`;
    countLine.textContent = text;
  }

  // 予定リスト
  const wrap = byId("rdSchedule");
  if (!wrap) return;
  wrap.innerHTML = "";

  const items = sortDayItems(reservations, selectedBlocks);

  if (selectedBlocksError) {
    wrap.innerHTML = `<div class="rd-error-state">${escapeText(selectedBlocksError)}</div>`;
    return;
  }
  if (items.length === 0) {
    wrap.innerHTML = `<div class="rd-empty-state">この日の予定はまだありません。<br>右下の＋から追加できます。</div>`;
    return;
  }

  items.forEach((it) => {
    if (it.kind === "booking") wrap.appendChild(bookingSlot(it.value));
    else wrap.appendChild(blockSlot(it.value));
  });
}

function bookingSlot(r) {
  if (r.status === "invalid") return invalidSlot(r);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rd-slot";
  const end = r.end_time || addMinutes(r.start_time, COURSE_MIN[String(r.course_code)] || 0);
  const course = r.course_code ? `<span class="rd-pill course">${escapeText(String(r.course_code))}分</span>` : "";
  btn.innerHTML = `
    <span class="time">${escapeText(r.start_time || "--:--")}<small>〜${escapeText(end || "--:--")}</small></span>
    <span class="body"><span class="name">${escapeText(r.customer_name || "名前未設定")}</span><span class="tags">${course}</span></span>
    <span class="chev">${icon("chevRight", 20, 2)}</span>`;
  btn.addEventListener("click", () => openBookingSheet(r));
  return btn;
}

// CalendarSyncService が「変な予約」として取り込んだ invalid 状態の予約。
// 何がおかしいか + どう直せばいいかを表示して、tap で編集シートに飛ぶ。
function invalidSlot(r) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rd-slot invalid";
  const time = r.start_time
    ? `${escapeText(r.start_time)}${r.end_time ? `<small>〜${escapeText(r.end_time)}</small>` : ""}`
    : `<small>時刻未設定</small>`;
  const name = r.customer_name && r.customer_name.length > 0
    ? escapeText(r.customer_name)
    : `<span class="rd-muted">名前未設定</span>`;
  const errorBlocks = renderInvalidErrorMessages(r);
  btn.innerHTML = `
    <span class="rd-slot-invalid-warning">${icon("alertCircle", 16, 2)} 予約データの形式が不正です</span>
    <span class="time">${time}</span>
    <span class="body"><span class="name">${name}</span></span>
    ${errorBlocks}
    <span class="chev">${icon("chevRight", 20, 2)}</span>`;
  btn.addEventListener("click", () => openBookingSheet(r));
  return btn;
}

// validation_errors（JSON 文字列）を日本語で「何がおかしいか + どう直すか」に翻訳する。
const INVALID_ERROR_MESSAGES = {
  customer_name_missing: {
    what: "お客さんの名前が入っていません",
    how: "件名にお客さんのお名前を入れてください（例：山田 さくら）",
  },
  store_alias_unknown: {
    what: "お店の名前がわかりません",
    how: "場所欄に「田主丸」または「太宰府」と書いてください",
  },
  datetime_missing: {
    what: "開始時刻・終了時刻が決まっていません",
    how: "カレンダーで「終日」ではなく時刻を指定してください",
  },
  service_duration_missing: {
    what: "コース時間（40 分／60 分）が書かれていません",
    how: "件名か説明欄に「40 分」または「60 分」と書いてください",
  },
  outside_business_hours: {
    what: "営業時間外（9:00〜21:00 の外）です",
    how: "9:00〜21:00 の範囲で時刻を取り直してください",
  },
  daily_lock_violation: {
    what: "同じ日に田主丸店と太宰府店の両方の予約はできません",
    how: "1 日 1 店舗のルールです。日付かお店を変えてください",
  },
  blocked_time_conflict: {
    what: "「予約不可」にした時間と重なっています",
    how: "時間をずらすか、予約不可を解除してください",
  },
  reservation_conflict: {
    what: "ほかのお客さまの予約と時間が重なっています",
    how: "時間をずらしてください",
  },
  validation_error: {
    what: "入力内容に問題があります",
    how: "件名・場所・時刻・説明欄を確認してください",
  },
};

function parseValidationErrors(r) {
  const raw = r && r.validation_errors;
  if (!raw) return [];
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    // description_extra_content は警告レベルなので invalid 表示には含めない
    return arr.filter((code) => code !== "description_extra_content");
  } catch (_) {
    return [];
  }
}

function renderInvalidErrorMessages(r) {
  const codes = parseValidationErrors(r);
  if (codes.length === 0) {
    return `<div class="rd-slot-invalid-errors"><div class="rd-invalid-error"><div class="what">入力内容に問題があります</div></div></div>`;
  }
  const blocks = codes.map((code) => {
    const msg = INVALID_ERROR_MESSAGES[code] || INVALID_ERROR_MESSAGES.validation_error;
    return `<div class="rd-invalid-error"><div class="what">${escapeText(msg.what)}</div><div class="how">→ ${escapeText(msg.how)}</div></div>`;
  }).join("");
  return `<div class="rd-slot-invalid-errors">${blocks}</div>`;
}

function blockSlot(b) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rd-slot blocked";
  btn.innerHTML = `
    <span class="time">${escapeText(b.start_time || "--:--")}</span>
    <span class="body"><span class="name">予約不可</span><div class="sub">${escapeText(b.start_time || "")}〜${escapeText(b.end_time || "")} ／ この時間は受付を停止</div></span>
    <span class="chev">${icon("chevRight", 20, 2)}</span>`;
  btn.addEventListener("click", () => openBlockSheet(b));
  return btn;
}

/* ============ FAB / シート開閉 ============ */
function setFab(open) {
  fabOpen = open && !isDegraded();
  byId("rdFabMenu")?.classList.toggle("open", fabOpen);
  byId("rdFab")?.classList.toggle("open", fabOpen);
  // v2: ＋を押した直後に背景をうすく暗転（メニューは暗転の上に出す）
  document.querySelector(".rd-fab-layer")?.classList.toggle("elevated", fabOpen);
  if (fabOpen) {
    byId("rdScrim")?.classList.add("show");
  } else if (!anySheetOpen()) {
    byId("rdScrim")?.classList.remove("show");
  }
}

function openSheet(id) {
  byId("rdScrim")?.classList.add("show");
  byId(id)?.classList.add("show");
}

function closeSheets() {
  byId("rdScrim")?.classList.remove("show");
  ["rdSheetBooking", "rdSheetBlock", "rdSheetStore"].forEach((s) => byId(s)?.classList.remove("show"));
  setFab(false);
}

function anySheetOpen() {
  return ["rdSheetBooking", "rdSheetBlock", "rdSheetStore"].some((s) => byId(s)?.classList.contains("show"));
}

/* ============ 予約シート ============ */
function openBookingSheet(reservation) {
  // 店休日は予約追加不可（編集は既存データ救済のため許可）
  if (!reservation && schedulesByDate.get(selectedDate)?.planned_store === "closed") {
    showToast("この日は店休です。予約を入れるには、先に「この日のお店」を変更してください");
    return;
  }
  editingReservation = reservation || null;
  const isEdit = !!reservation;
  byId("rdBkTitle").textContent = isEdit ? "予約を編集" : "予約を追加";
  byId("rdBkSave").textContent = isEdit ? "変更を保存する" : "この内容で予約する";
  byId("rdBkDelete").hidden = !isEdit;
  putError("rdBkError", "");

  // 店舗のロック判定：その日の active 予約（編集中は自分を除く）or planned_store(salon)
  const lockedStore = resolveLockedStore(isEdit ? reservation : null);
  const storeField = byId("rdBkStoreField");
  const storePickBox = byId("rdBkStorePick");
  const ctxText = byId("rdBkCtxText");
  if (lockedStore) {
    // 店舗確定：冒頭の文脈行に「M月D日（曜）・<店舗> に追加します」で示し、お店選択は出さない
    bookingStoreChoice = lockedStore;
    storeField.hidden = true;
    ctxText.textContent = `${formatCtxDate(selectedDate)}・${STORE_FULL[lockedStore]} に${isEdit ? "" : "追加します"}`;
  } else {
    // 予約0かつ店舗未設定の日：最初の予約で店舗を決める（田主丸/太宰府）
    bookingStoreChoice = isEdit ? (reservation.store_code || "") : "";
    storeField.hidden = false;
    ctxText.textContent = `${formatCtxDate(selectedDate)} に${isEdit ? "" : "追加します"}`;
    storePickBox.querySelectorAll("button[data-s]").forEach((b) => b.classList.toggle("on", b.dataset.s === bookingStoreChoice));
  }

  if (isEdit) {
    byId("rdBkName").value = reservation.customer_name || "";
    byId("rdBkStart").value = reservation.start_time || minutesToStr(OPEN_MIN);
    setBookingCourse(String(reservation.course_code || "60"));
    byId("rdBkTel").value = reservation.customer_phone || "";
    byId("rdBkMemo").value = reservation.note || "";
  } else {
    byId("rdBkName").value = "";
    byId("rdBkStart").value = nextFreeStart();
    setBookingCourse("60");
    byId("rdBkTel").value = "";
    byId("rdBkMemo").value = "";
  }
  byId("rdBkName").classList.remove("invalid");
  updateBookingEnd();
  byId("rdBkSave").disabled = isDegraded();
  byId("rdBkDelete").disabled = isDegraded();
  openSheet("rdSheetBooking");
}

function setBookingCourse(c) {
  bookingCourse = COURSE_MIN[c] ? c : "60";
  byId("rdBkCourse").querySelectorAll("button[data-c]").forEach((b) => b.classList.toggle("on", b.dataset.c === bookingCourse));
  updateBookingEnd();
}

function setBookingStoreChoice(s) {
  bookingStoreChoice = s;
  byId("rdBkStorePick").querySelectorAll("button[data-s]").forEach((b) => b.classList.toggle("on", b.dataset.s === s));
}

function updateBookingEnd() {
  const start = byId("rdBkStart").value;
  byId("rdBkEnd").textContent = addMinutes(start, COURSE_MIN[bookingCourse]) || "--:--";
}

async function saveBooking() {
  if (isDegraded()) return;
  putError("rdBkError", "");
  const name = byId("rdBkName").value.trim();
  if (!name) {
    byId("rdBkName").classList.add("invalid");
    byId("rdBkName").focus();
    putError("rdBkError", "お名前を入力してください");
    return;
  }
  byId("rdBkName").classList.remove("invalid");

  const start = byId("rdBkStart").value;
  const course = bookingCourse;
  const end = addMinutes(start, COURSE_MIN[course]);
  const store = bookingStoreChoice;
  const tel = byId("rdBkTel").value.trim();
  const memo = byId("rdBkMemo").value.trim();

  const editId = editingReservation?.reservation_id || editingReservation?.id || null;
  // 時刻重複チェックは active 予約のみで行う（invalid は時刻が "" の可能性 + 修正中の予約自身が含まれている）
  const vmsg = validateBookingValues(
    { start, end, store, name },
    { reservations: activeReservationsForDate(selectedDate), blocks: selectedBlocks, excludeId: editId },
  );
  if (vmsg) { putError("rdBkError", vmsg); return; }

  const save = byId("rdBkSave");
  save.disabled = true;
  try {
    if (editingReservation) {
      const id = editId;
      const target = `reservations/${id}`;
      // invalid な予約を編集して保存する場合は、validation 全項目を通っているので
      // status を active に昇格 + validation_errors field を削除する。
      // active を編集する場合は status を触らない（既存仕様維持）。
      const wasInvalid = editingReservation.status === "invalid";
      const data = {
        visit_date: selectedDate, start_time: start, end_time: end,
        store_code: store, course_code: course, customer_name: name,
        customer_phone: tel, note: memo, updated_at: serverTimestamp(),
      };
      if (wasInvalid) {
        data.status = "active";
        data.validation_errors = deleteField();
      }
      await commitWrite({
        op: "updateReservation",
        domain: {
          collection: "reservations", docId: id, action: "update",
          data,
        },
        inverse: { op: "update", target, data: stripId(editingReservation) },
        target, dispatchSource: "admin_reservation_update",
      });
      closeSheets();
      showToast(wasInvalid ? "予約データを修正しました" : "予約を変更しました");
    } else {
      const id = `rsv_${randomHex(12)}`;
      const target = `reservations/${id}`;
      await commitWrite({
        op: "createReservation",
        domain: {
          collection: "reservations", docId: id, action: "set",
          data: {
            reservation_id: id, created_at: serverTimestamp(), updated_at: serverTimestamp(),
            status: "active", visit_date: selectedDate, start_time: start, end_time: end,
            store_code: store, course_code: course, customer_name: name, customer_phone: tel,
            customer_line_user_id: "", customer_line_display_name: "", source: "manual",
            cancel_token_hash: "", note: memo,
          },
        },
        inverse: { op: "delete", target },
        target, dispatchSource: "admin_reservation_create",
      });
      closeSheets();
      showToast("予約を追加しました");
    }
  } catch (err) {
    console.error("reservation write failed", err);
    putError("rdBkError", jpError(err, "保存に失敗しました"));
    save.disabled = isDegraded();
  }
}

/* ============ 予約不可シート ============ */
function openBlockSheet(block) {
  editingBlock = block || null;
  const isEdit = !!block;
  byId("rdBlkTitle").textContent = isEdit ? "受付停止を編集" : "予約を受けない時間";
  byId("rdBlkDelete").hidden = !isEdit;
  putError("rdBlkError", "");
  byId("rdBlkStart").value = isEdit ? (block.start_time || "12:00") : "12:00";
  byId("rdBlkEnd").value = isEdit ? (block.end_time || "13:00") : "13:00";
  byId("rdBlkSave").disabled = isDegraded();
  byId("rdBlkDelete").disabled = isDegraded();
  openSheet("rdSheetBlock");
}

async function saveBlock() {
  if (isDegraded()) return;
  putError("rdBlkError", "");
  const start = byId("rdBlkStart").value;
  const end = byId("rdBlkEnd").value;
  const editId = editingBlock?.id || null;
  // block の時刻重複チェックは active 予約のみで行う（invalid は時刻が "" の可能性）
  const vmsg = validateBlockValues(
    { start, end },
    { reservations: activeReservationsForDate(selectedDate), blocks: selectedBlocks, excludeId: editId },
  );
  if (vmsg) { putError("rdBlkError", vmsg); return; }

  const save = byId("rdBlkSave");
  save.disabled = true;
  try {
    const id = editId || `${selectedDate}_${start}_${end}`;
    const target = `blocks/${id}`;
    await commitWrite({
      op: editingBlock ? "updateBlock" : "addBlock",
      domain: {
        collection: "blocks", docId: id, action: editingBlock ? "update" : "set",
        data: {
          date: selectedDate, start_time: start, end_time: end, active: true,
          created_at: editingBlock?.created_at || serverTimestamp(), updated_at: serverTimestamp(),
        },
      },
      inverse: editingBlock ? { op: "update", target, data: stripId(editingBlock) } : { op: "delete", target },
      target, dispatchSource: editingBlock ? "admin_block_update" : "admin_block_add",
    });
    closeSheets();
    showToast(editingBlock ? "受付停止を変更しました" : "受付停止を追加しました");
  } catch (err) {
    console.error("block write failed", err);
    putError("rdBlkError", jpError(err, "保存に失敗しました"));
    save.disabled = isDegraded();
  }
}

/* ============ お店設定シート ============ */
let storeChoice = "";
function openStoreSheet() {
  if (isDegraded()) return;
  // store-lock 判定は active 予約のみで決める。invalid な予約は店舗未確定なので
  // store の選択肢を縛るべきではない（修正後に正しい店舗が決まる）。
  const reservations = activeReservationsForDate(selectedDate);
  const schedule = schedulesByDate.get(selectedDate);
  const hasBooking = reservations.length > 0;
  const current = resolveDayStore(schedule, reservations) || "";
  storeChoice = current;

  byId("rdStoreOpts").querySelectorAll("button[data-s]").forEach((b) => {
    b.classList.toggle("on", b.dataset.s === current);
    b.disabled = hasBooking && b.dataset.s !== current;
  });
  byId("rdStoreLockNote").hidden = !hasBooking;
  toggleEventFields(current === "event");
  byId("rdEvName").value = schedule?.event_name || "";
  byId("rdEvVenue").value = schedule?.event_venue || "";
  byId("rdStMemo").value = schedule?.note || "";
  byId("rdStDelete").hidden = !schedule?.id;
  byId("rdStDelete").disabled = isDegraded();
  byId("rdStSave").disabled = isDegraded();
  putError("rdStError", "");
  openSheet("rdSheetStore");
}

function pickStore(s) {
  storeChoice = s;
  byId("rdStoreOpts").querySelectorAll("button[data-s]").forEach((b) => b.classList.toggle("on", b.dataset.s === s));
  toggleEventFields(s === "event");
}

function toggleEventFields(show) {
  byId("rdEventFields").hidden = !show;
}

async function saveStore() {
  if (isDegraded()) return;
  putError("rdStError", "");
  if (!storeChoice) { putError("rdStError", "お店を選んでください"); return; }
  const eventName = byId("rdEvName").value.trim();
  const eventVenue = byId("rdEvVenue").value.trim();
  const memo = byId("rdStMemo").value.trim();
  if (storeChoice === "event" && !eventName) {
    byId("rdEvName").classList.add("invalid");
    byId("rdEvName").focus();
    putError("rdStError", "イベント名を入力してください");
    return;
  }

  const existing = schedulesByDate.get(selectedDate);
  const target = `schedules/${selectedDate}`;
  const save = byId("rdStSave");
  save.disabled = true;
  try {
    await commitWrite({
      op: "setSchedule",
      domain: {
        collection: "schedules", docId: selectedDate, action: "set",
        data: {
          date: selectedDate, planned_store: storeChoice,
          event_name: storeChoice === "event" ? eventName : "",
          event_venue: storeChoice === "event" ? eventVenue : "",
          note: memo, active: true,
          created_at: existing?.created_at || serverTimestamp(), updated_at: serverTimestamp(),
        },
      },
      inverse: existing ? { op: "update", target, data: stripId(existing) } : { op: "delete", target },
      target, dispatchSource: "admin_schedule_set",
    });
    closeSheets();
    showToast("この日のお店を更新しました");
  } catch (err) {
    console.error("schedule write failed", err);
    putError("rdStError", jpError(err, "保存に失敗しました"));
    save.disabled = isDegraded();
  }
}

function deleteStore() {
  if (isDegraded()) return;
  const existing = schedulesByDate.get(selectedDate);
  if (!existing?.id) return;
  requestDelete("schedule", existing);
}

/* ============ キャンセル（確認ダイアログ → ソフトデリート → トースト復活） ============ */
function requestDelete(kind, item) {
  if (!item) return;
  pendingDelete = { kind, item };
  const titleNode = byId("rdCfTitle");
  const sumNode = byId("rdCfSum");
  const okNode = byId("rdCfOk");
  if (kind === "booking") {
    const isInvalid = item.status === "invalid";
    if (isInvalid) {
      // invalid 予約は status=cancelled に遷移すると Firestore rules の厳密検証で reject されるため
      // 物理削除（doc 自体を delete）に変える。UI 文言も「キャンセル」ではなく「削除」に。
      titleNode.textContent = "この予約データを削除しますか？";
      sumNode.textContent = `${item.start_time || "(時刻なし)"}　${item.customer_name || "(名前なし)"}`;
      okNode.textContent = "予約データを削除する";
    } else {
      const end = item.end_time || addMinutes(item.start_time, COURSE_MIN[String(item.course_code)] || 0);
      titleNode.textContent = "この予約をキャンセルしますか？";
      sumNode.textContent = `${item.start_time}〜${end}　${item.customer_name || ""}　${item.course_code || ""}分`;
      okNode.textContent = "予約をキャンセルする";
    }
  } else if (kind === "schedule") {
    const storeName = STORE_FULL[item.planned_store] || item.planned_store || "";
    const eventNote = item.event_name ? `　${item.event_name}` : "";
    titleNode.textContent = "この日のお店設定を解除しますか？";
    sumNode.textContent = `${selectedDate}　${storeName}${eventNote}`;
    okNode.textContent = "お店設定を解除する";
  } else {
    titleNode.textContent = "この受付停止を解除しますか？";
    sumNode.textContent = `${item.start_time}〜${item.end_time}　受付停止`;
    okNode.textContent = "受付停止を解除する";
  }
  okNode.disabled = isDegraded();
  byId("rdScrim2").classList.add("show");
  byId("rdConfirm").classList.add("show");
}

function closeConfirm() {
  byId("rdConfirm")?.classList.remove("show");
  byId("rdScrim2")?.classList.remove("show");
  pendingDelete = null;
}

function isConfirmOpen() {
  return Boolean(byId("rdConfirm")?.classList.contains("show"));
}

async function confirmDelete() {
  if (isDegraded() || !pendingDelete) return;
  const { kind, item } = pendingDelete;
  const ok = byId("rdCfOk");
  ok.disabled = true;
  try {
    if (kind === "booking") {
      const id = item.reservation_id || item.id;
      const isInvalid = item.status === "invalid";
      if (isInvalid) {
        // invalid 予約は物理削除（rules で invalid→cancelled の transition が弾かれるため）。
        // undo の inverse は元 invalid 状態の全フィールド復元。
        const target = `reservations/${id}`;
        lastCancelled = null;
        const restoreData = stripId(item);
        await commitWrite({
          op: "deleteInvalidReservation",
          domain: { collection: "reservations", docId: id, action: "delete" },
          inverse: { op: "create", target, data: restoreData },
          target, dispatchSource: "admin_invalid_reservation_delete",
        });
        closeConfirm();
        closeSheets();
        showToast("予約データを削除しました");
      } else {
        lastCancelled = { id, snapshot: { ...item } };
        await cancelReservation(id);
        closeConfirm();
        closeSheets();
        showToast("予約をキャンセルしました", true, 6000);
      }
    } else if (kind === "schedule") {
      const target = `schedules/${item.id}`;
      lastCancelled = null;
      const scheduleRestoreData = {
        date: item.date, planned_store: item.planned_store || "",
        event_name: item.event_name || "", event_venue: item.event_venue || "",
        note: item.note || "", active: true,
        created_at: item.created_at || serverTimestamp(), updated_at: serverTimestamp(),
      };
      await commitWrite({
        op: "deleteSchedule",
        domain: { collection: "schedules", docId: item.id, action: "delete" },
        inverse: { op: "create", target, data: scheduleRestoreData },
        target, dispatchSource: "admin_schedule_delete",
      });
      closeConfirm();
      closeSheets();
      showToast("この日のお店設定を解除しました");
    } else {
      const id = item.id;
      const target = `blocks/${id}`;
      lastCancelled = null;
      const blockRestoreData = {
        date: item.date, start_time: item.start_time, end_time: item.end_time,
        active: true, created_at: item.created_at || serverTimestamp(), updated_at: serverTimestamp(),
      };
      await commitWrite({
        op: "deleteBlock",
        domain: { collection: "blocks", docId: id, action: "delete" },
        inverse: { op: "create", target, data: blockRestoreData },
        target, dispatchSource: "admin_block_delete",
      });
      closeConfirm();
      closeSheets();
      showToast("受付停止を解除しました");
    }
  } catch (err) {
    console.error("delete failed", err);
    closeConfirm();
    showToast(jpError(err, "操作に失敗しました"));
  }
}

async function restoreLastCancelled() {
  hideToast();
  if (!lastCancelled || isDegraded()) return;
  const { id, snapshot } = lastCancelled;
  lastCancelled = null;
  const start = snapshot.start_time;
  const end = snapshot.end_time || addMinutes(start, COURSE_MIN[String(snapshot.course_code)] || 0);
  // v1.1 HIGH-NEW-1: 衝突判定は selectedDate ではなく復活対象日（snapshot.visit_date）基準で行う。
  // キャンセル後 6 秒以内に別日へ移動して Undo すると、selectedDate キャッシュは別日を指すため
  // 元日の衝突を見逃す（Codex review 4 回目 HIGH-1）。全経路と同じく Firestore から読んで集約判定。
  const visitDate = snapshot.visit_date;
  try {
    const [scheduleSnap, resSnap, blockSnap] = await Promise.all([
      getDoc(doc(db, "schedules", visitDate)),
      getDocs(query(collection(db, "reservations"), where("status", "==", "active"), where("visit_date", "==", visitDate))),
      getDocs(query(collection(db, "blocks"), where("active", "==", true), where("date", "==", visitDate))),
    ]);
    const scheduleData = scheduleSnap.exists() ? (scheduleSnap.data() || {}) : null;
    const otherActiveReservations = resSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const blocks = blockSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const verdict = findRestoreConflicts({
      reservation: { ...snapshot, id, start_time: start, end_time: end },
      scheduleData, otherActiveReservations, blocks,
    });
    if (!verdict.ok) {
      showToast("この日は予定が変わったため戻せませんでした");
      return;
    }
  } catch (err) {
    console.error("restore conflict check failed", err);
    showToast("確認中にエラーが発生したため戻せませんでした");
    return;
  }
  const target = `reservations/${id}`;
  try {
    await commitWrite({
      op: "restoreReservation",
      domain: { collection: "reservations", docId: id, action: "update", data: { status: "active", updated_at: serverTimestamp() } },
      inverse: { op: "update", target, data: { status: "cancelled" }, precondition: { type: "source_revision_match" } },
      target, dispatchSource: "admin_reservation_restore",
    });
    showToast("予約を元に戻しました");
  } catch (err) {
    console.error("restore failed", err);
    showToast(jpError(err, "元に戻せませんでした"));
  }
}

/* ============ トースト ============ */
function showToast(msg, undoable = false, ms = 3600) {
  byId("rdToastMsg").textContent = msg;
  byId("rdToastUndo").hidden = !undoable;
  byId("rdToast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  byId("rdToast")?.classList.remove("show");
}

/* ============ ロジック ============ */
function reservationsForDate(date) {
  // active と invalid（calendar 経由で取り込まれた変な予約）の両方をリストに出す。
  // 件数集計・物理制約 validation は status==="active" のみ別途フィルタする。
  return monthReservations
    .filter((r) => r.visit_date === date && (r.status === "active" || r.status === "invalid"))
    .sort((a, b) => `${a.start_time || ""}${a.reservation_id || a.id || ""}`.localeCompare(`${b.start_time || ""}${b.reservation_id || b.id || ""}`));
}

// active のみ（件数集計・カレンダー dot 表示・物理制約 validation の入力に使う）。
function activeReservationsForDate(date) {
  return reservationsForDate(date).filter((r) => r.status === "active");
}

/* ---- 純粋関数（物理制約 validation / sort・テスト対象） ---- */
// 予定リストの並び：時刻昇順、同時刻は予約を予約不可より先に
function sortDayItems(reservations, blocks) {
  const rank = (it) => `${it.t || "99:99"}${it.kind === "booking" ? "0" : "1"}${it.id}`;
  return [
    ...(reservations || []).map((r) => ({ kind: "booking", t: r.start_time || "", e: r.end_time || "", id: r.reservation_id || r.id || "", value: r })),
    ...(blocks || []).map((b) => ({ kind: "block", t: b.start_time || "", e: b.end_time || "", id: b.id || "", value: b })),
  ].sort((a, c) => rank(a).localeCompare(rank(c)));
}

// 予約の物理制約：名前・店舗・時刻境界・予約/予約不可の時刻重複（1日1店舗は店舗ロック UI 側で担保）
function validateBookingValues({ start, end, store, name }, { reservations = [], blocks = [], excludeId = null } = {}) {
  if (!name) return "お名前を入力してください";
  if (!store) return "お店を選んでください";
  if (!isValidTime(start) || !end) return "開始時刻が不正です";
  if (strToMin(start) < OPEN_MIN || strToMin(end) > CLOSE_MIN) return `営業時間外です（${minutesToStr(OPEN_MIN)}-${minutesToStr(CLOSE_MIN)}）`;
  const r = reservations.find((x) => {
    const id = x.reservation_id || x.id;
    if (excludeId && id === excludeId) return false;
    return timeOverlap(start, end, x.start_time, x.end_time);
  });
  if (r) return `${r.start_time}〜${r.end_time} の予約と重複しています`;
  const b = blocks.find((x) => timeOverlap(start, end, x.start_time, x.end_time));
  if (b) return `${b.start_time}〜${b.end_time} の予約不可と重複しています`;
  return "";
}

// 予約不可の物理制約：時刻妥当・営業時間内・予約不可/予約の時刻重複（編集中の自身は除外）
function validateBlockValues({ start, end }, { reservations = [], blocks = [], excludeId = null } = {}) {
  if (!isValidTime(start) || !isValidTime(end)) return "時刻が不正です";
  if (strToMin(end) <= strToMin(start)) return "終了時刻は開始時刻より後にしてください";
  if (strToMin(start) < OPEN_MIN || strToMin(end) > CLOSE_MIN) return `営業時間内（${minutesToStr(OPEN_MIN)}〜${minutesToStr(CLOSE_MIN)}）で指定してください`;
  const b = blocks.find((x) => {
    if (excludeId && x.id === excludeId) return false;
    return timeOverlap(start, end, x.start_time, x.end_time);
  });
  if (b) return `${b.start_time}〜${b.end_time} の予約不可と重複しています`;
  const r = reservations.find((x) => timeOverlap(start, end, x.start_time, x.end_time));
  if (r) return `${r.start_time}〜${r.end_time} の予約と重複しています`;
  return "";
}

// その日の店舗を決定：planned_store(salon/event/closed) 優先、無ければ active 予約の店から（1店舗のみなら）
function resolveDayStore(schedule, reservations) {
  const planned = schedule?.planned_store;
  if (planned === "tanushimaru" || planned === "dazaifu" || planned === "event" || planned === "closed") return planned;
  const codes = new Set();
  for (const r of reservations || []) {
    const s = r.store_code;
    if (s === "tanushimaru" || s === "dazaifu" || s === "event") codes.add(s);
  }
  return codes.size === 1 ? [...codes][0] : null;
}

// 予約フォームの店舗ロック：その日に salon が決まっていれば返す（event は予約不可なので null=選択させない…ではなく salon のみロック）
function resolveLockedStore(excludeReservation) {
  // store-lock 判定は active 予約のみで決める（invalid は store_code 不確定なので除外）
  const reservations = activeReservationsForDate(selectedDate).filter((r) => {
    const id = r.reservation_id || r.id;
    const exId = excludeReservation?.reservation_id || excludeReservation?.id;
    return id !== exId;
  });
  const codes = new Set();
  for (const r of reservations) {
    if (r.store_code === "tanushimaru" || r.store_code === "dazaifu") codes.add(r.store_code);
  }
  if (codes.size === 1) return [...codes][0];
  const planned = schedulesByDate.get(selectedDate)?.planned_store;
  if (planned === "tanushimaru" || planned === "dazaifu") return planned;
  return null; // 予約0 かつ salon 未設定 → 選択させる
}

function findReservationCollision(start, end, excludeId) {
  // 時刻衝突判定は active 予約のみ（invalid は時刻が "" の可能性）
  return activeReservationsForDate(selectedDate).find((r) => {
    const id = r.reservation_id || r.id;
    if (excludeId && id === excludeId) return false;
    return timeOverlap(start, end, r.start_time, r.end_time);
  }) || null;
}

function findBlockCollision(start, end) {
  return selectedBlocks.find((b) => timeOverlap(start, end, b.start_time, b.end_time)) || null;
}

function nextFreeStart() {
  // 既存予約の時刻空きを探す。active のみで判定（invalid は時刻が "" の可能性）
  const used = activeReservationsForDate(selectedDate).map((r) => strToMin(r.start_time));
  for (let m = OPEN_MIN; m <= CLOSE_MIN - 60; m += 60) {
    if (!used.includes(m)) return minutesToStr(m);
  }
  return "14:00";
}

/* ============ ユーティリティ ============ */
function byId(id) { return document.getElementById(id); }
function setMonthStatus(text) { const n = byId("rdMonthStatus"); if (n) { n.textContent = text || ""; n.hidden = !text; } }
function putError(id, msg) { const n = byId(id); if (!n) return; n.textContent = msg; n.hidden = !msg; }

function fillTimeSelect(sel, from, to) {
  if (!sel) return;
  sel.innerHTML = "";
  for (let m = from; m <= to; m += TIME_STEP) {
    const t = minutesToStr(m);
    const o = document.createElement("option");
    o.value = t; o.textContent = t;
    sel.appendChild(o);
  }
}

function isValidTime(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(v); }
function strToMin(v) { if (!isValidTime(v)) return 0; const [h, m] = v.split(":").map(Number); return h * 60 + m; }
function minutesToStr(v) { return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`; }
function addMinutes(start, mins) { if (!isValidTime(start) || !mins) return ""; return minutesToStr(strToMin(start) + mins); }
function timeOverlap(s1, e1, s2, e2) { return strToMin(s1) < strToMin(e2) && strToMin(e1) > strToMin(s2); }

function stripId(value) { const { id, ...rest } = value; return rest; }

function randomHex(length) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, length);
}

function jpError(error, fallback) {
  const message = String(error?.message || "");
  return /[ぁ-んァ-ヴ一-龯]/.test(message) ? message : fallback;
}

function escapeText(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function todayKey() {
  const parts = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}
function parseDateKey(value) { const [y, m, d] = value.split("-").map(Number); return new Date(y, m - 1, d); }
function formatCtxDate(key) { const d = parseDateKey(key); return `${d.getMonth() + 1}月${d.getDate()}日（${WDAYS[d.getDay()]}）`; }
function dateKey(date) { return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-"); }
function startOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1); }
function endOfMonth(date) { return new Date(date.getFullYear(), date.getMonth() + 1, 0); }
function startOfWeek(date) { const s = new Date(date); s.setDate(s.getDate() - s.getDay()); return s; }
function endOfWeek(date) { const e = new Date(date); e.setDate(e.getDate() + (6 - e.getDay())); return e; }
function addMonths(date, n) { return new Date(date.getFullYear(), date.getMonth() + n, 1); }
function monthQueryRange(month) { return { start: dateKey(startOfMonth(month)), end: dateKey(endOfMonth(addMonths(month, 1))) }; }

/* ============ アイコン ============ */
function icon(name, size = 20, sw = 2) {
  const paths = {
    chevDown: '<polyline points="6 9 12 15 18 9"></polyline>',
    chevRight: '<polyline points="9 18 15 12 9 6"></polyline>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
    noEntry: '<circle cx="12" cy="12" r="9"></circle><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"></line>',
    x: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
    clock: '<circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
    check: '<polyline points="20 6 9 17 4 12"></polyline>',
    trash: '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>',
    alertCircle: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>',
  };
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ""}</svg>`;
}
