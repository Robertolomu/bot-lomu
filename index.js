'use strict';

const express   = require('express');
const axios     = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const PORT      = process.env.PORT || 3000;
const WAHA_URL  = (process.env.WAHA_URL  || '').replace(/\/$/, '');
const SESSION   = process.env.WAHA_SESSION || 'default';
const WAHA_KEY  = process.env.WAHA_API_KEY || '';
const BOT_URL   = (process.env.BOT_URL   || '').replace(/\/$/, '');
const SHEET_URL = process.env.SHEET_CSV_URL || '';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const app = express();
app.use(express.json());

let records   = [];
let lastFetch = null;

function wahaH() {
  const h = { 'Content-Type': 'application/json' };
  if (WAHA_KEY) h['X-Api-Key'] = WAHA_KEY;
  return h;
}

// ── Google Sheets ─────────────────────────────────────────────────────────────
async function loadSheet() {
  if (!SHEET_URL) { console.warn('[SHEET] SHEET_CSV_URL no configurada'); return; }
  try {
    const res   = await axios.get(SHEET_URL, { timeout: 15000 });
    const lines = res.data.trim().split('\n');
    if (lines.length < 2) return;
    const hdrs = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    records = lines.slice(1).map(line => {
      const cols = line.match(/(".*?"|[^,]+)(?=\s*,|\s*$)/g) || line.split(',');
      const o = {};
      hdrs.forEach((h, i) => { o[h] = (cols[i] || '').trim().replace(/^"|"$/g, ''); });
      return o;
    });
    lastFetch = new Date().toISOString();
    console.log(`[SHEET] ${records.length} registros cargados`);
  } catch (e) {
    console.error('[SHEET] Error:', e.message);
  }
}
loadSheet();
setInterval(loadSheet, 10 * 60 * 1000);

// ── WAHA helpers ──────────────────────────────────────────────────────────────
async function wahaGet(path) {
  return axios.get(WAHA_URL + path, { headers: wahaH(), timeout: 8000 });
}
async function wahaPost(path, data = {}) {
  return axios.post(WAHA_URL + path, data, { headers: wahaH(), timeout: 8000 });
}
async function wahaPut(path, data = {}) {
  return axios.put(WAHA_URL + path, data, { headers: wahaH(), timeout: 8000 });
}
async function wahaDel(path) {
  return axios.delete(WAHA_URL + path, { headers: wahaH(), timeout: 8000 });
}

async function setupWebhook() {
  if (!BOT_URL || !WAHA_URL) return;
  const url = BOT_URL + '/webhook';
  try {
    await wahaPut(`/api/sessions/${SESSION}`, { config: { webhooks: [{ url, events: ['message','message.any'] }] } });
    console.log('[WH] Webhook OK:', url);
  } catch (_) {
    try {
      await wahaPost(`/api/sessions/${SESSION}/webhooks`, { url, events: ['message'] });
      console.log('[WH] Webhook OK (v1):', url);
    } catch (e2) { console.warn('[WH] Webhook error:', e2.message); }
  }
}

async function startSession() {
  if (!WAHA_URL) return;
  try {
    await wahaPost('/api/sessions', { name: SESSION, config: {} });
    console.log('[WAHA] Sesión creada');
  } catch (_) {
    try { await wahaPost(`/api/sessions/${SESSION}/start`); }
    catch (e2) { console.log('[WAHA] Sesión ya existe:', e2.message); }
  }
  setTimeout(setupWebhook, 5000);
}

// ── Claude ────────────────────────────────────────────────────────────────────
async function askClaude(userMessage) {
  const ctx = records.length > 0
    ? `Datos de mantenimiento de flota LOMU (${records.length} registros):\n` + records.map(r => JSON.stringify(r)).join('\n')
    : 'No hay datos de mantenimiento disponibles.';
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: `Eres el asistente de mantenimiento vehicular de LOMU (Transportes y Maquinarias).
Responde consultas sobre el historial de mantenimiento de la flota basándote SOLO en los datos.
Sé claro y conciso. Si no encuentras la información, dilo. Responde en español.\n\n${ctx}`,
    messages: [{ role: 'user', content: userMessage }]
  });
  return msg.content[0].text;
}

async function sendMsg(chatId, text) {
  await wahaPost('/api/sendText', { chatId, text, session: SESSION });
}

// ── Rutas ─────────────────────────────────────────────────────────────────────

