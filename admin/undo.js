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
import { findRestoreConflicts } from "./schedule-guard.js";

const SKIP_ACTION = "undo_attempted_but_skipped";
const CONFLICT_MESSAGE =
  "他の管理者が既に変更しています。元に戻す操作を実行すると最新変更が失われます。続行しますか？";

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

  // v1.1 HIGH-NEW-1: この undo が予約を active に復帰させる場合、復活前に物理制約を再確認する。
  // 操作履歴 undo（cancel の inverse 等）はキャンセル後に店休/別店舗/同枠予約/受付停止が
  // 入った状態でも素通りで active に戻していた（Codex review 3 回目）。
  await assertReservationRestorable(operation, targetSnap);

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
  });

  return { status: "done", revision, logEntry: entry };
}

export async function executeRedo() {
  const entry = await getLatestRedoableLog();
  if (!entry) return { status: "empty" };

  const operation = normalizeOperation(entry.inverse_operation);
  const targetSnap = await getTargetSnapshot(operation);

  // v1.1 HIGH-NEW-1: redo も active 予約を再作成しうる（予約作成の undo を redo すると create で復活）。
  // executeUndo と同じ復活ガードを通す（Codex review 4 回目 HIGH-2）。
  await assertReservationRestorable(operation, targetSnap);

  const undoOperation = buildInverseForAppliedOperation(operation, targetSnap);
  const revision = await commitWrite({
    op: `redo_of:${entry.id}`,
    domain: domainFromOperation(operation),
    inverse: undoOperation,
    target: operation.target,
  });

  return { status: "done", revision, logEntry: entry };
}

// v1.1 HIGH-NEW-1: undo が予約を「キャンセル等 → active」に戻す時だけ物理制約を再確認する。
// 既に active な予約の編集 undo（名前変更の取り消し等）は対象外（status が変わらないため）。
async function assertReservationRestorable(operation, targetSnap) {
  const target = parseTarget(operation.target);
  if (!target || target.collection !== "reservations") return;
  if (operation.op === "delete") return; // 削除方向は active 復帰ではない

  const base = targetSnap.exists() ? (targetSnap.data() || {}) : {};
  const reservation = { ...base, ...(operation.data || {}) };
  const willBeActive = reservation.status === "active";
  const currentlyActive = targetSnap.exists() && base.status === "active";
  if (!willBeActive || currentlyActive) return; // active への遷移でなければ検証不要

  const visitDate = reservation.visit_date;
  if (!visitDate) return; // 日付不明なら従来どおり（rules / GAS 側の最終防衛に委ねる）

  const [scheduleSnap, resSnap, blockSnap] = await Promise.all([
    getDoc(doc(db, "schedules", visitDate)),
    getDocs(query(
      collection(db, "reservations"),
      where("status", "==", "active"),
      where("visit_date", "==", visitDate),
    )),
    getDocs(query(
      collection(db, "blocks"),
      where("active", "==", true),
      where("date", "==", visitDate),
    )),
  ]);
  const scheduleData = scheduleSnap.exists() ? (scheduleSnap.data() || {}) : null;
  const otherActiveReservations = resSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const blocks = blockSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const verdict = findRestoreConflicts({ reservation: { ...reservation, id: target.docId }, scheduleData, otherActiveReservations, blocks });
  if (!verdict.ok) {
    // userFacingErrorMessage が日本語判定で拾えるよう日本語メッセージで throw
    throw new Error(`この予約は復活できません（その日${verdict.message}）`);
  }
}

async function getRecentActorLogs() {
  const user = auth.currentUser;
  if (!user) throw new Error("ログインが必要です");

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
    throw new Error("元に戻す操作の情報が空です");
  }
  if (!["create", "update", "delete"].includes(operation.op)) {
    throw new Error(`未対応の履歴操作です（${operation.op || "不明"}）`);
  }
  if (!operation.target || !parseTarget(operation.target)) {
    throw new Error("元に戻す操作の対象が不正です");
  }
  if ((operation.op === "create" || operation.op === "update") && !operation.data) {
    throw new Error("元に戻す操作の保存内容がありません");
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
  if (!target) throw new Error("操作対象が不正です");

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

  // L-C3 note: targetSnap が exists()=false の場合は「元 update 対象の doc が既に削除された」状態。
  // 現状は空 data の create を試みるが、firestore.rules の hasAll(required fields) check で
  // 必ず reject される（spec §3.8 completeness 観点での既知 edge case）。
  // ユーザー視点: 「他端末で削除済の予約を undo しようとした」シナリオで「保存失敗」エラー表示になる。
  // 改善候補: 本ケースを早期検知して conflict 専用 modal で「対象が既に削除されています」を表示する。
  // 現状は rules reject に依存（複数 admin 並行操作の最終防衛ライン）・実害は限定的。
  if (!targetSnap.exists()) {
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
