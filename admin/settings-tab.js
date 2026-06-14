import { signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { auth, db } from "./app.js";
import { isDegraded } from "./degraded.js";
import { executeRedo, executeUndo, getLatestRedoableLog, getLatestUndoableLog } from "./undo.js";
import { commitWrite } from "./write-helpers.js";
import { findRestoreConflicts } from "./schedule-guard.js";

let initialized = false;

export function initSettingsTab() {
  const root = document.getElementById("panel-settings");
  if (!root) return;

  if (!initialized) {
    buildSettingsDom(root);
    setupSettingsLogout();
    setupUndoRedoButtons();
    initialized = true;
  }

  renderAccount();
  refreshUndoRedoButtons();
  loadRecentCancelledReservations();
}

function buildSettingsDom(root) {
  root.innerHTML = `
    <div class="panel-heading">
      <p class="section-label">Settings</p>
      <h2>設定</h2>
    </div>
    <div class="settings-stack">
      <section class="settings-section" aria-labelledby="settingsAccountTitle">
        <div class="section-subhead">
          <p class="section-label">Account</p>
          <h3 id="settingsAccountTitle">ログイン情報</h3>
        </div>
        <dl class="settings-kv" id="settingsAccountInfo"></dl>
        <button type="button" class="btn settings-logout" id="settingsLogoutButton">ログアウト</button>
      </section>

      <section class="undo-toolbar" aria-labelledby="settingsUndoTitle">
        <div>
          <p class="section-label">History</p>
          <h3 id="settingsUndoTitle">操作履歴</h3>
          <p class="undo-toolbar-note" id="settingsUndoStatus">履歴を確認しています</p>
        </div>
        <div class="undo-toolbar-actions">
          <button type="button" class="btn btn-secondary btn-compact" id="settingsUndoButton" data-write="true" disabled>直前の操作を元に戻す</button>
          <button type="button" class="btn btn-secondary btn-compact" id="settingsRedoButton" data-write="true" disabled>やり直し</button>
        </div>
        <div class="undo-toast" id="settingsUndoToast" role="status" aria-live="polite" hidden></div>
      </section>

      <section class="settings-section" aria-labelledby="settingsCancelledTitle">
        <div class="section-subhead">
          <p class="section-label">Recent Cancellations</p>
          <h3 id="settingsCancelledTitle">最近キャンセルした予約</h3>
          <p class="undo-toolbar-note" id="settingsCancelledStatus">確認しています...</p>
        </div>
        <ul class="cancelled-list" id="settingsCancelledList" aria-live="polite"></ul>
      </section>
    </div>
  `;
}

function setupSettingsLogout() {
  document.getElementById("settingsLogoutButton")?.addEventListener("click", async () => {
    const confirmed = await confirmDialog("ログアウトしますか？", "ログアウト");
    if (!confirmed) return;
    const button = document.getElementById("settingsLogoutButton");
    if (button) button.disabled = true;
    try {
      await signOut(auth);
      window.location.assign(new URL("login.html", window.location.href));
    } catch (error) {
      console.error("settings signOut failed", error);
      if (button) button.disabled = false;
      alert("ログアウトに失敗しました");
    }
  });
}

function renderAccount() {
  const user = auth.currentUser;
  const info = document.getElementById("settingsAccountInfo");
  if (!info || !user) return;

  info.innerHTML = "";
  addKv(info, "email", user.email || "未設定");
}

function setupUndoRedoButtons() {
  const undoButton = document.getElementById("settingsUndoButton");
  const redoButton = document.getElementById("settingsRedoButton");

  undoButton?.addEventListener("click", async () => {
    await runHistoryAction(undoButton, async () => {
      const log = await getLatestUndoableLog();
      const result = await executeUndo(log);
      if (result.status === "done") {
        showUndoToast(`${targetLabel(log)}を元に戻しました`);
      } else if (result.status === "skipped") {
        showUndoToast("元に戻す操作を中止しました");
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
    showUndoToast(userFacingErrorMessage(error, "履歴操作に失敗しました"));
  } finally {
    await refreshUndoRedoButtons();
  }
}

async function refreshUndoRedoButtons() {
  const undoButton = document.getElementById("settingsUndoButton");
  const redoButton = document.getElementById("settingsRedoButton");
  if (!undoButton || !redoButton) return;

  const degraded = isDegraded();

  try {
    const [undoLog, redoLog] = await Promise.all([getLatestUndoableLog(), getLatestRedoableLog()]);
    undoButton.disabled = degraded || !undoLog;
    undoButton.title = degraded
      ? "安全モード中は操作できません"
      : (undoLog ? `${targetLabel(undoLog)}を元に戻す` : "元に戻せる操作がありません");
    redoButton.disabled = degraded || !redoLog;
    redoButton.title = degraded
      ? "安全モード中は操作できません"
      : (redoLog ? `${targetLabel(redoLog)}をやり直す` : "やり直せる操作がありません");
    setUndoStatus(
      degraded
        ? "安全モード中"
        : (undoLog ? `最新: ${actionLabel(undoLog.action)} / ${targetLabel(undoLog)}` : "元に戻せる操作がありません"),
    );
  } catch (error) {
    console.error("undo state refresh failed", error);
    undoButton.disabled = true;
    redoButton.disabled = true;
    undoButton.title = "元に戻せる操作がありません";
    redoButton.title = "やり直せる操作がありません";
    setUndoStatus("履歴を確認できませんでした");
  }
}

// ── 最近キャンセルした予約 ──────────────────────────────────────────────────

async function loadRecentCancelledReservations() {
  const statusEl = document.getElementById("settingsCancelledStatus");
  const listEl = document.getElementById("settingsCancelledList");
  if (!statusEl || !listEl) return;

  listEl.innerHTML = "";
  statusEl.textContent = "確認しています...";

  try {
    // 既存 composite index（status ASC + visit_date ASC）を使用。limit(20) で reads 上限を確保。
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const snap = await getDocs(
      query(
        collection(db, "reservations"),
        where("status", "==", "cancelled"),
        where("visit_date", ">=", cutoffStr),
        orderBy("visit_date", "asc"),
        limit(20),
      ),
    );

    const items = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.visit_date > b.visit_date ? -1 : 1)); // 新しい順で表示

    if (items.length === 0) {
      statusEl.textContent = "過去7日間のキャンセルはありません";
      return;
    }

    statusEl.textContent = `${items.length}件`;
    for (const item of items) {
      listEl.appendChild(buildCancelledItem(item));
    }
  } catch (error) {
    console.error("cancelled list load failed", error);
    statusEl.textContent = "読み込みに失敗しました";
  }
}

function buildCancelledItem(item) {
  const li = document.createElement("li");
  li.className = "cancelled-item";

  const dateStr = formatVisitDate(item.visit_date);
  const storeStr = item.store_code === "tanushimaru" ? "田主丸店" : item.store_code === "dazaifu" ? "太宰府店" : item.store_code || "";
  const nameStr = item.customer_name || "（名前なし）";
  const timeStr = item.start_time ? `${item.start_time}〜${item.end_time || ""}` : "";

  li.innerHTML = `
    <div class="cancelled-item-info">
      <span class="cancelled-item-date">${dateStr}　${storeStr}</span>
      <span class="cancelled-item-name">${nameStr}${timeStr ? "　" + timeStr : ""}</span>
    </div>
    <button type="button" class="btn btn-secondary btn-compact cancelled-restore-btn" data-id="${item.id}" data-date="${item.visit_date}" data-store="${item.store_code || ""}">
      復活させる
    </button>
  `;

  li.querySelector(".cancelled-restore-btn")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await handleRestore(item, li);
    } finally {
      btn.disabled = false;
    }
  });

  return li;
}

