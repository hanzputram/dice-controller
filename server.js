const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const url = require('url');

const app = express();

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception caught:', err?.message || err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection caught:', reason?.message || reason);
});

// CORS Middleware - Manual
app.use((req, res, next) => {
    // Allow semua domain (untuk development)
    res.header('Access-Control-Allow-Origin', '*');
    
    // Allow method yang diperlukan
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    
    // Allow header yang diperlukan (termasuk untuk API Key)
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key');

    // Allow Private Network Access (PNA) untuk membolehkan fetch dari origin publik ke localhost
    res.header('Access-Control-Allow-Private-Network', 'true');
    
    // Handle preflight request
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    
    next();
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const BACKUPS_DIR = path.join(__dirname, 'backups');
const MAX_BACKUPS = 50;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ─── Users & API Keys (file-persisted) ───────────────────────────────

function getDefaultUsers() {
  return [
    {
      apiKey: 'key-iphone-saya',
      name: 'Andi',
      device: 'iPhone 15',
      createdAt: '2024-01-01',
      allowedToChange: true
    },
    {
      apiKey: 'key-android-teman',
      name: 'Budi',
      device: 'Samsung S24',
      createdAt: '2024-01-02',
      allowedToChange: false
    },
    {
      apiKey: 'key-laptop-rumah',
      name: 'Rumah',
      device: 'MacBook Pro',
      createdAt: '2024-01-03',
      allowedToChange: true
    }
  ];
}

function initUsersFile() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(getDefaultUsers(), null, 2));
  }
}

function readUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    initUsersFile();
    return readUsers();
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function generateApiKey(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const rand = Math.random().toString(36).substr(2, 6);
  return `key-${slug}-${rand}`;
}

/**
 * Mask an API key for safe display.
 * "key-iphone-saya" → "key-i***saya"
 */
function maskApiKey(key) {
  if (!key || key.length < 8) return '***';
  return key.slice(0, 5) + '***' + key.slice(-4);
}

/**
 * Middleware: verify X-API-Key header against USERS list.
 * If valid, attaches user info to req.user and logs the request.
 * If invalid, returns 401 and logs the failed attempt.
 */
function verifyApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const ip = getClientIp(req);
  const timestamp = new Date().toISOString();

  if (!apiKey) {
    console.log(`[${timestamp}] ⛔ UNAUTHORIZED — No API Key — ${ip} — ${req.method} ${req.path}`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API Key tidak valid atau tidak disertakan',
      requiredHeader: 'X-API-Key'
    });
  }

  const user = readUsers().find(u => u.apiKey === apiKey);

  if (!user) {
    console.log(`[${timestamp}] ⛔ UNAUTHORIZED — Invalid key "${apiKey}" — ${ip} — ${req.method} ${req.path}`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API Key tidak valid atau tidak disertakan',
      requiredHeader: 'X-API-Key'
    });
  }

  // Attach user info to request
  req.user = {
    name: user.name,
    device: user.device,
    apiKey: user.apiKey,
    allowedToChange: user.allowedToChange
  };

  console.log(`[${timestamp}] ${req.user.name} (${req.user.device}) — ${req.method} ${req.path}`);
  next();
}

// ─── Data Structure ───────────────────────────────────────────────────
// data.json schema:
// {
//   total: number,
//   distribution: number[],
//   isValid: boolean,
//   activeProfileId: string | null,
//   profiles: [ { id, name, total, distribution, createdAt } ],
//   webhooks: [ { id, url, createdAt } ],
//   history: [ { timestamp, previousTotal, newTotal, changedBy, apiKeyUsed, ip } ]
// }

// ─── Init ─────────────────────────────────────────────────────────────

function getDefaultData() {
  return {
    devices: {}, // apiKey -> { total, distribution, isValid, activeProfileId }
    profiles: [
      { id: 'preset-menang', name: 'Menang', total: 54, distribution: [6,6,6,6,6,6,6,6,6], createdAt: new Date().toISOString() },
      { id: 'preset-kalah',  name: 'Kalah',  total: 9,  distribution: [1,1,1,1,1,1,1,1,1], createdAt: new Date().toISOString() },
      { id: 'preset-random', name: 'Random', total: 27, distribution: [3,3,3,3,3,3,3,3,3], createdAt: new Date().toISOString() }
    ],
    webhooks: [],
    history: []
  };
}

// Initialize data file if it doesn't exist
function initDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(getDefaultData(), null, 2));
  } else {
    // Migrate: add missing fields to existing data
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    let changed = false;
    
    if (!data.devices) {
      data.devices = {};
      const users = readUsers();
      users.forEach(u => {
        data.devices[u.apiKey] = {
          total: data.total || 9,
          distribution: data.distribution || [1,1,1,1,1,1,1,1,1],
          isValid: data.isValid !== undefined ? data.isValid : true,
          activeProfileId: data.activeProfileId || null
        };
      });
      // clean up old root properties
      delete data.total;
      delete data.distribution;
      delete data.isValid;
      delete data.activeProfileId;
      changed = true;
    }
    
    if (!data.profiles) { data.profiles = getDefaultData().profiles; changed = true; }
    if (!data.webhooks) { data.webhooks = []; changed = true; }
    if (!data.history) { data.history = []; changed = true; }
    if (changed) fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }
}

function initBackupsDir() {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
}

// Read data from JSON file
function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    initDataFile();
    return readData();
  }
}

// Write data to JSON file
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/**
 * Calculate an even distribution of `total` across 9 dice (each 1-6).
 * Strategy: start all dice at 1, then distribute the remaining points
 * as evenly as possible from right to left.
 */
function calculateDistribution(total) {
  if (total < 9 || total > 54) {
    return null;
  }

  const dice = new Array(9).fill(1);
  let remaining = total - 9; // points to distribute beyond the base of 1 each

  // Randomly distribute the remaining points
  while (remaining > 0) {
    // Find all indices that can still be incremented (value < 6)
    const validIndices = [];
    for (let i = 0; i < 9; i++) {
      if (dice[i] < 6) validIndices.push(i);
    }
    
    // Pick a random index from the valid ones
    const randIdx = validIndices[Math.floor(Math.random() * validIndices.length)];
    dice[randIdx]++;
    remaining--;
  }

  // Do NOT sort the array, so the distribution appears completely random 
  // both in the dashboard and when rolled in Google.
  return dice;
}

// ─── Backup Logic ─────────────────────────────────────────────────────

function createBackup() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUPS_DIR, `data-${timestamp}.json`);
    const currentData = fs.readFileSync(DATA_FILE, 'utf-8');
    fs.writeFileSync(backupFile, currentData);

    // Prune old backups beyond MAX_BACKUPS
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith('data-') && f.endsWith('.json'))
      .sort(); // oldest first

    while (files.length > MAX_BACKUPS) {
      const oldest = files.shift();
      fs.unlinkSync(path.join(BACKUPS_DIR, oldest));
    }
  } catch (err) {
    console.error('Backup failed:', err.message);
  }
}

// ─── Webhook Logic ────────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function fireWebhooks(data) {
  const allData = readData();
  const webhooks = allData.webhooks || [];

  const payload = JSON.stringify({
    total: data.total,
    distribution: data.distribution,
    timestamp: new Date().toISOString()
  });

  webhooks.forEach(wh => {
    try {
      const parsed = new URL(wh.url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(parsed, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      });
      req.on('error', err => console.error(`Webhook ${wh.url} error:`, err.message));
      req.write(payload);
      req.end();
    } catch (err) {
      console.error(`Webhook ${wh.url} error:`, err.message);
    }
  });
}

