/* Lyrio Web — self-contained reader: on-device library, karaoke TTS via voice engine. */
"use strict";

import { extractFromPdf } from "./extract.js";
import {
  DEFAULT_SETTINGS, loadSettings, persistSettings,
  getLibrary, saveLibrary, getDoc, saveDoc, deleteDoc, savePosition as storePosition,
  getCachedTranslation, cacheTranslation,
  audioKey, getCachedAudio, putCachedAudio,
} from "./storage.js";

const $ = (id) => document.getElementById(id);

const GEMINI_MODELS = ["gemini-flash-latest", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-flash"];
const geminiBadModels = new Set();

/* ---------- Gemini TTS: voces neuronales sin servidor ---------- */

// Cada modelo tiene su propia cuota gratuita: usarlos por turnos multiplica el margen.
const GEMINI_TTS_MODELS = [
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
];
const geminiBadTtsModels = new Set();

// Multilingües: la misma voz lee español e inglés según el texto.
const GEMINI_VOICES = [
  { name: "Kore", gender: "F", tone: "Firme" },
  { name: "Zephyr", gender: "F", tone: "Brillante" },
  { name: "Leda", gender: "F", tone: "Juvenil" },
  { name: "Aoede", gender: "F", tone: "Ligera" },
  { name: "Puck", gender: "M", tone: "Animado" },
  { name: "Charon", gender: "M", tone: "Informativo" },
  { name: "Orus", gender: "M", tone: "Firme" },
  { name: "Fenrir", gender: "M", tone: "Enérgico" },
];

const isGeminiVoice = (id) => typeof id === "string" && id.startsWith("gemini:");

function pcmToWav(pcm, sampleRate) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const put = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  put(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  put(8, "WAVE");
  put(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, 1, true);              // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes por segundo
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);             // 16 bits
  put(36, "data");
  view.setUint32(40, pcm.length, true);
  return new Blob([header, pcm], { type: "audio/wav" });
}

/* Gemini no devuelve tiempos por palabra: se reparten sobre la duración real
   del audio, dando más peso a las palabras largas y a las pausas de puntuación. */
