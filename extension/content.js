// ================================================================
// DICE CONTROLLER v7.0 — SILENT OVERRIDE (NO UI) + PERSISTENT
// ================================================================
// Runs in MAIN world (page context) at document_start.
// No popup, no dashboard overlay. Controlled entirely via
// the web dashboard.
//
// v7.0 CHANGES:
//   - Settings persist via localStorage (survive page refresh!)
//   - Load saved values BEFORE Math.random override
//   - No bookmark/shortcut needed — fully automatic
//
// How it works:
//   1. Load saved dice values from localStorage (instant)
//   2. Override Math.random() with saved values at document_start
//   3. Poll server every 500ms for updates, save to localStorage
//   4. ONLY override during 3s window AFTER "Lempar" is clicked
// ================================================================

(function () {
  "use strict";

  // ─── CONFIG ──────────────────────────────────────────────────────────
  const SERVER_URL = "https://aasjdhov.my.id";
  const API_KEY = "hanz-osaidhsf-woiiahds";
  const POLL_INTERVAL = 500;
  const STORAGE_KEY = '__diceCtrl_persist_v18';

  // ─── LOAD PERSISTED STATE ────────────────────────────────────────────
  // Ini dijalankan SEBELUM apapun — sehingga saat Safari refresh,
  // nilai dadu langsung tersedia tanpa harus menunggu server.
  let savedState = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      savedState = JSON.parse(raw);
    }
  } catch (e) {
    // localStorage mungkin tidak tersedia
  }

  // ─── STATE ───────────────────────────────────────────────────────────
  const state = {
    enabled: (savedState && savedState.on !== undefined) ? savedState.on : true,
    values: (savedState && savedState.v && savedState.v.length > 0) ? savedState.v : [],
    rollIndex: 0,
    maxFaces: (savedState && savedState.mf) ? savedState.mf : 6,
    isRollingWindow: false,
  };

  let rollWindowTimeout = null;

  // ─── SAVE STATE TO localStorage ──────────────────────────────────────
  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        v: state.values,
        on: state.enabled,
        mf: state.maxFaces,
        ts: Date.now()
      }));
    } catch (e) {
      // Abaikan error
    }
  }

  // ─── INTERCEPT ROLL BUTTON CLICK ─────────────────────────────────────
  if (typeof window !== "undefined") {
    window.addEventListener(
      "click",
      (e) => {
        let el = e.target;
        while (el && el !== document) {
          const aria = (el.getAttribute("aria-label") || "").toLowerCase();
          const text = (el.textContent || "").trim().toLowerCase();

          if (
            aria === "lempar" ||
            aria === "roll" ||
            text === "lempar" ||
            text === "roll"
          ) {
            state.rollIndex = 0;
            state.isRollingWindow = true;
            console.log(
              "[DiceCtrl] 🚀 LEMPAR CLICKED! Override activated for 3 seconds.",
            );

            clearTimeout(rollWindowTimeout);
            rollWindowTimeout = setTimeout(() => {
              state.isRollingWindow = false;
              console.log("[DiceCtrl] 🛑 Override window closed.");
            }, 3000);

            break;
          }
          el = el.parentNode;
        }
      },
      true,
    );
  }

  // ─── OVERRIDE Math.random() ──────────────────────────────────────────
  const _originalRandom = Math.random;

  Math.random = function () {
    if (
      !state.enabled ||
      !state.values ||
      state.values.length === 0 ||
      !state.isRollingWindow
    ) {
      return _originalRandom.call(Math);
    }

    const idx = state.rollIndex % state.values.length;
    const val = state.values[idx];
    const max = state.maxFaces || 6;
    const clamped = Math.max(1, Math.min(val, max));

    state.rollIndex++;

    const result = (clamped - 0.5) / max;

    console.log(
      `%c[DiceCtrl] Math.random() OVERRIDDEN → value: ${clamped} (index: ${idx})`,
      "color: #00ff88; font-size: 11px;",
    );

    return result;
  };

  // ─── OVERRIDE crypto.getRandomValues ─────────────────────────────────
  if (window.crypto && window.crypto.getRandomValues) {
    const _origCrypto = window.crypto.getRandomValues.bind(window.crypto);
    window.crypto.getRandomValues = function (arr) {
      if (
        !state.enabled ||
        !state.values ||
        state.values.length === 0 ||
        !state.isRollingWindow
      ) {
        return _origCrypto(arr);
      }

      for (let i = 0; i < arr.length; i++) {
        const idx = state.rollIndex % state.values.length;
        const val = state.values[idx];
        const max = state.maxFaces || 6;
        const clamped = Math.max(1, Math.min(val, max));
        state.rollIndex++;

        const normalized = (clamped - 0.5) / max;
        if (arr instanceof Uint8Array) {
          arr[i] = Math.floor(normalized * 256);
        } else if (arr instanceof Uint16Array) {
          arr[i] = Math.floor(normalized * 65536);
        } else if (arr instanceof Uint32Array) {
          arr[i] = Math.floor(normalized * 4294967296);
        } else {
          arr[i] = Math.floor(normalized * 256);
        }
      }
      return arr;
    };
  }

  // ─── SERVER POLLING + PERSIST ────────────────────────────────────────
  async function pollServer() {
    try {
      const res = await fetch(`${SERVER_URL}/api/total?_t=${Date.now()}`, {
        headers: { "X-API-Key": API_KEY },
        mode: "cors",
      });
      if (!res.ok) return;

      const data = await res.json();
      let changed = false;

      // Update override enabled
      if (data.overrideEnabled !== undefined) {
        if (state.enabled !== data.overrideEnabled) {
          state.enabled = data.overrideEnabled;
          changed = true;
        }
      }

      // Update distribution values
      if (data.distribution && Array.isArray(data.distribution)) {
        const newVals = JSON.stringify(data.distribution);
        const oldVals = JSON.stringify(state.values);
        if (newVals !== oldVals) {
          state.values = [...data.distribution];
          changed = true;
          console.log(
            `%c[DiceCtrl] Values synced: [${state.values.join(",")}] (total: ${data.total})`,
            "color: #00ff88;",
          );
        }
      }

      // Simpan ke localStorage jika ada perubahan
      if (changed) {
        saveState();
        console.log('[DiceCtrl] Settings saved to localStorage (survive refresh)');
      }
    } catch (e) {
      // Gagal koneksi — gunakan data dari localStorage (sudah loaded)
    }
  }

  function startPolling() {
    pollServer();
    setInterval(pollServer, POLL_INTERVAL);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startPolling);
  } else {
    startPolling();
  }

  // ─── EXPOSE & LOG ────────────────────────────────────────────────────
  window.__diceCtrl = state;
  window.__diceCtrl.clearCache = function() {
    try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
    console.log('[DiceCtrl] localStorage cache cleared');
  };

  const loadSource = (savedState && savedState.v && savedState.v.length > 0)
    ? 'localStorage (instant!)'
    : 'server (waiting for first poll)';

  console.log(
    `%c[DiceCtrl] v7.0 loaded — Persistent Mode | Data from: ${loadSource}`,
    "color: #00ff88; font-weight: bold; font-size: 13px;",
  );

  if (state.values.length > 0) {
    console.log(`[DiceCtrl] Saved values: [${state.values.join(',')}] | Enabled: ${state.enabled}`);
  }
})();
