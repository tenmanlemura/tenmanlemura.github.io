import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db, auth } from "./app.js";
import { assertNotDegraded } from "./degraded.js";

export async function commitWrite({ op, domain, inverse, target, dispatchSource }) {
  assertNotDegraded();

  const user = auth.currentUser;
  if (!user) throw new Error("ログインが必要です");

  let newRevision;
  await runTransaction(db, async (tx) => {
    const stateRef = doc(db, "publish_state/current");
    const stateSnap = await tx.get(stateRef);
    const currentRev = (stateSnap.exists() ? stateSnap.data().publishRevision : 0) || 0;
    newRevision = currentRev + 1;

    const common4 = {
      schema_version: 1,
      written_by: "admin_spa",
      written_at: serverTimestamp(),
      source_revision: newRevision,
    };

    const domainRef = doc(db, `${domain.collection}/${domain.docId}`);
    if (domain.action === "set") {
      tx.set(domainRef, { ...domain.data, ...common4 });
    } else if (domain.action === "update") {
      tx.update(domainRef, { ...domain.data, ...common4 });
    } else if (domain.action === "delete") {
      tx.delete(domainRef);
    } else {
      throw new Error(`不明な操作です（${domain.action}）`);
    }

    const logRef = doc(collection(db, "admin_log"));
    // M-B4 (rejected): actor_uid / actor_email 分離は Firestore Rules `validAdminLog()` の
    // hasOnly(['actor','action','target','timestamp','inverse_operation','schema_version',
    // 'written_by','written_at','source_revision']) 違反で write fail する。
    // 現状の actor 単一フィールド構成を維持。
    tx.set(logRef, {
      actor: user.email || user.uid,
      action: op,
      target,
      timestamp: serverTimestamp(),
      inverse_operation: inverse,
      ...common4,
    });

    if (stateSnap.exists()) {
      tx.update(stateRef, { publishRevision: newRevision });
    } else {
      // M-B3 (rejected): common4 除去は Firestore Rules `validPublishState()` の
      // hasAll(common4Keys()) 違反で create reject されるため revert。
      // publish_state schema は実際は common4 を required（spec §3.5 記述が古いだけ）。
      tx.set(stateRef, {
        publishRevision: newRevision,
        lastDispatchAt: null,
        lastDispatchedRevision: 0,
        lastPublishedRevision: 0,
        lastPublishedAt: null,
        lastError: null,
        consecutiveFailures: 0,
        ...common4,
      });
    }
  });

  fireDispatch(newRevision, dispatchSource).catch((err) => {
    console.warn("dispatch fire-and-forget failed:", err);
  });

  return newRevision;
}

async function fireDispatch(revision, source) {
  const url = window.__TENMAN_DISPATCH_URL;
  if (!url) {
    console.warn("dispatch URL not configured");
    return;
  }

  const currentUser = auth.currentUser;
  if (!currentUser) {
    console.warn("dispatch skipped: user signed out before dispatch");
    return;
  }

  const token = await currentUser.getIdToken();
  const body = JSON.stringify({ source, revision, admin_token: token });

  // exponential backoff retry: 0s（初回）+ 1s + 3s + 9s → 最大 4 試行・合計 ~13 秒
  // network 瞬断 / 5xx / 408 / 429 は retry。4xx（429/408 除く）は client error として即停止。
  // 全 retry 失敗時も throw しない（Watchdog 第 2 線が 1 分以内に補強発火する設計）。
  const DELAYS_MS = [1000, 3000, 9000];
  let lastError = null;
  for (let attempt = 0; attempt <= DELAYS_MS.length; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      });
      if (res.ok) {
        if (attempt > 0) {
          console.log(`dispatch succeeded after ${attempt} retry(s) (revision=${revision})`);
        }
        return;
      }
      lastError = new Error(`dispatch HTTP ${res.status}`);
      // 4xx は client error として即停止（408 timeout / 429 rate limit のみ retry）
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        console.warn(`dispatch client error, no retry (HTTP ${res.status})`);
        return;
      }
    } catch (err) {
      lastError = err;
    }
    if (attempt < DELAYS_MS.length) {
      await new Promise((resolve) => setTimeout(resolve, DELAYS_MS[attempt]));
    }
  }
  console.warn(
    `dispatch failed after ${DELAYS_MS.length} retries (revision=${revision}):`,
    lastError,
  );
}

export async function logSkipOnly({ action, target, reason }) {
  const user = auth.currentUser;
  if (!user) throw new Error("ログインが必要です");

  const logRef = doc(collection(db, "admin_log"));
  // M-B4 (rejected) と同じ理由で actor 単一フィールド維持（rules hasOnly() 違反回避）
  await setDoc(logRef, {
    schema_version: 1,
    written_by: "admin_spa",
    written_at: serverTimestamp(),
    actor: user.email || user.uid,
    action,
    target,
    reason,
    timestamp: serverTimestamp(),
    inverse_operation: {},
    source_revision: null,
  });
}