function estimateWords(text, durationMs) {
  const tokens = [...text.matchAll(/\S+/g)];
  if (!tokens.length) return [];
  const weights = tokens.map((m) => {
    let weight = m[0].length + 1.4;
    if (/[,;:)"]$/.test(m[0])) weight += 2.5;
    if (/[.!?…]$/.test(m[0])) weight += 5;
    return weight;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const lead = Math.min(260, durationMs * 0.04);          // silencio inicial típico
  const speakable = Math.max(0, durationMs - lead * 1.6);
  let t = lead;
  return tokens.map((m, k) => {
    const dur = (weights[k] / totalWeight) * speakable;
    const word = {
      w: m[0], s: Math.round(t), e: Math.round(t + dur),
      cs: m.index, ce: m.index + m[0].length,
    };
    t += dur;
    return word;
  });
}

/* Google limita las peticiones por minuto y por modelo. Para que la lectura no
   se corte: las peticiones van de una en una y espaciadas, se reparten entre
   los modelos disponibles, y ante un límite se espera lo que Google indica y
   se reintenta con otro modelo. El espaciado se adapta solo. */
const ttsGate = { chain: Promise.resolve(), last: 0, gapMs: 1200, cooldownUntil: {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nextTtsModel() {
  const now = Date.now();
  const usable = GEMINI_TTS_MODELS.filter(
    (m) => !geminiBadTtsModels.has(m) && (ttsGate.cooldownUntil[m] || 0) <= now);
  if (usable.length) return usable[0];
  // todos en espera: se elige el que se libera antes
  const waiting = GEMINI_TTS_MODELS.filter((m) => !geminiBadTtsModels.has(m));
  if (!waiting.length) return null;
  return waiting.sort((a, b) => (ttsGate.cooldownUntil[a] || 0) - (ttsGate.cooldownUntil[b] || 0))[0];
}

function parseRetryDelay(error) {
  for (const d of error?.details || []) {
    const secs = Number(/(\d+)/.exec(d.retryDelay || "")?.[1]);
    if (secs) return secs * 1000;
  }
  return 20000;
}

async function requestTts(text, voiceName, apiKey) {
  const payload = {
    contents: [{ parts: [{ text: `Lee en voz alta el siguiente texto, con tono natural y sin añadir nada:\n\n${text}` }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    const model = nextTtsModel();
    if (!model) break;

    // Esperar más de esto no compensa: es mejor seguir con la voz del dispositivo.
    if ((ttsGate.cooldownUntil[model] || 0) - Date.now() > 25000) break;

    const wait = Math.max(
      (ttsGate.cooldownUntil[model] || 0) - Date.now(),
      ttsGate.last + ttsGate.gapMs - Date.now(),
    );
    if (wait > 0) await sleep(wait);
    ttsGate.last = Date.now();

    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new Error("Sin conexión con Google (¿hay internet?)");
    }

    if (res.ok) {
      const part = (await res.json())?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!part?.data) throw new Error("Gemini no devolvió audio");
      const pcm = Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0));
      const rate = Number(/rate=(\d+)/.exec(part.mimeType || "")?.[1]) || 24000;
      ttsGate.gapMs = Math.max(1200, ttsGate.gapMs * 0.8);      // se relaja al ir bien
      return { blob: pcmToWav(pcm, rate), durationMs: (pcm.length / 2 / rate) * 1000 };
    }

    let error = {};
    try { error = (await res.json())?.error || {}; } catch {}
    const message = error.message || `HTTP ${res.status}`;

    if (res.status === 429) {
      // El límite diario no se recupera esperando: ese modelo se descarta por hoy.
      const perDay = JSON.stringify(error.details || []).includes("PerDay");
      ttsGate.cooldownUntil[model] = Date.now() + (perDay ? 6 * 3600e3 : parseRetryDelay(error));
      if (!perDay) ttsGate.gapMs = Math.min(8000, ttsGate.gapMs * 1.6);
      continue;                                                  // se prueba con otro modelo
    }
    if (UNAVAILABLE_HINTS.some((h) => message.toLowerCase().includes(h))) {
      geminiBadTtsModels.add(model);
      continue;
    }
    throw new Error(`Voces Gemini: ${message}`);
  }
  const err = new Error("Google agotó el uso gratuito por ahora.");
  err.quota = true;
  throw err;
}

function geminiSpeak(text, voiceName) {
  const apiKey = (state.settings.gemini_api_key || "").trim();
  if (!apiKey) {
    return Promise.reject(new Error("Configura tu API key de Google AI Studio en Ajustes para usar las voces Gemini."));
  }
  // una petición a la vez: evita ráfagas que disparan el límite por minuto
  const run = ttsGate.chain.then(() => requestTts(text, voiceName, apiKey));
  ttsGate.chain = run.catch(() => {});
  return run;
}

/* ---------- device voices (Web Speech API — no external service needed) ---------- */

let deviceVoices = [];

function refreshDeviceVoices() {
  const all = (window.speechSynthesis?.getVoices() || []).filter((v) =>
    /^e[sn][-_]?/i.test(v.lang) || v.lang.toLowerCase().startsWith("es") || v.lang.toLowerCase().startsWith("en"));
  const rank = (v) => {
    const n = v.name.toLowerCase();
    if (/natural|online/.test(n)) return 0;          // Edge neural voices
    if (/enhanced|premium|mejorad|superior/.test(n)) return 1;
    if (/^es-(mx|us|do|co|ar|419)/i.test(v.lang) || /^en-us/i.test(v.lang)) return 2;
    return 3;
  };
  all.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  deviceVoices = all;
}

if ("speechSynthesis" in window) {
  refreshDeviceVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    refreshDeviceVoices();
    autoPickDeviceVoices();
  });
}

const isDeviceVoice = (id) => typeof id === "string" && id.startsWith("device:");

function deviceVoiceByRef(id) {
  const uri = id.slice("device:".length);
  return deviceVoices.find((v) => v.voiceURI === uri || v.name === uri) || null;
}

function bestDeviceVoice(lang) {
  const pool = deviceVoices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  return pool[0] || null;    // deviceVoices is already quality-ranked
}

/* Si la voz guardada no puede sonar en este dispositivo, se elige la mejor
   disponible: Gemini cuando hay clave, si no la del propio dispositivo. */
/* Por defecto se usa la voz del dispositivo: es ilimitada. Las voces Gemini
   tienen una cuota diaria muy pequeña, así que solo se usan si las eliges. */
function autoPickDeviceVoices() {
  const hasKey = Boolean((state.settings.gemini_api_key || "").trim());
  const patch = {};
  for (const [lang, field] of [["es", "voice_es"], ["en", "voice_en"]]) {
    const current = state.settings[field];
    if (isDeviceVoice(current)) continue;
    if (isGeminiVoice(current) && hasKey) continue;
    const v = bestDeviceVoice(lang);
    if (v) patch[field] = "device:" + v.voiceURI;
    else if (hasKey) patch[field] = lang === "es" ? "gemini:Kore" : "gemini:Charon";
  }
  if (Object.keys(patch).length) saveSettings(patch);
}

/* ---------- state ---------- */

const state = {
  settings: loadSettings(),
  doc: null,
  index: 0,
  playing: false,
  translateOn: false,
  audio: new Audio(),
  cache: new Map(),        // "i|voice|speed" -> Promise<{url, words}>
  translations: new Map(),
  words: [],
  litIdx: -1,
  raf: 0,
  userScrolledAt: 0,
  wakeLock: null,
  playToken: 0,
  activeToken: 0,
  engine: "audio",         // "audio" (motor externo) | "device" (voz del dispositivo)
  deviceVolume: 1,
};

state.audio.setAttribute("playsinline", "");
state.audio.preload = "auto";

/* ---------- toast ---------- */

let toastTimer = 0;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4200);
}

/* ---------- settings ---------- */

function applyDisplaySettings() {
  const s = state.settings;
  document.documentElement.dataset.theme = s.theme;
  document.documentElement.dataset.font = s.font;
  document.documentElement.dataset.width = s.width || "medio";
  document.documentElement.style.setProperty("--reading-size", s.fontSize + "px");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.body).backgroundColor;
}

function saveSettings(patch) {
  Object.assign(state.settings, patch);
  applyDisplaySettings();
  persistSettings(state.settings);
}

function segLang(i) {
  return state.doc?.segments[i]?.lang || state.doc?.lang || "es";
}

