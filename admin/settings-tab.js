import { signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { auth } from "./app.js";
import { isDegraded } from "./degraded.js";
import { executeRedo, executeUndo, getLatestRedoableLog, getLatestUndoableLog } from "./undo.js";

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
    </div>
  `;
}

function setupSettingsLogout() {
  document.getElementById("settingsLogoutButton")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await signOut(auth);
      window.location.assign(new URL("login.html", window.location.href));
    } catch (error) {
      console.error("settings signOut failed", error);
      button.disabled = false;
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
  addKv(info, "display_name", user.displayName || "未設定");
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

function addKv(root, key, value) {
  const term = document.createElement("dt");
  term.textContent = key;
  const detail = document.createElement("dd");
  detail.textContent = String(value ?? "");
  root.appendChild(term);
  root.appendChild(detail);
}
