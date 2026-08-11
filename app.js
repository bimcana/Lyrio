/* Lyrio Web — self-contained reader: on-device library, karaoke TTS via voice engine. */
"use strict";

import { extractFromPdf } from "./extract.js";
import {
  DEFAULT_SETTINGS, loadSettings, persistSettings,
  getLibrary, saveLibrary, getDoc, saveDoc, deleteDoc, savePosition as storePosition,
  getCachedTranslation, cacheTranslation,
} from "./storage.js";

const $ = (id) => document.getElementById(id);

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

const GEMINI_MODELS = ["gemini-flash-latest", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-flash"];
const geminiBadModels = new Set();

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

/* If no external engine is configured, default to the device's best voices. */
function autoPickDeviceVoices() {
  if (proxyUrl()) return;
  const patch = {};
  if (!isDeviceVoice(state.settings.voice_es)) {
    const v = bestDeviceVoice("es");
    if (v) patch.voice_es = "device:" + v.voiceURI;
  }
  if (!isDeviceVoice(state.settings.voice_en)) {
    const v = bestDeviceVoice("en");
    if (v) patch.voice_en = "device:" + v.voiceURI;
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

function proxyUrl() {
  return (state.settings.proxy_url || "").trim().replace(/\/+$/, "");
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

function ttsKey(i) {
  return `${i}|${voiceForLang(segLang(i))}|${state.settings.speed}`;
}

function fetchSegmentAudio(i) {
  const key = ttsKey(i);
  if (state.cache.has(key)) return state.cache.get(key);
  const base = proxyUrl();
  if (!base) {
    return Promise.reject(new Error("Configura el motor de voz en Ajustes (dirección del servicio)."));
  }
  const seg = state.doc.segments[i];
  const promise = fetch(`${base}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: seg.text, voice: voiceForLang(segLang(i)), speed: state.settings.speed }),
  }).then(async (res) => {
    if (!res.ok) {
      let msg = `Motor de voz: error ${res.status}`;
      try { msg = (await res.json()).detail || msg; } catch {}
      throw new Error(msg);
    }
    const data = await res.json();
    const bytes = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
    return { url, words: data.words };
  }).catch((err) => {
    if (err instanceof TypeError) throw new Error("No se pudo contactar el motor de voz (¿hay internet?)");
    throw err;
  });
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

function prefetch(from) {
  for (let i = from; i < Math.min(from + 2, state.doc.segments.length); i++) {
    if (!isDeviceVoice(voiceForLang(segLang(i)))) fetchSegmentAudio(i);
  }
}

/* ---------- playback engine ---------- */

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
    setPlayUI("paused");
    state.playing = false;
    toast(err.message || "No se pudo reproducir", true);
  }
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

function voiceById(id) {
  return VOICES.find((v) => v.id === id);
}

function shortDeviceName(name) {
  return name.replace(/^Microsoft\s+/i, "").replace(/^Google\s+/i, "")
    .split(/\s+Online|\s*\(|\s*-\s/)[0].trim() || name;
}

function voiceLabel(id) {
  if (isDeviceVoice(id)) {
    const v = deviceVoiceByRef(id);
    return v ? `${shortDeviceName(v.name)} · 📱` : "Voz del dispositivo";
  }
  const v = voiceById(id);
  return v ? `${v.name} · ${v.gender === "F" ? "♀" : "♂"}` : "Voz";
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
  const proxyReady = Boolean(proxyUrl());
  $("voiceHint").textContent = proxyReady
    ? ""
    : "Las voces neuronales requieren configurar el motor de voz (más abajo). Mientras tanto, usa las voces integradas de este dispositivo.";

  for (const [lang, containerId] of [["es", "voicesEs"], ["en", "voicesEn"]]) {
    const wrap = $(containerId);
    wrap.innerHTML = "";
    for (const v of VOICES.filter((x) => x.lang === lang)) {
      const active = (lang === "es" ? state.settings.voice_es : state.settings.voice_en) === v.id;
      const btn = document.createElement("button");
      btn.className = "voice-item" + (active ? " active" : "") + (proxyReady ? "" : " disabled");
      btn.innerHTML = `<span class="vg">${v.gender === "F" ? "♀" : "♂"}</span><span><span class="vn"></span><span class="vr"></span></span>`;
      btn.querySelector(".vn").textContent = v.name;
      btn.querySelector(".vr").textContent = v.region;
      if (proxyReady) btn.addEventListener("click", () => selectVoice(lang, v.id));
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

function onVoiceOrSpeedChange() {
  if (!state.doc) return;
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
  $("proxyUrl").value = state.settings.proxy_url || "";
  $("proxyStatus").textContent = state.settings.proxy_url
    ? ""
    : "Opcional: sin él se usan las voces integradas del dispositivo.";
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
  $("speedSlider").addEventListener("change", onVoiceOrSpeedChange);
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
  $("saveProxy").addEventListener("click", async () => {
    const url = $("proxyUrl").value.trim().replace(/\/+$/, "");
    saveSettings({ proxy_url: url });
    state.cache.clear();
    renderVoiceLists();
    if (!url) {
      autoPickDeviceVoices();
      renderVoiceLists();
      updateChips();
      $("proxyStatus").textContent = "Sin motor externo: se usan las voces del dispositivo.";
      return;
    }
    $("proxyStatus").textContent = "Comprobando…";
    try {
      const res = await fetch(url + "/", { method: "GET" });
      const ok = res.ok && (await res.json()).service === "lyrio-voice";
      $("proxyStatus").textContent = ok ? "✓ Motor de voz conectado" : "⚠ Responde, pero no parece ser el motor de Lyrio";
    } catch {
      $("proxyStatus").textContent = "⚠ No se pudo conectar con esa dirección";
    }
  });
  $("saveKey").addEventListener("click", () => {
    saveSettings({ gemini_api_key: $("geminiKey").value.trim() });
    $("keyStatus").textContent = $("geminiKey").value.trim() ? "✓ Clave guardada" : "Clave eliminada";
    state.translations.clear();
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
window.lyrio = { state, uploadFile, jumpTo, togglePlay, pausePlayback, setImmersive, openChapters, saveSettings, exitReader };