function voiceForLang(lang) {
  return lang === "en" ? state.settings.voice_en : state.settings.voice_es;
}

function currentVoice() {
  return voiceForLang(segLang(state.index));
}

/* ---------- home / library ---------- */

async function renderLibrary() {
  const lib = await getLibrary().catch(() => []);
  $("librarySection").classList.toggle("hidden", lib.length === 0);
  const wrap = $("library");
  wrap.innerHTML = "";
  for (const d of lib) {
    const pct = d.n_segments > 1 ? Math.round((d.position / (d.n_segments - 1)) * 100) : 0;
    const item = document.createElement("button");
    item.className = "lib-item";
    item.innerHTML = `
      <div class="lib-info">
        <div class="lib-title"></div>
        <div class="lib-meta">${d.pages} pág. · ${d.lang === "es" ? "Español" : "English"} · ${pct}% leído</div>
        <div class="lib-bar"><div style="width:${pct}%"></div></div>
      </div>
      <span class="lib-del" title="Eliminar" role="button" aria-label="Eliminar documento">✕</span>`;
    item.querySelector(".lib-title").textContent = d.title;
    item.querySelector(".lib-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteDoc(d.id).catch(() => {});
      renderLibrary();
    });
    item.addEventListener("click", () => openDoc(d.id));
    wrap.appendChild(item);
  }
}

async function uploadFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name)) { toast("Solo se aceptan archivos PDF", true); return; }
  $("drop").classList.add("busy");
  $("drop").querySelector("strong").textContent = "Procesando…";
  try {
    const buffer = await file.arrayBuffer();
    const doc = await extractFromPdf(buffer, file.name);
    if (!doc.segments.length) {
      throw new Error("Este PDF no contiene texto seleccionable (probablemente es un escaneo). Aún no incluimos OCR.");
    }
    const library = await getLibrary();
    const previous = library.find((d) => d.id === doc.id);
    const position = previous ? previous.position || 0 : 0;   // re-upload keeps progress
    await saveDoc(doc);
    const rest = library.filter((d) => d.id !== doc.id);
    rest.unshift({
      id: doc.id, title: doc.title, pages: doc.pages, lang: doc.lang,
      n_segments: doc.segments.length, added: Date.now(), position,
    });
    await saveLibrary(rest);
    enterReader(doc, position);
  } catch (err) {
    toast(err.message || "No se pudo procesar el PDF", true);
  } finally {
    $("drop").classList.remove("busy");
    $("drop").querySelector("strong").textContent = "Arrastra tu PDF aquí";
  }
}

async function openDoc(id) {
  const doc = await getDoc(id).catch(() => null);
  if (!doc) { toast("Documento no encontrado en este dispositivo", true); return; }
  const entry = (await getLibrary()).find((d) => d.id === id);
  enterReader(doc, entry?.position || 0);
}

/* ---------- reader ---------- */

function enterReader(doc, position) {
  state.doc = doc;
  state.index = Math.min(position, doc.segments.length - 1);
  state.translations.clear();
  state.cache.clear();
  state.words = [];
  $("home").classList.add("hidden");
  $("reader").classList.remove("hidden");
  setImmersive(false);
  $("docTitleText").textContent = doc.title;
  const hasChapters = (doc.chapters || []).length > 0;
  $("docTitleChev").classList.toggle("hidden", !hasChapters);
  $("docTitle").classList.toggle("has-chapters", hasChapters);
  $("endCap").classList.add("hidden");

  const wrap = $("segments");
  wrap.innerHTML = "";
  for (const seg of doc.segments) {
    const p = document.createElement("p");
    p.className = "seg";
    p.dataset.i = seg.i;
    p.textContent = seg.text;
    p.addEventListener("click", () => jumpTo(seg.i));
    wrap.appendChild(p);
  }
  updateChips();
  setCurrent(state.index, { scroll: true, instant: true });
  updateMediaSession();
}

function exitReader() {
  stopPlayback();
  savePosition();
  state.doc = null;
  $("reader").classList.add("hidden");
  $("home").classList.remove("hidden");
  renderLibrary();
}

function segEl(i) {
  return $("segments").querySelector(`.seg[data-i="${i}"]`);
}

function setCurrent(i, { scroll = true, instant = false } = {}) {
  const prev = $("segments").querySelector(".seg.current");
  if (prev) {
    prev.classList.remove("current");
    restorePlainText(prev);
  }
  state.index = i;
  state.words = [];
  state.litIdx = -1;

  const segs = $("segments").children;
  for (let k = 0; k < segs.length; k++) {
    segs[k].classList?.toggle("near", Math.abs(k - i) === 1);
  }
  const el = segEl(i);
  if (!el) return;
  el.classList.add("current");
  if (scroll && Date.now() - state.userScrolledAt > 4000) {
    el.scrollIntoView({ block: "center", behavior: instant ? "auto" : "smooth" });
  }
  const total = state.doc.segments.length;
  $("progressFill").style.width = total > 1 ? `${(i / (total - 1)) * 100}%` : "100%";
  updateChips();
  if (state.translateOn) ensureTranslation(i);
  schedulePositionSave();
  schedulePrefetch(i);
}

