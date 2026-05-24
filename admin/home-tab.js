import { db } from "./app.js";
import {
  collection,
  getDocs,
  query,
  where,
  onSnapshot,
  orderBy,
  limit,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { cancelReservation, openReservationModal } from "./reservation-modal.js";
import { commitWrite } from "./write-helpers.js";

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
const PLANNED_STORES = [
  ["tanushimaru", "田主丸店"],
  ["dazaifu", "太宰府店"],
  ["event", "イベント"],
  ["both", "両店舗"],
];
const OPEN_MINUTES = 9 * 60;
const CLOSE_MINUTES = 21 * 60;

let initialized = false;
let built = false;
let currentMonth = startOfMonth(parseDateKey(todayKey()));
let selectedDate = todayKey();
let monthReservations = [];
let schedulesByDate = new Map();
let selectedBlocks = [];
let selectedBlocksError = "";
let unsubscribeReservations = null;
let unsubscribeSchedules = null;
let unsubscribeSelectedBlocks = null;

export function initHomeTab() {
  const root = document.getElementById("tab-home");
  if (!root) return;

  if (!built) {
    buildHomeDom(root);
    built = true;
  }

  if (initialized) {
    renderHome();
    return;
  }

  initialized = true;
  setupMonthButtons();
  setupWriteButtons();
  subscribeMonthData();
  subscribeSelectedBlocks(selectedDate);
  renderHome();
}

export function teardownHomeTab() {
  unsubscribeReservations?.();
  unsubscribeSchedules?.();
  unsubscribeSelectedBlocks?.();
  unsubscribeReservations = null;
  unsubscribeSchedules = null;
  unsubscribeSelectedBlocks = null;
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
          <div class="day-editor">
            <section class="day-editor-section" aria-labelledby="homeScheduleHeading">
              <h4 id="homeScheduleHeading">営業予定</h4>
              <form class="modal-form" id="homeScheduleForm" noValidate>
                <div class="form-grid">
                  <div class="form-field">
                    <span>日付</span>
                    <strong id="homeScheduleDate">--</strong>
                  </div>
                  <fieldset class="form-fieldset form-field-wide">
                    <legend>営業予定</legend>
                    <div class="radio-row">${radioOptions("planned_store", PLANNED_STORES, "both")}</div>
                  </fieldset>
                  <label class="form-field">
                    <span>イベント名</span>
                    <input type="text" name="event_name">
                  </label>
                  <label class="form-field">
                    <span>会場</span>
                    <input type="text" name="event_venue">
                  </label>
                  <label class="form-field form-field-wide">
                    <span>メモ</span>
                    <textarea name="note" rows="3"></textarea>
                  </label>
                </div>
                <p class="form-error" data-schedule-error hidden></p>
                <div class="day-editor-actions">
                  <button type="submit" class="btn btn-compact" data-write="true">営業予定を保存</button>
                  <button type="button" class="btn btn-secondary btn-compact" id="homeDeleteSchedule" data-write="true">削除</button>
                </div>
              </form>
            </section>
            <section class="day-editor-section" aria-labelledby="homeBlockHeading">
              <div class="section-subhead-action">
                <h4 id="homeBlockHeading">予約不可</h4>
                <button type="button" class="btn btn-secondary btn-compact" id="homeAddBlock" data-write="true">予約不可を追加</button>
              </div>
              <p class="tab-status" id="homeBlockStatus" role="status">選択日の予約不可を同期中</p>
            </section>
          </div>
          <div>
            <h4>予約 / 予約不可</h4>
            <div class="row-list" id="homeSelectedList"></div>
          </div>
        </div>
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

  document.getElementById("homeAddBlock")?.addEventListener("click", () => {
    openBlockModal();
  });

  document.getElementById("homeScheduleForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitSelectedSchedule(event.currentTarget);
  });

  document.getElementById("homeDeleteSchedule")?.addEventListener("click", () => {
    deleteSelectedSchedule();
  });

  document.getElementById("homeScheduleForm")?.addEventListener("change", (event) => {
    if (event.target?.name === "planned_store") syncScheduleEventFields();
  });
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
    (snapshot) => {
      selectedBlocks = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      selectedBlocksError = "";
      renderSelectedDetails();
    },
    (error) => {
      console.error("selected blocks listener failed", error);
      selectedBlocksError = error.message;
      renderSelectedDetails();
    },
  );
}

