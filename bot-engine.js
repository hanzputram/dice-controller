const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const rekapStore = require('./rekap-store');

const STATE_FILE = path.join(__dirname, 'bot-state.json');
const AUTH_DIR = path.join(__dirname, 'baileys_auth_info');

class BotEngine {
  constructor() {
    this.sock = null;
    this.qrDataUrl = null;
    this.qrText = null;
    this.pairingCode = null;
    this.connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
    this.logs = [];
    this.state = this.loadState();
    this.addLog('System initialized', 'info');
  }

  addLog(message, type = 'info') {
    const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.logs.unshift({ time, message, type });
    if (this.logs.length > 100) this.logs.pop();
  }

  loadState() {
    let state = null;
    try {
      if (fs.existsSync(STATE_FILE)) {
        state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      }
    } catch (err) {
      console.error('Error loading bot-state.json:', err);
    }

    if (!state) {
      state = {
        settings: {
          prefix: '.',
          headerTitle: "M1 ONLY TOPAN\nDEV: OPPO A15S\nROLL: GOOGLE\nWIB\nLW TOPANN\nhttps://whatsapp.com/channel/0029Vb8GuT15Ejy4omsRMb2l",
          subHeader: "LW @ltovan",
          adminOnly: true,
          activeGroupJid: null,
          activeTemplateId: 'tpl_default'
        },
        currentGameNumber: 1,
        games: [],
        players: {},
        lastBet: null,
        deposits: [],
        templates: [],
        admins: []
      };
    }

    if (!state.templates) state.templates = [];
    if (!state.admins) state.admins = [];
    if (!state.customCommands) state.customCommands = [];
    if (!state.settings) state.settings = {};
    if (!state.settings.activeTemplateId) state.settings.activeTemplateId = 'tpl_default';

    // Migrate old global game/saldo data into per-admin gameState
    const hasOldGlobalData = (state.games && state.games.length > 0) ||
      (state.players && Object.keys(state.players).length > 0);

    if (hasOldGlobalData && state.admins.length > 0) {
      // Move old global data to each admin that doesn't have gameState yet
      for (const admin of state.admins) {
        if (!admin.gameState) {
          admin.gameState = {
            games: [],
            players: {},
            currentGameNumber: 1,
            lastBet: null,
            deposits: []
          };
        }
      }
      // Clear old global fields
      state.games = [];
      state.players = {};
      state.currentGameNumber = 1;
      state.lastBet = null;
      state.deposits = [];
      state.savedSaldo = null;
    }

    if (state.templates.length === 0) {
      state.templates.push({
        id: 'tpl_default',
        name: 'Template Utama',
        headerTitle: state.settings.headerTitle || "M1 ONLY TOPAN\nDEV: OPPO A15S\nROLL: GOOGLE\nWIB\nLW TOPANN\nhttps://whatsapp.com/channel/0029Vb8GuT15Ejy4omsRMb2l",
        subHeader: state.settings.subHeader || "LW @ltovan"
      });
    }

    return state;
  }