/* Generar voz tarda; se adelanta el trabajo mientras lees para no esperar al pulsar play. */
let prefetchTimer = 0;
function schedulePrefetch(i) {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    if (state.doc && !state.playing) prefetch(i);
  }, 900);
}

function restorePlainText(el) {
  const i = Number(el.dataset.i);
  el.textContent = state.doc.segments[i].text;
  attachTranslation(el, i);
}

function renderWordSpans(el, i, words) {
  const text = state.doc.segments[i].text;
  const frag = document.createDocumentFragment();
  let cursor = 0;
  words.forEach((w, k) => {
    if (w.cs > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, w.cs)));
    const span = document.createElement("span");
    span.className = "w";
    span.dataset.k = k;
    span.textContent = text.slice(w.cs, w.ce);
    frag.appendChild(span);
    cursor = w.ce;
  });
  if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
  el.innerHTML = "";
  el.appendChild(frag);
  attachTranslation(el, i);
}

/* ---------- TTS via voice engine ---------- */

// Sin la velocidad: el audio se genera una vez y se acelera al reproducir.
const ttsKey = (i) => `${i}|${voiceForLang(segLang(i))}`;

function fetchGeminiSegment(i) {
  const seg = state.doc.segments[i];
  const voiceName = voiceForLang(segLang(i)).slice("gemini:".length);
  const cacheKey = audioKey(voiceName, null, seg.text);
  return (async () => {
    let entry = await getCachedAudio(cacheKey).catch(() => null);
    if (!entry) {
      entry = await geminiSpeak(seg.text, voiceName);
      putCachedAudio(cacheKey, entry.blob, entry.durationMs).catch(() => {});
    }
    return {
      url: URL.createObjectURL(entry.blob),
      words: estimateWords(seg.text, entry.durationMs),
    };
  })();
}

function fetchSegmentAudio(i) {
  const key = ttsKey(i);
  if (state.cache.has(key)) return state.cache.get(key);
  const promise = fetchGeminiSegment(i);
  promise.catch(() => state.cache.delete(key));
  state.cache.set(key, promise);
  trimCache();
  return promise;
}

function trimCache() {
  while (state.cache.size > 24) {
    const oldest = state.cache.keys().next().value;
    const p = state.cache.get(oldest);
    state.cache.delete(oldest);
    p.then((r) => URL.revokeObjectURL(r.url)).catch(() => {});
  }
}

/* Generar voz tarda unos segundos: se adelantan los párrafos siguientes
   para que la lectura continua nunca se corte. */
function prefetch(from) {
  if (!state.doc) return;
  for (let i = from; i < Math.min(from + 2, state.doc.segments.length); i++) {
    if (isGeminiVoice(voiceForLang(segLang(i)))) fetchSegmentAudio(i).catch(() => {});
  }
}

/* ---------- playback engine ---------- */

/* El audio Gemini se genera una sola vez: la velocidad se ajusta al reproducir. */
function applyPlaybackRate() {
  state.audio.preservesPitch = true;      // acelera sin subir el tono
  state.audio.playbackRate = state.settings.speed;
}

function wordsFromText(text) {
  const words = [];
  for (const m of text.matchAll(/\S+/g)) {
    words.push({ w: m[0], s: 0, e: 0, cs: m.index, ce: m.index + m[0].length });
  }
  return words;
}

function markLitByChar(charIndex) {
  const words = state.words;
  let lit = -1;
  for (let k = 0; k < words.length; k++) {
    if (words[k].cs <= charIndex) lit = k; else break;
  }
  applyLit(lit);
}

let currentUtterance = null;
let deviceKeepAlive = 0;
let deviceEstimator = 0;

