const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// ─── CONFIGURA AQUÍ ───────────────────────────────────────────
const CONFIG = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  WAHA_URL:          process.env.WAHA_URL || 'http://localhost:3000',
  WAHA_SESSION:      process.env.WAHA_SESSION || 'default',
  CSV_URL:           process.env.CSV_URL ||
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vThPXYqYxXVdzAwhtqIfACyyOghZ_e4O4YE_m5jaE1Zn5TxiyBUp6Q8WL8FOy-XeKigTHFDFd_ZdYR/pub?gid=2044008320&single=true&output=csv',
  PORT:              process.env.PORT || 8080,
};
// ──────────────────────────────────────────────────────────────

// Cache del sheet (se refresca cada 5 min)
let sheetCache = { data: [], updatedAt: null };

async function fetchSheetData() {
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutos
  if (sheetCache.data.length && sheetCache.updatedAt && (Date.now() - sheetCache.updatedAt < CACHE_TTL)) {
    return sheetCache.data;
  }
  try {
    const res  = await fetch(CONFIG.CSV_URL);
    const text = await res.text();
    const rows = parseCSV(text);
    sheetCache = { data: rows, updatedAt: Date.now() };
    console.log(`[Sheet] ${rows.length} registros cargados`);
    return rows;
  } catch (e) {
    console.error('[Sheet] Error al leer CSV:', e.message);
    return sheetCache.data; // devuelve caché anterior si falla
  }
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = [];
      let cur = '', inQuote = false;
      for (const ch of line) {
        if (ch === '"') { inQuote = !inQuote; }
        else if (ch === ',' && !inQuote) { vals.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
      vals.push(cur.trim());
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (vals[i] || '').replace(/"/g, '').trim(); });
      return obj;
    })
    .filter(r => r['Placa']);
}

async function askClaude(question, sheetData) {
  const dataStr = JSON.stringify(sheetData, null, 2);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `Eres el asistente de mantenimiento vehicular de LOMU (Transportes y Maquinarias).
Respondes consultas por WhatsApp sobre el historial de mantenimiento de la flota.
Usa ÚNICAMENTE los datos del Google Sheet proporcionados.
Responde en español, de forma clara y directa. Sin markdown. Sin asteriscos. Solo texto plano.
Si no hay información de un vehículo, dilo claramente.
Fecha actual: ${new Date().toLocaleDateString('es-PE')}.

DATOS ACTUALES DEL SHEET:
${dataStr}`,
      messages: [{ role: 'user', content: question }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || 'No pude procesar la consulta.';
}

async function sendWhatsApp(chatId, message) {
  const res = await fetch(`${CONFIG.WAHA_URL}/api/sendText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: CONFIG.WAHA_SESSION,
      chatId,
      text: message,
    }),
  });
  return res.json();
}

// ─── WEBHOOK — recibe mensajes de WAHA ───────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde rápido a WAHA

  const event = req.body;

  // Solo procesar mensajes de texto entrantes (no propios)
  if (event.event !== 'message' || !event.payload) return;
  const msg = event.payload;
  if (msg.fromMe) return;
  if (msg._data?.type !== 'chat' && msg.type !== 'chat') return;

  const chatId  = msg.from;
  const text    = (msg.body || '').trim();
  if (!text) return;

  console.log(`[WA] ${chatId}: ${text}`);

  try {
    const sheetData = await fetchSheetData();
    const reply     = await askClaude(text, sheetData);
    await sendWhatsApp(chatId, reply);
    console.log(`[WA] Respondido a ${chatId}`);
  } catch (e) {
    console.error('[Bot] Error:', e.message);
    await sendWhatsApp(chatId, 'Hubo un error al consultar. Intenta de nuevo en un momento.');
  }
});

// ─── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:  'ok',
    bot:     'LOMU Mantenimiento Bot',
    records: sheetCache.data.length,
    updated: sheetCache.updatedAt ? new Date(sheetCache.updatedAt).toLocaleString('es-PE') : 'nunca',
  });
});

// Precarga el sheet al iniciar
fetchSheetData();

app.listen(CONFIG.PORT, () => {
  console.log(`Bot LOMU corriendo en puerto ${CONFIG.PORT}`);
});
