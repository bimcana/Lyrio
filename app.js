/* Lyrio Web — lector autosuficiente: biblioteca en el dispositivo, lectura por
   oraciones con las voces del propio dispositivo y resaltado palabra a palabra. */
"use strict";

import { extractFromPdf } from "./extract.js?v=6";
import { splitSentences } from "./sentences.js?v=6";
import {
  loadSettings, persistSettings,
  getLibrary, saveLibrary, getDoc, saveDoc, deleteDoc, savePosition as storePosition,
  getCachedTranslation, cacheTranslation,
} from "./storage.js?v=6";

const $ = (id) => document.getElementById(id);

const GEMINI_MODELS = ["gemini-flash-latest", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-flash"];
const UNAVAILABLE_HINTS = ["not available", "not found", "deprecated", "does not exist", "no longer"];
const geminiBadModels = new Set();

const MAX_SPEED = 1.5;

/* ---------- voces neuronales de Microsoft (motor remoto) ---------- */

const NEURAL_VOICES = [
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

const isNeural = (id) => NEURAL_VOICES.some((v) => v.id === id);
const neuralById = (id) => NEURAL_VOICES.find((v) => v.id === id);

const engineUrl = () => (state.settings.engine_url || "").trim().replace(/\/+$/, "");

/* ---------- estado ---------- */

const state = {
  settings: loadSettings(),
  doc: null,
  para: 0,              // párrafo actual
  sent: 0,              // oración actual dentro del párrafo
  sentences: new Map(), // índice de párrafo -> [{cs, ce}]
  playing: false,
  words: [],            // {c, el} de la oración en curso
  litIdx: -1,
  translation: null,    // {para, sent, text}
  userScrolledAt: 0,
  wakeLock: null,
  token: 0,             // invalida cadenas de reproducción antiguas
  engine: "device",     // "device" (voz del sistema) | "neural" (motor remoto)
  audio: new Audio(),   // reproduce el audio del motor neuronal
  clips: new Map(),     // "para|sent|voz|vel" -> Promise<{url, words}>
  raf: 0,
};

state.audio.setAttribute("playsinline", "");
state.audio.preload = "auto";

/* ---------- avisos ---------- */

let toastTimer = 0;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4200);
}

/* ---------- voces del dispositivo ---------- */

let deviceVoices = [];

function refreshDeviceVoices() {
  const all = (window.speechSynthesis?.getVoices() || [])
    .filter((v) => /^(es|en)\b/i.test(v.lang) || /^(es|en)-/i.test(v.lang));
  const rank = (v) => {
    const n = v.name.toLowerCase();
    if (/natural|online/.test(n)) return 0;                       // voces neuronales de Edge
    if (/enhanced|premium|mejorad|superior/.test(n)) return 1;
    if (/^es-(mx|us|do|co|ar|419|cl|pe|ve)/i.test(v.lang) || /^en-us/i.test(v.lang)) return 2;
    return 3;
  };
  all.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  deviceVoices = all;
}

if ("speechSynthesis" in window) {
  refreshDeviceVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    refreshDeviceVoices();
    autoPickVoices();
    updateChips();
  });
}

function voiceByRef(id) {
  const uri = (id || "").replace(/^device:/, "");
  return deviceVoices.find((v) => v.voiceURI === uri || v.name === uri) || null;
}

function bestVoiceFor(lang) {
  return deviceVoices.filter((v) => v.lang.toLowerCase().startsWith(lang))[0] || null;
}

function autoPickVoices() {
  const patch = {};
  const tieneMotor = Boolean(engineUrl());
  for (const [lang, field] of [["es", "voice_es"], ["en", "voice_en"]]) {
    const actual = state.settings[field];
    if (isNeural(actual) && tieneMotor) continue;                 // voz neuronal utilizable
    if (voiceByRef(actual)) continue;                             // voz del sistema disponible
    if (tieneMotor) {
      patch[field] = lang === "es" ? "es-MX-DaliaNeural" : "en-US-AvaMultilingualNeural";
    } else {
      const v = bestVoiceFor(lang);
      if (v) patch[field] = "device:" + v.voiceURI;
    }
  }
  if (Object.keys(patch).length) saveSettings(patch);
}

