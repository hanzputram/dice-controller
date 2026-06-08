// ================================================================
// DICE CONTROLLER v3.0 — SILENT OVERRIDE (NO UI)
// ================================================================
// Runs in MAIN world (page context) at document_start.
// No popup, no dashboard overlay. Controlled entirely via
// the web dashboard at localhost:3000/dashboard.
//
// How it works:
//   1. Override Math.random() BEFORE Google's scripts load
//   2. Poll server every 500ms for dice values & roll commands
//   3. When roll command received → click Lempar button
// ================================================================

(function () {
  'use strict';

  // ─── CONFIG ──────────────────────────────────────────────────────────
  const SERVER_URL = 'http://localhost:3000';
  const API_KEY = 'key-iphone-saya';
  const POLL_INTERVAL = 500; // ms

  // ─── STATE ───────────────────────────────────────────────────────────
  const state = {
    enabled: true,
    values: [2, 6, 2, 5, 1, 6, 1, 3, 2], // dataset 1 default
    rollIndex: 0,
    lastRollTrigger: 0,
    maxFaces: 6,
  };

  // ─── OVERRIDE Math.random() — THE CORE MECHANISM ─────────────────────
  // This is the SAME approach the user confirmed works from console.
  // Because we run at document_start in MAIN world, we override
  // BEFORE Google's dice roller captures its reference.
  const _originalRandom = Math.random;

  Math.random = function () {
    if (!state.enabled || !state.values || state.values.length === 0) {
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
    // For a d6: Math.floor(random * 6) + 1 = desired value
    // So random needs to be in [(val-1)/max, val/max)
    const result = (clamped - 0.5) / max;

    console.log(
      `%c[DiceCtrl] Math.random() → ${result.toFixed(4)} (dice value: ${clamped}, index: ${idx})`,
      'color: #00ff88; font-size: 11px;'
    );

    return result;
  };

  console.log(
    '%c[DiceCtrl] ✓ Math.random override ACTIVE (document_start, MAIN world)',
    'color: #00ff88; font-weight: bold; font-size: 13px;'
  );

  // ─── ALSO OVERRIDE crypto.getRandomValues ────────────────────────────
  if (window.crypto && window.crypto.getRandomValues) {
    const _origCrypto = window.crypto.getRandomValues.bind(window.crypto);
    window.crypto.getRandomValues = function (arr) {
      if (!state.enabled || !state.values || state.values.length === 0) {
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

  // ─── FIND & CLICK THE ROLL BUTTON ────────────────────────────────────
  function findRollButton() {
    // Try aria-label selectors for various languages
    const ariaLabels = ['Lempar', 'Roll', 'Wurf', 'Tirar', 'Lancer'];
    for (const label of ariaLabels) {
      const btn = document.querySelector(`div[aria-label="${label}"]`);
      if (btn) return btn;
    }

    // Try known class names
    const classSelectors = ['.SUMRYc', '[data-act="roll"]'];
    for (const sel of classSelectors) {
      try {
        const btn = document.querySelector(sel);
        if (btn) return btn;
      } catch (e) {}
    }

    // Fallback: search for visible button/div containing "Lempar" or "Roll" text
    const candidates = document.querySelectorAll(
      'div[role="button"], button, [jsaction]'
    );
    for (const el of candidates) {
      const text = el.textContent.trim().toLowerCase();
      if (text === 'lempar' || text === 'roll') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return el;
      }
    }

    return null;
  }

  function clickElement(el) {
    if (!el) return false;
    el.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    );
    el.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    );
    el.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, cancelable: true })
    );
    el.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, cancelable: true })
    );
    el.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
    el.click();
    return true;
  }

  function triggerRoll() {
    // Reset roll index so values start from beginning
    state.rollIndex = 0;

    const btn = findRollButton();
    if (btn) {
      clickElement(btn);
      console.log(
        '%c[DiceCtrl] ✓ Roll triggered!',
        'color: #ffaa00; font-weight: bold;'
      );
      return true;
    } else {
      console.warn('[DiceCtrl] Roll button not found on page');
      return false;
    }
  }

  // ─── FIND & CLICK DICE TYPE BUTTONS ──────────────────────────────────
  function findDiceTypeButton(faces) {
    const candidates = document.querySelectorAll(
      'div[role="button"], button, div[jsaction], div'
    );
    for (const el of candidates) {
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      const text = el.textContent.trim();

      const isMatch =
        ariaLabel === `d${faces}` ||
        ariaLabel.includes(`${faces}-sided`) ||
        ariaLabel.includes(`sisi ${faces}`) ||
        text === `${faces}` ||
        text === `d${faces}`;

      if (isMatch) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.width < 100) {
          return el;
        }
      }
    }
    return null;
  }

  function findClearButton() {
    const candidates = document.querySelectorAll(
      'div[role="button"], button, div[jsaction]'
    );
    for (const el of candidates) {
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      const text = el.textContent.trim().toLowerCase();
      if (
        ariaLabel === 'hapus' ||
        ariaLabel === 'clear' ||
        text === 'hapus' ||
        text === 'clear'
      ) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return el;
      }
    }
    return null;
  }

  // ─── AUTO-SETUP: Clear + Add dice + Roll ─────────────────────────────
  let setupInProgress = false;

  async function autoSetupAndRoll(dataset, diceValues) {
    if (setupInProgress) return;
    setupInProgress = true;

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    console.log(
      `%c[DiceCtrl] Auto-setup: dataset ${dataset}, values [${diceValues.join(',')}]`,
      'color: #ffaa00; font-weight: bold;'
    );

    // Step 1: Clear
    const clearBtn = findClearButton();
    if (clearBtn) {
      clickElement(clearBtn);
      await wait(300);
    }

    // Step 2: Add dice
    let diceToAdd = [];
    if (dataset === 1) {
      // 9 x d6
      for (let i = 0; i < 9; i++) diceToAdd.push(6);
    } else {
      // d4, d6, d8, d10, d12, d20
      diceToAdd = [4, 6, 8, 10, 12, 20];
    }

    for (const faces of diceToAdd) {
      const btn = findDiceTypeButton(faces);
      if (btn) {
        clickElement(btn);
        await wait(150);
      } else {
        console.warn(`[DiceCtrl] D${faces} button not found`);
      }
    }

    // Step 3: Update values & roll
    state.values = [...diceValues];
    state.maxFaces = dataset === 2 ? 20 : 6;
    state.rollIndex = 0;

    await wait(300);
    triggerRoll();

    setupInProgress = false;
  }

  // ─── SERVER POLLING ──────────────────────────────────────────────────
  // Polls /api/dice-state for value updates and roll commands.
  async function pollServer() {
    try {
      const res = await fetch(`${SERVER_URL}/api/dice-state`, {
        headers: { 'X-API-Key': API_KEY },
      });
      if (!res.ok) return;

      const data = await res.json();

      // Update values if changed
      if (data.values && Array.isArray(data.values)) {
        const newVals = JSON.stringify(data.values);
        const oldVals = JSON.stringify(state.values);
        if (newVals !== oldVals) {
          state.values = [...data.values];
          state.rollIndex = 0;
          console.log(
            `%c[DiceCtrl] Values updated from server: [${state.values.join(',')}]`,
            'color: #00ff88;'
          );
        }
      }

      // Update enabled
      if (typeof data.enabled === 'boolean') {
        state.enabled = data.enabled;
      }

      // Update maxFaces
      if (typeof data.maxFaces === 'number') {
        state.maxFaces = data.maxFaces;
      }

      // Check for roll trigger
      if (
        typeof data.rollTriggerCount === 'number' &&
        data.rollTriggerCount > state.lastRollTrigger
      ) {
        state.lastRollTrigger = data.rollTriggerCount;

        // Perform auto-setup + roll
        const dataset = data.activeDataset || 1;
        autoSetupAndRoll(dataset, state.values);
      }
    } catch (e) {
      // Server unreachable — silent fail, keep using current values
    }
  }

  // Start polling after DOM is available
  function startPolling() {
    // Initial poll
    pollServer();
    // Recurring poll
    setInterval(pollServer, POLL_INTERVAL);
    console.log(
      `%c[DiceCtrl] ✓ Server polling started (${POLL_INTERVAL}ms interval)`,
      'color: #00ff88; font-weight: bold;'
    );
  }

  // Since we run at document_start, DOM isn't ready yet.
  // Wait for it before starting polling (needs DOM for button clicks).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPolling);
  } else {
    startPolling();
  }

  // ─── EXPOSE FOR CONSOLE DEBUGGING ────────────────────────────────────
  window.__diceCtrl = state;
  window.__diceCtrlRoll = triggerRoll;
  window.__diceCtrlSetup = autoSetupAndRoll;

  console.log(
    '%c[DiceCtrl] v3.0 loaded — silent mode, no UI popup',
    'color: #00ff88; font-weight: bold; font-size: 13px;'
  );
  console.log('[DiceCtrl] Debug: window.__diceCtrl, window.__diceCtrlRoll()');
})();