import {
  collection,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./app.js";
import { commitWrite } from "./write-helpers.js";

const PLANNED_STORES = [
  ["tanushimaru", "田主丸店"],
  ["dazaifu", "太宰府店"],
  ["event", "イベント"],
  ["both", "両店舗"],
];

let initialized = false;
let schedules = [];
let unsubscribe = null;

export function initScheduleTab() {
  const root = document.getElementById("panel-schedule");
  if (!root) return;

  if (!initialized) {
    buildScheduleDom(root);
    subscribeSchedules();
    initialized = true;
  }

  renderSchedules();
}

function buildScheduleDom(root) {
  root.innerHTML = `
    <div class="panel-heading panel-heading-action">
      <div>
        <p class="section-label">Schedule</p>
        <h2>営業予定</h2>
      </div>
      <button type="button" class="btn btn-secondary btn-compact" id="scheduleAddButton" data-write="true">営業予定を追加</button>
    </div>
    <div class="tab-status" id="scheduleStatus" role="status">読み込み中...</div>
    <div class="admin-list" id="scheduleList"></div>
  `;

  document.getElementById("scheduleAddButton")?.addEventListener("click", () => {
    openScheduleModal();
  });
}

function subscribeSchedules() {
  unsubscribe?.();
  unsubscribe = onSnapshot(
    query(collection(db, "schedules"), orderBy("date")),
    (snapshot) => {
      schedules = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      setStatus("scheduleStatus", "リアルタイム同期中");
      renderSchedules();
    },
    (error) => {
      console.error("schedules listener failed", error);
      setStatus("scheduleStatus", `営業予定の読み込みに失敗しました: ${error.message}`);
    },
  );
}

function renderSchedules() {
  const list = document.getElementById("scheduleList");
  if (!list) return;

  const rows = schedules.filter((item) => item.active === true).sort((a, b) => a.date.localeCompare(b.date));
  list.innerHTML = "";
  if (rows.length === 0) {
    list.appendChild(emptyRow("営業予定なし"));
    return;
  }

  rows.forEach((schedule) => {
    const row = document.createElement("div");
    row.className = "admin-list-row";

    const main = document.createElement("div");
    main.className = "admin-list-main";
    const title = document.createElement("strong");
    title.textContent = schedule.date;
    const meta = document.createElement("span");
    meta.textContent = scheduleMeta(schedule);
    main.appendChild(title);
    main.appendChild(meta);
    row.appendChild(main);

    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.appendChild(actionButton("編集", () => openScheduleModal(schedule)));
    actions.appendChild(actionButton("削除", () => deleteSchedule(schedule), "danger"));
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function openScheduleModal(existing = null) {
  const modal = createModal({
    title: existing ? "営業予定を編集" : "営業予定を追加",
    submitLabel: "保存",
  });
  const initial = {
    date: existing?.date || todayKey(),
    planned_store: existing?.planned_store || "both",
    event_name: existing?.event_name || "",
    event_venue: existing?.event_venue || "",
    note: existing?.note || "",
  };
  const form = document.createElement("form");
  form.className = "modal-form";
  form.noValidate = true;
  form.innerHTML = `
    <div class="form-grid">
      <label class="form-field">
        <span>日付</span>
        <input type="date" name="date" value="${escapeAttr(initial.date)}" required>
      </label>
      <fieldset class="form-fieldset form-field-wide">
        <legend>営業予定</legend>
        <div class="radio-row">${radioOptions("planned_store", PLANNED_STORES, initial.planned_store)}</div>
      </fieldset>
      <label class="form-field">
        <span>イベント名</span>
        <input type="text" name="event_name" value="${escapeAttr(initial.event_name)}">
      </label>
      <label class="form-field">
        <span>会場</span>
        <input type="text" name="event_venue" value="${escapeAttr(initial.event_venue)}">
      </label>
      <label class="form-field form-field-wide">
        <span>メモ</span>
        <textarea name="note" rows="3">${escapeText(initial.note)}</textarea>
      </label>
    </div>
    <p class="form-error" data-form-error hidden></p>
  `;

  modal.body.appendChild(form);
  modal.submitButton.addEventListener("click", () => form.requestSubmit());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitSchedule(form, modal);
  });
  showModal(modal);
}

async function submitSchedule(form, modal) {
  const error = form.querySelector("[data-form-error]");
  setError(error, "");
  modal.submitButton.disabled = true;

  try {
    const values = readScheduleForm(form);
    const message = validateSchedule(values);
    if (message) {
      setError(error, message);
      modal.submitButton.disabled = false;
      return;
    }

    const existing = schedules.find((item) => item.id === values.date);
    const target = `schedules/${values.date}`;
    await commitWrite({
      op: "setSchedule",
      domain: {
        collection: "schedules",
        docId: values.date,
        action: "set",
        data: {
          date: values.date,
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
    closeModal(modal);
  } catch (err) {
    console.error("schedule write failed", err);
    setError(error, err.message || "保存に失敗しました");
    modal.submitButton.disabled = false;
  }
}

async function deleteSchedule(schedule) {
  if (!confirm(`${schedule.date} の営業予定を削除しますか？`)) return;

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
  } catch (err) {
    console.error("delete schedule failed", err);
    alert(err.message || "削除に失敗しました");
  }
}

function readScheduleForm(form) {
  const data = new FormData(form);
  return {
    date: String(data.get("date") || "").trim(),
    planned_store: String(data.get("planned_store") || ""),
    event_name: String(data.get("event_name") || "").trim(),
    event_venue: String(data.get("event_venue") || "").trim(),
    note: String(data.get("note") || "").trim(),
  };
}

function validateSchedule(values) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) return "日付を入力してください";
  if (!PLANNED_STORES.some(([value]) => value === values.planned_store)) return "営業予定を選択してください";
  if (values.planned_store === "event" && !values.event_name) return "イベント名を入力してください";
  return "";
}

function scheduleMeta(schedule) {
  const label = PLANNED_STORES.find(([value]) => value === schedule.planned_store)?.[1] || schedule.planned_store;
  const event = schedule.event_name ? ` / ${schedule.event_name}` : "";
  const venue = schedule.event_venue ? ` @ ${schedule.event_venue}` : "";
  const note = schedule.note ? ` / ${schedule.note}` : "";
  return `${label}${event}${venue}${note}`;
}

function actionButton(label, onClick, variant = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = variant === "danger" ? "btn btn-icon-delete" : "btn btn-secondary btn-row";
  button.textContent = variant === "danger" ? "×" : label;
  button.title = label;
  button.dataset.write = "true";
  button.addEventListener("click", onClick);
  return button;
}

function createModal({ title, submitLabel }) {
  const root = getModalRoot();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="scheduleModalTitle">
      <div class="modal-head">
        <h2 id="scheduleModalTitle">${title}</h2>
        <button type="button" class="modal-close" aria-label="閉じる">×</button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-modal-cancel>キャンセル</button>
        <button type="button" class="btn" data-modal-submit data-write="true">${submitLabel}</button>
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

function setStatus(id, text) {
  const status = document.getElementById(id);
  if (status) status.textContent = text;
}

function setError(node, message) {
  if (!node) return;
  node.textContent = message;
  node.hidden = !message;
}

function emptyRow(text) {
  const row = document.createElement("div");
  row.className = "row-empty";
  row.textContent = text;
  return row;
}

function stripId(value) {
  const { id, ...data } = value;
  return data;
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

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}

function escapeText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
