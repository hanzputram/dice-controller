// ================================================================
// DICE CONTROLLER v6.0 — SILENT OVERRIDE (NO UI)
// ================================================================
// Runs in MAIN world (page context) at document_start.
// No popup, no dashboard overlay. Controlled entirely via
// the web dashboard at localhost:3000/dashboard.
//
// How it works:
//   1. Poll server every 500ms for distribution values from /api/total
//   2. ONLY override Math.random() for 3 seconds AFTER "Lempar" is clicked
//   3. This avoids needing to count dice on screen entirely! When you add
//      dice, they drop randomly. When you click Lempar, they land on
//      the dashboard values.
// ================================================================

(function () {
  'use strict';

  // ─── CONFIG ──────────────────────────────────────────────────────────
  const SERVER_URL = 'http://localhost:3000';
  const API_KEY = 'key-laptop-rumah';
  const POLL_INTERVAL = 500; // ms

  // ─── STATE ───────────────────────────────────────────────────────────
  const state = {
    enabled: true,
    values: [],       // Will be filled from server's distribution
    rollIndex: 0,
    maxFaces: 6,
    isRollingWindow: false, // True for 3s after clicking Lempar
  };

  let rollWindowTimeout = null;

  // ─── INTERCEPT ROLL BUTTON CLICK ─────────────────────────────────────
  // We only activate the override for a short window after the user clicks
  // the Lempar/Roll button. This bypasses the need to count the dice.
  if (typeof window !== 'undefined') {
    window.addEventListener('click', (e) => {
      let el = e.target;
      while (el && el !== document) {
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const text = (el.textContent || '').trim().toLowerCase();
        
        if (aria === 'lempar' || aria === 'roll' || text === 'lempar' || text === 'roll') {
          state.rollIndex = 0;
          state.isRollingWindow = true;
          console.log('[DiceCtrl] 🚀 LEMPAR CLICKED! Override activated for 3 seconds.');
          
          clearTimeout(rollWindowTimeout);
          rollWindowTimeout = setTimeout(() => {
            state.isRollingWindow = false;
            console.log('[DiceCtrl] 🛑 Override window closed.');
          }, 3000); // 3-second window to cover the roll calculation
          
          break;
        }
        el = el.parentNode;
      }
    }, true);
  }

  // ─── OVERRIDE Math.random() — THE CORE MECHANISM ─────────────────────
  const _originalRandom = Math.random;

  Math.random = function () {
    // ONLY override if enabled, we have values, AND we are within the Roll window
    if (!state.enabled || !state.values || state.values.length === 0 || !state.isRollingWindow) {
      return _originalRandom.call(Math);
    }

    const idx = state.rollIndex % state.values.length;
    const val = state.values[idx];
    const max = state.maxFaces || 6;

    // Clamp value to valid range
    const clamped = Math.max(1, Math.min(val, max));

    // Advance index
    state.rollIndex++;

    // Convert dice value to 0-1 range that maps to desired face
    const result = (clamped - 0.5) / max;

    console.log(
      `%c[DiceCtrl] Math.random() OVERRIDDEN → value: ${clamped} (index: ${idx})`,
      'color: #00ff88; font-size: 11px;'
    );

    return result;
  };

  // ─── ALSO OVERRIDE crypto.getRandomValues ────────────────────────────
  if (window.crypto && window.crypto.getRandomValues) {
    const _origCrypto = window.crypto.getRandomValues.bind(window.crypto);
    window.crypto.getRandomValues = function (arr) {
      if (!state.enabled || !state.values || state.values.length === 0 || !state.isRollingWindow) {
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

  // ─── SERVER POLLING ──────────────────────────────────────────────────
  async function pollServer() {
    try {
      const res = await fetch(`${SERVER_URL}/api/total`, {
        headers: { 'X-API-Key': API_KEY },
      });
      if (!res.ok) return;

      const data = await res.json();

      if (data.distribution && Array.isArray(data.distribution)) {
        const newVals = JSON.stringify(data.distribution);
        const oldVals = JSON.stringify(state.values);
        if (newVals !== oldVals) {
          state.values = [...data.distribution];
          console.log(
            `%c[DiceCtrl] Values synced from dashboard: [${state.values.join(',')}] (total: ${data.total})`,
            'color: #00ff88;'
          );
        }
      }
    } catch (e) {
      // silent
    }
  }

  function startPolling() {
    pollServer();
    setInterval(pollServer, POLL_INTERVAL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPolling);
  } else {
    startPolling();
  }

  window.__diceCtrl = state;

  console.log(
    '%c[DiceCtrl] v6.0 loaded — Time-Window Mode (No Dice Counting Needed)',
    'color: #00ff88; font-weight: bold; font-size: 13px;'
  );
})();