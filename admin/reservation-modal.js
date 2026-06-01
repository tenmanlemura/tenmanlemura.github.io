import {
  collection,
  getDocs,
  query,
  serverTimestamp,
  where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./app.js";
import { commitWrite } from "./write-helpers.js";
import { isDegraded } from "./degraded.js";

const STORE_OPTIONS = [
  ["tanushimaru", "田主丸店"],
  ["dazaifu", "太宰府店"],
];
const COURSE_OPTIONS = [
  ["40", "40分"],
  ["60", "60分"],
];
const OPEN_MINUTES = 9 * 60;
const CLOSE_MINUTES = 21 * 60;
const EMPTY_ERROR_MESSAGE = "";

/**
 * mountReservationForm — schedule modal 内インライン版。
 * popup overlay を作らず、container（DOM 要素）に form を mount する。
 * submit ボタンは caller 側（schedule modal の sub-footer）が持ち、
 * 戻り値 submit() を呼ぶ。submit() は { ok: boolean, ...} を返す。
 */
export function mountReservationForm({ container, existing = null, presetDate = null } = {}) {
  const initial = normalizeExisting(existing, presetDate);
  const form = document.createElement("form");
  form.className = "modal-form";
  form.noValidate = true;
  form.innerHTML = `
    <div class="form-grid">
      <label class="form-field">
        <span>日付<em class="form-required" aria-hidden="true">必須</em></span>
        <input type="date" name="visit_date" value="${escapeAttr(initial.visit_date)}" required aria-required="true">
      </label>
      <label class="form-field">
        <span>開始時刻<em class="form-required" aria-hidden="true">必須</em></span>
        <select name="start_time" required aria-required="true">${timeOptions(initial.start_time, false)}</select>
      </label>
      <fieldset class="form-fieldset">
        <legend>コース<em class="form-required" aria-hidden="true">必須</em></legend>
        <div class="radio-row">${radioOptions("course_code", COURSE_OPTIONS, initial.course_code)}</div>
      </fieldset>
      <label class="form-field">
        <span>終了時刻<em class="form-hint" aria-hidden="true">自動</em></span>
        <input type="text" name="end_time" value="${escapeAttr(initial.end_time)}" readonly>
      </label>
      <fieldset class="form-fieldset">
        <legend>店舗<em class="form-required" aria-hidden="true">必須</em></legend>
        <div class="radio-row">${radioOptions("store_code", STORE_OPTIONS, initial.store_code)}</div>
        <p class="form-note" data-store-lock-note hidden></p>
      </fieldset>
      <label class="form-field">
        <span>お名前<em class="form-required" aria-hidden="true">必須</em></span>
        <input type="text" name="customer_name" value="${escapeAttr(initial.customer_name)}" required aria-required="true">
      </label>
      <label class="form-field">
        <span>電話番号<em class="form-hint" aria-hidden="true">任意</em></span>
        <input type="tel" name="customer_phone" value="${escapeAttr(initial.customer_phone)}">
      </label>
      <label class="form-field form-field-wide">
        <span>メモ<em class="form-hint" aria-hidden="true">任意</em></span>
        <textarea name="note" rows="3">${escapeText(initial.note)}</textarea>
      </label>
    </div>
    <p class="form-error" data-form-error hidden></p>
  `;
  container.appendChild(form);
  form.addEventListener("input", () => updateEndTime(form));
  form.addEventListener("change", () => updateEndTime(form));
  setupStoreAvailability(form, existing);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submit();
  });

  updateEndTime(form);
  refreshStoreAvailability(form);

  let busy = false;
  async function submit() {
    if (busy) return { ok: false };
    busy = true;
    const error = form.querySelector("[data-form-error]");
    setError(error, EMPTY_ERROR_MESSAGE);
    try {
      const values = readReservationForm(form);
      const message = await validateReservation(values, existing?.id || existing?.reservation_id);
      if (message) {
        setError(error, message);
        busy = false;
        return { ok: false };
      }
      const id = existing?.id || existing?.reservation_id || `rsv_${randomHex(12)}`;
      const target = `reservations/${id}`;
      if (existing) {
        await commitWrite({
          op: "updateReservation",
          domain: {
            collection: "reservations",
            docId: id,
            action: "update",
            data: {
              visit_date: values.visit_date,
              start_time: values.start_time,
              end_time: values.end_time,
              store_code: values.store_code,
              course_code: values.course_code,
              customer_name: values.customer_name,
              customer_phone: values.customer_phone,
              note: values.note,
              updated_at: serverTimestamp(),
            },
          },
          inverse: { op: "update", target, data: stripId(existing) },
          target,
          dispatchSource: "admin_reservation_update",
        });
      } else {
        await commitWrite({
          op: "createReservation",
          domain: {
            collection: "reservations",
            docId: id,
            action: "set",
            data: {
              reservation_id: id,
              created_at: serverTimestamp(),
              updated_at: serverTimestamp(),
              status: "active",
              visit_date: values.visit_date,
              start_time: values.start_time,
              end_time: values.end_time,
              store_code: values.store_code,
              course_code: values.course_code,
              customer_name: values.customer_name,
              customer_phone: values.customer_phone,
              customer_line_user_id: "",
              customer_line_display_name: "",
              source: "manual",
              cancel_token_hash: "",
              note: values.note,
            },
          },
          inverse: { op: "delete", target },
          target,
          dispatchSource: "admin_reservation_create",
        });
      }
      busy = false;
      return { ok: true };
    } catch (err) {
      console.error("reservation write failed", err);
      setError(error, userFacingErrorMessage(err, "保存に失敗しました"));
      busy = false;
      return { ok: false };
    }
  }

  return { form, submit, dispose: () => form.remove() };
}