function stopDeviceSpeech() {
  clearInterval(deviceKeepAlive);
  clearInterval(deviceEstimator);
  currentUtterance = null;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function playSegmentDevice(i, token) {
  const seg = state.doc.segments[i];
  const voice = deviceVoiceByRef(voiceForLang(segLang(i)));
  const words = wordsFromText(seg.text);
  state.words = words;
  renderWordSpans(segEl(i), i, words);

  const u = new SpeechSynthesisUtterance(seg.text);
  if (voice) { u.voice = voice; u.lang = voice.lang; }
  else u.lang = segLang(i) === "es" ? "es-MX" : "en-US";
  u.rate = state.settings.speed;
  u.volume = state.deviceVolume ?? 1;

  let boundarySeen = false;
  u.onboundary = (e) => {
    if (token !== state.playToken) return;
    boundarySeen = true;
    clearInterval(deviceEstimator);
    if (typeof e.charIndex === "number") markLitByChar(e.charIndex);
  };
  u.onend = () => {
    if (token !== state.playToken || !state.playing) return;
    const next = state.index + 1;
    if (next < state.doc.segments.length) playSegment(next);
    else finishDocument();
  };
  u.onerror = (e) => {
    if (token !== state.playToken) return;
    if (e.error === "interrupted" || e.error === "canceled") return;
    state.playing = false;
    setPlayUI("paused");
    toast(`Voz del dispositivo: ${e.error || "error"}`, true);
  };

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
  currentUtterance = u;
  state.playing = true;
  state.activeToken = token;
  state.engine = "device";
  setPlayUI("playing");
  setImmersive(true);
  requestWakeLock();

  // some engines never emit boundary events -> estimate progression by time
  const start = performance.now();
  const charsPerSec = 14 * state.settings.speed;
  clearInterval(deviceEstimator);
  deviceEstimator = setInterval(() => {
    if (token !== state.playToken || boundarySeen) { clearInterval(deviceEstimator); return; }
    if (!window.speechSynthesis.speaking) return;
    markLitByChar(Math.floor(((performance.now() - start) / 1000) * charsPerSec));
  }, 200);

  // Chromium pauses long utterances without periodic resume
  clearInterval(deviceKeepAlive);
  deviceKeepAlive = setInterval(() => {
    if (state.playing && state.engine === "device" && window.speechSynthesis.speaking) {
      window.speechSynthesis.resume();
    }
  }, 10000);
}

async function playSegment(i, { autoScroll = true } = {}) {
  if (!state.doc) return;
  if (i >= state.doc.segments.length) { finishDocument(); return; }
  const token = ++state.playToken;
  state.audio.pause();
  stopDeviceSpeech();
  setCurrent(i, { scroll: autoScroll });

  if (isDeviceVoice(voiceForLang(segLang(i)))) {
    if (!("speechSynthesis" in window)) {
      toast("Este navegador no tiene voces integradas", true);
      setPlayUI("paused");
      return;
    }
    playSegmentDevice(i, token);
    return;
  }

  setPlayUI("loading");
  try {
    const { url, words } = await fetchSegmentAudio(i);
    if (token !== state.playToken) return;
    state.words = words;
    renderWordSpans(segEl(i), i, words);
    state.audio.src = url;
    applyPlaybackRate();
    await state.audio.play();
    if (token !== state.playToken) { state.audio.pause(); return; }
    state.playing = true;
    state.activeToken = token;
    state.engine = "audio";
    setPlayUI("playing");
    setImmersive(true);
    startWordSync();
    requestWakeLock();
    prefetch(i + 1);
  } catch (err) {
    if (token !== state.playToken) return;
    // Si Google agotó la cuota, se sigue leyendo con la voz del dispositivo.
    if (err.quota && switchToDeviceVoice(segLang(i))) {
      toast("Cuota de Google agotada: seguimos con la voz de este dispositivo.");
      playSegment(i, { autoScroll });
      return;
    }
    setPlayUI("paused");
    state.playing = false;
    toast(err.message || "No se pudo reproducir", true);
  }
}

/* Degradación elegante: cambia esa lengua a la mejor voz local disponible. */
function switchToDeviceVoice(lang) {
  const v = bestDeviceVoice(lang);
  if (!v) return false;
  saveSettings(lang === "es" ? { voice_es: "device:" + v.voiceURI } : { voice_en: "device:" + v.voiceURI });
  state.cache.clear();
  updateChips();
  return true;
}

state.audio.addEventListener("ended", () => {
  if (!state.playing || state.playToken !== state.activeToken) return;
  const next = state.index + 1;
  if (next < state.doc.segments.length) {
    playSegment(next);
  } else {
    finishDocument();
  }
});

function finishDocument() {
  state.playing = false;
  state.playToken++;
  setPlayUI("paused");
  setImmersive(false);
  stopWordSync();
  $("endCap").classList.remove("hidden");
  savePosition();
  releaseWakeLock();
}

function pausePlayback() {
  state.playing = false;
  state.playToken++;
  state.audio.pause();
  stopDeviceSpeech();      // device voices restart the paragraph on resume
  setPlayUI("paused");
  setImmersive(false);
  stopWordSync();
  savePosition();
  releaseWakeLock();
}

function stopPlayback() {
  pausePlayback();
  state.audio.removeAttribute("src");
  state.audio.load();
}

function togglePlay() {
  if (state.playing) {
    pausePlayback();
  } else if (state.engine !== "device" && state.audio.src && !state.audio.ended && state.audio.currentTime > 0 && sameSegmentLoaded()) {
    const token = ++state.playToken;
    state.audio.play().then(() => {
      if (token !== state.playToken) return;
      state.playing = true;
      state.activeToken = token;
      setPlayUI("playing");
      setImmersive(true);
      startWordSync();
      requestWakeLock();
    }).catch(() => playSegment(state.index));
  } else {
    playSegment(state.index);
  }
}

function sameSegmentLoaded() {
  return state.words.length > 0 && segEl(state.index)?.querySelector(".w") != null;
}

function jumpTo(i) {
  const wasPlaying = state.playing;
  state.audio.pause();
  stopWordSync();
  if (wasPlaying) {
    playSegment(i);
  } else {
    state.playToken++;
    setCurrent(i, { scroll: true });
    setPlayUI("paused");
  }
}

function setPlayUI(mode) {
  $("iconPlay").classList.toggle("hidden", mode !== "paused");
  $("iconPause").classList.toggle("hidden", mode !== "playing");
  $("iconSpin").classList.toggle("hidden", mode !== "loading");
  $("btnPlay").setAttribute("aria-label", mode === "playing" ? "Pausa" : "Reproducir");
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = mode === "playing" ? "playing" : "paused";
  }
}

function setImmersive(on) {
  $("reader").classList.toggle("immersive", on);
}

/* ---------- word sync (karaoke) ---------- */