// ─── History Logic ────────────────────────────────────────────────────

function addHistoryEntry(previousTotal, newTotal, ip, user) {
  const data = readData();
  data.history.unshift({
    timestamp: new Date().toISOString(),
    previousTotal,
    newTotal,
    changedBy: user ? user.name : 'unknown',
    apiKeyUsed: user ? maskApiKey(user.apiKey) : 'N/A',
    ip: ip || 'unknown'
  });
  // Keep last 200 entries
  if (data.history.length > 200) {
    data.history = data.history.slice(0, 200);
  }
  writeData(data);
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.connection?.remoteAddress
    || req.ip
    || 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════
// ROUTES — PUBLIC (no API key required)
// ═══════════════════════════════════════════════════════════════════════

// Dashboard page (Hidden Route)
app.get('/sys-config-manager', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Fake Landing Page
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// POST /api/register — public endpoint to register a new user
app.post('/api/register', (req, res) => {
  const { name, device } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Field "name" is required' });
  }

  if (!device || typeof device !== 'string' || device.trim().length === 0) {
    return res.status(400).json({ error: 'Field "device" is required' });
  }

  const users = readUsers();

  // Check for duplicate name+device
  if (users.some(u => u.name === name.trim() && u.device === device.trim())) {
    return res.status(409).json({ error: 'User with same name and device already exists' });
  }

  const apiKey = generateApiKey(name.trim());
  const newUser = {
    apiKey,
    name: name.trim(),
    device: device.trim(),
    createdAt: new Date().toISOString(),
    allowedToChange: false // By default, newly registered users are read-only
  };

  users.push(newUser);
  writeUsers(users);

  console.log(`[${newUser.createdAt}] 📝 NEW PUBLIC REGISTRATION: ${newUser.name} (${newUser.device})`);

  // Return with full key visible ONCE so user can copy it
  res.status(201).json({
    apiKey: newUser.apiKey,
    name: newUser.name,
    device: newUser.device,
    createdAt: newUser.createdAt,
    allowedToChange: newUser.allowedToChange
  });
});

// GET /health
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// GET /api/bookmarklet — returns a fully self-contained bookmarklet URL
// that bypasses CSP by using eval(atob(...)) instead of external script loading
app.get('/api/bookmarklet', (req, res) => {
  const apiKey = req.query.key;
  if (!apiKey) {
    return res.status(400).json({ error: 'Missing API key param: ?key=YOUR_KEY' });
  }

  const user = readUsers().find(u => u.apiKey === apiKey);
  if (!user) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const serverUrl = `${req.protocol}://${req.get('host')}`;

  // Build the full dice controller script as a string
  const script = `(function(){if(window.__diceCtrlLoaded)return;window.__diceCtrlLoaded=true;var S="${serverUrl}",K="${apiKey}",P=500,st={enabled:true,values:[],ri:0,mf:6,rw:false,conn:false,m:"none",ls:0},rwt=null;var dot=document.createElement("div");dot.style.cssText="position:fixed!important;bottom:10px!important;right:10px!important;width:14px!important;height:14px!important;border-radius:50%!important;background:#ff4444!important;z-index:2147483647!important;pointer-events:none!important;transition:background 0.3s!important;box-shadow:0 0 6px rgba(0,0,0,0.4)!important;";document.body.appendChild(dot);function ss(c){dot.style.background=c}window.addEventListener("click",function(e){var el=e.target;while(el&&el!==document){var a=(el.getAttribute("aria-label")||"").toLowerCase();var t=(el.textContent||"").trim().toLowerCase();if(a==="lempar"||a==="roll"||t==="lempar"||t==="roll"){st.ri=0;st.rw=true;console.log("[DC] ROLL!");clearTimeout(rwt);rwt=setTimeout(function(){st.rw=false},3000);break}el=el.parentNode}},true);var _r=Math.random;Math.random=function(){if(!st.enabled||!st.values||st.values.length===0||!st.rw)return _r.call(Math);var i=st.ri%st.values.length;var v=st.values[i];var m=st.mf||6;var c=Math.max(1,Math.min(v,m));st.ri++;var r=(c-0.5)/m;console.log("[DC] OVERRIDE->"+c);return r};if(window.crypto&&window.crypto.getRandomValues){var _c=window.crypto.getRandomValues.bind(window.crypto);window.crypto.getRandomValues=function(a){if(!st.enabled||!st.values||st.values.length===0||!st.rw)return _c(a);for(var i=0;i<a.length;i++){var idx=st.ri%st.values.length;var v=st.values[idx];var m=st.mf||6;var c=Math.max(1,Math.min(v,m));st.ri++;var n=(c-0.5)/m;if(a instanceof Uint8Array)a[i]=Math.floor(n*256);else if(a instanceof Uint16Array)a[i]=Math.floor(n*65536);else if(a instanceof Uint32Array)a[i]=Math.floor(n*4294967296);else a[i]=Math.floor(n*256)}return a}}function pd(d){if(!d)return;st.conn=true;st.ls=Date.now();if(d.overrideEnabled!==undefined)st.enabled=d.overrideEnabled;if(d.distribution&&Array.isArray(d.distribution)){var nv=JSON.stringify(d.distribution);var ov=JSON.stringify(st.values);if(nv!==ov){st.values=d.distribution.slice();console.log("[DC] Sync:"+st.values.join(",")+"|T:"+d.total);ss("#44ff44")}}}window.__diceCallback=function(d){st.m="jsonp";pd(d)};function pj(){return new Promise(function(res){try{var o=document.getElementById("__dj");if(o)o.remove();var s=document.createElement("script");s.id="__dj";s.src=S+"/api/jsonp?key="+encodeURIComponent(K)+"&callback=__diceCallback&_t="+Date.now();var dn=false;s.onerror=function(){this.remove();if(!dn){dn=true;res(false)}};s.onload=function(){this.remove();if(!dn){dn=true;res(st.m==="jsonp"&&st.conn)}};setTimeout(function(){if(!dn){dn=true;try{s.remove()}catch(e){}res(false)}},3000);(document.head||document.documentElement).appendChild(s)}catch(e){res(false)}})}function pf(){return new Promise(function(res){try{fetch(S+"/api/total?_t="+Date.now(),{headers:{"X-API-Key":K},mode:"cors"}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d){st.m="fetch";pd(d);res(true)}else res(false)}).catch(function(){res(false)})}catch(e){res(false)}})}function pc(){return new Promise(function(res){try{var o=document.getElementById("__dc");if(o)o.remove();var l=document.createElement("link");l.id="__dc";l.rel="stylesheet";l.href=S+"/api/css-data?key="+encodeURIComponent(K)+"&_t="+Date.now();var dn=false;l.onload=function(){try{var s=getComputedStyle(document.documentElement);var r=s.getPropertyValue("--dice-data").trim().replace(/['"]/g,"");if(r){var d=JSON.parse(atob(r));st.m="css";pd(d);if(!dn){dn=true;res(true)}}else{if(!dn){dn=true;res(false)}}}catch(e){if(!dn){dn=true;res(false)}}};l.onerror=function(){if(!dn){dn=true;res(false)}};setTimeout(function(){if(!dn){dn=true;res(false)}},3000);(document.head||document.documentElement).appendChild(l)}catch(e){res(false)}})}var pm=null,fc=0;async function poll(){ss("#ffaa00");if(pm){var ok=false;if(pm==="jsonp")ok=await pj();else if(pm==="fetch")ok=await pf();else if(pm==="css")ok=await pc();if(ok)return;fc++;if(fc>3){pm=null;fc=0}}var ms=[pj,pf,pc],ns=["jsonp","fetch","css"];for(var i=0;i<ms.length;i++){var s=await ms[i]();if(s){pm=ns[i];console.log("[DC] Using:"+ns[i]);return}}ss("#ff4444");console.log("[DC] All failed")}poll();setInterval(poll,P);window.__diceCtrl=st;console.log("[DC] v9.1 loaded!")})()`;

  const b64 = Buffer.from(script).toString('base64');
  const bookmarklet = `javascript:void(eval(atob('${b64}')))`;

  res.json({
    bookmarklet,
    user: user.name,
    device: user.device,
    length: bookmarklet.length,
    instructions: [
      '1. Copy the bookmarklet URL',
      '2. In Safari, bookmark any page',
      '3. Edit the bookmark → paste the bookmarklet URL as the address',
      '4. Go to Google → search "roll dice"',
      '5. Tap the bookmarklet from bookmarks',
      '6. Green dot = working!'
    ]
  });
});

// GET /api/inject — serves the full dice controller script as JavaScript
// Used by bookmarklet to load the complete script
app.get('/api/inject', (req, res) => {
  const apiKey = req.query.key;
  if (!apiKey) {
    res.setHeader('Content-Type', 'application/javascript');
    return res.send('console.error("[DiceCtrl] No API key provided");');
  }

  const user = readUsers().find(u => u.apiKey === apiKey);
  if (!user) {
    res.setHeader('Content-Type', 'application/javascript');
    return res.send('console.error("[DiceCtrl] Invalid API key");');
  }

  const serverUrl = `${req.protocol}://${req.get('host')}`;

  const script = `
(function() {
  if (window.__diceCtrlLoaded) { console.log("[DiceCtrl] Already loaded!"); return; }
  window.__diceCtrlLoaded = true;

  var SERVER_URL = "__SERVER_URL__";
  var API_KEY = "${apiKey}";
  var POLL_INTERVAL = 500;

  var state = {
    enabled: true,
    values: [],
    rollIndex: 0,
    maxFaces: 6,
    isRollingWindow: false,
    connected: false,
    method: "none",
    lastSync: 0
  };

  var rollWindowTimeout = null;

  // ─── DEBUG INDICATOR ───
  var dot = document.createElement("div");
  dot.style.cssText = "position:fixed!important;bottom:10px!important;right:10px!important;width:14px!important;height:14px!important;border-radius:50%!important;background:#ff4444!important;z-index:2147483647!important;pointer-events:none!important;transition:background 0.3s!important;box-shadow:0 0 6px rgba(0,0,0,0.4)!important;";
  document.body.appendChild(dot);

  function setStatus(color) { dot.style.background = color; }

  // ─── INTERCEPT ROLL BUTTON ───
  window.addEventListener("click", function(e) {
    var el = e.target;
    while (el && el !== document) {
      var aria = (el.getAttribute("aria-label") || "").toLowerCase();
      var text = (el.textContent || "").trim().toLowerCase();
      if (aria === "lempar" || aria === "roll" || text === "lempar" || text === "roll") {
        state.rollIndex = 0;
        state.isRollingWindow = true;
        console.log("[DiceCtrl] LEMPAR! Override aktif 3 detik.");
        clearTimeout(rollWindowTimeout);
        rollWindowTimeout = setTimeout(function() {
          state.isRollingWindow = false;
          console.log("[DiceCtrl] Override window ditutup.");
        }, 3000);
        break;
      }
      el = el.parentNode;
    }
  }, true);

  // ─── OVERRIDE Math.random() ───
  var _origRandom = Math.random;
  Math.random = function() {
    if (!state.enabled || !state.values || state.values.length === 0 || !state.isRollingWindow) {
      return _origRandom.call(Math);
    }
    var idx = state.rollIndex % state.values.length;
    var val = state.values[idx];
    var max = state.maxFaces || 6;
    var clamped = Math.max(1, Math.min(val, max));
    state.rollIndex++;
    var result = (clamped - 0.5) / max;
    console.log("[DiceCtrl] OVERRIDE -> " + clamped + " (idx:" + idx + ")");
    return result;
  };

  // ─── OVERRIDE crypto.getRandomValues ───
  if (window.crypto && window.crypto.getRandomValues) {
    var _origCrypto = window.crypto.getRandomValues.bind(window.crypto);
    window.crypto.getRandomValues = function(arr) {
      if (!state.enabled || !state.values || state.values.length === 0 || !state.isRollingWindow) {
        return _origCrypto(arr);
      }
      for (var i = 0; i < arr.length; i++) {
        var idx = state.rollIndex % state.values.length;
        var val = state.values[idx];
        var max = state.maxFaces || 6;
        var clamped = Math.max(1, Math.min(val, max));
        state.rollIndex++;
        var normalized = (clamped - 0.5) / max;
        if (arr instanceof Uint8Array) arr[i] = Math.floor(normalized * 256);
        else if (arr instanceof Uint16Array) arr[i] = Math.floor(normalized * 65536);
        else if (arr instanceof Uint32Array) arr[i] = Math.floor(normalized * 4294967296);
        else arr[i] = Math.floor(normalized * 256);
      }
      return arr;
    };
  }

  // ─── PROCESS DATA ───
  function processData(data) {
    if (!data) return;
    state.connected = true;
    state.lastSync = Date.now();
    if (data.overrideEnabled !== undefined) state.enabled = data.overrideEnabled;
    if (data.distribution && Array.isArray(data.distribution)) {
      var newV = JSON.stringify(data.distribution);
      var oldV = JSON.stringify(state.values);
      if (newV !== oldV) {
        state.values = data.distribution.slice();
        console.log("[DiceCtrl] Synced via " + state.method + ": [" + state.values.join(",") + "] total:" + data.total);
        setStatus("#44ff44");
      }
    }
  }

  // ─── JSONP CALLBACK ───
  window.__diceCallback = function(data) {
    state.method = "jsonp";
    processData(data);
  };

  // ─── POLL: try JSONP first, then fetch, then CSS ───
  var preferredMethod = null;
  var failCount = 0;

  function tryJsonp() {
    return new Promise(function(resolve) {
      try {
        var old = document.getElementById("__diceJsonp");
        if (old) old.remove();
        var s = document.createElement("script");
        s.id = "__diceJsonp";
        s.src = SERVER_URL + "/api/jsonp?key=" + encodeURIComponent(API_KEY) + "&callback=__diceCallback&_t=" + Date.now();
        var done = false;
        s.onerror = function() { this.remove(); if (!done) { done = true; resolve(false); } };
        s.onload = function() { this.remove(); if (!done) { done = true; resolve(state.method === "jsonp" && state.connected); } };
        setTimeout(function() { if (!done) { done = true; try { s.remove(); } catch(e){} resolve(false); } }, 3000);
        (document.head || document.documentElement).appendChild(s);
      } catch(e) { resolve(false); }
    });
  }

  function tryFetch() {
    return new Promise(function(resolve) {
      try {
        fetch(SERVER_URL + "/api/total?_t=" + Date.now(), {
          headers: { "X-API-Key": API_KEY }, mode: "cors"
        }).then(function(r) { return r.ok ? r.json() : null; })
          .then(function(data) { if (data) { state.method = "fetch"; processData(data); resolve(true); } else resolve(false); })
          .catch(function() { resolve(false); });
      } catch(e) { resolve(false); }
    });
  }

  function tryCss() {
    return new Promise(function(resolve) {
      try {
        var old = document.getElementById("__diceCss");
        if (old) old.remove();
        var link = document.createElement("link");
        link.id = "__diceCss";
        link.rel = "stylesheet";
        link.href = SERVER_URL + "/api/css-data?key=" + encodeURIComponent(API_KEY) + "&_t=" + Date.now();
        var done = false;
        link.onload = function() {
          try {
            var style = getComputedStyle(document.documentElement);
            var raw = style.getPropertyValue("--dice-data").trim().replace(/['\"]/g, "");
            if (raw) {
              var decoded = atob(raw);
              var data = JSON.parse(decoded);
              state.method = "css";
              processData(data);
              if (!done) { done = true; resolve(true); }
            } else { if (!done) { done = true; resolve(false); } }
          } catch(e) { if (!done) { done = true; resolve(false); } }
        };
        link.onerror = function() { if (!done) { done = true; resolve(false); } };
        setTimeout(function() { if (!done) { done = true; resolve(false); } }, 3000);
        (document.head || document.documentElement).appendChild(link);
      } catch(e) { resolve(false); }
    });
  }

  async function poll() {
    setStatus("#ffaa00");
    if (preferredMethod) {
      var ok = false;
      if (preferredMethod === "jsonp") ok = await tryJsonp();
      else if (preferredMethod === "fetch") ok = await tryFetch();
      else if (preferredMethod === "css") ok = await tryCss();
      if (ok) return;
      failCount++;
      if (failCount > 3) { preferredMethod = null; failCount = 0; }
    }
    var methods = [tryJsonp, tryFetch, tryCss];
    var names = ["jsonp", "fetch", "css"];
    for (var i = 0; i < methods.length; i++) {
      var success = await methods[i]();
      if (success) { preferredMethod = names[i]; console.log("[DiceCtrl] Using method: " + names[i]); return; }
    }
    setStatus("#ff4444");
    console.log("[DiceCtrl] All methods failed");
  }

  poll();
  setInterval(poll, POLL_INTERVAL);
  window.__diceCtrl = state;
  console.log("[DiceCtrl] v8.0 Bookmarklet loaded!");
})();
`.replace(/__SERVER_URL__/g, serverUrl);

  const finalScript = script;

  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(finalScript);
});

// GET /setup — bookmarklet installer page
app.get('/setup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

// GET /api/userscript — serves the dice controller userscript for direct install
// User navigates to this URL on their iPhone, Userscripts app detects and installs it
app.get('/api/userscript', (req, res) => {
  const apiKey = req.query.key || 'hanz-osaidhsf-woiiahds';
  const serverUrl = `${req.protocol}://${req.get('host')}`;

  // Read the template script and replace config values
  const scriptPath = path.join(__dirname, 'extension', 'dice-controller.user.js');
  let script = fs.readFileSync(scriptPath, 'utf-8');

  // Replace server URL and API key in the script
  script = script.replace(/var SERVER = "[^"]*"/, `var SERVER = "${serverUrl}"`);
  script = script.replace(/var KEY = "[^"]*"/, `var KEY = "${apiKey}"`);

  res.setHeader('Content-Type', 'text/javascript');
  res.setHeader('Content-Disposition', 'inline; filename="dice-controller.user.js"');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(script);
});

// GET /install — mobile-friendly install page with instructions
app.get('/install', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'install.html'));
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTES — PROTECTED (API key required)
// ═══════════════════════════════════════════════════════════════════════

// GET /api/whoami — return current user info
app.get('/api/whoami', verifyApiKey, (req, res) => {
  res.json({
    name: req.user.name,
    device: req.user.device,
    apiKey: maskApiKey(req.user.apiKey),
    allowedToChange: req.user.allowedToChange
  });
});

// GET /api/devices — returns list of devices for targeting
app.get('/api/devices', verifyApiKey, (req, res) => {
  const users = readUsers();
  const devices = users.map(u => ({
    name: u.name,
    device: u.device,
    apiKey: u.apiKey
  }));
  res.json({ devices });
});

function resolveDevicePayload(apiKey) {
  const data = readData();
  const ds = readDiceState();

  const myData = data.devices[apiKey] || {
    total: 9,
    distribution: [1,1,1,1,1,1,1,1,1],
    isValid: true,
    activeProfileId: null,
    overrideEnabled: true,
    activeMode: 'set_total'
  };

  let distribution = myData.distribution;
  let total = myData.total;
  let overrideEnabled = myData.overrideEnabled !== false;

  if (myData.activeMode === 'dice_controller') {
    const extValues = ds.activeDataset === 1 ? ds.dataset1 : ds.dataset2;
    distribution = extValues;
    total = extValues.reduce((a, b) => a + b, 0);
    overrideEnabled = ds.enabled !== false;
  } else if (myData.autoRange && Array.isArray(myData.autoRange) && myData.autoRange.length === 2) {
    const min = myData.autoRange[0];
    const max = myData.autoRange[1];
    total = Math.floor(Math.random() * (max - min + 1)) + min;
    distribution = calculateDistribution(total);
  }

  return {
    total,
    distribution,
    isValid: myData.isValid,
    activeProfileId: myData.activeProfileId,
    overrideEnabled,
    showIndicator: myData.showIndicator !== false,
    autoRange: myData.autoRange || null,
    activeMode: myData.activeMode || 'set_total'
  };
}

// GET /api/total
app.get('/api/total', verifyApiKey, (req, res) => {
  const myKey = req.user.apiKey;
  const targetKey = req.query.targetKey || myKey;
  res.json(resolveDevicePayload(targetKey));
});

// GET /api/jsonp — returns data via JSONP callback to bypass CSP
app.get('/api/jsonp', (req, res) => {
  const apiKey = req.query.key;
  const callback = req.query.callback || '__diceCallback';

  if (!apiKey) {
    return res.status(400).send(`${callback}({"error": "Missing API key"})`);
  }

  const user = readUsers().find(u => u.apiKey === apiKey);
  if (!user) {
    return res.status(401).send(`${callback}({"error": "Invalid API key"})`);
  }

  const payload = resolveDevicePayload(apiKey);
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`${callback}(${JSON.stringify(payload)});`);
});