async function handleRestore(item, listItem) {
  if (isDegraded()) {
    alert("安全モード中は復活できません");
    return;
  }

  // v1.1: 復活前に schedule / 別店舗 / 同店舗時間重複 / 受付停止を一括チェック
  // （HIGH-3 + HIGH-NEW-1 / Codex review 2026-06-12・schedule-guard に集約）
  try {
    const [scheduleSnap, resSnap, blockSnap] = await Promise.all([
      getDoc(doc(db, "schedules", item.visit_date)),
      getDocs(query(
        collection(db, "reservations"),
        where("status", "==", "active"),
        where("visit_date", "==", item.visit_date),
      )),
      getDocs(query(
        collection(db, "blocks"),
        where("active", "==", true),
        where("date", "==", item.visit_date),
      )),
    ]);
    const scheduleData = scheduleSnap.exists() ? (scheduleSnap.data() || {}) : null;
    const otherActiveReservations = resSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const blocks = blockSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const verdict = findRestoreConflicts({ reservation: item, scheduleData, otherActiveReservations, blocks });
    if (!verdict.ok) {
      alert(`${formatVisitDate(item.visit_date)} ${verdict.message}`);
      return;
    }
  } catch (error) {
    console.error("restore conflict check failed", error);
    alert("確認中にエラーが発生しました。もう一度試してください。");
    return;
  }

  const confirmed = await confirmDialog(
    `${formatVisitDate(item.visit_date)}　${item.customer_name || ""}の予約を復活させますか？`,
    "復活させる",
  );
  if (!confirmed) return;

  try {
    await commitWrite({
      op: "reservation_restore",
      domain: {
        collection: "reservations",
        docId: item.id,
        action: "update",
        data: { status: "active" },
      },
      inverse: {
        op: "update",
        target: `reservations/${item.id}`,
        data: { status: "cancelled" },
      },
      target: `reservations/${item.id}`,
    });
    listItem.remove();
    const listEl = document.getElementById("settingsCancelledList");
    const statusEl = document.getElementById("settingsCancelledStatus");
    if (listEl && statusEl) {
      const remaining = listEl.querySelectorAll(".cancelled-item").length;
      statusEl.textContent = remaining > 0 ? `${remaining}件` : "過去7日間のキャンセルはありません";
    }
  } catch (error) {
    console.error("restore failed", error);
    alert(userFacingErrorMessage(error, "復活に失敗しました。もう一度試してください。"));
  }
}