function shortVoiceName(name) {
  return name.replace(/^Microsoft\s+/i, "").replace(/^Google\s+/i, "")
    .split(/\s+Online|\s*\(|\s*-\s/)[0].trim() || name;
}

/* ---------- ajustes ---------- */

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
  if (state.settings.speed > MAX_SPEED) state.settings.speed = MAX_SPEED;
  applyDisplaySettings();
  persistSettings(state.settings);
}

function paraLang(i) {
  return state.doc?.segments[i]?.lang || state.doc?.lang || "es";
}

function voiceForPara(i) {
  return paraLang(i) === "en" ? state.settings.voice_en : state.settings.voice_es;
}

/* ---------- oraciones ---------- */

function sentencesFor(i) {
  if (!state.sentences.has(i)) {
    state.sentences.set(i, splitSentences(state.doc.segments[i].text));
  }
  return state.sentences.get(i);
}

function sentenceText(i, k) {
  const s = sentencesFor(i)[k];
  return state.doc.segments[i].text.slice(s.cs, s.ce);
}

/* ---------- biblioteca ---------- */

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
    const position = previous ? previous.position || 0 : 0;
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

/* ---------- lector ---------- */

function enterReader(doc, position) {
  state.doc = doc;
  state.para = Math.min(position, doc.segments.length - 1);
  state.sent = 0;
  state.sentences.clear();
  state.translation = null;
  state.words = [];
  $("home").classList.add("hidden");
  $("reader").classList.remove("hidden");
  setImmersive(false);
  closePopovers();
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
    wrap.appendChild(p);
    renderParagraph(seg.i);
  }
  updateChips();
  setCurrent(state.para, 0, { instant: true });
}

function exitReader() {
  stopSpeech();
  savePosition();
  state.doc = null;
  $("reader").classList.add("hidden");
  $("home").classList.remove("hidden");
  renderLibrary();
}

const segEl = (i) => $("segments").querySelector(`.seg[data-i="${i}"]`);

/* Cada párrafo se dibuja como oraciones tocables; la que se lee además
   lleva una palabra por span para el resaltado. */
function renderParagraph(i) {
  const el = segEl(i);
  if (!el) return;
  const text = state.doc.segments[i].text;
  const sents = sentencesFor(i);
  const isCurrentPara = i === state.para;
  const frag = document.createDocumentFragment();

  sents.forEach((s, k) => {
    const span = document.createElement("span");
    span.className = "sn";
    span.dataset.s = k;
    const sentText = text.slice(s.cs, s.ce);

    if (isCurrentPara && k === state.sent) {
      span.classList.add("active");
      let last = 0;
      for (const m of sentText.matchAll(/\S+/g)) {
        if (m.index > last) span.appendChild(document.createTextNode(sentText.slice(last, m.index)));
        const w = document.createElement("span");
        w.className = "w";
        w.dataset.c = String(s.cs + m.index);
        w.textContent = m[0];
        span.appendChild(w);
        last = m.index + m[0].length;
      }
      if (last < sentText.length) span.appendChild(document.createTextNode(sentText.slice(last)));
    } else {
      span.textContent = sentText;
      if (isCurrentPara && k < state.sent) span.classList.add("done");
    }
    frag.appendChild(span);

    const gapEnd = k + 1 < sents.length ? sents[k + 1].cs : text.length;
    if (gapEnd > s.ce) frag.appendChild(document.createTextNode(text.slice(s.ce, gapEnd)));
  });

  el.innerHTML = "";
  el.appendChild(frag);
  if (isCurrentPara) {
    state.words = [...el.querySelectorAll(".w")].map((w) => ({ c: Number(w.dataset.c), el: w }));
    state.litIdx = -1;
  }
  attachTranslation(el, i);
}