// GET /api/css-data — returns data via CSS custom properties to bypass CSP
app.get('/api/css-data', (req, res) => {
  const apiKey = req.query.key;

  if (!apiKey) {
    res.setHeader('Content-Type', 'text/css');
    return res.send(':root { --dice-data: ""; }');
  }

  const user = readUsers().find(u => u.apiKey === apiKey);
  if (!user) {
    res.setHeader('Content-Type', 'text/css');
    return res.send(':root { --dice-data: ""; }');
  }

  const payload = resolveDevicePayload(apiKey);
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');

  res.setHeader('Content-Type', 'text/css');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(`:root { --dice-data: "${b64}"; }`);
});

// POST /api/total
app.post('/api/total', verifyApiKey, (req, res) => {
  // Permission check
  if (!req.user.allowedToChange) {
    return res.status(403).json({
      error: 'Forbidden',
      message: `User ${req.user.name} tidak memiliki izin untuk action ini`
    });
  }

  const { total, targetKey, overrideEnabled, showIndicator, autoRange } = req.body;
  const targetApiKey = targetKey || req.user.apiKey;

  const data = readData();
  if (!data.devices[targetApiKey]) {
    data.devices[targetApiKey] = { total: 9, distribution: [1,1,1,1,1,1,1,1,1], isValid: true, activeProfileId: null, overrideEnabled: true, activeMode: 'set_total' };
  }

  // Switch to set_total mode whenever total or autoRange is updated
  data.devices[targetApiKey].activeMode = 'set_total';

  // Jika request hanya untuk mematikan/menyalakan override atau indicator
  if ((overrideEnabled !== undefined || showIndicator !== undefined) && total === undefined && autoRange === undefined) {
    if (overrideEnabled !== undefined) {
      data.devices[targetApiKey].overrideEnabled = Boolean(overrideEnabled);
      if (!overrideEnabled) data.devices[targetApiKey].activeProfileId = null;
    }
    if (showIndicator !== undefined) {
      data.devices[targetApiKey].showIndicator = Boolean(showIndicator);
    }
    writeData(data);
    return res.json({
      total: data.devices[targetApiKey].total,
      distribution: data.devices[targetApiKey].distribution,
      isValid: data.devices[targetApiKey].isValid,
      activeProfileId: data.devices[targetApiKey].activeProfileId,
      overrideEnabled: data.devices[targetApiKey].overrideEnabled,
      showIndicator: data.devices[targetApiKey].showIndicator !== false,
      autoRange: data.devices[targetApiKey].autoRange || null
    });
  }

  // Handle autoRange
  if (autoRange && Array.isArray(autoRange) && autoRange.length === 2) {
    data.devices[targetApiKey].autoRange = autoRange;
    data.devices[targetApiKey].isValid = true;
    data.devices[targetApiKey].activeProfileId = null;
    data.devices[targetApiKey].overrideEnabled = true;
    
    // Pick a temporary total/distribution just to save
    const randTotal = Math.floor(Math.random() * (autoRange[1] - autoRange[0] + 1)) + autoRange[0];
    data.devices[targetApiKey].total = randTotal;
    data.devices[targetApiKey].distribution = calculateDistribution(randTotal);
    
    writeData(data);
    return res.json({
      total: randTotal,
      distribution: data.devices[targetApiKey].distribution,
      isValid: true,
      activeProfileId: null,
      overrideEnabled: true,
      showIndicator: data.devices[targetApiKey].showIndicator !== false,
      autoRange: autoRange
    });
  }

  if (total === undefined || total === null) {
    return res.status(400).json({
      error: 'Field "total" or "autoRange" is required',
      isValid: false
    });
  }

  // If a specific total is provided, clear autoRange
  delete data.devices[targetApiKey].autoRange;

  const numTotal = Number(total);

  if (!Number.isInteger(numTotal) || numTotal < 9 || numTotal > 54) {
    return res.status(400).json({
      error: 'Total harus berupa bilangan bulat antara 9-54',
      isValid: false
    });
  }
  
  const previousTotal = data.devices[targetApiKey].total;
  const distribution = calculateDistribution(numTotal);

  data.devices[targetApiKey].total = numTotal;
  data.devices[targetApiKey].distribution = distribution;
  data.devices[targetApiKey].isValid = true;
  data.devices[targetApiKey].activeProfileId = null; // Manual change clears active profile
  if (overrideEnabled !== undefined) {
    data.devices[targetApiKey].overrideEnabled = Boolean(overrideEnabled);
  } else {
    data.devices[targetApiKey].overrideEnabled = true; // Auto-enable when setting a new total without specifying
  }

  // Backup before write
  createBackup();

  writeData(data);

  // Log history with user info
  addHistoryEntry(previousTotal, numTotal, getClientIp(req), req.user);

  // Fire webhooks asynchronously
  fireWebhooks({ total: numTotal, distribution, targetKey: targetApiKey });

  const freshData = readData();
  const freshDeviceData = freshData.devices[targetApiKey];
  res.json({
    total: freshDeviceData.total,
    distribution: freshDeviceData.distribution,
    isValid: freshDeviceData.isValid,
    activeProfileId: freshDeviceData.activeProfileId,
    overrideEnabled: freshDeviceData.overrideEnabled !== false,
    showIndicator: freshDeviceData.showIndicator !== false,
    autoRange: freshDeviceData.autoRange || null
  });
});

