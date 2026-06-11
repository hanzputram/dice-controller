const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const url = require('url');

const app = express();

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

// GET /api/total
app.get('/api/total', verifyApiKey, (req, res) => {
  const data = readData();
  const myKey = req.user.apiKey;
  const targetKey = req.query.targetKey || myKey;
  
  const myData = data.devices[targetKey] || {
    total: 9,
    distribution: [1,1,1,1,1,1,1,1,1],
    isValid: true,
    activeProfileId: null,
    overrideEnabled: true
  };
  
  res.json({
    total: myData.total,
    distribution: myData.distribution,
    isValid: myData.isValid,
    activeProfileId: myData.activeProfileId,
    overrideEnabled: myData.overrideEnabled !== false
  });
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

  const { total, targetKey, overrideEnabled } = req.body;
  const targetApiKey = targetKey || req.user.apiKey;

  const data = readData();
  if (!data.devices[targetApiKey]) {
    data.devices[targetApiKey] = { total: 9, distribution: [1,1,1,1,1,1,1,1,1], isValid: true, activeProfileId: null, overrideEnabled: true };
  }

  // Jika request hanya untuk mematikan/menyalakan override
  if (overrideEnabled !== undefined && total === undefined) {
    data.devices[targetApiKey].overrideEnabled = Boolean(overrideEnabled);
    if (!overrideEnabled) data.devices[targetApiKey].activeProfileId = null;
    writeData(data);
    return res.json({
      total: data.devices[targetApiKey].total,
      distribution: data.devices[targetApiKey].distribution,
      isValid: data.devices[targetApiKey].isValid,
      activeProfileId: data.devices[targetApiKey].activeProfileId,
      overrideEnabled: data.devices[targetApiKey].overrideEnabled
    });
  }

  if (total === undefined || total === null) {
    return res.status(400).json({
      error: 'Field "total" is required',
      isValid: false
    });
  }

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
    overrideEnabled: freshDeviceData.overrideEnabled !== false
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

// POST /api/roll — dashboard triggers a roll
app.post('/api/roll', verifyApiKey, (req, res) => {
  if (!req.user.allowedToChange) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const ds = readDiceState();
  ds.rollTriggerCount = (ds.rollTriggerCount || 0) + 1;
  writeDiceState(ds);

  console.log(`[${new Date().toISOString()}] 🎲 ROLL triggered by ${req.user.name} (count: ${ds.rollTriggerCount})`);

  res.json({
    rollTriggerCount: ds.rollTriggerCount,
    message: 'Roll command sent to extension',
  });
});

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