function setCurrent(para, sent, { instant = false, scroll = true } = {}) {
  const prevPara = state.para;
  state.para = para;
  state.sent = sent;
  if (prevPara !== para) renderParagraph(prevPara);
  renderParagraph(para);

  const segs = $("segments").children;
  for (let k = 0; k < segs.length; k++) {
    segs[k].classList.toggle("current", k === para);
    segs[k].classList.toggle("near", Math.abs(k - para) === 1);
  }

  if (scroll && Date.now() - state.userScrolledAt > 4000) {
    const target = segEl(para)?.querySelector(".sn.active") || segEl(para);
    target?.scrollIntoView({ block: "center", behavior: instant ? "auto" : "smooth" });
  }

  const total = state.doc.segments.length;
  $("progressFill").style.width = total > 1 ? `${(para / (total - 1)) * 100}%` : "100%";
  updateChips();
  schedulePositionSave();
}

/* ---------- motor de voz del dispositivo ---------- */

let keepAlive = 0;
let estimator = 0;

function stopSpeech() {
  clearInterval(keepAlive);
  clearInterval(estimator);
  cancelAnimationFrame(state.raf);
  state.playing = false;
  state.token++;
  state.audio.pause();
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  setPlayUI("paused");
  setImmersive(false);
  releaseWakeLock();
  savePosition();
}

function markLitByChar(absChar) {
  let lit = -1;
  for (let k = 0; k < state.words.length; k++) {
    if (state.words[k].c <= absChar) lit = k; else break;
  }
  if (lit === state.litIdx) return;
  for (let k = 0; k < state.words.length; k++) {
    const w = state.words[k].el;
    w.classList.toggle("sung", k < lit);
    w.classList.toggle("lit", k === lit);
    if (k === lit) w.classList.add("sung");
  }
  state.litIdx = lit;
}

/* ---------- motor neuronal: pide el audio y lo reproduce con tiempos reales ---------- */

const clipKey = (p, k) => `${p}|${k}|${voiceForPara(p)}|${state.settings.speed}`;