// ─── Profiles ─────────────────────────────────────────────────────────

// GET /api/profiles — list all profiles
app.get('/api/profiles', verifyApiKey, (_req, res) => {
  const data = readData();
  res.json({
    profiles: data.profiles,
    activeProfileId: data.activeProfileId
  });
});

// POST /api/profiles — create a new profile
app.post('/api/profiles', verifyApiKey, (req, res) => {
  // Permission check
  if (!req.user.allowedToChange) {
    return res.status(403).json({
      error: 'Forbidden',
      message: `User ${req.user.name} tidak memiliki izin untuk action ini`
    });
  }

  const { name, total } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Field "name" is required' });
  }

  let profileTotal = total !== undefined ? Number(total) : null;

  if (profileTotal !== null) {
    if (!Number.isInteger(profileTotal) || profileTotal < 9 || profileTotal > 54) {
      return res.status(400).json({ error: 'Total harus antara 9-54' });
    }
  }

  const data = readData();

  // If no total provided, use current total
  if (profileTotal === null) {
    profileTotal = data.total;
  }

  const distribution = calculateDistribution(profileTotal);
  const profile = {
    id: generateId(),
    name: name.trim(),
    total: profileTotal,
    distribution,
    createdAt: new Date().toISOString()
  };

  data.profiles.push(profile);
  writeData(data);

  res.status(201).json(profile);
});