function renderHome() {
  renderCalendar();
  renderSelectedDetails();
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
    const badgeStore = resolveDayBadgeStore(schedule, reservations);
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
    if (badgeStore) dayLine.appendChild(storeBadge(badgeStore));
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

  renderSelectedSchedule();
  renderBlockStatus();
  renderSelectedList("homeSelectedList", reservationsForDate(selectedDate), selectedBlocks);
}

function renderSelectedSchedule() {
  const form = document.getElementById("homeScheduleForm");
  if (!form) return;

  const schedule = schedulesByDate.get(selectedDate);
  const dateNode = document.getElementById("homeScheduleDate");
  if (dateNode) dateNode.textContent = selectedDate;

  const planned = schedule?.planned_store || "both";
  form.querySelectorAll('input[name="planned_store"]').forEach((input) => {
    input.checked = input.value === planned;
  });
  form.elements.event_name.value = schedule?.event_name || "";
  form.elements.event_venue.value = schedule?.event_venue || "";
  form.elements.note.value = schedule?.note || "";

  const deleteButton = document.getElementById("homeDeleteSchedule");
  if (deleteButton) deleteButton.disabled = !schedule?.id;
  setError(form.querySelector("[data-schedule-error]"), "");
  syncScheduleEventFields();
}

function syncScheduleEventFields() {
  const form = document.getElementById("homeScheduleForm");
  if (!form) return;

  const isEvent = String(new FormData(form).get("planned_store") || "") === "event";
  form.elements.event_name.disabled = !isEvent;
  form.elements.event_venue.disabled = !isEvent;
}

function renderBlockStatus() {
  const status = document.getElementById("homeBlockStatus");
  if (!status) return;

  if (selectedBlocksError) {
    status.textContent = `予約不可の読み込みに失敗しました: ${selectedBlocksError}`;
    return;
  }

  status.textContent = selectedBlocks.length > 0 ? `${selectedBlocks.length} 件の予約不可` : "予約不可なし";
}

function renderSelectedList(id, reservations, blocks) {
  const list = document.getElementById(id);
  if (!list) return;

  list.innerHTML = "";
  const rows = selectedDetailItems(reservations, blocks);
  if (rows.length === 0 && !selectedBlocksError) {
    list.appendChild(emptyRow("予定なし"));
    return;
  }

  rows.forEach((item) => {
    list.appendChild(item.type === "reservation" ? reservationRow(item.value) : blockRow(item.value));
  });

  if (selectedBlocksError) {
    list.appendChild(emptyRow(`予約不可の読み込みに失敗しました: ${selectedBlocksError}`));
  }
}

function selectedDetailItems(reservations, blocks) {
  return [
    ...reservations.map((reservation) => ({
      type: "reservation",
      startTime: reservation.start_time || "",
      endTime: reservation.end_time || "",
      id: reservation.reservation_id || reservation.id || "",
      value: reservation,
    })),
    ...blocks.map((block) => ({
      type: "block",
      startTime: block.start_time || "",
      endTime: block.end_time || "",
      id: block.id || "",
      value: block,
    })),
  ].sort(compareSelectedDetailItem);
}

function compareSelectedDetailItem(a, b) {
  return detailItemSortKey(a).localeCompare(detailItemSortKey(b));
}

function detailItemSortKey(item) {
  const typeRank = item.type === "reservation" ? "0" : "1";
  return `${item.startTime || "99:99"}${item.endTime || "99:99"}${typeRank}${item.id}`;
}

function reservationRow(reservation) {
  const row = document.createElement("div");
  row.className = "row-list-item detail-row reservation-row";

  row.appendChild(timeNode(reservation.start_time || "--:--"));
  row.appendChild(kindBadge("予約", "reservation"));

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

  return row;
}

