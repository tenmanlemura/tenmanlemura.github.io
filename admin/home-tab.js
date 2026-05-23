import { db } from "./app.js";
import {
  collection,
  query,
  where,
  onSnapshot,
  orderBy,
  limit,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { cancelReservation, openReservationModal } from "./reservation-modal.js";
import { executeRedo, executeUndo, getLatestRedoableLog, getLatestUndoableLog } from "./undo.js";

const WDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const STORE_LABELS = {
  tanushimaru: "田主丸店",
  dazaifu: "太宰府店",
  event: "イベント出店",
  both: "両店舗受付中",
};
const STORE_SHORT = {
  tanushimaru: "田",
  dazaifu: "太",
  event: "イ",
  both: "両",
};

let initialized = false;
let built = false;
let currentMonth = startOfMonth(parseDateKey(todayKey()));
let selectedDate = todayKey();
let monthReservations = [];
let todayReservations = [];
let schedulesByDate = new Map();
let selectedBlocks = [];
let todayBlocks = [];
let unsubscribeReservations = null;
let unsubscribeTodayReservations = null;
let unsubscribeSchedules = null;
let unsubscribeSelectedBlocks = null;
let unsubscribeTodayBlocks = null;

export function initHomeTab() {
  const root = document.getElementById("tab-home");
  if (!root) return;

  if (!built) {
    buildHomeDom(root);
    built = true;
  }

  if (initialized) {
    renderHome();
    refreshUndoRedoButtons();
    return;
  }

  initialized = true;
  setupMonthButtons();
  setupWriteButtons();
  setupUndoRedoButtons();
  subscribeMonthData();
  subscribeTodayReservations();
  subscribeTodayBlocks();
  subscribeSelectedBlocks(selectedDate);
  renderHome();
  refreshUndoRedoButtons();
}

export function teardownHomeTab() {
  unsubscribeReservations?.();
  unsubscribeTodayReservations?.();
  unsubscribeSchedules?.();
  unsubscribeSelectedBlocks?.();
  unsubscribeTodayBlocks?.();
  unsubscribeReservations = null;
  unsubscribeTodayReservations = null;
  unsubscribeSchedules = null;
  unsubscribeSelectedBlocks = null;
  unsubscribeTodayBlocks = null;
  initialized = false;
}

function buildHomeDom(root) {
  root.innerHTML = `
    <div class="panel-heading">
      <p class="section-label">Home</p>
      <h2>ホーム</h2>
    </div>
    <div class="home-stack">
      <section class="month-shell" aria-labelledby="homeMonthTitle">
        <div class="month-head">
          <button type="button" class="btn btn-secondary btn-compact" id="homePrevMonth">前月</button>
          <div class="month-title" id="homeMonthTitle">--</div>
          <button type="button" class="btn btn-secondary btn-compact" id="homeNextMonth">次月</button>
          <button type="button" class="btn btn-secondary btn-compact" id="homeCurrentMonth">今月</button>
        </div>
        <div class="month-status" id="homeMonthStatus" role="status">読み込み中...</div>
        <div class="month-grid" id="homeMonthCalendar" aria-label="月次カレンダー"></div>
      </section>

      <section class="detail-shell" aria-labelledby="homeSelectedTitle">
        <div class="section-subhead section-subhead-action">
          <div>
            <p class="section-label">Selected day</p>
            <h3 id="homeSelectedTitle">選択日詳細</h3>
          </div>
          <button type="button" class="btn btn-secondary btn-compact" id="homeAddReservation" data-write="true">予約を追加</button>
        </div>
        <div class="detail-grid">
          <div>
            <h4>予約</h4>
            <div class="row-list" id="homeSelectedReservationList"></div>
          </div>
          <div>
            <h4>予約不可</h4>
            <div class="row-list" id="homeSelectedBlockList"></div>
          </div>
        </div>
      </section>

      <section class="detail-shell" aria-labelledby="homeTodayTitle">
        <div class="section-subhead">
          <p class="section-label">Today</p>
          <h3 id="homeTodayTitle">今日の予約</h3>
        </div>
        <div class="detail-grid">
          <div>
            <h4>確定予約</h4>
            <div class="row-list" id="homeTodayReservationList"></div>
          </div>
          <div>
            <h4>予約不可</h4>
            <div class="row-list" id="homeTodayBlockList"></div>
          </div>
        </div>
      </section>

      <section class="undo-toolbar" aria-labelledby="homeUndoTitle">
        <div>
          <p class="section-label">History</p>
          <h3 id="homeUndoTitle">操作履歴</h3>
          <p class="undo-toolbar-note" id="homeUndoStatus">履歴を確認しています</p>
        </div>
        <div class="undo-toolbar-actions">
          <button type="button" class="btn btn-secondary btn-compact" id="homeUndoButton" data-write="true" disabled>直前の操作を元に戻す</button>
          <button type="button" class="btn btn-secondary btn-compact" id="homeRedoButton" data-write="true" disabled>やり直し</button>
        </div>
        <div class="undo-toast" id="homeUndoToast" role="status" aria-live="polite" hidden></div>
      </section>
    </div>
  `;
}

function setupMonthButtons() {
  document.getElementById("homePrevMonth")?.addEventListener("click", () => {
    currentMonth = addMonths(currentMonth, -1);
    selectedDate = dateKey(currentMonth);
    subscribeMonthData();
    subscribeSelectedBlocks(selectedDate);
    renderHome();
  });

  document.getElementById("homeNextMonth")?.addEventListener("click", () => {
    currentMonth = addMonths(currentMonth, 1);
    selectedDate = dateKey(currentMonth);
    subscribeMonthData();
    subscribeSelectedBlocks(selectedDate);
    renderHome();
  });

  document.getElementById("homeCurrentMonth")?.addEventListener("click", () => {
    currentMonth = startOfMonth(parseDateKey(todayKey()));
    selectedDate = todayKey();
    subscribeMonthData();
    subscribeSelectedBlocks(selectedDate);
    renderHome();
  });
}

function setupWriteButtons() {
  document.getElementById("homeAddReservation")?.addEventListener("click", () => {
    openReservationModal({ mode: "create", presetDate: selectedDate });
  });
}

function setupUndoRedoButtons() {
  const undoButton = document.getElementById("homeUndoButton");
  const redoButton = document.getElementById("homeRedoButton");

  undoButton?.addEventListener("click", async () => {
    await runHistoryAction(undoButton, async () => {
      const log = await getLatestUndoableLog();
      const result = await executeUndo(log);
      if (result.status === "done") {
        showUndoToast(`${targetLabel(log)}を元に戻しました`);
      } else if (result.status === "skipped") {
        showUndoToast("undo を中止しました");
      } else {
        showUndoToast("元に戻せる操作がありません");
      }
    });
  });

  redoButton?.addEventListener("click", async () => {
    await runHistoryAction(redoButton, async () => {
      const log = await getLatestRedoableLog();
      const result = await executeRedo();
      if (result.status === "done") {
        showUndoToast(`${targetLabel(log)}をやり直しました`);
      } else {
        showUndoToast("やり直せる操作がありません");
      }
    });
  });
}

async function runHistoryAction(button, action) {
  button.disabled = true;
  setUndoStatus("処理中...");
  try {
    await action();
  } catch (error) {
    console.error("history action failed", error);
    showUndoToast(error.message || "履歴操作に失敗しました");
  } finally {
    await refreshUndoRedoButtons();
  }
}

async function refreshUndoRedoButtons() {
  const undoButton = document.getElementById("homeUndoButton");
  const redoButton = document.getElementById("homeRedoButton");
  if (!undoButton || !redoButton) return;

  try {
    const [undoLog, redoLog] = await Promise.all([getLatestUndoableLog(), getLatestRedoableLog()]);
    undoButton.disabled = !undoLog;
    undoButton.title = undoLog ? `${targetLabel(undoLog)}を元に戻す` : "元に戻せる操作がありません";
    redoButton.disabled = !redoLog;
    redoButton.title = redoLog ? `${targetLabel(redoLog)}をやり直す` : "やり直せる操作がありません";
    setUndoStatus(undoLog ? `最新: ${actionLabel(undoLog.action)} / ${targetLabel(undoLog)}` : "元に戻せる操作がありません");
  } catch (error) {
    console.error("undo state refresh failed", error);
    undoButton.disabled = true;
    redoButton.disabled = true;
    undoButton.title = "元に戻せる操作がありません";
    redoButton.title = "やり直せる操作がありません";
    setUndoStatus("履歴を確認できませんでした");
  }
}

function targetLabel(log) {
  const target = log?.target || log?.target_path || log?.inverse_operation?.target || "対象";
  const id = target.split("/").pop();
  if (target.startsWith("reservations/")) return `${id} の予約`;
  if (target.startsWith("schedules/")) return `${id} の営業予定`;
  if (target.startsWith("blocks/")) return `${id} の予約不可`;
  return target;
}

function actionLabel(action) {
  if (!action) return "操作";
  if (action.startsWith("undo_of:")) return "undo";
  if (action.startsWith("redo_of:")) return "redo";
  return action;
}

function setUndoStatus(text) {
  const status = document.getElementById("homeUndoStatus");
  if (status) status.textContent = text;
}

function showUndoToast(message) {
  const toast = document.getElementById("homeUndoToast");
  if (!toast) return;

  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showUndoToast.timer);
  showUndoToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 3600);
}