export function openReservationModal({ mode, presetDate, existing } = {}) {
  const isEdit = mode === "edit";
  const initial = normalizeExisting(existing, presetDate);
  const modal = createModal({
    title: isEdit ? "予約を編集" : "予約を追加",
    submitLabel: isEdit ? "保存" : "追加",
  });
  const form = document.createElement("form");
  form.className = "modal-form";
  form.noValidate = true;
  form.innerHTML = `
    <div class="form-grid">
      <label class="form-field">
        <span>日付<em class="form-required" aria-hidden="true">必須</em></span>
        <input type="date" name="visit_date" value="${escapeAttr(initial.visit_date)}" required aria-required="true">
      </label>
      <label class="form-field">
        <span>開始時刻<em class="form-required" aria-hidden="true">必須</em></span>
        <select name="start_time" required aria-required="true">${timeOptions(initial.start_time, false)}</select>
      </label>
      <fieldset class="form-fieldset">
        <legend>コース<em class="form-required" aria-hidden="true">必須</em></legend>
        <div class="radio-row">${radioOptions("course_code", COURSE_OPTIONS, initial.course_code)}</div>
      </fieldset>
      <label class="form-field">
        <span>終了時刻<em class="form-hint" aria-hidden="true">自動</em></span>
        <input type="text" name="end_time" value="${escapeAttr(initial.end_time)}" readonly>
      </label>
      <fieldset class="form-fieldset">
        <legend>店舗<em class="form-required" aria-hidden="true">必須</em></legend>
        <div class="radio-row">${radioOptions("store_code", STORE_OPTIONS, initial.store_code)}</div>
        <p class="form-note" data-store-lock-note hidden></p>
      </fieldset>
      <label class="form-field">
        <span>お名前<em class="form-required" aria-hidden="true">必須</em></span>
        <input type="text" name="customer_name" value="${escapeAttr(initial.customer_name)}" required aria-required="true">
      </label>
      <label class="form-field">
        <span>電話番号<em class="form-hint" aria-hidden="true">任意</em></span>
        <input type="tel" name="customer_phone" value="${escapeAttr(initial.customer_phone)}">
      </label>
      <label class="form-field form-field-wide">
        <span>メモ<em class="form-hint" aria-hidden="true">任意</em></span>
        <textarea name="note" rows="3">${escapeText(initial.note)}</textarea>
      </label>
    </div>
    <p class="form-error" data-form-error hidden></p>
  `;

  modal.body.appendChild(form);
  modal.submitButton.addEventListener("click", () => form.requestSubmit());
  form.addEventListener("input", () => updateEndTime(form));
  form.addEventListener("change", () => updateEndTime(form));
  setupStoreAvailability(form, isEdit ? existing : null);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitReservationForm({ form, modal, existing: isEdit ? existing : null });
  });

  updateEndTime(form);
  showModal(modal);
  refreshStoreAvailability(form);
}