function blockRow(block) {
  const row = document.createElement("div");
  row.className = "row-list-item detail-row block-row";

  row.appendChild(timeNode(`${block.start_time || "--:--"}-${block.end_time || "--:--"}`));
  row.appendChild(kindBadge("不可", "block"));

  const main = document.createElement("span");
  main.className = "row-main";
  const title = document.createElement("strong");
  title.textContent = "予約不可";
  const meta = document.createElement("span");
  meta.className = "row-meta";
  meta.textContent = "この時間帯は受付停止";
  main.appendChild(title);
  main.appendChild(meta);
  row.appendChild(main);

  const actions = document.createElement("span");
  actions.className = "row-actions";
  actions.appendChild(blockEditButton(block));
  actions.appendChild(blockDeleteButton(block));
  row.appendChild(actions);

  return row;
}

function timeNode(text) {
  const time = document.createElement("span");
  time.className = "row-time";
  time.textContent = text;
  return time;
}

function kindBadge(label, type) {
  const badge = document.createElement("span");
  badge.className = `row-kind is-${type}`;
  badge.textContent = label;
  return badge;
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

function blockDeleteButton(block) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-icon-delete";
  button.textContent = "×";
  button.title = "削除";
  button.dataset.write = "true";
  button.addEventListener("click", async () => {
    if (!block.id) {
      alert("削除対象のIDが見つかりません");
      return;
    }
    if (!confirm(`${block.date} ${block.start_time}-${block.end_time} を削除しますか？`)) return;

    button.disabled = true;
    try {
      const target = `blocks/${block.id}`;
      await commitWrite({
        op: "deleteBlock",
        domain: {
          collection: "blocks",
          docId: block.id,
          action: "delete",
        },
        inverse: {
          op: "create",
          target,
          data: stripId(block),
        },
        target,
        dispatchSource: "admin_block_delete",
      });
    } catch (error) {
      console.error("delete block failed", error);
      alert(error.message || "削除に失敗しました");
      button.disabled = false;
    }
  });
  return button;
}

function blockEditButton(block) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-secondary btn-row";
  button.textContent = "編集";
  button.dataset.write = "true";
  button.addEventListener("click", () => openBlockModal(block));
  return button;
}

async function submitSelectedSchedule(form) {
  const error = form.querySelector("[data-schedule-error]");
  setError(error, "");
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton) submitButton.disabled = true;

  try {
    const values = readScheduleForm(form);
    const message = validateSchedule(values);
    if (message) {
      setError(error, message);
      if (submitButton) submitButton.disabled = false;
      return;
    }

    const existing = schedulesByDate.get(selectedDate);
    const target = `schedules/${selectedDate}`;
    await commitWrite({
      op: "setSchedule",
      domain: {
        collection: "schedules",
        docId: selectedDate,
        action: "set",
        data: {
          date: selectedDate,
          planned_store: values.planned_store,
          event_name: values.planned_store === "event" ? values.event_name : "",
          event_venue: values.planned_store === "event" ? values.event_venue : "",
          note: values.note,
          active: true,
          created_at: existing?.created_at || serverTimestamp(),
          updated_at: serverTimestamp(),
        },
      },
      inverse: existing
        ? { op: "update", target, data: stripId(existing) }
        : { op: "delete", target },
      target,
      dispatchSource: "admin_schedule_set",
    });
  } catch (errorObject) {
    console.error("schedule write failed", errorObject);
    setError(error, errorObject.message || "保存に失敗しました");
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

async function deleteSelectedSchedule() {
  const schedule = schedulesByDate.get(selectedDate);
  if (!schedule?.id) return;
  if (!confirm(`${selectedDate} の営業予定を削除しますか？`)) return;

  const target = `schedules/${schedule.id}`;
  try {
    await commitWrite({
      op: "deleteSchedule",
      domain: {
        collection: "schedules",
        docId: schedule.id,
        action: "delete",
      },
      inverse: {
        op: "create",
        target,
        data: stripId(schedule),
      },
      target,
      dispatchSource: "admin_schedule_delete",
    });
  } catch (error) {
    console.error("delete schedule failed", error);
    alert(error.message || "削除に失敗しました");
  }
}

function readScheduleForm(form) {
  const data = new FormData(form);
  return {
    planned_store: String(data.get("planned_store") || ""),
    event_name: String(data.get("event_name") || "").trim(),
    event_venue: String(data.get("event_venue") || "").trim(),
    note: String(data.get("note") || "").trim(),
  };
}

function validateSchedule(values) {
  if (!PLANNED_STORES.some(([value]) => value === values.planned_store)) return "営業予定を選択してください";
  if (values.planned_store === "event" && !values.event_name) return "イベント名を入力してください";
  return "";
}

function openBlockModal(existing = null) {
  const isEdit = Boolean(existing);
  const modal = createModal({
    title: isEdit ? "予約不可を編集" : "予約不可を追加",
    submitLabel: isEdit ? "保存" : "追加",
    titleId: "homeBlockModalTitle",
  });
  const initial = {
    start_time: existing?.start_time || "09:00",
    end_time: existing?.end_time || "10:00",
  };
  const form = document.createElement("form");
  form.className = "modal-form";
  form.noValidate = true;
  form.innerHTML = `
    <div class="form-grid">
      <div class="form-field">
        <span>日付</span>
        <strong>${escapeText(selectedDate)}</strong>
      </div>
      <label class="form-field">
        <span>開始時刻</span>
        <select name="start_time" required>${timeOptions(initial.start_time, false)}</select>
      </label>
      <label class="form-field">
        <span>終了時刻</span>
        <select name="end_time" required>${timeOptions(initial.end_time, true)}</select>
      </label>
      <div class="preset-row form-field-wide">
        <button type="button" class="btn btn-secondary btn-row" data-preset="morning">午前休</button>
        <button type="button" class="btn btn-secondary btn-row" data-preset="afternoon">午後休</button>
        <button type="button" class="btn btn-secondary btn-row" data-preset="all">終日</button>
      </div>
    </div>
    <p class="form-error" data-form-error hidden></p>
  `;

  modal.body.appendChild(form);
  modal.submitButton.addEventListener("click", () => form.requestSubmit());
  form.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => applyPreset(form, button.dataset.preset));
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitBlockForm({ form, modal, existing });
  });
  showModal(modal);
}

