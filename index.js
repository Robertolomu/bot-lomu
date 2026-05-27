/**
 * Bot LOMU — Mantenimiento Vehicular 🚛
 * Variables de entorno requeridas:
 *   ANTHROPIC_API_KEY  — clave Anthropic Claude
 *   WAHA_URL           — URL base de WAHA
 *   WAHA_SESSION       — nombre de sesión (default: "default")
 *   WAHA_API_KEY       — API key de WAHA
 *   BOT_URL            — URL pública de este servidor
 *   SHEET_CSV_URL      — URL CSV público de Google Sheets  ← FALTABA ESTO
 */

'use strict';

const express  = require('express');
const axios    = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const PORT         = process.env.PORT || 3000;
const WAHA_URL     = (process.env.WAHA_URL  || '').replace(/\/$/, '');
const SESSION      = process.env.WAHA_SESSION || 'default';
const WAHA_API_KEY = process.env.WAHA_API_KEY || '';
const BOT_URL      = (process.env.BOT_URL   || '').replace(/\/$/, '');
const SHEET_URL    = process.env.SHEET_CSV_URL || '';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let records  = [];
let lastFetch = null;

function wahaHeaders() {
  return WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {};
}

// ── Google Sheets CSV ─────────────────────────────────────────────────────────
async function loadSheet() {
  if (!SHEET_URL) {
    console.warn('[SHEET] SHEET_CSV_URL no configurada');
    return;
  }
  try {
    const res   = await axios.get(SHEET_URL, { timeout: 15000 });
    const lines = res.data.trim().split('\n');
    if (lines.length < 2) return;
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    records = lines.slice(1).map(line => {
      const cols = line.match(/(".*?"|[^,]+)(?=\s*,|\s*$)/g) || line.split(',');
      const obj  = {};
      headers.forEach((h, i) => { obj[h] = (cols[i] || '').trim().replace(/^"|"$/g, ''); });
      return obj;
    });
    lastFetch = new Date().toISOString();
    console.log(`[SHEET] ${records.length} registros cargados`);
  } catch (err) {
    console.error('[SHEET] Error:', err.message);
  }
}
loadSheet();
setInterval(loadSheet, 10 * 60 * 1000);

// ── Webhook WAHA ──────────────────────────────────────────────────────────────
async function setupWebhook() {
  if (!BOT_URL || !WAHA_URL) return;
  const webhookUrl = `${BOT_URL}/webhook`;
  try {
    await axios.put(
      `${WAHA_URL}/api/sessions/${SESSION}`,
      { config: { webhooks: [{ url: webhookUrl, events: ['message', 'message.any'] }] } },
      { headers: { ...wahaHeaders(), 'Content-Type': 'application/json' } }
    );
    console.log('[WEBHOOK] Configurado:', webhookUrl);
  } catch (_) {
    try {
      await axios.post(
        `${WAHA_URL}/api/sessions/${SESSION}/webhooks`,
        { url: webhookUrl, events: ['message'] },
        { headers: { ...wahaHeaders(), 'Content-Type': 'application/json' } }
      );
      console.log('[WEBHOOK] Configurado (v1):', webhookUrl);
    } catch (e2) {
      console.warn('[WEBHOOK] No se pudo configurar:', e2.message);
    }
  }
}

// ── Iniciar sesión WAHA ───────────────────────────────────────────────────────
async function startSession() {
  if (!WAHA_URL) return;
  try {
    await axios.post(
      `${WAHA_URL}/api/sessions`,
      { name: SESSION, config: {} },
      { headers: { ...wahaHeaders(), 'Content-Type': 'application/json' } }
    );
    console.log('[WAHA] Sesión creada:', SESSION);
  } catch (_) {
    try {
      await axios.post(`${WAHA_URL}/api/sessions/${SESSION}/start`, {}, { headers: wahaHeaders() });
    } catch (e2) {
      console.log('[WAHA] Sesión ya existe o error ignorado:', e2.message);
    }
  }
  setTimeout(setupWebhook, 5000);
}

// ── Claude ────────────────────────────────────────────────────────────────────
async function askClaude(userMessage) {
  const context = records.length > 0
    ? `Datos de mantenimiento de flota LOMU (${records.length} registros):\n` +
      records.map(r => JSON.stringify(r)).join('\n')
    : 'No hay datos de mantenimiento disponibles en este momento.';

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: `Eres el asistente de mantenimiento vehicular de LOMU (Transportes y Maquinarias).
Responde consultas sobre el historial de mantenimiento de la flota basándote SOLO en los datos proporcionados.
Sé claro y conciso. Si no encuentras la información, dilo. Responde en español.\n\n${context}`,
    messages: [{ role: 'user', content: userMessage }]
  });
  return msg.content[0].text;
}

