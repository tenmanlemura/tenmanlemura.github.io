import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { initDegradedListener } from "./degraded.js";
import { initHomeTab } from "./home-tab.js";
import { initScheduleTab } from "./schedule-tab.js";
import { initBlockTab } from "./block-tab.js";
import { initSettingsTab } from "./settings-tab.js";

const VALID_TABS = ["home", "schedule", "block", "settings"];
const LOGIN_PATH = "login.html";
const ADMIN_PATH = "index.html";
const NO_ADMIN_MESSAGE = "このアカウントには管理権限がありません。yuko に連絡してください。";

export let app;
export let auth;
export let db;

export function initFirebase() {
  if (app && auth && db) {
    return { app, auth, db };
  }

  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);

  return { app, auth, db };
}

export async function verifyAdminClaim(user, forceRefresh = false) {
  if (!user) return false;
  const token = await user.getIdTokenResult(forceRefresh);
  return token.claims.admin === true;
}

export function setupTabs() {
  const buttons = Array.from(document.querySelectorAll("[data-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-tab-panel]"));

  function normalizeTab(tab) {
    return VALID_TABS.includes(tab) ? tab : "home";
  }

  function activateTab(nextTab, options = {}) {
    const tab = normalizeTab(nextTab);

    buttons.forEach((button) => {
      const isActive = button.dataset.tab === tab;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
      button.tabIndex = isActive ? 0 : -1;
    });

    panels.forEach((panel) => {
      const isActive = panel.dataset.tabPanel === tab;
      panel.classList.toggle("is-active", isActive);
      panel.hidden = !isActive;
    });

    loadTab(tab);

    if (!options.skipHash && window.location.hash !== `#${tab}`) {
      window.location.hash = tab;
    }
  }

  buttons.forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });

  window.addEventListener("hashchange", () => {
    activateTab(window.location.hash.slice(1), { skipHash: true });
  });

  activateTab(window.location.hash.slice(1), { skipHash: true });
}

export function setupLogout() {
  const button = document.getElementById("logoutButton");
  if (!button) return;

  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await signOut(auth);
      redirectTo(LOGIN_PATH);
    } catch (error) {
      console.error("signOut failed", error);
      button.disabled = false;
    }
  });
}

export function loadHomeTab() {
  initHomeTab();
}
export function loadScheduleTab() {
  initScheduleTab();
}
export function loadBlockTab() {
  initBlockTab();
}
export function loadSettingsTab() {
  initSettingsTab();
}

function loadTab(tab) {
  const loaders = {
    home: loadHomeTab,
    schedule: loadScheduleTab,
    block: loadBlockTab,
    settings: loadSettingsTab,
  };

  loaders[tab]?.();
}

function redirectTo(fileName) {
  window.location.assign(new URL(fileName, window.location.href));
}

