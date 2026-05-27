const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const CONFIG = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  WAHA_URL:          process.env.WAHA_URL || 'http://localhost:3000',
  WAHA_SESSION:      process.env.WAHA_SESSION || 'default',
  WAHA_API_KEY:      process.env.WAHA_API_KEY || 'waha',
  BOT_URL:           process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : process.env.BOT_URL,
  CSV_URL:           process.env.CSV_URL || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vThPXYqYxXVdzAwhtqIfACyyOghZ_e4O4YE_m5jaE1Zn5TxiyBUp6Q8WL8FOy-XeKigTHFDFd_ZdYR/pub?gid=2044008320&single=true&output=csv',
  PORT:              process.env.PORT || 8080,
};

let sheetCache = { data: [], updatedAt: null };

function wahaHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Api-Key': CONFIG.WAHA_API_KEY,
  };
}

async function fetchSheetData() {
  const CACHE_TTL = 5 * 60 * 1000;
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
    console.error('[Sheet] Error:', e.message);
    return sheetCache.data;
  }
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  return lines.slice(1).filter(l => l.trim()).map(line => {
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
  }).filter(r => r['Placa']);
}

async function askClaude(question, sheetData) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `Eres el asistente de mantenimiento vehicular de LOMU (Transportes y Maquinarias).
Respondes consultas por WhatsApp sobre el historial de mantenimiento de la flota.
Usa ÚNICAMENTE los datos del Google Sheet. Responde en español, claro y directo. Sin markdown. Solo texto plano.
Fecha actual: ${new Date().toLocaleDateString('es-PE')}.
DATOS DEL SHEET:\n${JSON.stringify(sheetData, null, 2)}`,
      messages: [{ role: 'user', content: question }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || 'No pude procesar la consulta.';
}

async function sendWhatsApp(chatId, message) {
  try {
    const res = await fetch(`${CONFIG.WAHA_URL}/api/sendText`, {
      method: 'POST',
      headers: wahaHeaders(),
      body: JSON.stringify({ session: CONFIG.WAHA_SESSION, chatId, text: message }),
    });
    return res.json();
  } catch (e) {
    console.error('[WA Send] Error:', e.message);
  }
}

async function setupWAHA() {
  await new Promise(r => setTimeout(r, 5000));
  console.log('[WAHA] Iniciando sesión...');
  try {
    // Iniciar sesión
    await fetch(`${CONFIG.WAHA_URL}/api/sessions/start`, {
      method: 'POST',
      headers: wahaHeaders(),
      body: JSON.stringify({ name: CONFIG.WAHA_SESSION }),
    });
    console.log('[WAHA] Sesión iniciada');

    // Configurar webhook
    if (CONFIG.BOT_URL) {
      await fetch(`${CONFIG.WAHA_URL}/api/sessions/${CONFIG.WAHA_SESSION}/config/update`, {
        method: 'PUT',
        headers: wahaHeaders(),
        body: JSON.stringify({
          webhooks: [{ url: `${CONFIG.BOT_URL}/webhook`, events: ['message'] }]
        }),
      });
      console.log(`[WAHA] Webhook configurado: ${CONFIG.BOT_URL}/webhook`);
    }

    // Obtener QR
    setTimeout(async () => {
      try {
        const qrRes = await fetch(`${CONFIG.WAHA_URL}/api/${CONFIG.WAHA_SESSION}/auth/qr`, {
          headers: wahaHeaders()
        });
        if (qrRes.ok) {
          console.log('[WAHA] QR disponible en: GET /qr');
        }
      } catch(e) {}
    }, 3000);

  } catch (e) {
    console.error('[WAHA Setup] Error:', e.message);
  }
}

// Endpoint para ver el QR en el navegador
app.get('/qr', async (req, res) => {
  try {
    const qrRes = await fetch(`${CONFIG.WAHA_URL}/api/${CONFIG.WAHA_SESSION}/auth/qr?format=image`, {
      headers: wahaHeaders()
    });
    if (qrRes.ok) {
      const buf = await qrRes.buffer();
      res.setHeader('Content-Type', 'image/png');
      res.send(buf);
    } else {
      res.json({ error: 'QR no disponible aún, espera 10 segundos y recarga' });
    }
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Estado de la sesión
app.get('/status', async (req, res) => {
  try {
    const r = await fetch(`${CONFIG.WAHA_URL}/api/sessions/${CONFIG.WAHA_SESSION}`, {
      headers: wahaHeaders()
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Webhook — recibe mensajes de WAHA
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const event = req.body;
  if (event.event !== 'message' || !event.payload) return;
  const msg = event.payload;
  if (msg.fromMe) return;
  if (msg.type !== 'chat') return;
  const chatId = msg.from;
  const text = (msg.body || '').trim();
  if (!text) return;
  console.log(`[WA] ${chatId}: ${text}`);
  try {
    const sheetData = await fetchSheetData();
    const reply = await askClaude(text, sheetData);
    await sendWhatsApp(chatId, reply);
  } catch (e) {
    console.error('[Bot]', e.message);
    await sendWhatsApp(chatId, 'Error al consultar. Intenta de nuevo.');
  }
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    bot: 'LOMU Mantenimiento Bot',
    records: sheetCache.data.length,
    qr: `${CONFIG.BOT_URL || ''}/qr`,
    sessionStatus: `${CONFIG.BOT_URL || ''}/status`,
  });
});

fetchSheetData();

app.listen(CONFIG.PORT, () => {
  console.log(`Bot LOMU corriendo en puerto ${CONFIG.PORT}`);
  setupWAHA();
});