// DELETE /api/profiles/:id — delete a profile
app.delete('/api/profiles/:id', verifyApiKey, (req, res) => {
  // Permission check
  if (!req.user.allowedToChange) {
    return res.status(403).json({
      error: 'Forbidden',
      message: `User ${req.user.name} tidak memiliki izin untuk action ini`
    });
  }

  const data = readData();
  const idx = data.profiles.findIndex(p => p.id === req.params.id);

  if (idx === -1) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  data.profiles.splice(idx, 1);
  if (data.activeProfileId === req.params.id) {
    data.activeProfileId = null;
  }
  writeData(data);

  res.json({ success: true });
});

// PUT /api/profiles/:id/activate — activate a profile (apply its total)
app.put('/api/profiles/:id/activate', verifyApiKey, (req, res) => {
  // Permission check
  if (!req.user.allowedToChange) {
    return res.status(403).json({
      error: 'Forbidden',
      message: `User ${req.user.name} tidak memiliki izin untuk action ini`
    });
  }

  const { targetKey } = req.body;
  const targetApiKey = targetKey || req.user.apiKey;

  const data = readData();
  const profile = data.profiles.find(p => p.id === req.params.id);

  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  if (!data.devices[targetApiKey]) {
    data.devices[targetApiKey] = { total: 9, distribution: [1,1,1,1,1,1,1,1,1], isValid: true, activeProfileId: null };
  }

  const previousTotal = data.devices[targetApiKey].total;

  data.devices[targetApiKey].total = profile.total;
  data.devices[targetApiKey].distribution = profile.distribution;
  data.devices[targetApiKey].isValid = true;
  data.devices[targetApiKey].activeProfileId = profile.id;

  // Backup before write
  createBackup();

  writeData(data);

  // Log history with user info
  addHistoryEntry(previousTotal, profile.total, getClientIp(req), req.user);

  // Fire webhooks
  fireWebhooks({ total: profile.total, distribution: profile.distribution, targetKey: targetApiKey });

  const freshData = readData();
  const freshDeviceData = freshData.devices[targetApiKey];
  res.json({
    total: freshDeviceData.total,
    distribution: freshDeviceData.distribution,
    isValid: freshDeviceData.isValid,
    activeProfileId: freshDeviceData.activeProfileId,
    activatedProfile: profile.name
  });
});

