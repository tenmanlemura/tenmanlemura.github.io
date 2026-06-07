const isLocalhost = typeof window !== "undefined" &&
  (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost");

export const useEmulator = isLocalhost;

export const firebaseConfig = isLocalhost ? {
  apiKey: "PLACEHOLDER_EMULATOR_KEY",
  authDomain: "tenman-demo.firebaseapp.com",
  projectId: "tenman-demo",
  storageBucket: "tenman-demo.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000000000000000000000",
} : {
  apiKey: "AIzaSyD7KEWZ801Hb8VErejD56dT2CqRuBdzf2A",
  authDomain: "tenman-prod.firebaseapp.com",
  projectId: "tenman-prod",
  storageBucket: "tenman-prod.firebasestorage.app",
  messagingSenderId: "486152126022",
  appId: "1:486152126022:web:a50e0022bd336390631447",
};
