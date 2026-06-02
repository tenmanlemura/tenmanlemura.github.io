// tenman build_state cutover S5: GHA ビルド完了を system/build_state に通知する（firebase-admin 直接）。
// 案 X。generate-availability.mjs の生成 + commit が成功した後に呼ばれる。
// build-availability イベント（Watchdog 発火）の時のみ workflow から実行される。
//
// 役割:
// - in_flight=false に戻す（次サイクルで Watchdog が再び判断できるように）
// - consecutive_failures=0 にリセット（dispatch + build が通った証拠）
// - last_completed_at を記録
// - 途中編集の取りこぼし防止:
//     current.last_edited_at <= build_target_edited_at  → needs_build=false（今回のビルドが全編集を反映済）
//     current.last_edited_at >  build_target_edited_at  → needs_build=true のまま（ビルド中に新編集・次サイクルで再ビルド）
//
// env:
//   FIREBASE_SERVICE_ACCOUNT_JSON  service account JSON 文字列（GHA secret）
//   BUILD_TARGET_EDITED_AT         Watchdog が dispatch 時に snapshot した last_edited_at（ISO 文字列・空可）
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") throw new Error(name + " is not set");
  return v;
}

function initFirestore() {
  const raw = requireEnv("FIREBASE_SERVICE_ACCOUNT_JSON");
  let sa;
  try {
    sa = JSON.parse(raw);
  } catch (err) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON parse failed: " + (err?.message || err));
  }
  if (getApps().length === 0) {
    initializeApp({ credential: cert(sa), projectId: sa.project_id });
  }
  return getFirestore();
}

async function main() {
  const db = initFirestore();
  const ref = db.doc("system/build_state");

  const targetIso = process.env.BUILD_TARGET_EDITED_AT || "";
  const targetMs = targetIso ? new Date(targetIso).getTime() : 0;

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      // seed されていない場合は何もしない（cutover 順序が崩れている兆候）
      return { skipped: "build_state_absent" };
    }
    const cur = snap.data() || {};
    const curEditedMs = cur.last_edited_at && typeof cur.last_edited_at.toDate === "function"
      ? cur.last_edited_at.toDate().getTime()
      : 0;

    // ビルド中に新しい編集が入っていなければ needs_build を解除。入っていれば true のまま残す。
    const coveredAllEdits = curEditedMs <= targetMs;

    const update = {
      in_flight: false,
      consecutive_failures: 0,
      last_completed_at: Timestamp.now(),
      written_by: "publish_complete_webhook",
      written_at: Timestamp.now(),
      source_revision: (cur.source_revision || 0) + 1,
    };
    if (coveredAllEdits) {
      update.needs_build = false;
    }
    tx.update(ref, update);
    return {
      coveredAllEdits,
      needs_build_after: coveredAllEdits ? false : (cur.needs_build === true),
      target_edited_at: targetIso || null,
    };
  });

  console.log("[notify-build-complete] " + JSON.stringify(result));
}

main().catch((err) => {
  console.error("[notify-build-complete] ERROR: " + (err?.stack || err?.message || String(err)));
  process.exit(1);
});