// Healthcheck — Railway lo usa para verificar que el bot está vivo
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.get('/', async (req, res) => {
  let sessionStatus = 'unknown';
  try {
    const r = await wahaGet(`/api/sessions/${SESSION}`);
    sessionStatus = r.data.status || 'unknown';
  } catch (_) {}
  res.json({ status: 'ok', bot: 'LOMU Mantenimiento Bot', records: records.length, lastFetch, sessionStatus });
});

app.get('/qr', async (req, res) => {
  // Intentar imagen PNG directa
  try {
    const r = await axios.get(`${WAHA_URL}/api/${SESSION}/auth/qr`,
      { headers: { 'X-Api-Key': WAHA_KEY, Accept: 'image/png' }, responseType: 'arraybuffer', timeout: 10000 });
    res.set('Content-Type', 'image/png');
    return res.send(r.data);
  } catch (_) {}

  // Fallback: QR en base64
  try {
    const r = await wahaGet(`/api/sessions/${SESSION}/auth/qr`);
    if (r.data?.value) {
      return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>QR LOMU</title><meta http-equiv="refresh" content="25">
<style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;
min-height:100vh;font-family:sans-serif;background:#f0f0f0;margin:0}
img{padding:16px;background:white;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.12)}</style></head>
<body><h2>📱 Escanea con WhatsApp</h2>
<img src="data:image/png;base64,${r.data.value}" width="280" height="280"/>
<p style="color:#666;margin-top:16px">La página se recarga automáticamente cada 25 segundos</p>
<p><a href="/restart">🔄 Reiniciar sesión</a></p>
</body></html>`);
    }
  } catch (_) {}

  res.status(503).send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
<h2>⏳ QR aún no disponible</h2>
<p>WAHA puede estar iniciando. Intenta en 10 segundos.</p>
<p><a href="/qr">🔄 Recargar</a> | <a href="/restart">⚡ Reiniciar sesión</a></p>
<script>setTimeout(()=>location.reload(),10000)</script>
</body></html>`);
});

app.get('/status', async (req, res) => {
  try {
    const r = await wahaGet(`/api/sessions/${SESSION}`);
    res.json(r.data);
  } catch (e) {
    res.status(502).json({ error: 'No se pudo contactar WAHA', detail: e.message });
  }
});

app.get('/restart', async (req, res) => {
  console.log('[RESTART] Reiniciando sesión WAHA...');
  try {
    try { await wahaPost(`/api/sessions/${SESSION}/stop`); } catch (_) {}
    await new Promise(r => setTimeout(r, 1500));
    try { await wahaDel(`/api/sessions/${SESSION}`); } catch (_) {}
    await new Promise(r => setTimeout(r, 2000));
    await wahaPost('/api/sessions', { name: SESSION, config: {} });
    await new Promise(r => setTimeout(r, 4000));
    await setupWebhook();
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
<h2>✅ Sesión reiniciada</h2>
<p>Redirigiendo al QR en 5 segundos...</p>
<script>setTimeout(()=>window.location='/qr',5000)</script>
</body></html>`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    for (const ev of events) {
      if (ev.event !== 'message' && ev.event !== 'message.any') continue;
      const msg = ev.payload || ev;
      if (!msg?.body || msg.fromMe) continue;
      const text   = msg.body.trim();
      const chatId = msg.from || msg.chatId;
      if (!text || !chatId) continue;
      console.log(`[MSG] ${chatId}: ${text}`);
      try {
        const resp = await askClaude(text);
        await sendMsg(chatId, resp);
      } catch (e) {
        console.error('[ERR]', e.message);
        try { await sendMsg(chatId, '⚠️ Error procesando tu consulta. Intenta de nuevo.'); } catch (_) {}
      }
    }
  } catch (e) { console.error('[WH]', e.message); }
});

app.get('/reload', async (req, res) => {
  await loadSheet();
  res.json({ status: 'ok', records: records.length, lastFetch });
});

// ── Arranque ──────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚛 Bot LOMU en puerto ${PORT}`);
  console.log(`   WAHA:    ${WAHA_URL}`);
  console.log(`   BOT:     ${BOT_URL}`);
  console.log(`   SHEET:   ${SHEET_URL || '⚠️ NO CONFIGURADA'}`);
  console.log(`   Records: ${records.length}\n`);
  // No llamamos startSession() aquí para no bloquear el healthcheck
  // La sesión ya debe estar corriendo en WAHA
  setTimeout(setupWebhook, 3000);
});