function fetchClip(p, k) {
  const key = clipKey(p, k);
  if (state.clips.has(key)) return state.clips.get(key);
  const base = engineUrl();
  const promise = fetch(`${base}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: sentenceText(p, k),
      voice: voiceForPara(p),
      speed: Math.min(MAX_SPEED, state.settings.speed),
    }),
  }).then(async (res) => {
    if (!res.ok) {
      let msg = `Motor de voz: error ${res.status}`;
      try { msg = (await res.json()).detail || msg; } catch {}
      throw new Error(msg);
    }
    const data = await res.json();
    const bytes = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
    return { url: URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" })), words: data.words };
  }).catch((err) => {
    if (err instanceof TypeError) throw new Error("No se pudo contactar el motor de voz (¿hay internet?)");
    throw err;
  });
  promise.catch(() => state.clips.delete(key));
  state.clips.set(key, promise);
  while (state.clips.size > 20) {
    const viejo = state.clips.keys().next().value;
    const p2 = state.clips.get(viejo);
    state.clips.delete(viejo);
    p2.then((r) => URL.revokeObjectURL(r.url)).catch(() => {});
  }
  return promise;
}

/* Adelanta las siguientes oraciones para que la lectura no se corte. */
function prefetchClips(p, k) {
  if (!state.doc || state.engine !== "neural") return;
  let para = p, sent = k, hechos = 0;
  while (hechos < 3) {
    const sents = sentencesFor(para);
    if (sent + 1 < sents.length) sent++;
    else if (para + 1 < state.doc.segments.length) { para++; sent = 0; }
    else break;
    fetchClip(para, sent).catch(() => {});
    hechos++;
  }
}

function syncNeuralWords(words) {
  const t = state.audio.currentTime * 1000;
  let lit = -1;
  for (let i = 0; i < words.length; i++) {
    if (t >= words[i].s) lit = i; else break;
  }
  if (lit === state.litIdx) return;
  for (let i = 0; i < state.words.length; i++) {
    const el = state.words[i].el;
    el.classList.toggle("sung", i < lit);
    el.classList.toggle("lit", i === lit);
    if (i === lit) el.classList.add("sung");
  }
  state.litIdx = lit;
}

async function speakNeural(token) {
  const p = state.para, k = state.sent;
  try {
    const { url, words } = await fetchClip(p, k);
    if (token !== state.token) return;
    state.audio.src = url;
    state.audio.playbackRate = 1;
    await state.audio.play();
    if (token !== state.token) { state.audio.pause(); return; }
    state.playing = true;
    state.engine = "neural";
    setPlayUI("playing");
    setImmersive(true);
    requestWakeLock();
    prefetchClips(p, k);

    cancelAnimationFrame(state.raf);
    const tick = () => {
      if (token !== state.token) return;
      syncNeuralWords(words);
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
  } catch (err) {
    if (token !== state.token) return;
    // Si el motor falla, la lectura continúa con la voz del dispositivo.
    const v = bestVoiceFor(paraLang(p));
    if (v) {
      saveSettings(paraLang(p) === "es" ? { voice_es: "device:" + v.voiceURI }
                                        : { voice_en: "device:" + v.voiceURI });
      updateChips();
      toast("Motor de voz no disponible: seguimos con la voz del dispositivo.");
      speakCurrent();
      return;
    }
    state.playing = false;
    setPlayUI("paused");
    toast(err.message || "No se pudo reproducir", true);
  }
}

state.audio.addEventListener("ended", () => {
  if (state.playing && state.engine === "neural") advance();
});

function speakCurrent() {
  if (!state.doc) return;

  if (isNeural(voiceForPara(state.para)) && engineUrl()) {
    const token = ++state.token;
    window.speechSynthesis?.cancel();
    setPlayUI("loading");
    speakNeural(token);
    return;
  }

  if (!("speechSynthesis" in window)) { toast("Este navegador no tiene voces integradas", true); return; }

  const token = ++state.token;
  state.engine = "device";
  state.audio.pause();
  const sents = sentencesFor(state.para);
  const s = sents[state.sent];
  const text = sentenceText(state.para, state.sent);
  const voice = voiceByRef(voiceForPara(state.para));

  const u = new SpeechSynthesisUtterance(text);
  if (voice) { u.voice = voice; u.lang = voice.lang; }
  else u.lang = paraLang(state.para) === "es" ? "es-MX" : "en-US";
  u.rate = Math.min(MAX_SPEED, state.settings.speed);
  u.volume = state.testVolume ?? 1;

  let boundarySeen = false;
  u.onboundary = (e) => {
    if (token !== state.token) return;
    if (typeof e.charIndex !== "number") return;
    boundarySeen = true;
    clearInterval(estimator);
    markLitByChar(s.cs + e.charIndex);
  };
  u.onend = () => {
    if (token !== state.token || !state.playing) return;
    advance();
  };
  u.onerror = (e) => {
    if (token !== state.token) return;
    if (e.error === "interrupted" || e.error === "canceled") return;
    state.playing = false;
    setPlayUI("paused");
    toast(`Voz del dispositivo: ${e.error || "error"}`, true);
  };

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
  state.playing = true;
  setPlayUI("playing");
  setImmersive(true);
  requestWakeLock();

  // Algunos motores no emiten límites de palabra: se estima por tiempo.
  const start = performance.now();
  const charsPerSec = 14 * u.rate;
  clearInterval(estimator);
  estimator = setInterval(() => {
    if (token !== state.token || boundarySeen) { clearInterval(estimator); return; }
    if (!window.speechSynthesis.speaking) return;
    markLitByChar(s.cs + ((performance.now() - start) / 1000) * charsPerSec);
  }, 200);

  clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    if (state.playing && window.speechSynthesis.speaking) window.speechSynthesis.resume();
  }, 10000);
}

function advance() {
  const sents = sentencesFor(state.para);
  if (state.sent + 1 < sents.length) {
    setCurrent(state.para, state.sent + 1);
    speakCurrent();
  } else if (state.para + 1 < state.doc.segments.length) {
    setCurrent(state.para + 1, 0);
    speakCurrent();
  } else {
    finishDocument();
  }
}

function finishDocument() {
  stopSpeech();
  $("endCap").classList.remove("hidden");
}

function togglePlay() {
  if (state.playing) {
    stopSpeech();
  } else {
    $("endCap").classList.add("hidden");
    speakCurrent();
  }
}

/* Saltar a una oración concreta (clic del usuario) o a un párrafo (botones). */
function goTo(para, sent, { keepPlaying = true } = {}) {
  const wasPlaying = state.playing;
  state.token++;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  state.audio.pause();
  cancelAnimationFrame(state.raf);
  clearInterval(estimator);
  state.translation = null;
  setCurrent(para, sent);
  if (wasPlaying && keepPlaying) speakCurrent();
  else { state.playing = false; setPlayUI("paused"); }
}

const goToPara = (i) => goTo(Math.max(0, Math.min(state.doc.segments.length - 1, i)), 0);

function setPlayUI(mode) {
  $("iconPlay").classList.toggle("hidden", mode !== "paused");
  $("iconPause").classList.toggle("hidden", mode !== "playing");
  $("iconSpin").classList.toggle("hidden", mode !== "loading");
  $("btnPlay").setAttribute("aria-label", mode === "playing" ? "Pausa" : "Reproducir");
}

function setImmersive(on) {
  $("reader").classList.toggle("immersive", on);
  if (on) closePopovers();
}

/* ---------- traducción: solo la oración actual, bajo demanda ---------- */

function attachTranslation(el, i) {
  el.querySelector(".trans")?.remove();
  const t = state.translation;
  if (!t || t.para !== i) return;
  const target = el.querySelectorAll(".sn")[t.sent];
  if (!target) return;
  const span = document.createElement("span");
  span.className = "trans" + (t.text ? "" : " loading");
  span.textContent = t.text || "traduciendo…";
  target.after(span);
}

async function translateCurrentSentence() {
  if (!state.doc) return;
  if (state.translation && state.translation.para === state.para && state.translation.sent === state.sent) {
    state.translation = null;                       // segundo toque: ocultar
    renderParagraph(state.para);
    updateChips();
    return;
  }
  const para = state.para;
  const sent = state.sent;
  const text = sentenceText(para, sent);
  const target = paraLang(para) === "es" ? "en" : "es";
  state.translation = { para, sent, text: "" };
  renderParagraph(para);
  updateChips();
  try {
    const translated = await geminiTranslate(text, target);
    if (state.translation?.para === para && state.translation?.sent === sent) {
      state.translation.text = translated;
    }
  } catch (err) {
    if (state.translation?.para === para && state.translation?.sent === sent) {
      state.translation.text = `⚠ ${err.message}`;
    }
  }
  renderParagraph(para);
}

const LANG_NAMES = { es: "español latinoamericano natural", en: "natural American English" };

async function geminiTranslate(text, target) {
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
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }),
      });
    } catch {
      throw new Error("Sin conexión con Google (¿hay internet?)");
    }
    if (res.ok) {
      const translated = (await res.json())?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!translated) throw new Error("Gemini devolvió una respuesta inesperada");
      cacheTranslation(target, text, translated).catch(() => {});
      return translated;
    }
    let message = "";
    try { message = (await res.json())?.error?.message || ""; } catch {}
    lastError = message || `HTTP ${res.status}`;
    if (res.status === 429) throw new Error("Google limitó el uso por ahora. Espera un momento.");
    if (UNAVAILABLE_HINTS.some((h) => message.toLowerCase().includes(h))) {
      geminiBadModels.add(model);
      continue;
    }
    throw new Error(`Gemini API: ${lastError}`);
  }
  throw new Error(`Gemini API: ${lastError}`);
}

/* ---------- posición ---------- */

let posTimer = 0;
function schedulePositionSave() {
  clearTimeout(posTimer);
  posTimer = setTimeout(savePosition, 1500);
}
function savePosition() {
  if (!state.doc) return;
  storePosition(state.doc.id, state.para).catch(() => {});
}
window.addEventListener("pagehide", savePosition);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") savePosition();
});

async function requestWakeLock() {
  try { state.wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

/* ---------- capítulos ---------- */

function currentChapterPos() {
  const chapters = state.doc?.chapters || [];
  let current = -1;
  for (let k = 0; k < chapters.length; k++) {
    if (chapters[k].seg <= state.para) current = k; else break;
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
    btn.addEventListener("click", () => { closeSheet(); goToPara(ch.seg); });
    wrap.appendChild(btn);
  });
  $("chapterSheet").classList.remove("hidden");
  $("sheetBackdrop").classList.remove("hidden");
  wrap.querySelector(".chapter-item.active")?.scrollIntoView({ block: "center" });
}

/* ---------- chips y desplegables ---------- */

function voiceLabel(id) {
  const n = neuralById(id);
  if (n) return `${n.name} · ${n.gender === "F" ? "♀" : "♂"}`;
  const v = voiceByRef(id);
  return v ? shortVoiceName(v.name) : "Voz";
}

function updateChips() {
  $("chipVoice").textContent = voiceLabel(voiceForPara(state.para));
  $("chipSpeed").textContent = `${state.settings.speed.toFixed(2).replace(/0$/, "")}×`;
  const t = state.translation;
  $("chipTranslate").classList.toggle("active", Boolean(t && t.para === state.para && t.sent === state.sent));
}

function closePopovers() {
  $("popSpeed").classList.add("hidden");
  $("popSize").classList.add("hidden");
  $("chipSpeed").classList.remove("open");
  $("chipFont").classList.remove("open");
}

function togglePopover(which) {
  const pop = which === "speed" ? $("popSpeed") : $("popSize");
  const chip = which === "speed" ? $("chipSpeed") : $("chipFont");
  const wasOpen = !pop.classList.contains("hidden");
  closePopovers();
  if (wasOpen) return;
  if (which === "speed") {
    $("speedRange").value = state.settings.speed;
    $("speedOut").textContent = `${state.settings.speed.toFixed(2).replace(/0$/, "")}×`;
  } else {
    $("sizeRange").value = state.settings.fontSize;
    $("sizeOut").textContent = `${state.settings.fontSize} px`;
  }
  pop.classList.remove("hidden");
  chip.classList.add("open");
}

function selectVoice(lang, id) {
  saveSettings(lang === "es" ? { voice_es: id } : { voice_en: id });
  state.clips.clear();
  renderVoiceLists();
  updateChips();
  if (state.playing) { state.token++; speakCurrent(); }
}

function renderVoiceLists() {
  refreshDeviceVoices();
  const motor = Boolean(engineUrl());
  $("voiceHint").textContent = motor
    ? "Voces neuronales de Microsoft: iguales en todos tus dispositivos, sin límite, con resaltado exacto."
    : "Configura el motor de voz más abajo para usar las voces neuronales de Microsoft en cualquier dispositivo.";

  for (const [lang, containerId] of [["es", "neuralVoicesEs"], ["en", "neuralVoicesEn"]]) {
    const wrap = $(containerId);
    wrap.innerHTML = "";
    for (const v of NEURAL_VOICES.filter((x) => x.lang === lang)) {
      const activa = (lang === "es" ? state.settings.voice_es : state.settings.voice_en) === v.id;
      const btn = document.createElement("button");
      btn.className = "voice-item" + (activa ? " active" : "") + (motor ? "" : " disabled");
      btn.innerHTML = `<span class="vg">${v.gender === "F" ? "♀" : "♂"}</span><span><span class="vn"></span><span class="vr"></span></span>`;
      btn.querySelector(".vn").textContent = v.name;
      btn.querySelector(".vr").textContent = v.region;
      if (motor) btn.addEventListener("click", () => selectVoice(lang, v.id));
      wrap.appendChild(btn);
    }
  }

  for (const [lang, containerId] of [["es", "devVoicesEs"], ["en", "devVoicesEn"]]) {
    const wrap = $(containerId);
    wrap.innerHTML = "";
    const pool = deviceVoices.filter((v) => v.lang.toLowerCase().startsWith(lang));
    wrap.closest(".voice-group").classList.toggle("hidden", pool.length === 0);
    for (const v of pool) {
      const id = "device:" + v.voiceURI;
      const active = (lang === "es" ? state.settings.voice_es : state.settings.voice_en) === id;
      const neural = /natural|online|enhanced|premium/i.test(v.name);
      const btn = document.createElement("button");
      btn.className = "voice-item" + (active ? " active" : "");
      btn.innerHTML = `<span class="vg">${neural ? "★" : "♪"}</span><span><span class="vn"></span><span class="vr"></span></span>`;
      btn.querySelector(".vn").textContent = shortVoiceName(v.name);
      btn.querySelector(".vr").textContent = v.lang + (neural ? " · Neural" : "");
      btn.addEventListener("click", () => selectVoice(lang, id));
      wrap.appendChild(btn);
    }
  }
}

function openSheet() {
  renderVoiceLists();
  $("engineUrl").value = state.settings.engine_url || "";
  $("engineStatus").textContent = engineUrl() ? "✓ Motor configurado" : "";
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

/* ---------- eventos ---------- */

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
  $("btnPrev").addEventListener("click", () => goToPara(state.para - 1));
  $("btnNext").addEventListener("click", () => goToPara(state.para + 1));
  $("btnSettings").addEventListener("click", openSheet);
  $("docTitle").addEventListener("click", openChapters);
  $("chipVoice").addEventListener("click", openSheet);
  $("chipSpeed").addEventListener("click", () => togglePopover("speed"));
  $("chipFont").addEventListener("click", () => togglePopover("size"));
  $("chipTranslate").addEventListener("click", translateCurrentSentence);
  $("sheetBackdrop").addEventListener("click", closeSheet);

  // clic en una oración -> rebobina a ella
  $("segments").addEventListener("click", (e) => {
    const sn = e.target.closest(".sn");
    if (sn) {
      const p = Number(sn.closest(".seg").dataset.i);
      goTo(p, Number(sn.dataset.s));
      return;
    }
    if (!e.target.closest(".seg")) setImmersive(!$("reader").classList.contains("immersive"));
  });

  ["wheel", "touchmove"].forEach((ev) =>
    $("stage").addEventListener(ev, () => { state.userScrolledAt = Date.now(); }, { passive: true }));

  $("speedRange").addEventListener("input", (e) => {
    const speed = Number(e.target.value);
    $("speedOut").textContent = `${speed.toFixed(2).replace(/0$/, "")}×`;
    saveSettings({ speed });
    updateChips();
  });
  $("speedRange").addEventListener("change", () => { if (state.playing) { state.token++; speakCurrent(); } });
  $("sizeRange").addEventListener("input", (e) => {
    saveSettings({ fontSize: Number(e.target.value) });
    $("sizeOut").textContent = `${e.target.value} px`;
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
  $("saveEngine").addEventListener("click", async () => {
    const url = $("engineUrl").value.trim().replace(/\/+$/, "");
    saveSettings({ engine_url: url });
    state.clips.clear();
    if (!url) {
      autoPickVoices(); renderVoiceLists(); updateChips();
      $("engineStatus").textContent = "Sin motor: se usan las voces del dispositivo.";
      return;
    }
    $("engineStatus").textContent = "Comprobando… (puede tardar si estaba dormido)";
    try {
      const res = await fetch(url + "/", { method: "GET" });
      const ok = res.ok && (await res.json()).service === "lyrio-voice";
      $("engineStatus").textContent = ok
        ? "✓ Motor conectado — ya puedes elegir voces de Microsoft"
        : "⚠ Responde, pero no parece el motor de Lyrio";
      if (ok) { autoPickVoices(); renderVoiceLists(); updateChips(); }
    } catch {
      $("engineStatus").textContent = "⚠ No se pudo conectar con esa dirección";
    }
  });
  $("saveKey").addEventListener("click", () => {
    const key = $("geminiKey").value.trim();
    saveSettings({ gemini_api_key: key });
    $("keyStatus").textContent = key ? "✓ Clave guardada" : "Clave eliminada";
  });

  document.addEventListener("keydown", (e) => {
    if ($("reader").classList.contains("hidden")) return;
    if (e.target.tagName === "INPUT") return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    if (e.code === "ArrowRight") goToPara(state.para + 1);
    if (e.code === "ArrowLeft") goToPara(state.para - 1);
    if (e.code === "Escape") { closeSheet(); closePopovers(); }
  });
}

/* ---------- arranque ---------- */

function boot() {
  wireEvents();
  applyDisplaySettings();
  autoPickVoices();
  renderLibrary();
}

boot();

window.lyrio = {
  state, uploadFile, goTo, goToPara, togglePlay, stopSpeech, setImmersive, openChapters,
  saveSettings, exitReader, openSheet, closeSheet, togglePopover, renderVoiceLists,
  translateCurrentSentence, sentencesFor,
};