// ─── Webhooks ─────────────────────────────────────────────────────────

// GET /api/webhooks — list all webhooks
app.get('/api/webhooks', verifyApiKey, (_req, res) => {
  const data = readData();
  res.json({ webhooks: data.webhooks });
});

// POST /api/webhooks — register a webhook URL
app.post('/api/webhooks', verifyApiKey, (req, res) => {
  // Permission check
  if (!req.user.allowedToChange) {
    return res.status(403).json({
      error: 'Forbidden',
      message: `User ${req.user.name} tidak memiliki izin untuk action ini`
    });
  }

  const { url: webhookUrl } = req.body;

  if (!webhookUrl || typeof webhookUrl !== 'string') {
    return res.status(400).json({ error: 'Field "url" is required' });
  }

  // Validate URL
  try {
    new URL(webhookUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  const data = readData();

  // Prevent duplicates
  if (data.webhooks.some(w => w.url === webhookUrl)) {
    return res.status(409).json({ error: 'Webhook URL already registered' });
  }

  const webhook = {
    id: generateId(),
    url: webhookUrl,
    createdAt: new Date().toISOString()
  };

  data.webhooks.push(webhook);
  writeData(data);

  res.status(201).json(webhook);
});

// DELETE /api/webhooks/:id — remove a webhook
app.delete('/api/webhooks/:id', verifyApiKey, (req, res) => {
  // Permission check
  if (!req.user.allowedToChange) {
    return res.status(403).json({
      error: 'Forbidden',
      message: `User ${req.user.name} tidak memiliki izin untuk action ini`
    });
  }

  const data = readData();
  const idx = data.webhooks.findIndex(w => w.id === req.params.id);

  if (idx === -1) {
    return res.status(404).json({ error: 'Webhook not found' });
  }

  data.webhooks.splice(idx, 1);
  writeData(data);

  res.json({ success: true });
});

// ─── History ──────────────────────────────────────────────────────────

// GET /api/history — get change log (with optional ?limit=N)
app.get('/api/history', verifyApiKey, (req, res) => {
  const data = readData();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({
    history: data.history.slice(0, limit),
    totalEntries: data.history.length
  });
});

// ─── Admin: API Key Management ───────────────────────────────────────

/**
 * Middleware: require admin privileges (allowedToChange === true).
 * Must be used AFTER verifyApiKey.
 */
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.allowedToChange) {
    return res.status(403).json({
      error: 'Forbidden',
      message: `User ${req.user?.name || 'unknown'} tidak memiliki izin admin`
    });
  }
  next();
}

// GET /api/admin/keys — list all API keys
app.get('/api/admin/keys', verifyApiKey, requireAdmin, (_req, res) => {
  const users = readUsers();
  const unmasked = users.map(u => ({
    apiKey: u.apiKey, // Do not mask so frontend can use it for edit/delete
    name: u.name,
    device: u.device,
    createdAt: u.createdAt,
    allowedToChange: u.allowedToChange
  }));
  res.json({ users: unmasked });
});

// POST /api/admin/keys — create a new API key
app.post('/api/admin/keys', verifyApiKey, requireAdmin, (req, res) => {
  const { name, device, allowedToChange } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Field "name" is required' });
  }

  if (!device || typeof device !== 'string' || device.trim().length === 0) {
    return res.status(400).json({ error: 'Field "device" is required' });
  }

  const users = readUsers();

  // Check for duplicate name+device
  if (users.some(u => u.name === name.trim() && u.device === device.trim())) {
    return res.status(409).json({ error: 'User with same name and device already exists' });
  }

  const apiKey = generateApiKey(name.trim());
  const newUser = {
    apiKey,
    name: name.trim(),
    device: device.trim(),
    createdAt: new Date().toISOString(),
    allowedToChange: allowedToChange === true
  };

  users.push(newUser);
  writeUsers(users);

  console.log(`[${new Date().toISOString()}] 🔑 NEW KEY created by ${req.user.name}: ${newUser.name} (${newUser.device})`);

  // Return with full key visible ONCE so admin can copy it
  res.status(201).json({
    apiKey: newUser.apiKey,
    name: newUser.name,
    device: newUser.device,
    createdAt: newUser.createdAt,
    allowedToChange: newUser.allowedToChange
  });
});

// DELETE /api/admin/keys/:apiKey — delete an API key
app.delete('/api/admin/keys/:apiKey', verifyApiKey, requireAdmin, (req, res) => {
  const targetKey = req.params.apiKey;
  const users = readUsers();
  const idx = users.findIndex(u => u.apiKey === targetKey);

  if (idx === -1) {
    return res.status(404).json({ error: 'API Key not found' });
  }

  // Prevent self-deletion
  if (users[idx].apiKey === req.user.apiKey) {
    return res.status(400).json({ error: 'Tidak bisa menghapus API Key sendiri' });
  }

  const deleted = users.splice(idx, 1)[0];
  writeUsers(users);

  console.log(`[${new Date().toISOString()}] 🗑️ KEY deleted by ${req.user.name}: ${deleted.name} (${deleted.device})`);

  res.json({ success: true, deleted: { name: deleted.name, device: deleted.device } });
});

// PUT /api/admin/keys/:apiKey — update an API key permission
app.put('/api/admin/keys/:apiKey', verifyApiKey, requireAdmin, (req, res) => {
  const targetKey = req.params.apiKey;
  const { allowedToChange } = req.body;

  if (typeof allowedToChange !== 'boolean') {
    return res.status(400).json({ error: 'Field "allowedToChange" must be a boolean' });
  }

  const users = readUsers();
  const idx = users.findIndex(u => u.apiKey === targetKey);

  if (idx === -1) {
    return res.status(404).json({ error: 'API Key not found' });
  }

  // Prevent self-demotion
  if (users[idx].apiKey === req.user.apiKey && !allowedToChange) {
    return res.status(400).json({ error: 'Tidak bisa menghapus akses admin pada diri sendiri' });
  }

  users[idx].allowedToChange = allowedToChange;
  writeUsers(users);

  console.log(`[${new Date().toISOString()}] 🛠️ KEY UPDATED by ${req.user.name}: ${users[idx].name} -> allowedToChange=${allowedToChange}`);

  res.json({
    success: true,
    user: {
      name: users[idx].name,
      device: users[idx].device,
      allowedToChange: users[idx].allowedToChange
    }
  });
});