async function submitBlockForm({ form, modal, existing }) {
  const error = form.querySelector("[data-form-error]");
  setError(error, "");
  modal.submitButton.disabled = true;

  try {
    const values = readBlockForm(form);
    const message = await validateBlock(values, existing?.id);
    if (message) {
      setError(error, message);
      modal.submitButton.disabled = false;
      return;
    }

    const id = existing?.id || `${values.date}_${values.start_time}_${values.end_time}`;
    const target = `blocks/${id}`;
    await commitWrite({
      op: existing ? "updateBlock" : "addBlock",
      domain: {
        collection: "blocks",
        docId: id,
        action: existing ? "update" : "set",
        data: {
          date: values.date,
          start_time: values.start_time,
          end_time: values.end_time,
          active: true,
          created_at: existing?.created_at || serverTimestamp(),
          updated_at: serverTimestamp(),
        },
      },
      inverse: existing
        ? { op: "update", target, data: stripId(existing) }
        : { op: "delete", target },
      target,
      dispatchSource: existing ? "admin_block_update" : "admin_block_add",
    });
    closeModal(modal);
  } catch (errorObject) {
    console.error("block write failed", errorObject);
    setError(error, errorObject.message || "保存に失敗しました");
    modal.submitButton.disabled = false;
  }
}

function readBlockForm(form) {
  const data = new FormData(form);
  return {
    date: selectedDate,
    start_time: String(data.get("start_time") || ""),
    end_time: String(data.get("end_time") || ""),
  };
}

async function validateBlock(values, currentBlockId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) return "日付を選択してください";
  if (!isValidTime(values.start_time) || !isValidTime(values.end_time)) return "時刻の形式が不正です";
  const start = timeToMinutes(values.start_time);
  const end = timeToMinutes(values.end_time);
  if (end <= start) return "終了時刻は開始時刻より後にしてください";
  if (start < OPEN_MINUTES || end > CLOSE_MINUTES) return "営業時間内で指定してください（09:00-21:00）";

  const blockCollision = selectedBlocks.find((block) => {
    if (block.id === currentBlockId) return false;
    return timeRangesOverlap(values.start_time, values.end_time, block.start_time, block.end_time);
  });
  if (blockCollision) return `${blockCollision.start_time}-${blockCollision.end_time} の予約不可と重複しています`;

  const reservationCollision = await findBlockReservationCollision(values);
  if (reservationCollision) {
    return `${reservationCollision.start_time}-${reservationCollision.end_time} の予約と重複しています`;
  }

  return "";
}