function applyLit(lit) {
  if (lit === state.litIdx) return;
  const el = segEl(state.index);
  if (el) {
    el.querySelectorAll(".w.lit").forEach((n) => n.classList.remove("lit"));
    for (let k = 0; k <= lit; k++) {
      const span = el.querySelector(`.w[data-k="${k}"]`);
      if (span) span.classList.toggle("sung", k < lit);
      if (span && k === lit) span.classList.add("lit", "sung");
    }
  }
  state.litIdx = lit;
}

function syncWords() {
  const t = state.audio.currentTime * 1000;
  const words = state.words;
  if (!words.length) return;
  let lit = -1;
  for (let k = 0; k < words.length; k++) {
    if (t >= words[k].s) lit = k; else break;
  }
  applyLit(lit);
}

function startWordSync() {
  stopWordSync();
  const tick = () => {
    syncWords();
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

function stopWordSync() {
  cancelAnimationFrame(state.raf);
  state.raf = 0;
}

state.audio.addEventListener("timeupdate", () => {
  if (state.playing) syncWords();
});

/* ---------- translation (direct to Gemini from this device) ---------- */

function targetLang(i) {
  return segLang(i ?? state.index) === "es" ? "en" : "es";
}

const LANG_NAMES = { es: "español latinoamericano natural", en: "natural American English" };
const UNAVAILABLE_HINTS = ["not available", "not found", "deprecated", "does not exist", "no longer"];

async function translateText(text, target) {
  const apiKey = (state.settings.gemini_api_key || "").trim();
  if (!apiKey) {
    throw new Error("Configura tu API key de Google AI Studio en Ajustes (aistudio.google.com/apikey — es gratis).");
  }
  const cached = await getCachedTranslation(target, text).catch(() => null);
  if (cached) return cached;

  const prompt = `Traduce el siguiente texto a ${LANG_NAMES[target] || target}. ` +
    "Mantén el tono y el significado, con fluidez nativa. " +
    "Responde ÚNICAMENTE con la traducción, sin comentarios.\n\n" + text;
  const override = (state.settings.gemini_model || "").trim();
  const models = override ? [override] : GEMINI_MODELS.filter((m) => !geminiBadModels.has(m));
  let lastError = "sin modelos disponibles";

  for (const model of models.length ? models : GEMINI_MODELS) {
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
      });
    } catch {
      throw new Error("Sin conexión con Google (¿hay internet?)");
    }
    if (res.ok) {
      const data = await res.json();
      const translation = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!translation) throw new Error("Gemini devolvió una respuesta inesperada");
      cacheTranslation(target, text, translation).catch(() => {});
      return translation;
    }
    let message = "";
    try { message = (await res.json())?.error?.message || ""; } catch {}
    lastError = message || `HTTP ${res.status}`;
    if (UNAVAILABLE_HINTS.some((h) => message.toLowerCase().includes(h))) {
      geminiBadModels.add(model);
      continue;
    }
    throw new Error(`Gemini API: ${lastError}`);
  }
  throw new Error(`Gemini API: ${lastError}`);
}

function attachTranslation(el, i) {
  el.querySelector(".trans")?.remove();
  if (!state.translateOn) return;
  const cached = state.translations.get(i);
  const span = document.createElement("span");
  span.className = "trans" + (cached ? "" : " loading");
  span.textContent = cached || "traduciendo…";
  el.appendChild(span);
}

async function ensureTranslation(i) {
  if (!state.translateOn || state.translations.has(i)) {
    attachTranslation(segEl(i), i);
    return;
  }
  attachTranslation(segEl(i), i);
  try {
    const translation = await translateText(state.doc.segments[i].text, targetLang(i));
    state.translations.set(i, translation);
  } catch (err) {
    state.translations.set(i, `⚠ ${err.message}`);
  }
  const el = segEl(i);
  if (el) attachTranslation(el, i);
  if (state.translateOn && i + 1 < state.doc.segments.length && !state.translations.has(i + 1)) {
    ensureTranslation(i + 1);
  }
}

function toggleTranslate() {
  state.translateOn = !state.translateOn;
  $("chipTranslate").classList.toggle("active", state.translateOn);
  document.querySelectorAll(".seg").forEach((el) => attachTranslation(el, Number(el.dataset.i)));
  if (state.translateOn) ensureTranslation(state.index);
}

/* ---------- position ---------- */

let posTimer = 0;
function schedulePositionSave() {
  clearTimeout(posTimer);
  posTimer = setTimeout(savePosition, 1500);
}
function savePosition() {
  if (!state.doc) return;
  storePosition(state.doc.id, state.index).catch(() => {});
}
window.addEventListener("pagehide", savePosition);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") savePosition();
});

/* ---------- media session / wake lock ---------- */

function updateMediaSession() {
  if (!("mediaSession" in navigator) || !state.doc) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.doc.title,
    artist: "Lyrio",
    album: state.doc.lang === "es" ? "Lectura en español" : "English reading",
  });
  navigator.mediaSession.setActionHandler("play", () => togglePlay());
  navigator.mediaSession.setActionHandler("pause", () => pausePlayback());
  navigator.mediaSession.setActionHandler("previoustrack", () => jumpTo(Math.max(0, state.index - 1)));
  navigator.mediaSession.setActionHandler("nexttrack", () =>
    jumpTo(Math.min(state.doc.segments.length - 1, state.index + 1)));
}