function subscribeMonthData() {
  unsubscribeReservations?.();
  unsubscribeSchedules?.();

  const range = monthQueryRange(currentMonth);
  monthReservations = [];
  schedulesByDate = new Map();
  setMonthStatus("読み込み中...");

  unsubscribeReservations = onSnapshot(
    query(
      collection(db, "reservations"),
      where("visit_date", ">=", range.start),
      where("visit_date", "<=", range.end),
      where("status", "==", "active"),
      orderBy("visit_date"),
      limit(500),
    ),
    (snapshot) => {
      monthReservations = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      renderHome();
      setMonthStatus("リアルタイム同期中");
    },
    (error) => {
      console.error("reservations listener failed", error);
      setMonthStatus(`予約の読み込みに失敗しました: ${error.message}`);
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
    (snapshot) => {
      schedulesByDate = new Map(
        snapshot.docs
          .map((item) => ({ id: item.id, ...item.data() }))
          .filter((item) => item.active !== false)
          .map((item) => [item.date, item]),
      );
      renderHome();
    },
    (error) => {
      console.error("schedules listener failed", error);
      setMonthStatus(`営業予定の読み込みに失敗しました: ${error.message}`);
    },
  );
}

function subscribeTodayReservations() {
  unsubscribeTodayReservations?.();

  unsubscribeTodayReservations = onSnapshot(
    query(
      collection(db, "reservations"),
      where("visit_date", "==", todayKey()),
      where("status", "==", "active"),
      limit(100),
    ),
    (snapshot) => {
      todayReservations = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      renderTodayLists();
    },
    (error) => {
      console.error("today reservations listener failed", error);
      renderError("homeTodayReservationList", error.message);
    },
  );
}

function subscribeTodayBlocks() {
  unsubscribeTodayBlocks?.();

  unsubscribeTodayBlocks = onSnapshot(
    query(
      collection(db, "blocks"),
      where("date", "==", todayKey()),
      where("active", "==", true),
      limit(100),
    ),
    (snapshot) => {
      todayBlocks = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      if (selectedDate === todayKey()) {
        selectedBlocks = todayBlocks;
        renderSelectedDetails();
      }
      renderTodayLists();
    },
    (error) => {
      console.error("today blocks listener failed", error);
      renderError("homeTodayBlockList", error.message);
    },
  );
}

function subscribeSelectedBlocks(date) {
  unsubscribeSelectedBlocks?.();

  if (date === todayKey()) {
    selectedBlocks = todayBlocks;
    renderSelectedDetails();
    unsubscribeSelectedBlocks = null;
    return;
  }

  selectedBlocks = [];
  unsubscribeSelectedBlocks = onSnapshot(
    query(
      collection(db, "blocks"),
      where("date", "==", date),
      where("active", "==", true),
      limit(100),
    ),
    (snapshot) => {
      selectedBlocks = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      renderSelectedDetails();
    },
    (error) => {
      console.error("selected blocks listener failed", error);
      renderError("homeSelectedBlockList", error.message);
    },
  );
}

function renderHome() {
  renderCalendar();
  renderSelectedDetails();
  renderTodayLists();
}

function renderCalendar() {
  const title = document.getElementById("homeMonthTitle");
  const grid = document.getElementById("homeMonthCalendar");
  if (!title || !grid) return;

  title.textContent = `${currentMonth.getFullYear()} 年 ${currentMonth.getMonth() + 1} 月`;
  grid.innerHTML = "";

  WDAYS.forEach((wday) => {
    const node = document.createElement("div");
    node.className = "month-wday";
    node.textContent = wday;
    grid.appendChild(node);
  });

  const first = startOfMonth(currentMonth);
  const last = endOfMonth(currentMonth);
  const start = startOfWeek(first);
  const end = endOfWeek(last);
  const today = todayKey();

  for (let day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) {
    const key = dateKey(day);
    const reservations = reservationsForDate(key);
    const schedule = schedulesByDate.get(key);
    const plannedStore = schedule?.planned_store || "both";
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "month-cell";
    cell.dataset.date = key;
    cell.setAttribute("aria-label", `${key} の詳細を表示`);

    if (day.getMonth() !== currentMonth.getMonth()) cell.classList.add("is-out");
    if (key === today) cell.classList.add("is-today");
    if (key === selectedDate) cell.classList.add("is-selected");

    const dayLine = document.createElement("div");
    dayLine.className = "month-day-line";
    const dayNum = document.createElement("span");
    dayNum.className = "month-daynum";
    dayNum.textContent = String(day.getDate());
    dayLine.appendChild(dayNum);
    dayLine.appendChild(storeBadge(plannedStore));
    cell.appendChild(dayLine);

    if (reservations.length > 0) {
      const count = document.createElement("span");
      count.className = "month-count";
      count.textContent = `${reservations.length}件`;
      cell.appendChild(count);
    }

    reservations.slice(0, 2).forEach((reservation) => {
      const name = document.createElement("span");
      name.className = "month-name";
      name.textContent = reservation.customer_name || "名前未設定";
      cell.appendChild(name);
    });

    if (reservations.length > 2) {
      const more = document.createElement("span");
      more.className = "month-more";
      more.textContent = `+${reservations.length - 2}`;
      cell.appendChild(more);
    }

    cell.addEventListener("click", () => {
      selectedDate = key;
      subscribeSelectedBlocks(selectedDate);
      renderHome();
    });

    grid.appendChild(cell);
  }
}

function renderSelectedDetails() {
  const title = document.getElementById("homeSelectedTitle");
  if (title) {
    title.textContent = selectedDate === todayKey() ? "今日の詳細" : `${selectedDate} の詳細`;
  }

  renderReservationList("homeSelectedReservationList", reservationsForDate(selectedDate));
  renderBlockList("homeSelectedBlockList", selectedBlocks);
}

function renderTodayLists() {
  renderReservationList("homeTodayReservationList", todayReservations);
  renderBlockList("homeTodayBlockList", todayBlocks);
}

function renderReservationList(id, reservations) {
  const list = document.getElementById(id);
  if (!list) return;

  list.innerHTML = "";
  const rows = [...reservations].sort(compareReservationTime);
  if (rows.length === 0) {
    list.appendChild(emptyRow("予約なし"));
    return;
  }

  rows.forEach((reservation) => {
    const row = document.createElement("div");
    row.className = "row-list-item reservation-row";

    const time = document.createElement("span");
    time.className = "row-time";
    time.textContent = reservation.start_time || "--:--";
    row.appendChild(time);

    const main = document.createElement("span");
    main.className = "row-main";
    const name = document.createElement("strong");
    name.textContent = reservation.customer_name || "名前未設定";
    const meta = document.createElement("span");
    meta.className = "row-meta";
    meta.textContent = `${storeLabel(reservation.store_code)} / ${reservation.course_code || "course 未設定"}`;
    main.appendChild(name);
    main.appendChild(meta);
    row.appendChild(main);

    const actions = document.createElement("span");
    actions.className = "row-actions";
    actions.appendChild(reservationActionButton("編集", "edit", reservation));
    actions.appendChild(reservationActionButton("×", "cancel", reservation));
    row.appendChild(actions);

    list.appendChild(row);
  });
}

function renderBlockList(id, blocks) {
  const list = document.getElementById(id);
  if (!list) return;

  list.innerHTML = "";
  const rows = [...blocks].sort((a, b) => `${a.start_time}${a.id || ""}`.localeCompare(`${b.start_time}${b.id || ""}`));
  if (rows.length === 0) {
    list.appendChild(emptyRow("予約不可なし"));
    return;
  }

  rows.forEach((block) => {
    const row = document.createElement("div");
    row.className = "row-list-item block-row";

    const time = document.createElement("span");
    time.className = "row-time";
    time.textContent = `${block.start_time || "--:--"}-${block.end_time || "--:--"}`;
    row.appendChild(time);

    const main = document.createElement("span");
    main.className = "row-main";
    main.textContent = "予約不可";
    row.appendChild(main);

    list.appendChild(row);
  });
}

function reservationActionButton(label, action, reservation) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = label === "×" ? "btn btn-icon-delete" : "btn btn-secondary btn-row";
  button.textContent = label;
  button.dataset.write = "true";
  button.setAttribute("aria-label", action === "cancel" ? "予約をキャンセル" : "予約を編集");
  button.addEventListener("click", async () => {
    if (action === "edit") {
      openReservationModal({ mode: "edit", existing: reservation });
      return;
    }

    const id = reservation.id || reservation.reservation_id;
    if (!id || !confirm(`${reservation.customer_name || "この予約"}をキャンセルしますか？`)) return;
    button.disabled = true;
    try {
      await cancelReservation(id);
    } catch (error) {
      console.error("cancel reservation failed", error);
      alert(error.message || "キャンセルに失敗しました");
      button.disabled = false;
    }
  });
  return button;
}