  saveState() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error('Error saving bot-state.json:', err);
    }
  }

  async logoutSession() {
    try {
      if (this.sock) {
        await this.sock.logout().catch(() => {});
      }
    } catch (e) {}
    this.connectionStatus = 'disconnected';
    this.qrDataUrl = null;
    this.qrText = null;
    this.pairingCode = null;
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    setTimeout(() => this.startSocket(), 1000);
  }

  async startSocket() {
    // Prevent multiple simultaneous reconnects
    if (this._reconnecting) return;
    this._reconnecting = true;
    
    try {
      // Close existing socket if any
      if (this.sock) {
        this.sock.ev.removeAllListeners();
        this.sock.ws?.close();
        this.sock = null;
      }
    } catch (e) {}

    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    this.connectionStatus = 'connecting';
    console.log(`Starting WhatsApp Bot with Baileys v${version.join('.')}`);
    this.addLog(`Menghubungkan ke WhatsApp (Baileys v${version.join('.')})...`, 'info');

    this.sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,
      auth: state,
      browser: Browsers.ubuntu('Chrome')
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrText = qr;
        try {
          this.qrDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
        } catch (e) {
          console.error('QR generation failed:', e);
          this.qrDataUrl = null;
        }
        this.connectionStatus = 'waiting_qr';
        console.log('WhatsApp QR Code generated. View in Web Dashboard!');
        this.addLog('QR Code baru dibuat. Siap di-scan di Web Dashboard.', 'warn');
      }

      if (connection === 'close') {
        this.connectionStatus = 'disconnected';
        this.qrDataUrl = null;
        this.qrText = null;
        this.pairingCode = null;
        this._reconnecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        console.log(`Connection closed (code: ${statusCode}). LoggedOut: ${isLoggedOut}`);
        this.addLog(`Koneksi terputus (Kode: ${statusCode || 'Unknown'}, LoggedOut: ${isLoggedOut})`, isLoggedOut ? 'error' : 'warn');
        
        if (isLoggedOut) {
          // Clear auth so fresh QR is generated on restart
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          }
        }
        // Always reconnect quickly
        setTimeout(() => this.startSocket(), 1000);
      } else if (connection === 'open') {
        this.connectionStatus = 'connected';
        this._reconnecting = false;
        this.qrDataUrl = null;
        this.qrText = null;
        console.log('✅ WhatsApp Bot Connected successfully!');
        this.addLog('✅ WhatsApp Bot Terhubung!', 'success');
      }
    });

    this.sock.ev.on('messages.upsert', async (m) => {
      for (const msg of m.messages) {
        if (!msg.message) continue;
        try {
          await this.handleMessage(msg);
        } catch (err) {
          console.error('Error in messages.upsert handler:', err?.message || err);
        }
      }
    });
  }

  async requestPairingCode(phoneNumber) {
    if (!this.sock) {
      throw new Error('Socket not initialized');
    }
    const code = await this.sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
    this.pairingCode = code;
    return code;
  }

  async joinGroup(inviteLinkOrCode) {
    if (!this.sock || this.connectionStatus !== 'connected') {
      throw new Error('Bot WhatsApp belum terhubung. Silakan scan QR code / pair terlebih dahulu.');
    }
    let code = (inviteLinkOrCode || '').trim();
    const match = code.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (match) code = match[1];

    if (!code) throw new Error('Format link grup WhatsApp tidak valid.');

    const res = await this.sock.groupAcceptInvite(code);
    if (res) {
      this.state.settings.activeGroupJid = res;
      this.saveState();
    }
    return res;
  }

  cleanPhone(num) {
    if (!num) return '';
    let digits = (num || '').split('@')[0].replace(/[^0-9]/g, '');
    if (digits.startsWith('0')) {
      digits = '62' + digits.slice(1);
    }
    return digits;
  }

  getAdminData(senderJid, groupJid = null) {
    if (!senderJid) return null;
    const sPhone = this.cleanPhone(senderJid);
    let rPhone = sPhone;
    let lPhone = sPhone;

    if (groupJid && this.groupMetadataCache && this.groupMetadataCache[groupJid]) {
      const participants = this.groupMetadataCache[groupJid].participants || [];
      const p = participants.find(x => x.id === senderJid || x.lid === senderJid);
      if (p) {
        if (p.id) rPhone = this.cleanPhone(p.id);
        if (p.lid) lPhone = this.cleanPhone(p.lid);
      }
    }

    const manualAdmin = (this.state.admins || []).find(a => {
      const adminNum = this.cleanPhone(a.number);
      if (!adminNum) return false;
      return (
        sPhone === adminNum || sPhone.endsWith(adminNum) || adminNum.endsWith(sPhone) ||
        rPhone === adminNum || rPhone.endsWith(adminNum) || adminNum.endsWith(rPhone) ||
        lPhone === adminNum || lPhone.endsWith(adminNum) || adminNum.endsWith(lPhone)
      );
    });

    return manualAdmin || null;
  }

  // Get or initialize per-admin game state (games, saldo, etc.)
  getAdminGameState(senderJid, groupJid) {
    const adminData = this.getAdminData(senderJid, groupJid);
    if (!adminData) {
      console.log(`[PER-ADMIN] No admin found for sender ${senderJid}`);
      return null;
    }
    console.log(`[PER-ADMIN] Sender ${senderJid} → Admin: ${adminData.name} (${adminData.number}), id: ${adminData.id}`);

    if (!adminData.gameState) {
      adminData.gameState = {
        games: [],
        players: {},
        currentGameNumber: 1,
        lastBet: null,
        deposits: []
      };
    }

    return adminData.gameState;
  }

  // Check if sender is BOTH a WhatsApp Group Admin AND registered in Manual Admin list with status ON
  async isAdmin(groupJid, senderJid) {
    try {
      if (!this.sock || !groupJid) return false;

      // Fetch group metadata to get actual WhatsApp group participant info & admin status
      const groupMetadata = await this.sock.groupMetadata(groupJid).catch(() => null);
      if (!groupMetadata || !groupMetadata.participants) return false;

      if (!this.groupMetadataCache) this.groupMetadataCache = {};
      this.groupMetadataCache[groupJid] = groupMetadata;

      const participant = groupMetadata.participants.find(
        (p) => p.id === senderJid || p.lid === senderJid
      );

      // REQUIREMENT 1: Must be a WhatsApp Group Admin in the WA group!
      const isGroupAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
      if (!isGroupAdmin) {
        console.log(`[ACCESS DENIED] ${senderJid} is NOT an Admin in WhatsApp Group.`);
        return false;
      }

      // Extract phone number JID and LID for matching
      const realPhoneJid = (participant && participant.id) ? participant.id : senderJid;
      const realLidJid = (participant && participant.lid) ? participant.lid : senderJid;

      const sPhone = this.cleanPhone(senderJid);
      const rPhone = this.cleanPhone(realPhoneJid);
      const lPhone = this.cleanPhone(realLidJid);

      // Find ALL matching entries in Daftar Admin Manual
      const matchingAdmins = (this.state.admins || []).filter(a => {
        const adminNum = this.cleanPhone(a.number);
        if (!adminNum) return false;
        return (
          sPhone === adminNum || sPhone.endsWith(adminNum) || adminNum.endsWith(sPhone) ||
          rPhone === adminNum || rPhone.endsWith(adminNum) || adminNum.endsWith(rPhone) ||
          lPhone === adminNum || lPhone.endsWith(adminNum) || adminNum.endsWith(lPhone)
        );
      });

      // REQUIREMENT 2: Must be registered in Daftar Admin Manual!
      if (matchingAdmins.length === 0) {
        console.log(`[ACCESS DENIED] ${senderJid} (phone: ${rPhone}) is a Group Admin, but NOT registered in Daftar Admin Manual.`);
        return false;
      }

      // REQUIREMENT 3: Status ON/OFF check. If ANY matching entry is set to OFF (enabled === false), BLOCK!
      const anyDisabled = matchingAdmins.some(a => a.enabled === false);
      if (anyDisabled) {
        console.log(`[ACCESS DENIED] ${senderJid} is registered in Manual Admins but status is set to OFF.`);
        return false;
      }

      return true;
    } catch (err) {
      console.error('Error checking admin status:', err);
      return false;
    }
  }

  async handleMessage(msg) {
    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const sender = msg.key.participant || msg.key.remoteJid;

    // Get text content
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';

    const prefix = this.state.settings.prefix || '.';

    // Check if message is a command starting with prefix
    if (!text.startsWith(prefix)) return;

    // Extract command and arguments
    const trimmed = text.slice(prefix.length).trim();
    const args = trimmed.split(/\s+/);
    const command = args[0].toLowerCase();

    // Check admin rights for group commands if adminOnly is enabled
    const admin = isGroup ? await this.isAdmin(from, sender) : true;
    console.log(`[COMMAND RECEIVED] .${command} from ${sender} in ${from} (isAdmin: ${admin})`);
    this.addLog(`Perintah .${command} dari ${sender.split('@')[0]}`, 'info');

    const isMyIdCmd = (command === 'myidq' || command === 'myid' || command === 'id');

    if (isGroup && this.state.settings.adminOnly && !admin && !isMyIdCmd) {
      console.log(`[BLOCKED NON-ADMIN] ${sender} is not authorized.`);
      this.addLog(`Akses Ditolak: ${sender.split('@')[0]} mencoba perintah .${command}`, 'warn');
      return;
    }
    // ONLY process commands from the designated target group
    if (isGroup) {
      const targetJid = this.state.settings.targetGroupJid || this.state.settings.activeGroupJid;
      if (targetJid && from !== targetJid) {
        // Silently ignore commands from non-target groups
        return;
      }
    }

    try {
      switch (command) {
        case 'c':
          await this.handleCalculateBet(from, msg, text, args, sender);
          break;
        case 'fee':
          await this.handleFeeCommand(from, msg, text, args, sender);
          break;
        case 'dp':
        case 'deposit':
          await this.handleDeposit(from, msg, args, sender);
          break;
        case 'b':
        case 'k':
          await this.handleGameResult(from, msg, command, args, sender);
          break;
        case 'lw':
          await this.handleSendLw(from, null, sender);
          break;
        case 'kick':
          if (isGroup) await this.handleKick(from, msg, args);
          break;
        case 'on':
        case 'close':
        case 'tutup':
          if (isGroup) await this.handleGroupAnnouncement(from, true);
          break;
        case 'off':
        case 'open':
        case 'buka':
          if (isGroup) await this.handleGroupAnnouncement(from, false);
          break;
        case 'myidq':
        case 'myid':
        case 'id':
          {
            let phone = sender.split('@')[0];
            let lid = sender.endsWith('@lid') ? phone : '';
            let isGroupAdmin = !isGroup;
            if (isGroup && this.sock) {
              const gm = (this.groupMetadataCache && this.groupMetadataCache[from]) || await this.sock.groupMetadata(from).catch(() => null);
              if (gm && gm.participants) {
                const p = gm.participants.find(x => x.id === sender || x.lid === sender);
                if (p) {
                  if (p.id) phone = p.id.split('@')[0];
                  if (p.lid) lid = p.lid.split('@')[0];
                  if (p.admin === 'admin' || p.admin === 'superadmin') isGroupAdmin = true;
                }
              }
            }

            if (isGroupAdmin) {
              const infoText = `📱 *INFORMASI ID WHATSAPP*\n\n` +
                `• *Nomor WA*: \`${phone}\`\n` +
                `• *ID Privasi (LID)*: \`${lid || phone}\`\n\n` +
                `_Gunakan ID Privasi (LID) di atas untuk pendaftaran Admin._`;
              await this.sock.sendMessage(from, { text: infoText }, { quoted: msg });
            }
          }
          break;
        case 'pp':
        case 'getpp':
          if (isGroup) await this.handleGetGroupPp(from);
          break;
        case 'geser':
        case 'pindah':
        case 'transfer':
          await this.handleGeserSaldo(from, msg, args, sender);
          break;
        case 'setpp':
          if (isGroup) await this.handleSetGroupPp(from, msg);
          break;
        case 'save':
          this.saveState();
          await this.sock.sendMessage(from, { text: '✅ Data bot berhasil disimpan!' }, { quoted: msg });
          break;
        case 'resetgame':
          {
            const gs = this.getAdminGameState(sender, from);
            if (!gs) break;
            gs.games = [];
            gs.currentGameNumber = 1;
            gs.lastBet = null;
            this.saveState();
            await this.sock.sendMessage(from, { text: '🔄 Permainan berhasil di-reset!' }, { quoted: msg });
          }
          break;
        case 'clear':
          await this.handleClear(from, msg, sender);
          break;
        case 's':
          await this.handleSaveLw(from, msg, sender);
          break;
        case 'earn':
        case 'rekap':
        case 'income':
          await this.handleEarnCommand(from, msg, text, sender);
          break;
        default:
          {
            const customCmd = (this.state.customCommands || []).find(
              c => c.trigger.toLowerCase() === command || c.trigger.toLowerCase() === trimmed.toLowerCase()
            );

            if (customCmd) {
              if (customCmd.adminOnly && !admin) {
                await this.sock.sendMessage(from, { text: '⚠️ Perintah ini hanya dapat digunakan oleh Admin.' }, { quoted: msg });
                break;
              }

              const gs = this.getAdminGameState(sender, from);
              let responseText = customCmd.response || '';
              const senderPhone = (sender || '').split('@')[0];
              responseText = responseText
                .replace(/{PREFIX}/g, prefix)
                .replace(/{SENDER}/g, senderPhone)
                .replace(/{GAME_COUNT}/g, gs ? gs.games.length : 0);

              await this.sock.sendMessage(from, { text: responseText }, { quoted: msg });
            }
          }
          break;
      }
    } catch (err) {
      console.error(`Error executing command .${command}:`, err);
    }
  }

  calculateFee(amount) {
    const num = parseInt(amount, 10);
    if (isNaN(num) || num < 2) return 0;
    if (num <= 9) return 1;
    return Math.floor(num / 10) + 1;
  }

  async handleFeeCommand(from, msg, text, args, sender) {
    let rawInput = '';

    // Check if command was sent as a reply to another message
    const quotedText = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
                       msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text;

    if (quotedText) {
      rawInput = quotedText;
    } else {
      // Use full text excluding ".fee"
      rawInput = text.replace(/^\.fee\s*/i, '').trim();
    }

    if (!rawInput) {
      const helpText = `💰 *PANDUAN PERINTAH .FEE*\n\n` +
        `Gunakan perintah ini untuk menghitung fee otomatis.\n\n` +
        `*Format Penggunaan:*\n` +
        `.fee\nK:\nren 10\nB:\npan 40\n\n` +
        `*Atau reply pesan taruhan dengan .fee*\n\n` +
        `📋 *DAFTAR TIER FEE:*\n` +
        `• 2 - 9 : 1\n` +
        `• 10 - 19 : 2\n` +
        `• 20 - 29 : 3\n` +
        `• 30 - 39 : 4\n` +
        `• 40 - 49 : 5\n` +
        `• 50 - 59 : 6\n` +
        `• 60 - 69 : 7\n` +
        `• 70 - 79 : 8\n` +
        `• 80 - 89 : 9\n` +
        `• 90 - 99 : 10\n` +
        `• 100 - 109 : 11\n` +
        `• (dan seterusnya per kelipatan +10)`;
      await this.sock.sendMessage(from, { text: helpText }, { quoted: msg });
      return;
    }

    const lines = rawInput.split('\n');
    let currentSide = null;
    const kList = [];
    const bList = [];
    const generalList = [];

    const hasSides = rawInput.toLowerCase().includes('k:') || rawInput.toLowerCase().includes('b:');

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      const lower = line.toLowerCase();
      if (lower.startsWith('k:') || lower === 'k') {
        currentSide = 'k';
        continue;
      } else if (lower.startsWith('b:') || lower === 'b') {
        currentSide = 'b';
        continue;
      }

      // Match player line e.g., "ren 10", "pan 40", "acik 18.lf", "aboy 25"
      const matchWithPlayer = line.match(/^([a-zA-Z0-9_\-@]+)\s+(\d+)/);
      const matchNumberOnly = line.match(/^(\d+)$/);

      if (matchWithPlayer) {
        const name = matchWithPlayer[1].toUpperCase();
        const amount = parseInt(matchWithPlayer[2], 10);
        const fee = this.calculateFee(amount);
        const item = { name, amount, fee };

        if (currentSide === 'k') kList.push(item);
        else if (currentSide === 'b') bList.push(item);
        else generalList.push(item);
      } else if (matchNumberOnly) {
        const amount = parseInt(matchNumberOnly[1], 10);
        const fee = this.calculateFee(amount);
        const item = { name: `ITEM ${generalList.length + 1}`, amount, fee };

        if (currentSide === 'k') kList.push(item);
        else if (currentSide === 'b') bList.push(item);
        else generalList.push(item);
      }
    }

    // Space-separated fallback: e.g. ".fee 10 40 25"
    if (kList.length === 0 && bList.length === 0 && generalList.length === 0) {
      const numbers = rawInput.match(/\d+/g);
      if (numbers) {
        numbers.forEach((n, idx) => {
          const amount = parseInt(n, 10);
          const fee = this.calculateFee(amount);
          generalList.push({ name: `NOMINAL ${idx + 1}`, amount, fee });
        });
      }
    }

    if (kList.length === 0 && bList.length === 0 && generalList.length === 0) {
      await this.sock.sendMessage(from, { text: '⚠️ Tidak ada nominal angka yang dapat dihitung feenya.' }, { quoted: msg });
      return;
    }

    let output = `💰 *HITUNG FEE PEMAIN*\n\n`;
    let grandTotalFee = 0;
    let grandTotalNominal = 0;

    if (hasSides || kList.length > 0 || bList.length > 0) {
      if (kList.length > 0) {
        const subKFee = kList.reduce((sum, i) => sum + i.fee, 0);
        const subKNominal = kList.reduce((sum, i) => sum + i.amount, 0);
        grandTotalFee += subKFee;
        grandTotalNominal += subKNominal;

        output += `*K:*\n`;
        for (const item of kList) {
          output += `• ${item.name} ${item.amount} ➔ Fee: ${item.fee}\n`;
        }
        output += `_Subtotal Fee K: ${subKFee}_\n\n`;
      }

      if (bList.length > 0) {
        const subBFee = bList.reduce((sum, i) => sum + i.fee, 0);
        const subBNominal = bList.reduce((sum, i) => sum + i.amount, 0);
        grandTotalFee += subBFee;
        grandTotalNominal += subBNominal;

        output += `*B:*\n`;
        for (const item of bList) {
          output += `• ${item.name} ${item.amount} ➔ Fee: ${item.fee}\n`;
        }
        output += `_Subtotal Fee B: ${subBFee}_\n\n`;
      }
    }

    if (generalList.length > 0) {
      const subGenFee = generalList.reduce((sum, i) => sum + i.fee, 0);
      const subGenNominal = generalList.reduce((sum, i) => sum + i.amount, 0);
      grandTotalFee += subGenFee;
      grandTotalNominal += subGenNominal;

      for (const item of generalList) {
        output += `• ${item.name} ${item.amount} ➔ Fee: ${item.fee}\n`;
      }
      output += `\n`;
    }

    await this.sock.sendMessage(from, { text: output.trim() }, { quoted: msg });
  }

  // Parse bet string (e.g. k:\n paruel 4\n acik 18 \n b:\n topan 9lf)
  parseBetString(rawText) {
    const lines = rawText.split('\n');
    let currentSide = null; // 'k' or 'b'
    const kList = [];
    const bList = [];

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      const lower = line.toLowerCase();
      if (lower.startsWith('k:') || lower === 'k') {
        currentSide = 'k';
        continue;
      } else if (lower.startsWith('b:') || lower === 'b') {
        currentSide = 'b';
        continue;
      }

      if (!currentSide) continue;

      // Parse player line: e.g., "paruel 4", "nama 4.", "topan 9lf", "acik 18", "aboy 5d"
      const match = line.match(/^([a-zA-Z0-9_\-@]+)\s+(\d+)\s*([\.a-zA-Z]*)$/i);
      if (match) {
        const name = match[1].toUpperCase();
        const amount = parseInt(match[2], 10);
        const suffix = (match[3] || '').toLowerCase();
        
        // 'lf' suffix triggers LF header line + Saldo Kurang
        // '.' suffix triggers Saldo Kurang
        // 'd' or plain number indicates already transferred (sudah TF to admin)
        const hasLf = suffix.includes('lf');
        const hasDot = suffix.includes('.');
        const isSaldoKurang = hasLf || hasDot;

        const item = { name, amount, hasLf, hasDot, isSaldoKurang, isLf: isSaldoKurang, raw: line };
        if (currentSide === 'k') kList.push(item);
        else if (currentSide === 'b') bList.push(item);
      }
    }

    const totalK = kList.reduce((sum, item) => sum + item.amount, 0);
    const totalB = bList.reduce((sum, item) => sum + item.amount, 0);
    const balancedAmount = Math.min(totalK, totalB);

    const allPlayers = [...kList, ...bList];
    const saldoKurangPlayers = allPlayers.filter((p) => p.isSaldoKurang);
    const lfHeaderPlayers = allPlayers.filter((p) => p.hasLf);

    return {
      kList,
      bList,
      totalK,
      totalB,
      balancedAmount,
      lfPlayers: saldoKurangPlayers,
      saldoKurangPlayers,
      lfHeaderPlayers
    };
  }

  async handleCalculateBet(from, msg, text, args, sender) {
    const gs = this.getAdminGameState(sender, from);
    if (!gs) return;

    let betText = '';

    // Check if command was sent as reply to a bet message
    const quotedText = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
                       msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text;

    if (quotedText && (quotedText.toLowerCase().includes('k:') || quotedText.toLowerCase().includes('b:'))) {
      betText = quotedText;
    } else {
      // Use full text excluding ".c"
      betText = text.replace(/^\.c\s*/i, '');
    }

    if (!betText || (!betText.toLowerCase().includes('k:') && !betText.toLowerCase().includes('b:'))) {
      return;
    }

    const parsed = this.parseBetString(betText);
    gs.lastBet = parsed;
    this.saveState();

    // Format output exactly as requested
    const formatAmounts = (list) => list.map((item) => item.amount).join(', ');
    const kAmountsStr = formatAmounts(parsed.kList);
    const bAmountsStr = formatAmounts(parsed.bList);

    let output = `✨ K : ${kAmountsStr} : ${parsed.totalK}\n`;
    output += `✨ B : ${bAmountsStr} : ${parsed.totalB}\n`;
    output += `─────────\n`;

    // Format LF & Saldo Kurang sections
    const formatLfAndSaldoKurang = () => {
      let res = '';
      if (parsed.lfHeaderPlayers.length > 0) {
        const lfNames = parsed.lfHeaderPlayers.map((p) => p.name).join(', ');
        res += `ˎˊ˗ LF : ${lfNames}\n\n`;
      }
      if (parsed.saldoKurangPlayers.length > 0) {
        res += `ˎˊ˗ SALDO KURANG :\n`;
        for (const p of parsed.saldoKurangPlayers) {
          res += `     ${p.name} -${p.amount}\n`;
        }
      }
      return res;
    };

    const extraSection = formatLfAndSaldoKurang();

    if (parsed.totalK === parsed.totalB) {
      if (extraSection) {
        output += extraSection;
      } else {
        output += `➤ Seimbang! ${parsed.totalK} vs ${parsed.totalB}`;
      }
    } else {
      const diff = Math.abs(parsed.totalK - parsed.totalB);
      const needSide = parsed.totalK > parsed.totalB ? 'B' : 'K';
      output += `➤ Tidak seimbang! ${needSide} -${diff}`;
      if (extraSection) {
        output += `\n\n` + extraSection;
      }
    }

    await this.sock.sendMessage(from, { text: output.trim() }, { quoted: msg });
  }

  async handleDeposit(from, msg, args, sender) {
    const gs = this.getAdminGameState(sender, from);
    if (!gs) return;

    // .dp acik 38
    if (args.length < 3) {
      return;
    }

    const playerName = args[1].toUpperCase();
    const amount = parseInt(args[2], 10);

    if (isNaN(amount) || amount <= 0) {
      return;
    }

    const currentSaldo = gs.players[playerName] || 0;
    const newSaldo = currentSaldo + amount;
    gs.players[playerName] = newSaldo;

    gs.deposits.push({
      player: playerName,
      amount,
      newSaldo,
      timestamp: new Date().toISOString()
    });

    this.saveState();

    const output = `*⋆ DEPOSIT partial*\n✿ PEMAIN: ${playerName}\n✿ DEPOSIT: +${amount}\n✿ SALDO: ${newSaldo}\n\n│ KETIK .LW UNTUK MELIHAT PERUBAHAN`;
    await this.sock.sendMessage(from, { text: output }, { quoted: msg });
  }

  async handleGameResult(from, msg, winSideCmd, args, sender) {
    const gs = this.getAdminGameState(sender, from);
    if (!gs) return;

    // .b 33 or .k 29
    const winSide = winSideCmd.toUpperCase(); // 'B' or 'K'
    const score = args[1] ? parseInt(args[1], 10) : 0;

    if (isNaN(score) || score <= 0) {
      return;
    }

    const bet = gs.lastBet;
    if (!bet) {
      return;
    }

    const winList = winSide === 'K' ? bet.kList : bet.bList;
    const loseList = winSide === 'K' ? bet.bList : bet.kList;

    // Balanced calculation:
    // User rule: "total balance saldo game 21 antara k dan b misal 20 vs 20 maka yang dihitung hanya 20 nya saja"
    const netGamePoints = bet.balancedAmount;

    // Update balances
    for (const winner of winList) {
      const curr = gs.players[winner.name] || 0;
      gs.players[winner.name] = curr + winner.amount;
    }

    for (const loser of loseList) {
      const curr = gs.players[loser.name] || 0;
      gs.players[loser.name] = curr - loser.amount;
    }

    const gameNumStr = String(gs.currentGameNumber).padStart(2, '0');
    const gameLabel = `GAME ${gameNumStr} : ${winSide} ${score} (${netGamePoints})`;

    gs.games.push({
      gameNumber: gs.currentGameNumber,
      winSide,
      score,
      netPoints: netGamePoints,
      label: gameLabel,
      timestamp: new Date().toISOString()
    });

    gs.currentGameNumber += 1;
    this.saveState();

    // Automatically send full .lw rekap
    await this.handleSendLw(from, null, sender);
  }

  getTemplateForSenderOrId(templateId, senderJid, groupJid) {
    if (senderJid) {
      const manualAdmin = this.getAdminData(senderJid, groupJid);
      if (manualAdmin && manualAdmin.templateId) {
        const tpl = (this.state.templates || []).find(t => t.id === manualAdmin.templateId);
        if (tpl) return tpl;
      }
    }

    if (templateId) {
      const tpl = (this.state.templates || []).find(t => t.id === templateId);
      if (tpl) return tpl;
    }

    const activeId = this.state.settings.activeTemplateId;
    const activeTpl = (this.state.templates || []).find(t => t.id === activeId);
    if (activeTpl) return activeTpl;

    if (this.state.templates && this.state.templates.length > 0) return this.state.templates[0];

    return {
      headerTitle: this.state.settings.headerTitle || "M1 ONLY TOPAN\nDEV: OPPO A15S\nROLL: GOOGLE\nWIB\nLW TOPANN\nhttps://whatsapp.com/channel/0029Vb8GuT15Ejy4omsRMb2l",
      subHeader: this.state.settings.subHeader || "LW @ltovan"
    };
  }

  generateLwText(templateId, senderJid, groupJid) {
    const tpl = this.getTemplateForSenderOrId(templateId, senderJid, groupJid);

    // Today's date in Indonesian format
    const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
      'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const now = new Date();
    const dateStr = `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;

    let text = `${tpl.headerTitle}\n\n${tpl.subHeader}\n📅 ${dateStr}\n`;

    // Get per-admin game state
    const gs = senderJid ? this.getAdminGameState(senderJid, groupJid) : null;
    const adminData = senderJid ? this.getAdminData(senderJid, groupJid) : null;

    // Show saved game history (per admin) from .s if available
    if (adminData && adminData.savedGameHistory && adminData.savedGameHistory.length > 0) {
      for (const g of adminData.savedGameHistory) {
        text += `${g.label}\n`;
      }
      if (gs && gs.games.length > 0) {
        text += `─────────\n`;
      }
    }

    // Current games history (per admin)
    if (gs) {
      for (const g of gs.games) {
        text += `${g.label}\n`;
      }
    }

    text += `\n`;

    // Calculate balances (per admin)
    const players = gs ? gs.players : {};
    const positivePlayers = [];
    const negativePlayers = [];
    let totalPositive = 0;
    let totalNegative = 0;

    for (const [name, saldo] of Object.entries(players)) {
      if (saldo > 0) {
        positivePlayers.push({ name, saldo });
        totalPositive += saldo;
      } else if (saldo < 0) {
        negativePlayers.push({ name, saldo });
        totalNegative += saldo;
      }
    }

    // Sort positive descending
    positivePlayers.sort((a, b) => b.saldo - a.saldo);
    // Sort negative ascending (most negative first)
    negativePlayers.sort((a, b) => a.saldo - b.saldo);

    text += `SALDO ${totalPositive}\n`;
    positivePlayers.forEach((p, idx) => {
      const badge = idx === 0 ? ' 👑' : '';
      text += `${p.name} ${p.saldo}${badge}\n`;
    });

    if (negativePlayers.length > 0) {
      text += `\nMINUS ${totalNegative}\n`;
      negativePlayers.forEach((p, idx) => {
        const badge = idx === 0 ? ' ☠️' : '';
        text += `${p.name} ${p.saldo}${badge}\n`;
      });
    }

    return text.trim();
  }

  async getGroupMembers(groupJid) {
    const jid = groupJid || this.state.settings.targetGroupJid || this.state.settings.activeGroupJid;
    if (!this.sock || !jid) return [];
    try {
      const groupMetadata = await this.sock.groupMetadata(jid).catch(() => null);
      if (!groupMetadata || !groupMetadata.participants) return [];
      
      return groupMetadata.participants.map(p => {
        const phone = (p.id || '').split('@')[0];
        const lid = (p.lid || '').split('@')[0];
        return {
          id: p.id,
          phone,
          lid,
          admin: p.admin || null
        };
      });
    } catch (err) {
      console.error('Error fetching group members:', err);
      return [];
    }
  }

  async getJoinedGroups() {
    if (!this.sock || this.connectionStatus !== 'connected') return [];
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      return Object.values(groups).map(g => ({
        id: g.id,
        subject: g.subject,
        size: g.participants ? g.participants.length : 0
      }));
    } catch (err) {
      console.error('Error fetching joined groups:', err);
      return [];
    }
  }

  async handleSendLw(targetJid, templateId, senderJid) {
    const jid = targetJid || this.state.settings.targetGroupJid || this.state.settings.activeGroupJid;
    if (!jid) {
      throw new Error('Belum ada grup target yang dipilih. Silakan pilih grup di Dashboard Web!');
    }
    const lwText = this.generateLwText(templateId, senderJid, jid);
    await this.sock.sendMessage(jid, { text: lwText });
  }

  async handleKick(groupJid, msg, args) {
    try {
      const quotedSender = msg.message.extendedTextMessage?.contextInfo?.participant;
      let targetJid = quotedSender;

      if (!targetJid && msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length) {
        targetJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
      }

      if (!targetJid) {
        return;
      }

      await this.sock.groupParticipantsUpdate(groupJid, [targetJid], 'remove');
      await this.sock.sendMessage(groupJid, { text: '🚫 Anggota berhasil dikeluarkan dari grup.' }, { quoted: msg });
    } catch (err) {
      console.error('Error in handleKick:', err);
      await this.sock.sendMessage(groupJid, { text: '⚠️ Bot harus menjadi admin grup untuk dapat mengeluarkan anggota (.kick).' }, { quoted: msg });
    }
  }

  async handleGroupAnnouncement(groupJid, announce) {
    try {
      const setting = announce ? 'announcement' : 'not_announcement';
      await this.sock.groupSettingUpdate(groupJid, setting);
    } catch (err) {
      console.error('Error in handleGroupAnnouncement:', err);
    }
  }

  async handleGetGroupPp(groupJid) {
    try {
      const ppUrl = await this.sock.profilePictureUrl(groupJid, 'image');
      await this.sock.sendMessage(groupJid, {
        image: { url: ppUrl },
        caption: '🖼️ Foto Profil Grup'
      });
    } catch (err) {
      await this.sock.sendMessage(groupJid, { text: '⚠️ Tidak dapat mengambil foto profil grup.' });
    }
  }

  async handleSetGroupPp(groupJid, msg) {
    try {
      const isQuotedImage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
      const isImage = msg.message.imageMessage;

      if (!isImage && !isQuotedImage) {
        return;
      }

      const mediaMessage = isImage ? msg : {
        message: msg.message.extendedTextMessage.contextInfo.quotedMessage
      };

      const stream = await downloadMediaMessage(mediaMessage, 'buffer', {});
      await this.sock.updateProfilePicture(groupJid, stream);
      await this.sock.sendMessage(groupJid, { text: '✅ Foto profil grup berhasil diperbarui!' }, { quoted: msg });
    } catch (err) {
      console.error('Error setting group profile picture:', err);
      await this.sock.sendMessage(groupJid, { text: '❌ Gagal memperbarui foto profil grup.' });
    }
  }

  async handleGeserSaldo(from, msg, args, sender) {
    const gs = this.getAdminGameState(sender, from);
    if (!gs) return;

    const rawText = args.slice(1).join(' ').trim();
    if (!rawText) {
      return;
    }

    let fromPlayer = null;
    let toPlayer = null;
    let amount = 0;

    // Pattern 1: "gun ke ken 40"
    let match = rawText.match(/^([a-zA-Z0-9_\-]+)\s+ke\s+([a-zA-Z0-9_\-]+)\s+(\d+)/i);
    if (match) {
      fromPlayer = match[1].toUpperCase();
      toPlayer = match[2].toUpperCase();
      amount = parseInt(match[3], 10);
    } else {
      // Pattern 2: "gun 40 ke ken"
      match = rawText.match(/^([a-zA-Z0-9_\-]+)\s+(\d+)\s+ke\s+([a-zA-Z0-9_\-]+)/i);
      if (match) {
        fromPlayer = match[1].toUpperCase();
        amount = parseInt(match[2], 10);
        toPlayer = match[3].toUpperCase();
      } else {
        // Pattern 3: "gun ken 40"
        match = rawText.match(/^([a-zA-Z0-9_\-]+)\s+([a-zA-Z0-9_\-]+)\s+(\d+)/i);
        if (match) {
          fromPlayer = match[1].toUpperCase();
          toPlayer = match[2].toUpperCase();
          amount = parseInt(match[3], 10);
        }
      }
    }

    if (!fromPlayer || !toPlayer || isNaN(amount) || amount <= 0) {
      return;
    }

    if (fromPlayer === toPlayer) {
      return;
    }

    const currentFromSaldo = gs.players[fromPlayer] || 0;
    const currentToSaldo = gs.players[toPlayer] || 0;

    const newFromSaldo = currentFromSaldo - amount;
    const newToSaldo = currentToSaldo + amount;

    gs.players[fromPlayer] = newFromSaldo;
    gs.players[toPlayer] = newToSaldo;

    this.saveState();

    const output = `🔄 *GESER SALDO SUCCESS*\n\n` +
      `• *Pengirim*: ${fromPlayer} (-${amount})\n` +
      `• *Penerima*: ${toPlayer} (+${amount})\n\n` +
      `📊 *Saldo Terbaru*:\n` +
      `• ${fromPlayer}: ${newFromSaldo}\n` +
      `• ${toPlayer}: ${newToSaldo}\n\n` +
      `_Ketik .lw untuk melihat rekap saldo terbaru._`;

    await this.sock.sendMessage(from, { text: output }, { quoted: msg });
  }

  async handleClear(from, msg, sender) {
    const adminData = this.getAdminData(sender, from);
    const gs = this.getAdminGameState(sender, from);
    if (!gs) return;

    // Clear ONLY this admin's game history, saldo, and saved snapshot
    gs.games = [];
    gs.currentGameNumber = 1;
    gs.lastBet = null;
    gs.deposits = [];
    gs.players = {};

    if (adminData) {
      adminData.savedGameHistory = [];
    }

    this.saveState();

    // Auto-send fresh LW for this admin
    await this.handleSendLw(from, null, sender);
  }

  async handleSaveLw(from, msg, sender) {
    // Find admin data for this sender (matched by number or LID)
    const adminData = this.getAdminData(sender, from);
    if (!adminData) return;

    const gs = this.getAdminGameState(sender, from);
    if (!gs) return;

    // Save only the game history to this admin's record
    adminData.savedGameHistory = JSON.parse(JSON.stringify(gs.games));
    this.saveState();

    const gameCount = gs.games.length;
    let gameList = '';
    if (gameCount > 0) {
      gameList = gs.games.map(g => `  ${g.label}`).join('\n');
    } else {
      gameList = '  (tidak ada game)';
    }

    const adminName = adminData.name || adminData.number;
    const output = `💾 *HISTORY LW BERHASIL DISIMPAN*\n\n` +
      `👤 *Admin:* ${adminName}\n` +
      `📋 *${gameCount} game* tersimpan:\n${gameList}\n\n` +
      `_History ini akan tampil di LW baru saat .clear digunakan._`;

    await this.sock.sendMessage(from, { text: output }, { quoted: msg });
  }

  async handleEarnCommand(from, msg, text, sender) {
    const quotedText = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
                       msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text;

    let rawText = '';
    if (quotedText) {
      rawText = quotedText;
    } else {
      rawText = text.replace(/^\.(earn|rekap|income)\s*/i, '');
    }

    if (!rawText || !rawText.trim()) {
      const replyText = `⚠️ *FORMAT SALAH*\n\nReply pesan rekap dengan command *.earn* atau ketik langsung:\n\n.earn\nMain + fee\n26 jul -> 140\n27 jul -> 223`;
      await this.sock.sendMessage(from, { text: replyText }, { quoted: msg });
      return;
    }

    const { category, entries } = rekapStore.parseEarnText(rawText);

    if (!entries || entries.length === 0) {
      const replyText = `⚠️ *TIDAK ADA DATA REKAP DITEMUKAN*\n\nPastikan format teks berisi baris seperti:\n\`26 jul -> 140\``;
      await this.sock.sendMessage(from, { text: replyText }, { quoted: msg });
      return;
    }

    rekapStore.addOrUpdateEntries(category, entries, 'whatsapp_bot');
    const stats = rekapStore.getSummaryStats();

    let responseStr = `📊 *REKAP PENDAPATAN DICATAT*\n\n`;
    responseStr += `🏷️ *Kategori*: ${category}\n`;
    responseStr += `───────────────────\n`;

    let batchTotal = 0;
    for (const item of entries) {
      responseStr += `• *${item.dateRaw}*: +${item.amount.toLocaleString('id-ID')}\n`;
      batchTotal += item.amount;
    }

    responseStr += `───────────────────\n`;
    responseStr += `💰 *Subtotal Input*: ${batchTotal.toLocaleString('id-ID')}\n`;
    responseStr += `📈 *Total Bulan Ini*: ${stats.thisMonthIncome.toLocaleString('id-ID')}\n`;
    responseStr += `🏆 *Total Keseluruhan*: ${stats.totalIncome.toLocaleString('id-ID')}\n\n`;
    const rekapUrl = this.state?.settings?.webRekapUrl || 'https://aasjdhov.my.id/rekap';
    responseStr += `🌐 *Web Rekap*: ${rekapUrl}`;

    await this.sock.sendMessage(from, { text: responseStr }, { quoted: msg });
  }
}

module.exports = new BotEngine();
