// ==UserScript==
// @name         Dice Controller
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  Dice Controller for iOS Safari
// @author       Admin
// @match        *://*.google.com/search?*
// @run-at       document-start
// @grant        none
// ==/UserScript==

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
  "use strict";

  // ─── CONFIG ──────────────────────────────────────────────────────────
  // PENTING UNTUK MOBILE (HP):
  // 1. Ganti SERVER_URL dengan link public Anda (misal dari Ngrok atau Cloudflare)
  const SERVER_URL = "https://cemetery-scoring-circles-downloads.trycloudflare.com";
  // 2. Ganti API_KEY dengan API Key milik HP tersebut yang didaftarkan di Dashboard.
  const API_KEY = "key-laptop-rumah";
  const POLL_INTERVAL = 500; // ms

  // ─── STATE ───────────────────────────────────────────────────────────
  const state = {
    enabled: true,
    values: [], // Will be filled from server's distribution
    rollIndex: 0,
    maxFaces: 6,
    isRollingWindow: false, // True for 3s after clicking Lempar
  };

  let rollWindowTimeout = null;

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
            console.log("[DiceCtrl] 🚀 LEMPAR CLICKED! Override activated for 3 seconds.");

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

  // ─── OVERRIDE Math.random() — THE CORE MECHANISM ─────────────────────
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

  // ─── ALSO OVERRIDE crypto.getRandomValues ────────────────────────────
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

  // ─── SERVER POLLING ──────────────────────────────────────────────────
  async function pollServer() {
    try {
      const res = await fetch(`${SERVER_URL}/api/total`, {
        headers: { "X-API-Key": API_KEY },
      });
      if (!res.ok) return;

      const data = await res.json();

      if (data.distribution && Array.isArray(data.distribution)) {
        const newVals = JSON.stringify(data.distribution);
        const oldVals = JSON.stringify(state.values);
        if (newVals !== oldVals) {
          state.values = [...data.distribution];
          console.log(
            `%c[DiceCtrl] Values synced: [${state.values.join(",")}] (total: ${data.total})`,
            "color: #00ff88;",
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startPolling);
  } else {
    startPolling();
  }

  window.__diceCtrl = state;
  console.log("%c[DiceCtrl] Userscript v6.0 loaded", "color: #00ff88; font-weight: bold; font-size: 13px;");
})();
