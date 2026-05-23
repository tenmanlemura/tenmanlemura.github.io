import { db } from "./app.js";
import {
  collection,
  query,
  where,
  onSnapshot,
  doc,
  orderBy,
  limit,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const DEGRADED_MESSAGE =
  "現在、Firestore 無料枠が上限に近づいているため安全モードに切り替えています。書込操作は明日 00:30 JST 以降に自動復帰します。読込は通常通り利用できます。";

let degraded = false;
let unsubscribe = null;

export function initDegradedListener() {
  if (unsubscribe) return unsubscribe;

  const banner = document.getElementById("degraded-banner");
  if (banner) {
    banner.textContent = DEGRADED_MESSAGE;
  }
  setDegraded(false);

  unsubscribe = onSnapshot(
    doc(db, "settings/degraded_mode"),
    (snapshot) => {
      setDegraded(snapshot.exists() && snapshot.data()?.enabled === true);
    },
    (error) => {
      console.error("degraded_mode listener failed", error);
      setDegraded(false);
    },
  );

  window.addEventListener("beforeunload", unsubscribe, { once: true });
  return unsubscribe;
}

export function isDegraded() {
  return degraded;
}

export function assertNotDegraded() {
  if (degraded) {
    throw new Error(DEGRADED_MESSAGE);
  }
}

function setDegraded(enabled) {
  degraded = enabled === true;
  window.__tenmanDegraded = degraded;

  const banner = document.getElementById("degraded-banner");
  if (banner) {
    banner.hidden = !degraded;
    banner.textContent = DEGRADED_MESSAGE;
  }

  document.body.classList.toggle("degraded-mode", degraded);

  // spec §5.1 準拠: HTML disabled 属性で確実に操作不可（keyboard / screen reader user 含む WCAG 整合）。
  // 動的追加 button は assertNotDegraded() ガードに依存（モーダル open 時に throw）。
  document.querySelectorAll('button[data-write="true"]').forEach((btn) => {
    btn.disabled = degraded;
  });
}