function storeBadge(store) {
  const badge = document.createElement("span");
  badge.className = "month-badge";
  if (store === "event") badge.classList.add("is-event");
  if (store === "both") badge.classList.add("is-muted");
  badge.textContent = STORE_SHORT[store] || "両";
  badge.title = storeLabel(store);
  return badge;
}

function emptyRow(text) {
  const row = document.createElement("div");
  row.className = "row-empty";
  row.textContent = text;
  return row;
}

function renderError(id, message) {
  const list = document.getElementById(id);
  if (!list) return;
  list.innerHTML = "";
  list.appendChild(emptyRow(`エラー: ${message}`));
}

function setMonthStatus(text) {
  const status = document.getElementById("homeMonthStatus");
  if (status) status.textContent = text;
}

function reservationsForDate(date) {
  return monthReservations
    .filter((reservation) => reservation.visit_date === date && reservation.status === "active")
    .sort(compareReservationTime);
}

function compareReservationTime(a, b) {
  return `${a.start_time || ""}${a.reservation_id || a.id || ""}`.localeCompare(
    `${b.start_time || ""}${b.reservation_id || b.id || ""}`,
  );
}

function storeLabel(store) {
  return STORE_LABELS[store] || store || "店舗未設定";
}

function todayKey() {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseDateKey(value) {
  const [year, month, day] = value.split("-").map((part) => Number(part));
  return new Date(year, month - 1, day);
}

function dateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function startOfWeek(date) {
  const start = new Date(date);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function endOfWeek(date) {
  const end = new Date(date);
  end.setDate(end.getDate() + (6 - end.getDay()));
  return end;
}

function addMonths(date, amount) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function monthQueryRange(month) {
  return {
    start: dateKey(startOfMonth(month)),
    end: dateKey(endOfMonth(addMonths(month, 1))),
  };
}