// ─── Dice State (for Chrome extension sync) ──────────────────────────

const DICE_STATE_FILE = path.join(__dirname, 'dice-state.json');

function getDefaultDiceState() {
  return {
    activeDataset: 1,
    dataset1: [2, 6, 2, 5, 1, 6, 1, 3, 2],
    dataset2: [4, 6, 8, 10, 12, 20],
    enabled: true,
    rollTriggerCount: 0,
  };
}

function initDiceStateFile() {
  if (!fs.existsSync(DICE_STATE_FILE)) {
    fs.writeFileSync(DICE_STATE_FILE, JSON.stringify(getDefaultDiceState(), null, 2));
  }
}

function readDiceState() {
  try {
    const raw = fs.readFileSync(DICE_STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    initDiceStateFile();
    return readDiceState();
  }
}

function writeDiceState(state) {
  fs.writeFileSync(DICE_STATE_FILE, JSON.stringify(state, null, 2));
}

// GET /api/dice-state — extension polls this
app.get('/api/dice-state', verifyApiKey, (_req, res) => {
  const ds = readDiceState();
  const values = ds.activeDataset === 1 ? ds.dataset1 : ds.dataset2;
  const maxFaces = ds.activeDataset === 2 ? 20 : 6;
  res.json({
    activeDataset: ds.activeDataset,
    values,
    enabled: ds.enabled,
    maxFaces,
    rollTriggerCount: ds.rollTriggerCount,
    dataset1: ds.dataset1,
    dataset2: ds.dataset2,
  });
});

// POST /api/dice-state — dashboard updates values
app.post('/api/dice-state', verifyApiKey, (req, res) => {
  if (!req.user.allowedToChange) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const ds = readDiceState();
  const { activeDataset, dataset1, dataset2, enabled } = req.body;

  if (typeof activeDataset === 'number' && (activeDataset === 1 || activeDataset === 2)) {
    ds.activeDataset = activeDataset;
  }
  if (Array.isArray(dataset1)) {
    ds.dataset1 = dataset1.map(v => Math.max(1, Math.min(6, Number(v) || 1)));
    // Ensure exactly 9 values
    while (ds.dataset1.length < 9) ds.dataset1.push(1);
    ds.dataset1 = ds.dataset1.slice(0, 9);
  }
  if (Array.isArray(dataset2)) {
    const maxes = [4, 6, 8, 10, 12, 20];
    ds.dataset2 = dataset2.map((v, i) => Math.max(1, Math.min(maxes[i] || 20, Number(v) || 1)));
    while (ds.dataset2.length < 6) ds.dataset2.push(1);
    ds.dataset2 = ds.dataset2.slice(0, 6);
  }
  if (typeof enabled === 'boolean') {
    ds.enabled = enabled;
  }

  writeDiceState(ds);

  // Set activeMode to dice_controller for the target device
  const targetKey = req.body.targetKey || req.user.apiKey;
  const data = readData();
  if (data.devices[targetKey]) {
    data.devices[targetKey].activeMode = 'dice_controller';
    data.devices[targetKey].overrideEnabled = ds.enabled !== false;
    writeData(data);
  }

  const values = ds.activeDataset === 1 ? ds.dataset1 : ds.dataset2;
  const maxFaces = ds.activeDataset === 2 ? 20 : 6;
  res.json({
    activeDataset: ds.activeDataset,
    values,
    enabled: ds.enabled,
    maxFaces,
    rollTriggerCount: ds.rollTriggerCount,
    dataset1: ds.dataset1,
    dataset2: ds.dataset2,
    activeMode: 'dice_controller'
  });
});

// POST /api/roll — dashboard triggers a roll
app.post('/api/roll', verifyApiKey, (req, res) => {
  if (!req.user.allowedToChange) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const ds = readDiceState();
  ds.rollTriggerCount = (ds.rollTriggerCount || 0) + 1;
  writeDiceState(ds);

  // Switch to dice_controller mode
  const targetKey = req.body.targetKey || req.user.apiKey;
  const data = readData();
  if (data.devices[targetKey]) {
    data.devices[targetKey].activeMode = 'dice_controller';
    writeData(data);
  }

  console.log(`[${new Date().toISOString()}] 🎲 ROLL triggered by ${req.user.name} (count: ${ds.rollTriggerCount})`);

  res.json({
    rollTriggerCount: ds.rollTriggerCount,
    message: 'Roll command sent to extension',
  });
});

// ─── WhatsApp Bot Routes ──────────────────────────────────────────────
const botEngine = require('./bot-engine');

app.get('/bot', (req, res) => res.sendFile(path.join(__dirname, 'public', 'bot-dashboard.html')));
app.get('/bot-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'bot-dashboard.html')));

// Alias for easier access; the console mentions '/dashboard'
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'bot-dashboard.html')));

app.get('/api/bot/status', (req, res) => {
  res.json({
    status: botEngine.connectionStatus,
    qrDataUrl: botEngine.qrDataUrl,
    pairingCode: botEngine.pairingCode,
    logs: botEngine.logs || []
  });
});

app.get('/api/bot/logs', (req, res) => {
  res.json({ logs: botEngine.logs || [] });
});

