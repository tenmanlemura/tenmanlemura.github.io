import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
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

  // build_state（案 X）: 編集があったことを記録する。Watchdog が debounce(3分)後に 1 回だけ
  // build-availability dispatch する。data 書込トランザクションとは分離（best-effort・doc 不在や
  // 失敗で予約保存自体を巻き込まない）。doc は seed 済前提なので update（全上書きで Watchdog の
  // in_flight/disabled を踏まないよう needs_build/last_edited_at + common4 のみ書く）。
  flagBuildNeeded(newRevision).catch((err) => {
    console.warn("build_state flag update failed:", err);
  });

  return newRevision;
}

async function flagBuildNeeded(revision) {
  const buildStateRef = doc(db, "system/build_state");
  await updateDoc(buildStateRef, {
    needs_build: true,
    last_edited_at: serverTimestamp(),
    schema_version: 1,
    written_by: "admin_spa",
    written_at: serverTimestamp(),
    source_revision: revision,
  });
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
