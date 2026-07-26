// ==UserScript==
// @name         Dadu Kendali (Safari iOS - 3x3 Grid Exact Order)
// @namespace    dice
// @version      24.0
// @description  Exact 1-to-1 visual grid layout matching dashboard inputs on Safari iOS
// @match        *://*.google.com/*
// @match        *://google.com/*
// @match        *://*.google.co.id/*
// @match        *://google.co.id/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var mainWorldCode = `
(function() {
  if (window.__diceMainWorldActive) return;
  window.__diceMainWorldActive = true;

  var SERVER = "https://aasjdhov.my.id";
  var KEY = "hanz-osaidhsf-woiiahds";
  var POLL_INTERVAL = 500;
  var STORAGE_KEY = '__diceCtrl_persist_v24';

  // ─── PERSISTENT STATE ───
  var saved = null;
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch(e) {}

  var diceVals = (saved && saved.v && saved.v.length > 0) ? saved.v : [6,6,6,6,6,6,6,6,6];
  var diceOn = (saved && saved.on !== undefined) ? saved.on : true;
  var diceIdx = 0;
  var isRollingWindow = false;
  var rollTimeout = null;

  // ─── OVERRIDE Math.random ───
  var origRandom = Math.random;

  var ourRandom = function() {
    if (!diceOn || !diceVals || diceVals.length === 0 || !isRollingWindow) {
      return origRandom.call(Math);
    }

    var i = diceIdx % diceVals.length;
    var val = diceVals[i];
    if (val < 1) val = 1;
    if (val > 6) val = 6;
    diceIdx++;
    var result = (val - 0.5) / 6;
    return result;
  };

  Math.random = ourRandom;

  setInterval(function() {
    if (Math.random !== ourRandom) {
      if (Math.random !== origRandom) origRandom = Math.random;
      Math.random = ourRandom;
    }
  }, 20);

  // ─── OVERRIDE crypto.getRandomValues ───
  if (window.crypto && window.crypto.getRandomValues) {
    var origCrypto = window.crypto.getRandomValues.bind(window.crypto);
    window.crypto.getRandomValues = function(arr) {
      if (!diceOn || !diceVals || diceVals.length === 0 || !isRollingWindow) {
        return origCrypto(arr);
      }
      for (var i = 0; i < arr.length; i++) {
        var idx = diceIdx % diceVals.length;
        var val = Math.max(1, Math.min(diceVals[idx], 6));
        diceIdx++;
        var n = (val - 0.5) / 6;
        if (arr instanceof Uint8Array) arr[i] = Math.floor(n * 256);
        else if (arr instanceof Uint16Array) arr[i] = Math.floor(n * 65536);
        else if (arr instanceof Uint32Array) arr[i] = Math.floor(n * 4294967296);
        else arr[i] = Math.floor(n * 256);
      }
      return arr;
    };
  }

  // ─── UNIVERSAL TOUCH ACTIVATION ───
  function activateRollWindow() {
    diceIdx = 0;
    isRollingWindow = true;

    clearTimeout(rollTimeout);
    rollTimeout = setTimeout(function() {
      isRollingWindow = false;
    }, 3500);
  }

  window.addEventListener('touchstart', activateRollWindow, { capture: true, passive: true });
  window.addEventListener('pointerdown', activateRollWindow, { capture: true, passive: true });
  window.addEventListener('mousedown', activateRollWindow, { capture: true, passive: true });
  window.addEventListener('click', activateRollWindow, { capture: true, passive: true });

  // ─── POLLING SERVER ───
  function pollServer() {
    fetch(SERVER + '/api/total?_t=' + Date.now(), {
      headers: { 'X-API-Key': KEY },
      mode: 'cors'
    })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(d) {
      if (!d) return;
      var changed = false;

      if (d.overrideEnabled !== undefined && diceOn !== d.overrideEnabled) {
        diceOn = d.overrideEnabled;
        changed = true;
      }

      if (d.distribution && Array.isArray(d.distribution) && d.distribution.length > 0) {
        var sNew = JSON.stringify(d.distribution);
        var sOld = JSON.stringify(diceVals);
        if (sNew !== sOld) {
          diceVals = d.distribution.slice();
          changed = true;
        }
      }

      if (changed) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: diceVals, on: diceOn }));
        } catch(e) {}
      }
    })
    .catch(function(e) {});
  }

  pollServer();
  setInterval(pollServer, POLL_INTERVAL);

  console.log('[DiceCtrl] v24.0 Exact 3x3 Order Active!');
})();
`;

  // Inject Script Element into DOM
  try {
    var scriptEl = document.createElement('script');
    scriptEl.id = '__dice_main_world_script';
    scriptEl.textContent = mainWorldCode;
    var target = document.head || document.documentElement;
    if (target) {
      target.appendChild(scriptEl);
      scriptEl.remove();
    }
  } catch (e) {
    console.error('[DiceCtrl] Ingestion Error:', e);
  }
})();