async function findBlockReservationCollision(values) {
  const snapshot = await getDocs(
    query(
      collection(db, "reservations"),
      where("visit_date", "==", values.date),
      where("status", "==", "active"),
    ),
  );

  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .find((item) => timeRangesOverlap(values.start_time, values.end_time, item.start_time, item.end_time));
}

function resolveDayBadgeStore(schedule, reservations) {
  const planned = schedule?.planned_store;
  if (planned === "tanushimaru" || planned === "dazaifu" || planned === "event") {
    return planned;
  }
  const codes = new Set();
  for (const r of reservations || []) {
    if (r.store_code === "tanushimaru" || r.store_code === "dazaifu" || r.store_code === "event") {
      codes.add(r.store_code);
    }
  }
  if (codes.size === 1) return [...codes][0];
  return null;
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

function stripId(value) {
  const { id, ...data } = value;
  return data;
}

function createModal({ title, submitLabel, titleId }) {
  const root = getModalRoot();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <div class="modal-head">
        <h2 id="${titleId}">${escapeText(title)}</h2>
        <button type="button" class="modal-close" aria-label="閉じる">×</button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-modal-cancel>キャンセル</button>
        <button type="button" class="btn" data-modal-submit data-write="true">${escapeText(submitLabel)}</button>
      </div>
    </div>
  `;

  const modal = {
    overlay,
    body: overlay.querySelector(".modal-body"),
    submitButton: overlay.querySelector("[data-modal-submit]"),
  };
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeModal(modal);
  });
  overlay.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal(modal));
  overlay.querySelector(".modal-close")?.addEventListener("click", () => closeModal(modal));
  modal.onKeydown = (event) => {
    if (event.key === "Escape") closeModal(modal);
  };
  root.appendChild(overlay);
  return modal;
}

function showModal(modal) {
  document.addEventListener("keydown", modal.onKeydown);
  modal.overlay.querySelector("input, select, textarea, button")?.focus();
}

function closeModal(modal) {
  document.removeEventListener("keydown", modal.onKeydown);
  modal.overlay.remove();
}

function getModalRoot() {
  let root = document.getElementById("modalRoot");
  if (!root) {
    root = document.createElement("div");
    root.id = "modalRoot";
    document.body.appendChild(root);
  }
  return root;
}

function radioOptions(name, options, selected) {
  return options
    .map(
      ([value, label]) => `
        <label class="radio-pill">
          <input type="radio" name="${name}" value="${value}"${value === selected ? " checked" : ""}>
          <span>${label}</span>
        </label>
      `,
    )
    .join("");
}

function applyPreset(form, preset) {
  const start = form.elements.start_time;
  const end = form.elements.end_time;
  if (!start || !end) return;

  if (preset === "morning") {
    start.value = "09:00";
    end.value = "12:00";
  } else if (preset === "afternoon") {
    start.value = "12:00";
    end.value = "21:00";
  } else if (preset === "all") {
    start.value = "09:00";
    end.value = "21:00";
  }
}

function timeOptions(selected, includeEnd) {
  let html = "";
  const start = includeEnd ? OPEN_MINUTES + 30 : OPEN_MINUTES;
  for (let value = start; value <= CLOSE_MINUTES; value += 30) {
    const time = minutesToTime(value);
    html += `<option value="${time}"${time === selected ? " selected" : ""}>${time}</option>`;
  }
  return html;
}

function setError(node, message) {
  if (!node) return;
  node.textContent = message;
  node.hidden = !message;
}

function timeRangesOverlap(startA, endA, startB, endB) {
  return timeToMinutes(startA) < timeToMinutes(endB) && timeToMinutes(endA) > timeToMinutes(startB);
}

function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function timeToMinutes(value) {
  if (!isValidTime(value)) return 0;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function minutesToTime(value) {
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function escapeText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