function setText(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

function setLoginError(message) {
  const error = document.getElementById("loginError");
  if (!error) return;

  error.textContent = message;
  error.hidden = !message;
}

async function handleUnauthorizedLogin() {
  setLoginError(NO_ADMIN_MESSAGE);
  await signOut(auth);
}

function initLoginPage() {
  const { auth } = initFirebase();
  const loginForm = document.getElementById("loginForm");
  const emailInput = document.getElementById("loginEmail");
  const passwordInput = document.getElementById("loginPassword");
  const submitButton = document.getElementById("loginSubmitButton");
  const forgotPasswordButton = document.getElementById("forgotPasswordButton");
  const resetMessage = document.getElementById("resetMessage");
  let loginInProgress = false;
  let resetInProgress = false;

  function syncButtonState() {
    const inProgress = loginInProgress || resetInProgress;
    if (submitButton) submitButton.disabled = inProgress;
    if (forgotPasswordButton) forgotPasswordButton.disabled = inProgress;
  }

  function setResetMessage(message) {
    if (!resetMessage) return;

    resetMessage.textContent = message;
    resetMessage.hidden = !message;
  }

  function setLoginInProgress(inProgress) {
    loginInProgress = inProgress;
    syncButtonState();
  }

  function setResetInProgress(inProgress) {
    resetInProgress = inProgress;
    syncButtonState();
  }

  function getEmailValue() {
    return emailInput?.value.trim() || "";
  }

  function getLoginErrorMessage(error) {
    const code = error?.code;

    if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
      return "メールアドレスまたはパスワードが違います。";
    }

    if (code === "auth/too-many-requests") {
      return "ログイン試行回数が上限に達しました。時間をおいて再試行してください。";
    }

    if (code === "auth/network-request-failed") {
      return "ネットワークエラーが発生しました。接続を確認してください。";
    }

    return "ログインに失敗しました。時間をおいて再試行してください。";
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) return;

    setText("loginStatus", "管理権限を確認しています");
    try {
      if (await verifyAdminClaim(user, true)) {
        redirectTo(ADMIN_PATH);
        return;
      }

      await handleUnauthorizedLogin();
      setText("loginStatus", "");
      setLoginInProgress(false);
    } catch (error) {
      console.error("admin claim check failed", error);
      setLoginError("認証状態を確認できませんでした。時間をおいて再試行してください。");
      setText("loginStatus", "");
      setLoginInProgress(false);
      await signOut(auth);
    }
  });

  loginForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (loginInProgress) return;

    const email = getEmailValue();
    const password = passwordInput?.value || "";

    setLoginError("");
    setResetMessage("");

    if (!email || !password || !emailInput?.checkValidity()) {
      setLoginError("メールアドレスとパスワードを入力してください。");
      return;
    }

    setLoginInProgress(true);
    setText("loginStatus", "ログインしています");

    try {
      await signInWithEmailAndPassword(auth, email, password);
      setText("loginStatus", "管理権限を確認しています");
    } catch (error) {
      console.error("signInWithEmailAndPassword failed", error);
      setLoginError(getLoginErrorMessage(error));
      setText("loginStatus", "");
      setLoginInProgress(false);
    }
  });

  forgotPasswordButton?.addEventListener("click", async () => {
    if (resetInProgress) return;

    const email = getEmailValue();

    setLoginError("");
    setResetMessage("");
    setText("loginStatus", "");

    if (!email || !emailInput?.checkValidity()) {
      setLoginError("パスワードリセット用のメールアドレスを入力してください。");
      return;
    }

    setResetInProgress(true);

    try {
      await sendPasswordResetEmail(auth, email);
      setResetMessage("パスワード再設定メールを送信しました。受信トレイをご確認ください。");
    } catch (error) {
      console.warn("sendPasswordResetEmail failed", error);

      if (error?.code === "auth/network-request-failed") {
        setLoginError("ネットワークエラーが発生しました。接続を確認してください。");
      } else {
        setResetMessage("パスワード再設定メールを送信しました。受信トレイをご確認ください。");
      }
    } finally {
      setResetInProgress(false);
    }
  });
}

function initAdminPage() {
  const { auth } = initFirebase();
  const authGate = document.getElementById("authGate");
  const appShell = document.getElementById("appShell");

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      redirectTo(LOGIN_PATH);
      return;
    }

    try {
      if (!(await verifyAdminClaim(user))) {
        await signOut(auth);
        redirectTo(LOGIN_PATH);
        return;
      }

      setText("currentUserEmail", user.email || "ログイン中");
      setupTabs();
      setupLogout();
      initDegradedListener();
      authGate?.setAttribute("hidden", "");
      if (appShell) appShell.hidden = false;
    } catch (error) {
      console.error("admin auth check failed", error);
      await signOut(auth);
      redirectTo(LOGIN_PATH);
    }
  });
}

const page = document.body.dataset.page;
if (page === "login") {
  initLoginPage();
} else if (page === "admin") {
  initAdminPage();
}
