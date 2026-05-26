import { auth, db } from "./app.js";
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
import { commitWrite, logSkipOnly } from "./write-helpers.js";

const SKIP_ACTION = "undo_attempted_but_skipped";
const CONFLICT_MESSAGE =
  "他の管理者が既に変更しています。undo を実行すると最新変更が失われます。続行しますか？";

export async function getLatestUndoableLog() {
  const logs = await getRecentActorLogs();
  return logs.find((entry) => !startsWithAction(entry, SKIP_ACTION)) || null;
}

export async function getLatestRedoableLog() {
  const latest = await getLatestUndoableLog();
  return latest && startsWithAction(latest, "undo_of:") ? latest : null;
}

export async function executeUndo(logEntry) {
  const entry = logEntry || (await getLatestUndoableLog());
  if (!entry) return { status: "empty" };

  const operation = normalizeOperation(entry.inverse_operation);
  const targetSnap = await getTargetSnapshot(operation);
  const precondition = checkPrecondition({ operation, logEntry: entry, targetSnap });

  if (!precondition.ok) {
    const shouldForce = await confirmConflict();
    if (!shouldForce) {
      await logSkipOnly({
        action: SKIP_ACTION,
        target: `admin_log/${entry.id}`,
        reason: precondition.reason,
      });
      return { status: "skipped", reason: precondition.reason, logEntry: entry };
    }
  }

  const redoOperation = buildInverseForAppliedOperation(operation, targetSnap);
  const revision = await commitWrite({
    op: `undo_of:${entry.id}`,
    domain: domainFromOperation(operation),
    inverse: redoOperation,
    target: operation.target,
    dispatchSource: "admin_undo",
  });

  return { status: "done", revision, logEntry: entry };
}

export async function executeRedo() {
  const entry = await getLatestRedoableLog();
  if (!entry) return { status: "empty" };

  const operation = normalizeOperation(entry.inverse_operation);
  const targetSnap = await getTargetSnapshot(operation);
  const undoOperation = buildInverseForAppliedOperation(operation, targetSnap);
  const revision = await commitWrite({
    op: `redo_of:${entry.id}`,
    domain: domainFromOperation(operation),
    inverse: undoOperation,
    target: operation.target,
    dispatchSource: "admin_redo",
  });

  return { status: "done", revision, logEntry: entry };
}

async function getRecentActorLogs() {
  const user = auth.currentUser;
  if (!user) throw new Error("not authenticated");

  const snapshot = await getDocs(
    query(
      collection(db, "admin_log"),
      where("actor", "==", user.email || user.uid),
      orderBy("timestamp", "desc"),
      limit(25),
    ),
  );
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

function normalizeOperation(operation) {
  if (!operation || typeof operation !== "object") {
    throw new Error("inverse_operation が空です");
  }
  if (!["create", "update", "delete"].includes(operation.op)) {
    throw new Error(`unsupported inverse operation: ${operation.op || "unknown"}`);
  }
  if (!operation.target || !parseTarget(operation.target)) {
    throw new Error("inverse_operation.target が不正です");
  }
  if ((operation.op === "create" || operation.op === "update") && !operation.data) {
    throw new Error("inverse_operation.data がありません");
  }
  return operation;
}

async function getTargetSnapshot(operation) {
  const target = parseTarget(operation.target);
  return getDoc(doc(db, target.collection, target.docId));
}

function checkPrecondition({ operation, logEntry, targetSnap }) {
  const precondition = operation.precondition || inferPrecondition(operation);

  if (precondition.type === "target_not_exists") {
    return targetSnap.exists()
      ? { ok: false, reason: "target_exists" }
      : { ok: true };
  }

  if (precondition.type === "source_revision_match") {
    if (!targetSnap.exists()) return { ok: false, reason: "target_missing" };
    const expected = precondition.expected_source_revision ?? logEntry.source_revision;
    return targetSnap.data().source_revision === expected
      ? { ok: true }
      : { ok: false, reason: "source_revision_mismatch" };
  }

  return { ok: true };
}

function inferPrecondition(operation) {
  if (operation.op === "create") return { type: "target_not_exists" };
  return { type: "source_revision_match" };
}

function domainFromOperation(operation) {
  const target = parseTarget(operation.target);
  if (!target) throw new Error("target が不正です");

  if (operation.op === "delete") {
    return {
      collection: target.collection,
      docId: target.docId,
      action: "delete",
    };
  }

  return {
    collection: target.collection,
    docId: target.docId,
    action: operation.op === "create" ? "set" : "update",
    data: operation.data,
  };
}

function buildInverseForAppliedOperation(operation, targetSnap) {
  if (operation.op === "create") {
    return {
      op: "delete",
      target: operation.target,
    };
  }

  if (!targetSnap.exists()) {
    // L-C3 (RESOLVED-as-deferred 2026-05-26): targetSnap.exists()=false 経路は
    // 「他 admin が delete 済み」のレアケースで、tenman 運用（yuko + tenman さん
    // 1 人ずつ・admin 同時操作なし）では事実上発生しない。万一発生しても data:{}
    // を redo 適用する時、commitWrite() (write-helpers.js:18) が common4 を後付け
    // しても、firestore.rules の collection 固有必須フィールド (例: reservations
    // なら reservation_id / customer_name / start_time 等の hasAll allowlist) を
    // 満たさず **Rules reject される** ため、本番では undo 失敗の UX 劣化で止まり
    // data 整合性は守られる。Phase D で複数 admin 同時運用に拡張する時に
    // undo skip + admin_log 記録の正式 semantics を再設計予定。
    return {
      op: "create",
      target: operation.target,
      data: {},
    };
  }

  if (operation.op === "delete") {
    return {
      op: "create",
      target: operation.target,
      data: targetSnap.data(),
    };
  }

  return {
    op: "update",
    target: operation.target,
    data: targetSnap.data(),
  };
}

function parseTarget(target) {
  const [collectionName, ...rest] = String(target || "").split("/");
  const docId = rest.join("/");
  if (!collectionName || !docId || docId.includes("/")) return null;
  return { collection: collectionName, docId };
}

function startsWithAction(entry, prefix) {
  return String(entry?.action || "").startsWith(prefix);
}

function confirmConflict() {
  return new Promise((resolve) => {
    const root = getModalRoot();
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-panel" role="dialog" aria-modal="true" aria-labelledby="undoConflictTitle">
        <div class="confirm-body">
          <p class="section-label">Conflict</p>
          <h2 id="undoConflictTitle">変更が競合しています</h2>
          <p>${CONFLICT_MESSAGE}</p>
        </div>
        <div class="confirm-actions">
          <button type="button" class="btn btn-secondary" data-confirm-no>いいえ</button>
          <button type="button" class="btn" data-confirm-yes>続行</button>
        </div>
      </div>
    `;

    function close(result) {
      document.removeEventListener("keydown", onKeydown);
      overlay.remove();
      resolve(result);
    }

    function onKeydown(event) {
      if (event.key === "Escape") close(false);
    }

    overlay.querySelector("[data-confirm-no]")?.addEventListener("click", () => close(false));
    overlay.querySelector("[data-confirm-yes]")?.addEventListener("click", () => close(true));
    document.addEventListener("keydown", onKeydown);
    root.appendChild(overlay);
    overlay.querySelector("[data-confirm-no]")?.focus();
  });
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
