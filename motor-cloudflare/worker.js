/* Lyrio — motor de voz en Cloudflare Workers.
 *
 * Habla el protocolo de las voces neuronales de Microsoft Edge directamente
 * desde el borde de Cloudflare: recibe texto, devuelve MP3 + tiempos por
 * palabra. No guarda nada, no requiere servidor ni base de datos.
 *
 * El navegador no puede hacer esto por su cuenta porque no le permiten fijar
 * la cabecera Origin que el servicio exige; un Worker sí puede.
 */

const TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_VERSION = "143.0.3650.75";
const BASE = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const WIN_EPOCH = 11644473600;
const MAX_TEXT = 2000;

const VOICES = [
  { id: "es-MX-DaliaNeural", name: "Dalia", region: "México", gender: "F", lang: "es" },
  { id: "es-MX-JorgeNeural", name: "Jorge", region: "México", gender: "M", lang: "es" },
  { id: "es-US-PalomaNeural", name: "Paloma", region: "Latino EE.UU.", gender: "F", lang: "es" },
  { id: "es-US-AlonsoNeural", name: "Alonso", region: "Latino EE.UU.", gender: "M", lang: "es" },
  { id: "es-DO-RamonaNeural", name: "Ramona", region: "Rep. Dominicana", gender: "F", lang: "es" },
  { id: "es-DO-EmilioNeural", name: "Emilio", region: "Rep. Dominicana", gender: "M", lang: "es" },
  { id: "es-CO-SalomeNeural", name: "Salomé", region: "Colombia", gender: "F", lang: "es" },
  { id: "es-CO-GonzaloNeural", name: "Gonzalo", region: "Colombia", gender: "M", lang: "es" },
  { id: "es-AR-ElenaNeural", name: "Elena", region: "Argentina", gender: "F", lang: "es" },
  { id: "es-AR-TomasNeural", name: "Tomás", region: "Argentina", gender: "M", lang: "es" },
  { id: "en-US-AvaMultilingualNeural", name: "Ava", region: "US · Multilingual", gender: "F", lang: "en" },
  { id: "en-US-AndrewMultilingualNeural", name: "Andrew", region: "US · Multilingual", gender: "M", lang: "en" },
  { id: "en-US-EmmaMultilingualNeural", name: "Emma", region: "US · Multilingual", gender: "F", lang: "en" },
  { id: "en-US-BrianMultilingualNeural", name: "Brian", region: "US · Multilingual", gender: "M", lang: "en" },
  { id: "en-US-JennyNeural", name: "Jenny", region: "US", gender: "F", lang: "en" },
  { id: "en-US-GuyNeural", name: "Guy", region: "US", gender: "M", lang: "en" },
  { id: "en-US-AriaNeural", name: "Aria", region: "US", gender: "F", lang: "en" },
  { id: "en-US-ChristopherNeural", name: "Christopher", region: "US", gender: "M", lang: "en" },
];
const VOICE_IDS = new Set(VOICES.map((v) => v.id));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });

/* ---------- protocolo ---------- */

