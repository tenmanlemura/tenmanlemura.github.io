import { SDK_VERSION } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  collection,
  onSnapshot,
  query,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { auth, db } from "./app.js";
import { firebaseConfig } from "./firebase-config.js";

const FIRESTORE_SDK_VERSION = "10.14.1";

let initialized = false;
let users = [];
let unsubscribeUsers = null;
let packageVersion = "読み込み中";

export function initSettingsTab() {
  const root = document.getElementById("panel-settings");
  if (!root) return;

  if (!initialized) {
    buildSettingsDom(root);
    setupSettingsLogout();
    loadPackageVersion();
    subscribeUsers();
    initialized = true;
  }

  renderAccount();
  renderUsers();
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

      <section class="settings-section" aria-labelledby="settingsBootstrapTitle">
        <div class="section-subhead">
          <p class="section-label">Bootstrap</p>
          <h3 id="settingsBootstrapTitle">初回管理者追加</h3>
        </div>
        <div class="settings-note">
          <p>初回 admin 追加は yuko が GAS Editor + scripts/tenman-set-admin-claim.js で実行（Step 13 / 14）</p>
          <p>現在の管理者一覧は users collection を参照</p>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="settingsUsersTitle">
        <div class="section-subhead">
          <p class="section-label">Users</p>
          <h3 id="settingsUsersTitle">管理者一覧</h3>
        </div>
        <div class="tab-status" id="settingsUsersStatus" role="status">読み込み中...</div>
        <div class="settings-user-list" id="settingsUsersList"></div>
      </section>

      <section class="settings-section" aria-labelledby="settingsDebugTitle">
        <div class="section-subhead">
          <p class="section-label">Debug</p>
          <h3 id="settingsDebugTitle">debug 情報</h3>
        </div>
        <dl class="settings-kv" id="settingsDebugInfo"></dl>
      </section>
    </div>
  `;
}

async function loadPackageVersion() {
  try {
    const response = await fetch("./package.json", { cache: "no-store" });
    const data = await response.json();
    packageVersion = data.version || "未設定";
  } catch (error) {
    console.warn("package.json read failed", error);
    packageVersion = "取得失敗";
  }
  renderDebug();
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

function subscribeUsers() {
  unsubscribeUsers?.();
  unsubscribeUsers = onSnapshot(
    query(collection(db, "users")),
    (snapshot) => {
      users = snapshot.docs.map((item) => ({ uid: item.id, ...item.data() }));
      setStatus("settingsUsersStatus", "リアルタイム同期中");
      renderUsers();
    },
    (error) => {
      console.error("users listener failed", error);
      setStatus("settingsUsersStatus", `users collection の読み込みに失敗しました: ${error.message}`);
    },
  );
}

async function renderAccount() {
  const user = auth.currentUser;
  const info = document.getElementById("settingsAccountInfo");
  if (!info || !user) return;

  let adminClaim = false;
  try {
    const token = await user.getIdTokenResult();
    adminClaim = token.claims.admin === true;
  } catch (error) {
    console.warn("admin claim read failed", error);
  }

  info.innerHTML = "";
  addKv(info, "email", user.email || "未設定");
  addKv(info, "display_name", user.displayName || "未設定");
  addKv(info, "uid", user.uid);
  addKv(info, "admin claim", adminClaim ? "true" : "false");
  renderDebug();
}

function renderUsers() {
  const list = document.getElementById("settingsUsersList");
  if (!list) return;

  const currentUid = auth.currentUser?.uid || "";
  const rows = [...users].sort((a, b) => {
    const aKey = `${a.email || ""}${a.display_name || ""}${a.uid || ""}`;
    const bKey = `${b.email || ""}${b.display_name || ""}${b.uid || ""}`;
    return aKey.localeCompare(bKey, "ja");
  });

  list.innerHTML = "";
  if (rows.length === 0) {
    list.appendChild(emptyRow("users collection にユーザーがありません"));
    return;
  }

  rows.forEach((user) => {
    const row = document.createElement("div");
    row.className = "settings-user-row";

    const main = document.createElement("div");
    main.className = "settings-user-main";
    const title = document.createElement("strong");
    title.textContent = user.email || user.display_name || user.uid || "email 未設定";
    const meta = document.createElement("span");
    meta.textContent = `${user.display_name || "display_name 未設定"} / created_at: ${formatDate(user.created_at)}`;
    main.appendChild(title);
    main.appendChild(meta);
    row.appendChild(main);

    const badges = document.createElement("div");
    badges.className = "settings-badges";
    badges.appendChild(statusBadge(user.admin === true ? "admin" : "read-only", user.admin === true));
    if ((user.uid || "") === currentUid) badges.appendChild(statusBadge("自分", true));
    row.appendChild(badges);

    list.appendChild(row);
  });
}

function renderDebug() {
  const info = document.getElementById("settingsDebugInfo");
  if (!info) return;

  info.innerHTML = "";
  addKv(info, "firebase project ID", firebaseConfig.projectId || "未設定");
  addKv(info, "app version", packageVersion);
  addKv(info, "Firebase SDK", SDK_VERSION || "未設定");
  addKv(info, "Firestore SDK", FIRESTORE_SDK_VERSION);
}

function addKv(root, key, value) {
  const term = document.createElement("dt");
  term.textContent = key;
  const detail = document.createElement("dd");
  detail.textContent = String(value ?? "");
  root.appendChild(term);
  root.appendChild(detail);
}

function statusBadge(label, active) {
  const badge = document.createElement("span");
  badge.className = active ? "settings-badge is-active" : "settings-badge";
  badge.textContent = label;
  return badge;
}

function emptyRow(text) {
  const row = document.createElement("div");
  row.className = "row-empty";
  row.textContent = text;
  return row;
}

function setStatus(id, text) {
  const status = document.getElementById(id);
  if (status) status.textContent = text;
}

function formatDate(value) {
  if (!value) return "未設定";
  if (typeof value.toDate === "function") {
    return formatDateTime(value.toDate());
  }
  if (value instanceof Date) return formatDateTime(value);
  return String(value);
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