function formatVisitDate(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr || "";
  const [y, m, d] = dateStr.split("-");
  const day = new Date(`${dateStr}T00:00:00`).getDay();
  const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
  return `${Number(m)}月${Number(d)}日（${dayNames[day]}）`;
}

// ── 共通確認ダイアログ ───────────────────────────────────────────────────────

function confirmDialog(message, confirmLabel = "OK") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-panel" role="dialog" aria-modal="true" aria-labelledby="settingsConfirmMsg">
        <div class="confirm-body">
          <p id="settingsConfirmMsg">${message}</p>
        </div>
        <div class="confirm-actions">
          <button type="button" class="btn btn-secondary" data-no>キャンセル</button>
          <button type="button" class="btn" data-yes>${confirmLabel}</button>
        </div>
      </div>
    `;
    function close(result) {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    }
    function onKey(e) { if (e.key === "Escape") close(false); }
    overlay.querySelector("[data-no]")?.addEventListener("click", () => close(false));
    overlay.querySelector("[data-yes]")?.addEventListener("click", () => close(true));
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.querySelector("[data-no]")?.focus();
  });
}

// ── ユーティリティ ──────────────────────────────────────────────────────────

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
  if (action.startsWith("undo_of:")) return "元に戻す";
  if (action.startsWith("redo_of:")) return "やり直し";
  return action;
}

function setUndoStatus(text) {
  const status = document.getElementById("settingsUndoStatus");
  if (status) status.textContent = text;
}

function showUndoToast(message) {
  const toast = document.getElementById("settingsUndoToast");
  if (!toast) return;

  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showUndoToast.timer);
  showUndoToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 3600);
}

function userFacingErrorMessage(error, fallback) {
  const message = String(error?.message || "");
  return /[ぁ-んァ-ヴ一-龯]/.test(message) ? message : fallback;
}

function addKv(root, key, value) {
  const term = document.createElement("dt");
  term.textContent = key;
  const detail = document.createElement("dd");
  detail.textContent = String(value ?? "");
  root.appendChild(term);
  root.appendChild(detail);
}