// ── Enviar mensaje ────────────────────────────────────────────────────────────
async function sendMessage(chatId, text) {
  await axios.post(
    `${WAHA_URL}/api/sendText`,
    { chatId, text, session: SESSION },
    { headers: { ...wahaHeaders(), 'Content-Type': 'application/json' } }
  );
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/', async (req, res) => {
  let sessionStatus = 'unknown';
  try {
    const s = await axios.get(`${WAHA_URL}/api/sessions/${SESSION}`, { headers: wahaHeaders(), timeout: 5000 });
    sessionStatus = s.data.status || 'unknown';
  } catch (_) {}
  res.json({ status: 'ok', bot: 'LOMU Mantenimiento Bot', records: records.length, lastFetch, sessionStatus, qr: `${BOT_URL}/qr`, statusUrl: `${BOT_URL}/status` });
});

// QR para escanear
app.get('/qr', async (req, res) => {
  try {
    const r = await axios.get(
      `${WAHA_URL}/api/${SESSION}/auth/qr`,
      { headers: { ...wahaHeaders(), Accept: 'image/png' }, responseType: 'arraybuffer', timeout: 10000 }
    );
    res.set('Content-Type', 'image/png');
    return res.send(r.data);
  } catch (_) {}

  try {
    const r = await axios.get(
      `${WAHA_URL}/api/sessions/${SESSION}/auth/qr`,
      { headers: wahaHeaders(), timeout: 10000 }
    );
    if (r.data && r.data.value) {
      return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>QR LOMU</title>
<style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;background:#f5f5f5;}
img{border:8px solid white;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.15);}</style></head>
<body><h2>📱 Escanea con WhatsApp</h2>
<img src="data:image/png;base64,${r.data.value}" width="300" height="300"/>
<p style="color:#666">⏱ Expira en ~60s — recarga si falla</p>
<p><a href="/restart">🔄 Reiniciar sesión</a></p></body></html>`);
    }
  } catch (_) {}

  res.status(503).send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
<h2>⚠️ QR no disponible</h2>
<p>La sesión puede estar ya conectada, o WAHA está iniciando.</p>
<p><a href="/restart">🔄 Reiniciar sesión y obtener QR fresco</a></p>
<p><a href="${WAHA_URL}/dashboard" target="_blank">Dashboard WAHA</a></p>
</body></html>`);
});

// Estado sesión
app.get('/status', async (req, res) => {
  try {
    const r = await axios.get(`${WAHA_URL}/api/sessions/${SESSION}`, { headers: wahaHeaders(), timeout: 8000 });
    res.json(r.data);
  } catch (err) {
    res.status(502).json({ error: 'No se pudo contactar WAHA', detail: err.message });
  }
});

// Reiniciar sesión WAHA — FIX para "Can't link new devices"
app.get('/restart', async (req, res) => {
  console.log('[RESTART] Reiniciando sesión WAHA...');
  try {
    try { await axios.post(`${WAHA_URL}/api/sessions/${SESSION}/stop`, {}, { headers: wahaHeaders() }); } catch (_) {}
    try { await axios.delete(`${WAHA_URL}/api/sessions/${SESSION}`, { headers: wahaHeaders() }); } catch (_) {}
    await new Promise(r => setTimeout(r, 2000));
    await axios.post(
      `${WAHA_URL}/api/sessions`,
      { name: SESSION, config: {} },
      { headers: { ...wahaHeaders(), 'Content-Type': 'application/json' } }
    );
    await new Promise(r => setTimeout(r, 3000));
    await setupWebhook();
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
<h2>✅ Sesión reiniciada</h2><p>Redirigiendo al QR en 5 segundos...</p>
<p><a href="/qr">📱 Ir al QR ahora</a></p>
<script>setTimeout(()=>window.location='/qr',5000);</script>
</body></html>`);
  } catch (err) {
    res.status(500).json({ error: 'Error al reiniciar', detail: err.message });
  }
});

// Webhook: mensajes entrantes de WAHA
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    for (const event of events) {
      if (event.event !== 'message' && event.event !== 'message.any') continue;
      const msg = event.payload || event;
      if (!msg || !msg.body || msg.fromMe) continue;
      const text   = msg.body.trim();
      const chatId = msg.from || msg.chatId;
      if (!text || !chatId) continue;
      console.log(`[MSG] De ${chatId}: ${text}`);
      try {
        const respuesta = await askClaude(text);
        await sendMessage(chatId, respuesta);
      } catch (err) {
        console.error('[CLAUDE/SEND] Error:', err.message);
        try { await sendMessage(chatId, '⚠️ Error procesando tu consulta. Intenta de nuevo.'); } catch (_) {}
      }
    }
  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message);
  }
});

// Recargar datos manualmente
app.get('/reload', async (req, res) => {
  await loadSheet();
  res.json({ status: 'ok', records: records.length, lastFetch });
});

app.listen(PORT, async () => {
  console.log(`\n🚛 Bot LOMU en puerto ${PORT}`);
  console.log(`   WAHA_URL:    ${WAHA_URL}`);
  console.log(`   SESSION:     ${SESSION}`);
  console.log(`   BOT_URL:     ${BOT_URL}`);
  console.log(`   SHEET_URL:   ${SHEET_URL || '⚠️  NO CONFIGURADA — agrega SHEET_CSV_URL en Railway'}`);
  console.log('');
  await startSession();
});