async function requestWakeLock() {
  try { state.wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

/* ---------- chapters ---------- */

function currentChapterPos() {
  const chapters = state.doc?.chapters || [];
  let current = -1;
  for (let k = 0; k < chapters.length; k++) {
    if (chapters[k].seg <= state.index) current = k; else break;
  }
  return current;
}

function openChapters() {
  const chapters = state.doc?.chapters || [];
  if (!chapters.length) return;
  const wrap = $("chapterList");
  wrap.innerHTML = "";
  const active = currentChapterPos();
  chapters.forEach((ch, k) => {
    const btn = document.createElement("button");
    btn.className = "chapter-item" + (k === active ? " active" : "");
    btn.innerHTML = `<span class="ch-n">${k + 1}</span><span class="ch-t"></span>`;
    btn.querySelector(".ch-t").textContent = ch.title;
    btn.addEventListener("click", () => {
      closeSheet();
      jumpTo(ch.seg);
    });
    wrap.appendChild(btn);
  });
  $("chapterSheet").classList.remove("hidden");
  $("sheetBackdrop").classList.remove("hidden");
  wrap.querySelector(".chapter-item.active")?.scrollIntoView({ block: "center" });
}

/* ---------- chips & sheet ---------- */

function shortDeviceName(name) {
  return name.replace(/^Microsoft\s+/i, "").replace(/^Google\s+/i, "")
    .split(/\s+Online|\s*\(|\s*-\s/)[0].trim() || name;
}

function voiceLabel(id) {
  if (isGeminiVoice(id)) {
    const name = id.slice("gemini:".length);
    const v = GEMINI_VOICES.find((x) => x.name === name);
    return `${name} · ${v ? (v.gender === "F" ? "♀" : "♂") : "✨"}`;
  }
  const v = deviceVoiceByRef(id);
  return v ? `${shortDeviceName(v.name)} · 📱` : "Voz";
}

function updateChips() {
  $("chipVoice").textContent = voiceLabel(currentVoice());
  $("chipSpeed").textContent = `${state.settings.speed.toFixed(2).replace(/0$/, "")}×`;
  $("chipTranslate").classList.toggle("active", state.translateOn);
}

function selectVoice(lang, id) {
  saveSettings(lang === "es" ? { voice_es: id } : { voice_en: id });
  renderVoiceLists();
  updateChips();
  onVoiceOrSpeedChange();
}

function renderVoiceLists() {
  refreshDeviceVoices();
  const geminiReady = Boolean((state.settings.gemini_api_key || "").trim());
  $("voiceHint").textContent = geminiReady
    ? "Las voces del dispositivo son ilimitadas y funcionan sin conexión. Las Gemini suenan mejor, pero el plan gratuito de Google solo permite unos pocos párrafos al día."
    : "Las voces del dispositivo son ilimitadas y funcionan sin conexión. Para probar las voces Gemini pega tu clave de Google AI Studio más abajo (su plan gratuito solo alcanza para unos pocos párrafos al día).";

  for (const [lang, containerId] of [["es", "gemVoicesEs"], ["en", "gemVoicesEn"]]) {
    const wrap = $(containerId);
    wrap.innerHTML = "";
    for (const v of GEMINI_VOICES) {
      const id = "gemini:" + v.name;
      const active = (lang === "es" ? state.settings.voice_es : state.settings.voice_en) === id;
      const btn = document.createElement("button");
      btn.className = "voice-item" + (active ? " active" : "") + (geminiReady ? "" : " disabled");
      btn.innerHTML = `<span class="vg">${v.gender === "F" ? "♀" : "♂"}</span><span><span class="vn"></span><span class="vr"></span></span>`;
      btn.querySelector(".vn").textContent = v.name;
      btn.querySelector(".vr").textContent = v.tone;
      if (geminiReady) btn.addEventListener("click", () => selectVoice(lang, id));
      wrap.appendChild(btn);
    }
  }

  for (const [lang, containerId] of [["es", "devVoicesEs"], ["en", "devVoicesEn"]]) {
    const wrap = $(containerId);
    wrap.innerHTML = "";
    const pool = deviceVoices.filter((v) => v.lang.toLowerCase().startsWith(lang));
    wrap.closest(".voice-group").classList.toggle("hidden", pool.length === 0);
    for (const v of pool.slice(0, 12)) {
      const id = "device:" + v.voiceURI;
      const active = (lang === "es" ? state.settings.voice_es : state.settings.voice_en) === id;
      const btn = document.createElement("button");
      btn.className = "voice-item" + (active ? " active" : "");
      btn.innerHTML = `<span class="vg">📱</span><span><span class="vn"></span><span class="vr"></span></span>`;
      btn.querySelector(".vn").textContent = shortDeviceName(v.name);
      btn.querySelector(".vr").textContent = v.lang + (/natural|online/i.test(v.name) ? " · Neural" : "");
      btn.addEventListener("click", () => selectVoice(lang, id));
      wrap.appendChild(btn);
    }
  }
}

function onVoiceOrSpeedChange({ speedOnly = false } = {}) {
  if (!state.doc) return;
  // Con Gemini el audio no depende de la velocidad: basta ajustar la reproducción.
  if (speedOnly && isGeminiVoice(voiceForLang(segLang(state.index)))) {
    applyPlaybackRate();
    return;
  }
  if (state.playing) {
    playSegment(state.index);
  } else {
    state.words = [];
    const el = segEl(state.index);
    if (el) restorePlainText(el);
  }
}

function openSheet() {
  renderVoiceLists();
  $("speedSlider").value = state.settings.speed;
  $("speedValue").textContent = `${state.settings.speed.toFixed(2).replace(/0$/, "")}×`;
  $("sizeSlider").value = state.settings.fontSize;
  $("sizeValue").textContent = `${state.settings.fontSize}px`;
  $("geminiKey").value = state.settings.gemini_api_key || "";
  $("keyStatus").textContent = state.settings.gemini_api_key ? "✓ Clave configurada" : "";
  highlightChipRows();
  $("sheet").classList.remove("hidden");
  $("sheetBackdrop").classList.remove("hidden");
}

function closeSheet() {
  $("sheet").classList.add("hidden");
  $("chapterSheet").classList.add("hidden");
  $("sheetBackdrop").classList.add("hidden");
}

function highlightChipRows() {
  $("fontChips").querySelectorAll(".chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.font === state.settings.font));
  $("themeChips").querySelectorAll(".chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.theme === state.settings.theme));
  $("widthChips").querySelectorAll(".chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.width === (state.settings.width || "medio")));
}

/* ---------- wire events ---------- */

function wireEvents() {
  $("fileInput").addEventListener("change", (e) => uploadFile(e.target.files[0]));
  const drop = $("drop");
  ["dragover", "dragenter"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("dragover"); }));
  drop.addEventListener("drop", (e) => uploadFile(e.dataTransfer.files[0]));
  document.body.addEventListener("dragover", (e) => e.preventDefault());
  document.body.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!$("home").classList.contains("hidden")) uploadFile(e.dataTransfer.files[0]);
  });

  $("btnBack").addEventListener("click", exitReader);
  $("btnPlay").addEventListener("click", togglePlay);
  $("btnPrev").addEventListener("click", () => jumpTo(Math.max(0, state.index - 1)));
  $("btnNext").addEventListener("click", () =>
    jumpTo(Math.min(state.doc.segments.length - 1, state.index + 1)));
  $("btnSettings").addEventListener("click", openSheet);
  $("docTitle").addEventListener("click", openChapters);
  $("chipVoice").addEventListener("click", openSheet);
  $("chipFont").addEventListener("click", openSheet);
  $("chipSpeed").addEventListener("click", openSheet);
  $("chipTranslate").addEventListener("click", toggleTranslate);
  $("sheetBackdrop").addEventListener("click", closeSheet);

  ["wheel", "touchmove"].forEach((ev) =>
    $("stage").addEventListener(ev, () => { state.userScrolledAt = Date.now(); }, { passive: true }));

  $("stage").addEventListener("click", (e) => {
    if (e.target.closest(".seg")) return;
    setImmersive(!$("reader").classList.contains("immersive"));
  });

  $("speedSlider").addEventListener("input", (e) => {
    const speed = Number(e.target.value);
    $("speedValue").textContent = `${speed.toFixed(2).replace(/0$/, "")}×`;
    saveSettings({ speed });
    updateChips();
  });
  $("speedSlider").addEventListener("change", () => onVoiceOrSpeedChange({ speedOnly: true }));
  $("sizeSlider").addEventListener("input", (e) => {
    saveSettings({ fontSize: Number(e.target.value) });
    $("sizeValue").textContent = `${e.target.value}px`;
  });
  $("fontChips").addEventListener("click", (e) => {
    const font = e.target.closest(".chip")?.dataset.font;
    if (font) { saveSettings({ font }); highlightChipRows(); }
  });
  $("themeChips").addEventListener("click", (e) => {
    const theme = e.target.closest(".chip")?.dataset.theme;
    if (theme) { saveSettings({ theme }); highlightChipRows(); }
  });
  $("widthChips").addEventListener("click", (e) => {
    const width = e.target.closest(".chip")?.dataset.width;
    if (width) { saveSettings({ width }); highlightChipRows(); }
  });
  $("saveKey").addEventListener("click", () => {
    const key = $("geminiKey").value.trim();
    saveSettings({ gemini_api_key: key });
    $("keyStatus").textContent = key
      ? "✓ Clave guardada — ya puedes usar las voces Gemini y la traducción"
      : "Clave eliminada";
    state.translations.clear();
    autoPickDeviceVoices();
    renderVoiceLists();
    updateChips();
  });

  document.addEventListener("keydown", (e) => {
    if ($("reader").classList.contains("hidden")) return;
    if (e.target.tagName === "INPUT") return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    if (e.code === "ArrowRight") jumpTo(Math.min(state.doc.segments.length - 1, state.index + 1));
    if (e.code === "ArrowLeft") jumpTo(Math.max(0, state.index - 1));
    if (e.code === "Escape") closeSheet();
  });
}

/* ---------- boot ---------- */

function boot() {
  wireEvents();
  applyDisplaySettings();
  autoPickDeviceVoices();
  renderLibrary();
}

boot();

// debug/test handle (harmless in production)
window.lyrio = {
  state, uploadFile, jumpTo, togglePlay, pausePlayback, setImmersive, openChapters,
  saveSettings, exitReader, estimateWords, pcmToWav, renderVoiceLists, openSheet, closeSheet,
};
