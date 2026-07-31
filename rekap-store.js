const fs = require('fs');
const path = require('path');

const REKAP_FILE = path.join(__dirname, 'rekap-data.json');

function initRekapFile() {
  if (!fs.existsSync(REKAP_FILE)) {
    fs.writeFileSync(REKAP_FILE, JSON.stringify([], null, 2));
  }
}

function getRekapData() {
  initRekapFile();
  try {
    const raw = fs.readFileSync(REKAP_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading rekap-data.json:', err);
    return [];
  }
}

function saveRekapData(data) {
  try {
    fs.writeFileSync(REKAP_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving rekap-data.json:', err);
  }
}

/**
 * Parse text like:
 * Main + fee
 * 26 jul -> 140
 * 27 jul -> 223
 * 29 jul -> 170
 * 30 jul -> 199
 */
function parseEarnText(rawText) {
  if (!rawText) return { category: 'Main + fee', entries: [] };
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  let category = 'Main + fee';
  const entries = [];

  const monthMap = {
    jan: 1, januari: 1, january: 1,
    feb: 2, februari: 2, february: 2,
    mar: 3, maret: 3, march: 3,
    apr: 4, april: 4,
    mei: 5, may: 5,
    jun: 6, juni: 6, june: 6,
    jul: 7, juli: 7, july: 7,
    agu: 8, agt: 8, agustus: 8, aug: 8, august: 8,
    sep: 9, september: 9,
    okt: 10, oct: 10, oktober: 10, october: 10,
    nov: 11, november: 11,
    des: 12, dec: 12, desember: 12, december: 12
  };

  const currentYear = new Date().getFullYear();

  for (let line of lines) {
    if (line.toLowerCase().startsWith('.earn') || line.toLowerCase().startsWith('.rekap')) {
      line = line.replace(/^\.(earn|rekap)\s*/i, '').trim();
      if (!line) continue;
    }

    // Matches: "26 jul -> 140", "26 jul = 140", "26/07: 140", "26 jul 140", "26 jul - 140"
    const entryMatch = line.match(/^(\d{1,2}\s+[a-zA-Z]+|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\s*(?:->|=|:|-|\s+)\s*([\d\.\,\s]+[kKmMbBtT]?)(?:\s+(.*))?$/i);

    if (entryMatch) {
      const dateStr = entryMatch[1].trim();
      const amountStr = entryMatch[2].trim();
      const note = (entryMatch[3] || '').trim();

      // Parse amount
      let amount = 0;
      const lowerAmt = amountStr.toLowerCase();
      let multiplier = 1;
      if (lowerAmt.endsWith('k')) {
        multiplier = 1000;
      } else if (lowerAmt.endsWith('m')) {
        multiplier = 1000000;
      }
      const numericPart = lowerAmt.replace(/[^0-9\.]/g, '');
      amount = parseFloat(numericPart) * multiplier;

      // Parse date
      let dateIso = null;

      const numDateMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
      if (numDateMatch) {
        const day = parseInt(numDateMatch[1], 10);
        const month = parseInt(numDateMatch[2], 10);
        let year = numDateMatch[3] ? parseInt(numDateMatch[3], 10) : currentYear;
        if (year < 100) year += 2000;
        dateIso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      } else {
        const textDateMatch = dateStr.match(/^(\d{1,2})\s+([a-zA-Z]+)$/i);
        if (textDateMatch) {
          const day = parseInt(textDateMatch[1], 10);
          const mStr = textDateMatch[2].toLowerCase();
          const month = monthMap[mStr] || (new Date().getMonth() + 1);
          dateIso = `${currentYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
      }

      if (!dateIso) {
        dateIso = new Date().toISOString().split('T')[0];
      }

      if (!isNaN(amount) && amount >= 0) {
        entries.push({
          dateRaw: dateStr,
          dateIso,
          amount,
          note
        });
      }
    } else {
      if (line && !line.includes('->') && !line.includes('=')) {
        category = line;
      }
    }
  }

  return { category, entries };
}

function addOrUpdateEntries(category, entries, source = 'bot') {
  const data = getRekapData();
  const addedOrUpdated = [];

  for (const entry of entries) {
    const existingIdx = data.findIndex(
      item => item.category.toLowerCase() === category.toLowerCase() && item.dateIso === entry.dateIso
    );

    if (existingIdx >= 0) {
      data[existingIdx].amount = entry.amount;
      data[existingIdx].dateRaw = entry.dateRaw;
      if (entry.note) data[existingIdx].note = entry.note;
      data[existingIdx].updatedAt = new Date().toISOString();
      data[existingIdx].source = source;
      addedOrUpdated.push(data[existingIdx]);
    } else {
      const newItem = {
        id: 'rk_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        category: category || 'Main + fee',
        dateRaw: entry.dateRaw,
        dateIso: entry.dateIso,
        amount: entry.amount,
        note: entry.note || '',
        createdAt: new Date().toISOString(),
        source: source
      };
      data.push(newItem);
      addedOrUpdated.push(newItem);
    }
  }

  data.sort((a, b) => (a.dateIso > b.dateIso ? 1 : -1));
  saveRekapData(data);
  return addedOrUpdated;
}

function addSingleEntry(item) {
  const data = getRekapData();
  const newItem = {
    id: item.id || ('rk_' + Date.now() + '_' + Math.floor(Math.random() * 1000)),
    category: item.category || 'Main + fee',
    dateRaw: item.dateRaw || item.dateIso,
    dateIso: item.dateIso,
    amount: Number(item.amount) || 0,
    note: item.note || '',
    createdAt: item.createdAt || new Date().toISOString(),
    source: item.source || 'web'
  };

  // Overwrite if same category & dateIso exists
  const existingIdx = data.findIndex(
    x => x.category.toLowerCase() === newItem.category.toLowerCase() && x.dateIso === newItem.dateIso
  );

  if (existingIdx >= 0) {
    data[existingIdx] = {
      ...data[existingIdx],
      ...newItem,
      updatedAt: new Date().toISOString()
    };
  } else {
    data.push(newItem);
  }

  data.sort((a, b) => (a.dateIso > b.dateIso ? 1 : -1));
  saveRekapData(data);
  return newItem;
}

function updateSingleEntry(id, updatedFields) {
  const data = getRekapData();
  const idx = data.findIndex(i => i.id === id);
  if (idx < 0) return null;

  data[idx] = {
    ...data[idx],
    ...updatedFields,
    updatedAt: new Date().toISOString()
  };
  data.sort((a, b) => (a.dateIso > b.dateIso ? 1 : -1));
  saveRekapData(data);
  return data[idx];
}

function deleteSingleEntry(id) {
  let data = getRekapData();
  const initialLen = data.length;
  data = data.filter(i => i.id !== id);
  if (data.length !== initialLen) {
    saveRekapData(data);
    return true;
  }
  return false;
}

function clearAllRekap() {
  saveRekapData([]);
  return true;
}

function getSummaryStats() {
  const data = getRekapData();
  const totalIncome = data.reduce((sum, item) => sum + (item.amount || 0), 0);

  const currentMonthStr = new Date().toISOString().slice(0, 7);
  const thisMonthData = data.filter(item => (item.dateIso || '').startsWith(currentMonthStr));
  const thisMonthIncome = thisMonthData.reduce((sum, item) => sum + (item.amount || 0), 0);

  const categories = {};
  for (const item of data) {
    const cat = item.category || 'Umum';
    if (!categories[cat]) categories[cat] = 0;
    categories[cat] += item.amount || 0;
  }

  return {
    totalCount: data.length,
    totalIncome,
    thisMonthIncome,
    categories,
    data
  };
}

module.exports = {
  parseEarnText,
  getRekapData,
  saveRekapData,
  addOrUpdateEntries,
  addSingleEntry,
  updateSingleEntry,
  deleteSingleEntry,
  clearAllRekap,
  getSummaryStats
};