async function secMsGec() {
  let ticks = Math.floor(Date.now() / 1000) + WIN_EPOCH;
  ticks -= ticks % 300;                       // redondeo a 5 minutos
  const str = `${ticks * 10000000}${TRUSTED_TOKEN}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

const hex = (n) =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

const dateString = () =>
  new Date().toUTCString().replace(/^(\w{3}), (\d{2}) (\w{3}) (\d{4})/, "$1 $3 $2 $4")
    .replace(" GMT", " GMT+0000 (Coordinated Universal Time)");

const escapeXml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function cleanText(s) {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += (c <= 8 || c === 11 || c === 12 || (c >= 14 && c <= 31)) ? " " : ch;
  }
  return out;
}

function rateString(speed) {
  const s = Math.max(0.5, Math.min(2, Number(speed) || 1));
  const pct = Math.round((s - 1) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

function alignWords(text, events) {
  const lower = text.toLowerCase();
  const words = [];
  let cursor = 0;
  for (const ev of events) {
    let token = (ev.text || "").trim();
    if (!token) continue;
    let pos = lower.indexOf(token.toLowerCase(), cursor);
    if (pos === -1) {
      token = token.split(/\s+/)[0];
      pos = lower.indexOf(token.toLowerCase(), cursor);
      if (pos === -1) continue;
    }
    const startMs = ev.offset / 10000;
    words.push({
      w: text.slice(pos, pos + token.length),
      s: Math.round(startMs),
      e: Math.round(startMs + ev.duration / 10000),
      cs: pos,
      ce: pos + token.length,
    });
    cursor = pos + token.length;
  }
  return words;
}

function parseHeaders(bytes, headerLength) {
  const text = new TextDecoder().decode(bytes.slice(0, headerLength));
  const headers = {};
  for (const line of text.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return headers;
}

async function attempt(text, voice, speed, diag) {
  const gec = await secMsGec();
  const url =
    `https://${BASE}/edge/v1?TrustedClientToken=${TRUSTED_TOKEN}` +
    `&ConnectionId=${hex(16)}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}`;

  const major = CHROMIUM_VERSION.split(".")[0];
  const resp = await fetch(url, {
    headers: {
      Upgrade: "websocket",
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
      Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        `Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: `muid=${hex(16).toUpperCase()};`,
    },
  });

  diag.status = resp.status;
  const ws = resp.webSocket;
  if (!ws) {
    diag.note = await resp.text().catch(() => "");
    throw new Error(`el servicio rechazó la conexión (HTTP ${resp.status})`);
  }
  ws.accept();

  const chunks = [];
  const events = [];
  let total = 0;
  diag.textMsgs = 0;
  diag.binMsgs = 0;

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tiempo de espera agotado")), 25000);
    const finish = (err) => { clearTimeout(timer); err ? reject(err) : resolve(); };

    ws.addEventListener("message", (evt) => {
      if (typeof evt.data === "string") {
        diag.textMsgs++;
        const split = evt.data.indexOf("\r\n\r\n");
        const headers = parseHeaders(new TextEncoder().encode(evt.data), split);
        const path = headers.Path;
        if (path === "audio.metadata") {
          try {
            for (const m of JSON.parse(evt.data.slice(split + 4)).Metadata || []) {
              if (m.Type === "WordBoundary" || m.Type === "SentenceBoundary") {
                events.push({ text: m.Data.text.Text, offset: m.Data.Offset, duration: m.Data.Duration });
              }
            }
          } catch { /* metadato ilegible: se ignora */ }
        } else if (path === "turn.end") {
          try { ws.close(); } catch {}
          finish();
        }
      } else {
        diag.binMsgs++;
        const bytes = new Uint8Array(evt.data);
        if (bytes.length < 2) return;
        const headerLength = (bytes[0] << 8) | bytes[1];
        const audio = bytes.slice(headerLength + 2);
        if (audio.length) { chunks.push(audio); total += audio.length; }
      }
    });
    ws.addEventListener("close", (e) => {
      diag.closeCode = e.code;
      diag.closeReason = (e.reason || "").slice(0, 120);
      finish();
    });
    ws.addEventListener("error", (e) => finish(new Error(`fallo de conexión${e?.message ? `: ${e.message}` : ""}`)));
  });

  const config =
    `X-Timestamp:${dateString()}\r\n` +
    "Content-Type:application/json; charset=utf-8\r\n" +
    "Path:speech.config\r\n\r\n" +
    '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
    '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},' +
    '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n';
  ws.send(config);

  const ssml =
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voice}'>` +
    `<prosody pitch='+0Hz' rate='${rateString(speed)}' volume='+0%'>` +
    `${escapeXml(cleanText(text))}</prosody></voice></speak>`;
  ws.send(
    `X-RequestId:${hex(16)}\r\n` +
    "Content-Type:application/ssml+xml\r\n" +
    `X-Timestamp:${dateString()}Z\r\n` +
    "Path:ssml\r\n\r\n" +
    ssml
  );

  await done;
  if (!total) throw new Error("el servicio no devolvió audio");

  const merged = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { merged.set(c, at); at += c.length; }

  let binary = "";
  for (let i = 0; i < merged.length; i += 0x8000) {
    binary += String.fromCharCode(...merged.subarray(i, i + 0x8000));
  }
  return { audio: btoa(binary), words: alignWords(text, events) };
}

/* El servicio corta algunas sesiones abiertas desde redes de centros de datos.
   Reintentar con una conexión nueva resuelve la mayoría de esos cortes. */
async function synthesize(text, voice, speed) {
  const attempts = [];
  for (let i = 0; i < 3; i++) {
    const diag = { try: i + 1 };
    try {
      return await attempt(text, voice, speed, diag);
    } catch (err) {
      diag.error = err.message;
      attempts.push(diag);
      if (i < 2) await new Promise((r) => setTimeout(r, 350 * (i + 1)));
    }
  }
  const err = new Error(attempts[attempts.length - 1].error);
  err.diag = attempts;
  throw err;
}

/* ---------- rutas ---------- */

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (pathname === "/" ) return json({ ok: true, service: "lyrio-voice" });
    if (pathname === "/voices") return json(VOICES);

    if (pathname === "/tts" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ detail: "JSON inválido" }, 400); }
      const text = (body.text || "").trim();
      if (!text) return json({ detail: "Texto vacío" }, 400);
      if (text.length > MAX_TEXT) return json({ detail: "Texto demasiado largo" }, 400);
      if (!VOICE_IDS.has(body.voice)) return json({ detail: "Voz desconocida" }, 400);
      try {
        return json(await synthesize(text, body.voice, body.speed ?? 1));
      } catch (err) {
        return json({ detail: `Motor de voz: ${err.message}`, diag: err.diag }, 502);
      }
    }

    return json({ detail: "No encontrado" }, 404);
  },
};