export async function cancelReservation(id) {
  if (!id) throw new Error("予約 ID が見つかりません");

  return commitWrite({
    op: "cancelReservation",
    domain: {
      collection: "reservations",
      docId: id,
      action: "update",
      data: {
        status: "cancelled",
        updated_at: serverTimestamp(),
      },
    },
    // M-B5: inverse_operation.precondition を明示（spec §3.8 準拠）。
    // 明示しない場合は undo.js::inferPrecondition で同じ type が推論されるが、
    // 仕様意図を code 上で明確にすることで将来 inferPrecondition の挙動が変わっても
    // cancelReservation の undo semantics は維持される。
    inverse: {
      op: "update",
      target: `reservations/${id}`,
      data: { status: "active" },
      precondition: { type: "source_revision_match" },
    },
    target: `reservations/${id}`,
    dispatchSource: "admin_reservation_cancel",
  });
}

async function submitReservationForm({ form, modal, existing }) {
  const error = form.querySelector("[data-form-error]");
  setError(error, EMPTY_ERROR_MESSAGE);
  modal.submitButton.disabled = true;

  try {
    const values = readReservationForm(form);
    const message = await validateReservation(values, existing?.id || existing?.reservation_id);
    if (message) {
      setError(error, message);
      modal.submitButton.disabled = false;
      return;
    }

    const id = existing?.id || existing?.reservation_id || `rsv_${randomHex(12)}`;
    const target = `reservations/${id}`;
    if (existing) {
      await commitWrite({
        op: "updateReservation",
        domain: {
          collection: "reservations",
          docId: id,
          action: "update",
          data: {
            visit_date: values.visit_date,
            start_time: values.start_time,
            end_time: values.end_time,
            store_code: values.store_code,
            course_code: values.course_code,
            customer_name: values.customer_name,
            customer_phone: values.customer_phone,
            note: values.note,
            updated_at: serverTimestamp(),
          },
        },
        inverse: {
          op: "update",
          target,
          data: stripId(existing),
        },
        target,
        dispatchSource: "admin_reservation_update",
      });
    } else {
      await commitWrite({
        op: "createReservation",
        domain: {
          collection: "reservations",
          docId: id,
          action: "set",
          data: {
            reservation_id: id,
            created_at: serverTimestamp(),
            updated_at: serverTimestamp(),
            status: "active",
            visit_date: values.visit_date,
            start_time: values.start_time,
            end_time: values.end_time,
            store_code: values.store_code,
            course_code: values.course_code,
            customer_name: values.customer_name,
            customer_phone: values.customer_phone,
            customer_line_user_id: "",
            customer_line_display_name: "",
            source: "manual",
            cancel_token_hash: "",
            note: values.note,
          },
        },
        inverse: {
          op: "delete",
          target,
        },
        target,
        dispatchSource: "admin_reservation_create",
      });
    }

    closeModal(modal);
  } catch (err) {
    console.error("reservation write failed", err);
    setError(error, userFacingErrorMessage(err, "保存に失敗しました"));
    modal.submitButton.disabled = false;
  }
}

