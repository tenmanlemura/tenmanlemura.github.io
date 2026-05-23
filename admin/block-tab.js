import {
  collection,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./app.js";
import { commitWrite } from "./write-helpers.js";

const OPEN_MINUTES = 9 * 60;
const CLOSE_MINUTES = 21 * 60;

let initialized = false;
let blocks = [];
let unsubscribe = null;

export function initBlockTab() {
  const root = document.getElementById("panel-block");
  if (!root) return;

  if (!initialized) {
    buildBlockDom(root);
    subscribeBlocks();
    initialized = true;
  }

  renderBlocks();
}

function buildBlockDom(root) {
  root.innerHTML = `
    <div class="panel-heading panel-heading-action">
      <div>
        <p class="section-label">Blocked time</p>
        <h2>予約不可</h2>
      </div>
      <button type="button" class="btn btn-secondary btn-compact" id="blockAddButton" data-write="true">予約不可時間を追加</button>
    </div>
    <div class="tab-status" id="blockStatus" role="status">読み込み中...</div>
    <div class="admin-list" id="blockList"></div>
  `;

  document.getElementById("blockAddButton")?.addEventListener("click", () => {
    openBlockModal();
  });
}

function subscribeBlocks() {
  unsubscribe?.();
  unsubscribe = onSnapshot(
    query(collection(db, "blocks"), orderBy("date")),
    (snapshot) => {
      blocks = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      setStatus("blockStatus", "リアルタイム同期中");
      renderBlocks();
    },
    (error) => {
      console.error("blocks listener failed", error);
      setStatus("blockStatus", `予約不可時間の読み込みに失敗しました: ${error.message}`);
    },
  );
}

function renderBlocks() {
  const list = document.getElementById("blockList");
  if (!list) return;

  const rows = blocks
    .filter((item) => item.active === true)
    .sort((a, b) => `${a.date}${a.start_time}${a.id}`.localeCompare(`${b.date}${b.start_time}${b.id}`));
  list.innerHTML = "";
  if (rows.length === 0) {
    list.appendChild(emptyRow("予約不可時間なし"));
    return;
  }

  rows.forEach((block) => {
    const row = document.createElement("div");
    row.className = "admin-list-row";

    const main = document.createElement("div");
    main.className = "admin-list-main";
    const title = document.createElement("strong");
    title.textContent = block.date;
    const meta = document.createElement("span");
    meta.textContent = `${block.start_time || "--:--"}-${block.end_time || "--:--"}`;
    main.appendChild(title);
    main.appendChild(meta);
    row.appendChild(main);

    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.appendChild(deleteButton(block));
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function openBlockModal() {
  const modal = createModal({ title: "予約不可時間を追加", submitLabel: "追加" });
  const form = document.createElement("form");
  form.className = "modal-form";
  form.noValidate = true;
  form.innerHTML = `
    <div class="form-grid">
      <label class="form-field">
        <span>日付</span>
        <input type="date" name="date" value="${todayKey()}" required>
      </label>
      <label class="form-field">
        <span>開始時刻</span>
        <select name="start_time" required>${timeOptions("09:00", false)}</select>
      </label>
      <label class="form-field">
        <span>終了時刻</span>
        <select name="end_time" required>${timeOptions("10:00", true)}</select>
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
    await submitBlock(form, modal);
  });
  showModal(modal);
}

async function submitBlock(form, modal) {
  const error = form.querySelector("[data-form-error]");
  setError(error, "");
  modal.submitButton.disabled = true;

  try {
    const values = readBlockForm(form);
    const message = validateBlock(values);
    if (message) {
      setError(error, message);
      modal.submitButton.disabled = false;
      return;
    }

    const id = `${values.date}_${values.start_time}_${values.end_time}`;
    const target = `blocks/${id}`;
    await commitWrite({
      op: "addBlock",
      domain: {
        collection: "blocks",
        docId: id,
        action: "set",
        data: {
          date: values.date,
          start_time: values.start_time,
          end_time: values.end_time,
          active: true,
          created_at: serverTimestamp(),
          updated_at: serverTimestamp(),
        },
      },
      inverse: {
        op: "delete",
        target,
      },
      target,
      dispatchSource: "admin_block_add",
    });
    closeModal(modal);
  } catch (err) {
    console.error("block write failed", err);
    setError(error, err.message || "保存に失敗しました");
    modal.submitButton.disabled = false;
  }
}

async function deleteBlock(block) {
  if (!confirm(`${block.date} ${block.start_time}-${block.end_time} を削除しますか？`)) return;

  const target = `blocks/${block.id}`;
  try {
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
  } catch (err) {
    console.error("delete block failed", err);
    alert(err.message || "削除に失敗しました");
  }
}

function deleteButton(block) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-icon-delete";
  button.textContent = "×";
  button.title = "削除";
  button.dataset.write = "true";
  button.addEventListener("click", () => deleteBlock(block));
  return button;
}

function readBlockForm(form) {
  const data = new FormData(form);
  return {
    date: String(data.get("date") || "").trim(),
    start_time: String(data.get("start_time") || ""),
    end_time: String(data.get("end_time") || ""),
  };
}

function validateBlock(values) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) return "日付を入力してください";
  if (!isValidTime(values.start_time) || !isValidTime(values.end_time)) return "時刻の形式が不正です";
  const start = timeToMinutes(values.start_time);
  const end = timeToMinutes(values.end_time);
  if (end <= start) return "終了時刻は開始時刻より後にしてください";
  if (start < OPEN_MINUTES || end > CLOSE_MINUTES) return "営業時間内で指定してください（09:00-21:00）";
  return "";
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

function createModal({ title, submitLabel }) {
  const root = getModalRoot();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="blockModalTitle">
      <div class="modal-head">
        <h2 id="blockModalTitle">${title}</h2>
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
