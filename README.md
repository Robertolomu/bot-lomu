# Bot LOMU — Mantenimiento Vehicular 🚛

Bot de WhatsApp con IA que responde consultas sobre el historial de mantenimiento de la flota, alimentado por Google Sheets en tiempo real.

---

## Flujo del sistema

```
WhatsApp → WAHA → Este servidor → Claude API + Google Sheets → Respuesta
```

---

## PASO 1 — Subir el código a GitHub

1. Crea una cuenta en https://github.com
2. Crea un repo nuevo llamado `bot-lomu`
3. Sube estos archivos (arrastra y suelta en el repo)

---

## PASO 2 — Deployar WAHA en Railway

1. Ve a https://railway.app → Sign up con GitHub
2. **New Project → Deploy from Docker Image**
3. Imagen: `devlikeapro/waha`
4. En **Variables** agrega:
   - `WHATSAPP_DEFAULT_ENGINE` = `WEBJS`
5. Deploy → copia la URL pública que te da Railway (ej: `https://waha-xxx.up.railway.app`)

---

## PASO 3 — Deployar este servidor en Railway

1. En Railway → **New Project → Deploy from GitHub repo**
2. Selecciona el repo `bot-lomu`
3. En **Variables** agrega:
   ```
   ANTHROPIC_API_KEY = sk-ant-TUKEY
   WAHA_URL          = https://waha-xxx.up.railway.app
   WAHA_SESSION      = default
   ```
4. Deploy → copia tu URL (ej: `https://bot-lomu-xxx.up.railway.app`)

---

## PASO 4 — Conectar tu WhatsApp a WAHA

1. Abre: `https://waha-xxx.up.railway.app/dashboard`
2. Clic en **Start Session**
3. Escanea el QR con tu WhatsApp (o el de tu papá cuando hagas producción)

---

## PASO 5 — Configurar el Webhook

Haz esta llamada (puedes usar el navegador o Postman):

```
POST https://waha-xxx.up.railway.app/api/session/default/webhooks
Body:
{
  "url": "https://bot-lomu-xxx.up.railway.app/webhook",
  "events": ["message"]
}
```

O desde la terminal:
```bash
curl -X POST https://waha-xxx.up.railway.app/api/session/default/webhooks \
  -H "Content-Type: application/json" \
  -d '{"url":"https://bot-lomu-xxx.up.railway.app/webhook","events":["message"]}'
```

---

## PASO 6 — Probar

Mándate un WhatsApp desde otro número (o pide a alguien):
- "¿Qué mantenimientos tiene el ANG571?"
- "¿Cuándo le toca aceite al CBN246?"
- "¿Qué observaciones hay del BYO597?"

---

## Cambiar de tu número al de tu papá (producción)

1. WAHA Dashboard → cerrar sesión actual
2. Escanear QR con el celular de tu papá
3. Listo — mismo bot, otro número

---

## Costos estimados

| Servicio | Costo |
|---|---|
| Railway (WAHA) | Gratis hasta $5/mes de uso |
| Railway (Bot) | Gratis hasta $5/mes de uso |
| Anthropic API | ~$0.003 por consulta |
| Google Sheets | Gratis |

Para uso interno de flota: prácticamente $0/mes.