function readReservationForm(form) {
  const data = new FormData(form);
  const start = String(data.get("start_time") || "");
  const course = String(data.get("course_code") || "40");
  return {
    visit_date: String(data.get("visit_date") || "").trim(),
    start_time: start,
    end_time: addMinutesToTime(start, Number(course)),
    course_code: course,
    store_code: String(data.get("store_code") || ""),
    customer_name: String(data.get("customer_name") || "").trim(),
    customer_phone: String(data.get("customer_phone") || "").trim(),
    note: String(data.get("note") || "").trim(),
  };
}

async function validateReservation(values, currentId) {
  const missing = [];
  if (!values.visit_date) missing.push("日付");
  if (!values.start_time) missing.push("開始時刻");
  if (!values.course_code) missing.push("コース");
  if (!values.store_code) missing.push("店舗");
  if (!values.customer_name) missing.push("お名前");
  if (missing.length > 0) {
    return `次の必須項目を入力してください：${missing.join("、")}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.visit_date)) return "日付の形式が不正です";
  if (!isValidTime(values.start_time) || !isValidTime(values.end_time)) return "時刻の形式が不正です";
  if (!["40", "60"].includes(values.course_code)) return "コースを選択してください";
  if (!STORE_OPTIONS.some(([value]) => value === values.store_code)) return "店舗を選択してください";

  const start = timeToMinutes(values.start_time);
  const end = timeToMinutes(values.end_time);
  if (end <= start) return "終了時刻は開始時刻より後にしてください";
  if (start < OPEN_MINUTES || end > CLOSE_MINUTES) return "営業時間外です（09:00-21:00）";

  const collision = await findReservationCollision(values, currentId);
  if (collision) {
    return `${collision.start_time}-${collision.end_time} の予約と重複しています`;
  }

  const blockCollision = await findBlockCollision(values);
  if (blockCollision) {
    return `${blockCollision.start_time}-${blockCollision.end_time} の予約不可時間と重複しています`;
  }
  return "";
}

async function findReservationCollision(values, currentId) {
  const reservations = await fetchActiveReservationsForDate(values.visit_date);
  return reservations.find((item) => {
    if (isSameReservation(item, currentId)) return false;
    if (item.store_code !== values.store_code) return true;
    return timeRangesOverlap(values.start_time, values.end_time, item.start_time, item.end_time);
  });
}

async function findStoreLockForDate(visitDate, currentId) {
  if (!visitDate) return null;
  const reservations = await fetchActiveReservationsForDate(visitDate);
  return resolveStoreLock(reservations, currentId);
}

function resolveStoreLock(reservations, currentId) {
  const storeCodes = [];
  for (const item of reservations || []) {
    if (isSameReservation(item, currentId)) continue;
    if (!STORE_OPTIONS.some(([value]) => value === item.store_code)) continue;
    if (!storeCodes.includes(item.store_code)) storeCodes.push(item.store_code);
  }
  if (storeCodes.length === 0) return null;

  const storeCode = storeCodes[0];
  return {
    store_code: storeCode,
    label: storeLabel(storeCode),
  };
}

async function fetchActiveReservationsForDate(visitDate) {
  const snapshot = await getDocs(
    query(
      collection(db, "reservations"),
      where("visit_date", "==", visitDate),
      where("status", "==", "active"),
    ),
  );
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

function isSameReservation(item, currentId) {
  return Boolean(currentId && (item.id === currentId || item.reservation_id === currentId));
}

async function findBlockCollision(values) {
  const snapshot = await getDocs(
    query(
      collection(db, "blocks"),
      where("date", "==", values.visit_date),
      where("active", "==", true),
    ),
  );

  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .find((item) => timeRangesOverlap(values.start_time, values.end_time, item.start_time, item.end_time));
}

function normalizeExisting(existing, presetDate) {
  const start = existing?.start_time || "09:00";
  const course = existing?.course_code || "40";
  return {
    visit_date: existing?.visit_date || presetDate || todayKey(),
    start_time: start,
    end_time: existing?.end_time || addMinutesToTime(start, Number(course)),
    course_code: course,
    store_code: existing?.store_code || "tanushimaru",
    customer_name: existing?.customer_name || "",
    customer_phone: existing?.customer_phone || "",
    note: existing?.note || "",
  };
}

function updateEndTime(form) {
  const values = readReservationForm(form);
  const end = form.elements.end_time;
  if (end) end.value = values.end_time || "";
}

function setupStoreAvailability(form, existing) {
  form.__storeLockCurrentId = existing?.id || existing?.reservation_id || "";
  form.__storeLockRequestId = 0;
  form.elements.visit_date?.addEventListener("change", () => refreshStoreAvailability(form));
}

async function refreshStoreAvailability(form) {
  const requestId = (form.__storeLockRequestId || 0) + 1;
  form.__storeLockRequestId = requestId;

  try {
    const lock = await findStoreLockForDate(form.elements.visit_date?.value || "", form.__storeLockCurrentId);
    if (form.__storeLockRequestId !== requestId) return;
    applyStoreLock(form, lock);
  } catch (err) {
    console.error("reservation store availability check failed", err);
    if (form.__storeLockRequestId !== requestId) return;
    applyStoreLock(form, null);
  }
}

function applyStoreLock(form, lock) {
  const inputs = [...form.querySelectorAll('input[name="store_code"]')];
  const lockedStoreCode = lock?.store_code || "";
  for (const input of inputs) {
    input.disabled = Boolean(lockedStoreCode && input.value !== lockedStoreCode);
  }

  if (lockedStoreCode && !inputs.some((input) => input.checked && !input.disabled)) {
    const allowedInput = inputs.find((input) => input.value === lockedStoreCode);
    if (allowedInput) allowedInput.checked = true;
  }

  const note = form.querySelector("[data-store-lock-note]");
  if (!note) return;
  if (lockedStoreCode) {
    note.textContent = `この日は既に${lock.label}の予約があります。他店舗は選択できません。`;
    note.hidden = false;
  } else {
    note.textContent = "";
    note.hidden = true;
  }
}

function timeOptions(selected, includeEnd) {
  const end = includeEnd ? CLOSE_MINUTES : CLOSE_MINUTES - 30;
  let html = "";
  for (let value = OPEN_MINUTES; value <= end; value += 30) {
    const time = minutesToTime(value);
    html += `<option value="${time}"${time === selected ? " selected" : ""}>${time}</option>`;
  }
  return html;
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

function storeLabel(storeCode) {
  return STORE_OPTIONS.find(([value]) => value === storeCode)?.[1] || storeCode;
}

function createModal({ title, submitLabel }) {
  const root = getModalRoot();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="reservationModalTitle">
      <div class="modal-head">
        <h2 id="reservationModalTitle">${title}</h2>
        <button type="button" class="modal-close" aria-label="閉じる">×</button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-modal-cancel>キャンセル</button>
        <button type="button" class="btn" data-modal-submit data-write="true"${isDegraded() ? " disabled" : ""}>${submitLabel}</button>
      </div>
    </div>
  `;

  const modal = {
    overlay,
    body: overlay.querySelector(".modal-body"),
    submitButton: overlay.querySelector("[data-modal-submit]"),
    closeButton: overlay.querySelector(".modal-close"),
  };
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeModal(modal);
  });
  overlay.querySelector("[data-modal-cancel]")?.addEventListener("click", () => closeModal(modal));
  modal.closeButton?.addEventListener("click", () => closeModal(modal));
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

function setError(node, message) {
  if (!node) return;
  node.textContent = message;
  node.hidden = !message;
}

function userFacingErrorMessage(error, fallback) {
  const message = String(error?.message || "");
  return /[ぁ-んァ-ヴ一-龯]/.test(message) ? message : fallback;
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

function addMinutesToTime(value, amount) {
  if (!isValidTime(value) || !Number.isFinite(amount)) return "";
  return minutesToTime(timeToMinutes(value) + amount);
}

function timeRangesOverlap(startA, endA, startB, endB) {
  return timeToMinutes(startA) < timeToMinutes(endB) && timeToMinutes(endA) > timeToMinutes(startB);
}

function randomHex(length) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, length);
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