app.post('/api/bot/pair', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Nomor HP diperlukan' });
    const code = await botEngine.requestPairingCode(phoneNumber);
    res.json({ success: true, pairingCode: code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bot/logout', async (req, res) => {
  try {
    await botEngine.logoutSession();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bot/join-group', async (req, res) => {
  try {
    const { link } = req.body;
    if (!link) return res.status(400).json({ error: 'Link grup diperlukan' });
    const jid = await botEngine.joinGroup(link);
    res.json({ success: true, jid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bot/groups', async (req, res) => {
  try {
    const groups = await botEngine.getJoinedGroups();
    res.json({
      groups,
      targetGroupJid: botEngine.state.settings.targetGroupJid || botEngine.state.settings.activeGroupJid || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bot/target-group', (req, res) => {
  const { groupJid } = req.body;
  botEngine.state.settings.targetGroupJid = groupJid || '';
  if (groupJid) botEngine.state.settings.activeGroupJid = groupJid;
  botEngine.saveState();
  res.json({ success: true });
});

app.get('/api/bot/group-members', async (req, res) => {
  try {
    const members = await botEngine.getGroupMembers(req.query.groupJid);
    res.json({ members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bot/state', (req, res) => {
  const templateId = req.query.templateId;
  res.json({
    ...botEngine.state,
    lwText: botEngine.generateLwText(templateId)
  });
});

// ─── Template LW Endpoints ───────────────────────────────────────────

app.post('/api/bot/template', (req, res) => {
  const { id, name, headerTitle, subHeader } = req.body;
  if (!name || !headerTitle) {
    return res.status(400).json({ error: 'Nama template dan Header Title harus diisi' });
  }

  if (!botEngine.state.templates) botEngine.state.templates = [];

  const existingIdx = id ? botEngine.state.templates.findIndex(t => t.id === id) : -1;
  const tplId = existingIdx >= 0 ? id : 'tpl_' + Date.now();

  const tplData = {
    id: tplId,
    name: name.trim(),
    headerTitle: headerTitle,
    subHeader: subHeader || ''
  };

  if (existingIdx >= 0) {
    botEngine.state.templates[existingIdx] = tplData;
  } else {
    botEngine.state.templates.push(tplData);
  }

  // If active template missing, set active to this template
  if (!botEngine.state.settings.activeTemplateId) {
    botEngine.state.settings.activeTemplateId = tplId;
  }

  botEngine.saveState();
  res.json({ success: true, template: tplData });
});

app.delete('/api/bot/template/:id', (req, res) => {
  const { id } = req.params;
  if (!botEngine.state.templates) botEngine.state.templates = [];

  botEngine.state.templates = botEngine.state.templates.filter(t => t.id !== id);

  // If active template was deleted, reset active template
  if (botEngine.state.settings.activeTemplateId === id) {
    botEngine.state.settings.activeTemplateId = botEngine.state.templates[0]?.id || 'tpl_default';
  }

  botEngine.saveState();
  res.json({ success: true });
});

app.post('/api/bot/active-template', (req, res) => {
  const { templateId } = req.body;
  if (!templateId) return res.status(400).json({ error: 'templateId required' });
  botEngine.state.settings.activeTemplateId = templateId;
  botEngine.saveState();
  res.json({ success: true });
});

// ─── Manual Admin Endpoints ──────────────────────────────────────────

app.post('/api/bot/admin', (req, res) => {
  const { id, name, number, templateId } = req.body;
  if (!name || !number) {
    return res.status(400).json({ error: 'Nama Admin dan Nomor HP harus diisi' });
  }

  if (!botEngine.state.admins) botEngine.state.admins = [];

  const existingIdx = id ? botEngine.state.admins.findIndex(a => a.id === id) : -1;
  const adminId = existingIdx >= 0 ? id : 'admin_' + Date.now();

  const cleanNum = number.replace(/[^0-9]/g, '');

  const existingObj = existingIdx >= 0 ? botEngine.state.admins[existingIdx] : {};

  const adminData = {
    id: adminId,
    name: name.trim(),
    number: cleanNum,
    templateId: templateId || '',
    enabled: existingObj.enabled !== undefined ? existingObj.enabled : true
  };

  if (existingIdx >= 0) {
    botEngine.state.admins[existingIdx] = adminData;
  } else {
    botEngine.state.admins.push(adminData);
  }

  botEngine.saveState();
  res.json({ success: true, admin: adminData });
});

app.post('/api/bot/admin-toggle', (req, res) => {
  const { id, enabled } = req.body;
  if (!botEngine.state.admins) botEngine.state.admins = [];
  const admin = botEngine.state.admins.find(a => a.id === id);
  if (admin) {
    admin.enabled = enabled !== false;
    botEngine.saveState();
    res.json({ success: true, enabled: admin.enabled });
  } else {
    res.status(404).json({ error: 'Admin tidak ditemukan' });
  }
});

app.delete('/api/bot/admin/:id', (req, res) => {
  const { id } = req.params;
  if (!botEngine.state.admins) botEngine.state.admins = [];

  botEngine.state.admins = botEngine.state.admins.filter(a => a.id !== id);
  botEngine.saveState();
  res.json({ success: true });
});

// ─── Custom Command Endpoints ────────────────────────────────────────

app.post('/api/bot/custom-command', (req, res) => {
  const { id, trigger, response, adminOnly } = req.body;
  if (!trigger || !response) {
    return res.status(400).json({ error: 'Command Trigger dan Respon Teks harus diisi' });
  }

  if (!botEngine.state.customCommands) botEngine.state.customCommands = [];

  const existingIdx = id ? botEngine.state.customCommands.findIndex(c => c.id === id) : -1;
  const cmdId = existingIdx >= 0 ? id : 'cmd_' + Date.now();

  const cleanTrigger = trigger.replace(/^[.\s]+/, '').trim().toLowerCase();

  const cmdData = {
    id: cmdId,
    trigger: cleanTrigger,
    response: response,
    adminOnly: !!adminOnly
  };

  if (existingIdx >= 0) {
    botEngine.state.customCommands[existingIdx] = cmdData;
  } else {
    botEngine.state.customCommands.push(cmdData);
  }

  botEngine.saveState();
  res.json({ success: true, command: cmdData });
});

app.delete('/api/bot/custom-command/:id', (req, res) => {
  const { id } = req.params;
  if (!botEngine.state.customCommands) botEngine.state.customCommands = [];
  botEngine.state.customCommands = botEngine.state.customCommands.filter(c => c.id !== id);
  botEngine.saveState();
  res.json({ success: true });
});

app.post('/api/bot/deposit', (req, res) => {
  const { player, amount } = req.body;
  if (!player || !amount || isNaN(amount)) {
    return res.status(400).json({ error: 'Player name and numeric amount required' });
  }
  const normName = player.trim().toUpperCase();
  const numAmount = parseInt(amount, 10);
  const current = botEngine.state.players[normName] || 0;
  botEngine.state.players[normName] = current + numAmount;
  botEngine.state.deposits.push({
    player: normName,
    amount: numAmount,
    newSaldo: current + numAmount,
    timestamp: new Date().toISOString()
  });
  botEngine.saveState();
  res.json({ success: true, newSaldo: current + numAmount });
});

app.post('/api/bot/player-saldo', (req, res) => {
  const { name, saldo } = req.body;
  if (!name || isNaN(saldo)) {
    return res.status(400).json({ error: 'Invalid name or saldo' });
  }
  const normName = name.trim().toUpperCase();
  botEngine.state.players[normName] = parseInt(saldo, 10);
  botEngine.saveState();
  res.json({ success: true });
});

app.delete('/api/bot/player/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name).trim().toUpperCase();
  if (botEngine.state.players.hasOwnProperty(name)) {
    delete botEngine.state.players[name];
    botEngine.saveState();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Pemain tidak ditemukan' });
  }
});

app.post('/api/bot/settings', (req, res) => {
  const { prefix, headerTitle, activeTemplateId } = req.body;
  if (prefix) botEngine.state.settings.prefix = prefix;
  if (headerTitle) botEngine.state.settings.headerTitle = headerTitle;
  if (activeTemplateId) botEngine.state.settings.activeTemplateId = activeTemplateId;
  botEngine.saveState();
  res.json({ success: true });
});

app.post('/api/bot/send-lw', async (req, res) => {
  try {
    const { templateId } = req.body;
    await botEngine.handleSendLw(null, templateId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bot/reset-game', (req, res) => {
  botEngine.state.games = [];
  botEngine.state.currentGameNumber = 1;
  botEngine.state.lastBet = null;
  botEngine.saveState();
  res.json({ success: true });
});

// Start WhatsApp Socket
botEngine.startSocket();

// ─── Start ────────────────────────────────────────────────────────────

initUsersFile();
initDataFile();
initBackupsDir();
initDiceStateFile();


// ─── Start ────────────────────────────────────────────────────────────

http.createServer(app).listen(PORT, () => {
  console.log(`\n  🎲 Dice Dashboard Server`);
  console.log(`  ─────────────────────────`);
  console.log(`  Local:     http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`  Health:    http://localhost:${PORT}/health`);
  console.log(`  Backups:   ${BACKUPS_DIR}`);
  const users = readUsers();
  console.log(`\n  🔑 API Keys (${users.length}):`);
  users.forEach(u => {
    const perm = u.allowedToChange ? '✅ read+write' : '🔒 read-only';
    console.log(`     ${u.name} (${u.device}): ${u.apiKey} — ${perm}`);
  });
  console.log('');
});
