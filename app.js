/* Lyrio Web — lector autosuficiente: biblioteca en el dispositivo, voces
   neuronales de Microsoft y resaltado palabra a palabra. */
"use strict";

import { extractFromPdf } from "./extract.js?v=17";
import { splitSentences } from "./sentences.js?v=17";
import {
  loadSettings, persistSettings,
  getLibrary, saveLibrary, getDoc, saveDoc, deleteDoc, savePosition as storePosition,
  getCachedTranslation, cacheTranslation, getHighlights, saveHighlights,
} from "./storage.js?v=17";

const $ = (id) => document.getElementById(id);

const GEMINI_MODELS = ["gemini-flash-latest", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-flash"];
const UNAVAILABLE_HINTS = ["not available", "not found", "deprecated", "does not exist", "no longer"];
const geminiBadModels = new Set();

const MAX_SPEED = 1.5;
const LONG_PRESS_MS = 480;

const TEMAS = [
  { id: "kindle", name: "Kindle", bg: "#000000", fg: "#FFFFFF" },
  { id: "noche", name: "Noche", bg: "#16181C", fg: "#F2F5F9" },
  { id: "carbon", name: "Carbón", bg: "#1A1714", fg: "#F7F1E8" },
  { id: "dark", name: "Lyrio", bg: "#12101A", fg: "#F5F2FF" },
  { id: "sepia", name: "Sepia", bg: "#F3E9D2", fg: "#3B3020" },
  { id: "dia", name: "Día", bg: "#FBFAF7", fg: "#1F1D17" },
  { id: "papel", name: "Papel", bg: "#FFFFFF", fg: "#10131A" },
];

/* Catálogo mínimo hasta que responda el motor con el completo. */
const VOCES_BASE = [
  { id: "es-MX-DaliaNeural", name: "Dalia", region: "México", gender: "F", lang: "es" },
  { id: "es-MX-JorgeNeural", name: "Jorge", region: "México", gender: "M", lang: "es" },
  { id: "es-DO-RamonaNeural", name: "Ramona", region: "Rep. Dominicana", gender: "F", lang: "es" },
  { id: "es-DO-EmilioNeural", name: "Emilio", region: "Rep. Dominicana", gender: "M", lang: "es" },
  { id: "en-US-AvaMultilingualNeural", name: "Ava", region: "EE.UU.", gender: "F", lang: "en" },
  { id: "en-US-AndrewMultilingualNeural", name: "Andrew", region: "EE.UU.", gender: "M", lang: "en" },
];

/* ---------- estado ---------- */

const state = {
  settings: loadSettings(),
  doc: null,
  para: 0,
  sent: 0,
  sentences: new Map(),
  highlights: {},
  playing: false,
  engine: "neural",       // "neural" (motor) | "device" (voz del sistema)
  audio: new Audio(),
  clips: new Map(),       // "parrafo|voz|velocidad" -> Promise<{url, words}>
  words: [],              // {c, el} del párrafo en curso
  timings: [],            // tiempos que devuelve el motor
  litIdx: -1,
  translation: null,
  voices: VOCES_BASE,
  filterLang: "es",
  filterRegion: "",
  userScrolledAt: 0,
  wakeLock: null,
  token: 0,
  raf: 0,
  pick: null,             // oración con el menú de subrayado abierto
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

/* ---------- ajustes ---------- */

const engineUrl = () => (state.settings.engine_url || "").trim().replace(/\/+$/, "");

function applyDisplaySettings() {
  const s = state.settings;
  document.documentElement.dataset.theme = s.theme;
  document.documentElement.dataset.font = s.font;
  document.documentElement.dataset.width = s.width || "medio";
  document.documentElement.dataset.align = s.align || "izquierda";
  document.documentElement.style.setProperty("--reading-size", s.fontSize + "px");
  // Del catálogo, no de getComputedStyle: durante la transición aún devuelve el color anterior.
  const meta = document.querySelector('meta[name="theme-color"]');
  const tema = TEMAS.find((t) => t.id === s.theme);
  if (meta && tema) meta.content = tema.bg;
}

function saveSettings(patch) {
  Object.assign(state.settings, patch);
  if (state.settings.speed > MAX_SPEED) state.settings.speed = MAX_SPEED;
  applyDisplaySettings();
  persistSettings(state.settings);
}

const paraLang = (i) => state.doc?.segments[i]?.lang || state.doc?.lang || "es";
const voiceForPara = (i) => (paraLang(i) === "en" ? state.settings.voice_en : state.settings.voice_es);
const voiceById = (id) => state.voices.find((v) => v.id === id);

/* ---------- voces del dispositivo (respaldo sin conexión) ---------- */

let deviceVoices = [];
function refreshDeviceVoices() {
  deviceVoices = (window.speechSynthesis?.getVoices() || [])
    .filter((v) => /^(es|en)[-_]/i.test(v.lang));
}
if ("speechSynthesis" in window) {
  refreshDeviceVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", refreshDeviceVoices);
}
const bestDeviceVoice = (lang) =>
  deviceVoices.filter((v) => v.lang.toLowerCase().startsWith(lang))[0] || null;

/* ---------- catálogo de voces del motor ---------- */

async function loadVoiceCatalog() {
  const base = engineUrl();
  if (!base) return;
  try {
    const res = await fetch(`${base}/voices`);
    const lista = await res.json();
    if (Array.isArray(lista) && lista.length) {
      state.voices = lista;
      localStorage.setItem("lyrio-voces", JSON.stringify(lista));
    }
  } catch {
    try {
      const guardadas = JSON.parse(localStorage.getItem("lyrio-voces") || "null");
      if (Array.isArray(guardadas) && guardadas.length) state.voices = guardadas;
    } catch { /* sin catálogo: queda el mínimo */ }
  }
}

/* ---------- oraciones ---------- */

function sentencesFor(i) {
  if (!state.sentences.has(i)) {
    state.sentences.set(i, splitSentences(state.doc.segments[i].text));
  }
  return state.sentences.get(i);
}
const sentenceText = (i, k) => {
  const s = sentencesFor(i)[k];
  return state.doc.segments[i].text.slice(s.cs, s.ce);
};

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
    const doc = await extractFromPdf(await file.arrayBuffer(), file.name);
    if (!doc.segments.length) {
      throw new Error("Este PDF no contiene texto seleccionable (probablemente es un escaneo). Aún no incluimos OCR.");
    }
    const library = await getLibrary();
    const previo = library.find((d) => d.id === doc.id);
    const position = previo ? previo.position || 0 : 0;
    await saveDoc(doc);
    const resto = library.filter((d) => d.id !== doc.id);
    resto.unshift({
      id: doc.id, title: doc.title, pages: doc.pages, lang: doc.lang,
      n_segments: doc.segments.length, added: Date.now(), position,
    });
    await saveLibrary(resto);
    await enterReader(doc, position);
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
  await enterReader(doc, entry?.position || 0);
}

/* ---------- lector ---------- */

async function enterReader(doc, position) {
  state.doc = doc;
  state.para = Math.min(position, doc.segments.length - 1);
  state.sent = 0;
  state.sentences.clear();
  state.clips.clear();
  state.translation = null;
  state.words = [];
  state.highlights = await getHighlights(doc.id).catch(() => ({}));

  $("home").classList.add("hidden");
  $("reader").classList.remove("hidden");
  setImmersive(false);
  closePopovers();
  $("docTitleText").textContent = doc.title;
  const tieneCapitulos = (doc.chapters || []).length > 0;
  $("docTitleChev").classList.toggle("hidden", !tieneCapitulos);
  $("docTitle").classList.toggle("has-chapters", tieneCapitulos);
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
  updateMediaSession();
  requestWakeLock();
}

function exitReader() {
  stopPlayback();
  savePosition();
  state.doc = null;
  $("reader").classList.add("hidden");
  $("home").classList.remove("hidden");
  releaseWakeLock();
  renderLibrary();
}

const segEl = (i) => $("segments").querySelector(`.seg[data-i="${i}"]`);

function renderParagraph(i) {
  const el = segEl(i);
  if (!el) return;
  const text = state.doc.segments[i].text;
  const sents = sentencesFor(i);
  const esActual = i === state.para;
  const frag = document.createDocumentFragment();

  sents.forEach((s, k) => {
    const span = document.createElement("span");
    span.className = "sn";
    span.dataset.s = k;
    const color = state.highlights[`${i}:${k}`];
    if (color) span.dataset.hl = color;
    const sentText = text.slice(s.cs, s.ce);

    if (esActual && k === state.sent) span.classList.add("active");
    if (esActual && k < state.sent) span.classList.add("done");

    if (esActual) {
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
    }
    frag.appendChild(span);

    const finHueco = k + 1 < sents.length ? sents[k + 1].cs : text.length;
    if (finHueco > s.ce) frag.appendChild(document.createTextNode(text.slice(s.ce, finHueco)));
  });

  el.innerHTML = "";
  el.appendChild(frag);
  if (esActual) {
    state.words = [...el.querySelectorAll(".w")].map((w) => ({ c: Number(w.dataset.c), el: w }));
    state.litIdx = -1;
  }
  attachTranslation(el, i);
}

function setCurrent(para, sent, { instant = false, scroll = true, redraw = true } = {}) {
  const antes = state.para;
  state.para = para;
  state.sent = sent;
  if (redraw) {
    if (antes !== para) renderParagraph(antes);
    renderParagraph(para);
  }

  const segs = $("segments").children;
  for (let k = 0; k < segs.length; k++) {
    segs[k].classList.toggle("current", k === para);
    segs[k].classList.toggle("near", Math.abs(k - para) === 1);
  }
  // El desplazamiento se decide aquí, al cambiar de oración: nunca en mitad
  // de una, para no mover el texto mientras la voz la está leyendo.
  if (scroll) mantenerALaVista({ instant, parrafoNuevo: antes !== para });

  const total = state.doc.segments.length;
  $("progressFill").style.width = total > 1 ? `${(para / (total - 1)) * 100}%` : "100%";
  updateChips();
  schedulePositionSave();
}

/* Coloca la oración en curso a un cuarto de pantalla desde arriba, dejando
   tres cuartos por delante para que los párrafos largos no se salgan. */
const ANCLA = 0.25;
const UMBRAL = 0.66;

function mantenerALaVista({ instant = false, parrafoNuevo = false } = {}) {
  const modo = state.settings.scrollMode || "auto";
  if (modo === "manual") return;
  if (modo === "parrafo" && !parrafoNuevo) return;
  if (!instant && Date.now() - state.userScrolledAt < 4000) return;

  const stage = $("stage");
  const el = segEl(state.para)?.querySelector(".sn.active") || segEl(state.para);
  if (!el) return;

  const zona = stage.getBoundingClientRect();
  const linea = el.getBoundingClientRect();
  const posicion = (linea.top - zona.top) / zona.height;
  if (modo === "auto" && posicion >= 0 && posicion < UMBRAL) return;   // aún bien visible

  const destino = stage.scrollTop + (linea.top - zona.top) - zona.height * ANCLA;
  stage.scrollTo({ top: Math.max(0, destino), behavior: instant ? "auto" : "smooth" });
}

/* Marca la oración en curso sin volver a dibujar el párrafo entero. */
function markSentence(k, { force = false } = {}) {
  if (!force && k === state.sent) return;
  state.sent = k;
  const el = segEl(state.para);
  if (!el) return;
  el.querySelectorAll(".sn").forEach((sn, idx) => {
    sn.classList.toggle("active", idx === k);
    sn.classList.toggle("done", idx < k);
  });
  if (state.translation && state.translation.para === state.para) {
    state.translation = null;
    el.querySelector(".trans")?.remove();
    updateChips();
  }
  // Momento exacto en que termina una oración y empieza la siguiente:
  // es el único punto donde se permite mover el texto.
  mantenerALaVista();
}

/* ---------- motor neuronal: un audio por párrafo ---------- */

const clipKey = (i) => `${i}|${voiceForPara(i)}|${state.settings.speed}`;

function fetchPara(i) {
  const key = clipKey(i);
  if (state.clips.has(key)) return state.clips.get(key);
  const base = engineUrl();
  if (!base) return Promise.reject(new Error("Configura el motor de voz en Ajustes."));

  const { texto: paraVoz, mapa } = prepararTextoVoz(state.doc.segments[i].text);
  const promise = fetch(`${base}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: paraVoz,
      voice: voiceForPara(i),
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
    // El MP3 es de tasa constante: la duración sale exacta del tamaño.
    calibrarRitmo(state.doc.segments[i].text.length, (bytes.length * 8) / 48000);
    return {
      url: URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" })),
      words: reubicarPalabras(data.words, mapa),
    };
  }).catch((err) => {
    if (err instanceof TypeError) throw new Error("No se pudo contactar el motor de voz (¿hay internet?)");
    throw err;
  });

  promise.catch(() => state.clips.delete(key));
  state.clips.set(key, promise);
  while (state.clips.size > 8) {
    const viejo = state.clips.keys().next().value;
    const p = state.clips.get(viejo);
    state.clips.delete(viejo);
    p.then((r) => URL.revokeObjectURL(r.url)).catch(() => {});
  }
  return promise;
}

/* ---------- números ----------
   Con punto como separador de miles ("1.500") el motor deletrea cifra por
   cifra. Se le envía el número sin separadores ("1500"), que lee bien en
   cualquier caso, conservando el decimal si lo hay. La pantalla no cambia:
   los tiempos de palabra se traducen de vuelta al texto original. */

function separadoresDeMiles(token) {
  const seps = [];
  for (let i = 0; i < token.length; i++) if (token[i] === "." || token[i] === ",") seps.push(i);
  if (!seps.length) return [];
  const partes = token.split(/[.,]/);
  if (partes[0].length > 3) return [];                       // 12345.678 no es miles
  const cola = partes.slice(1);
  if (cola.every((p) => p.length === 3)) return seps;        // 1.234.567
  const ultimo = cola[cola.length - 1];
  if (ultimo.length <= 2 && cola.slice(0, -1).every((p) => p.length === 3)) {
    return seps.slice(0, -1);                                // 1.234,56 -> el último es decimal
  }
  return [];                                                 // fechas, versiones, 1.5
}

function prepararTextoVoz(texto) {
  const quitar = new Set();
  const re = /\d[\d.,]*\d/g;
  let m;
  while ((m = re.exec(texto)) !== null) {
    for (const p of separadoresDeMiles(m[0])) quitar.add(m.index + p);
  }
  if (!quitar.size) return { texto, mapa: null };
  let salida = "";
  const mapa = [];
  for (let i = 0; i < texto.length; i++) {
    if (quitar.has(i)) continue;
    mapa.push(i);
    salida += texto[i];
  }
  return { texto: salida, mapa };
}

/* Devuelve los tiempos con las posiciones referidas al texto que se ve. */
function reubicarPalabras(palabras, mapa) {
  if (!mapa) return palabras;
  return palabras.map((p) => ({
    ...p,
    cs: mapa[p.cs] ?? p.cs,
    ce: (mapa[p.ce - 1] ?? p.ce - 1) + 1,
  }));
}

/* ---------- exportar a MP3 ----------
   Los MP3 del motor son de tasa constante y del mismo codificador, así que
   basta encadenarlos para obtener un solo archivo continuo. */

let exportando = false;
let cancelarExport = false;

function abrirExportador() {
  if (!state.doc) return;
  if (!engineUrl()) { toast("Configura el motor de voz en Ajustes para exportar.", true); return; }
  const total = state.doc.segments.reduce((a, s) => a + s.text.length, 0);
  const cps = (state.cps || CPS_INICIAL) * Math.min(MAX_SPEED, state.settings.speed);
  const voz = voiceById(voiceForPara(0));
  $("exportTitle").textContent = "Exportar en MP3";
  $("exportInfo").textContent =
    `${state.doc.title} · unos ${formatoTiempo(total / cps)} de audio con la voz de ` +
    `${voz ? nombreVoz(voz) : "el documento"}. La preparación tarda un rato y necesita conexión; ` +
    "puedes cancelarla cuando quieras.";
  $("exportFill").style.width = "0";
  $("exportStart").classList.remove("hidden");
  $("exportCancel").textContent = "Cancelar";
  $("exportPanel").classList.remove("hidden");
  $("sheetBackdrop").classList.remove("hidden");
}

function cerrarExportador() {
  cancelarExport = true;
  $("exportPanel").classList.add("hidden");
  if ($("sheet").classList.contains("hidden") && $("chapterSheet").classList.contains("hidden")) {
    $("sheetBackdrop").classList.add("hidden");
  }
}

async function pedirAudioParrafo(i) {
  const { texto } = prepararTextoVoz(state.doc.segments[i].text);
  const res = await fetch(`${engineUrl()}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: texto,
      voice: voiceForPara(i),
      speed: Math.min(MAX_SPEED, state.settings.speed),
    }),
  });
  if (!res.ok) throw new Error(`el motor respondió ${res.status}`);
  const data = await res.json();
  return Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
}

async function exportarMP3() {
  if (exportando) return;
  exportando = true;
  cancelarExport = false;
  const segs = state.doc.segments;
  const partes = new Array(segs.length);
  let siguiente = 0, hechos = 0;

  $("exportStart").classList.add("hidden");
  const pintar = () => {
    $("exportFill").style.width = `${(hechos / segs.length) * 100}%`;
    $("exportTitle").textContent = `Preparando… ${hechos} de ${segs.length}`;
  };
  pintar();

  // Tres peticiones a la vez; el índice mantiene el orden del libro.
  const trabajador = async () => {
    while (!cancelarExport) {
      const i = siguiente++;
      if (i >= segs.length) return;
      partes[i] = await pedirAudioParrafo(i);
      hechos++;
      pintar();
    }
  };

  try {
    await Promise.all([trabajador(), trabajador(), trabajador()]);
    if (cancelarExport) { toast("Exportación cancelada."); return; }
    const blob = new Blob(partes.filter(Boolean), { type: "audio/mpeg" });
    const nombre = `${state.doc.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Lyrio"}.mp3`;
    await entregarArchivo(blob, nombre);
  } catch (err) {
    toast(`No se pudo exportar: ${err.message}`, true);
  } finally {
    exportando = false;
    cerrarExportador();
  }
}

/* En el móvil se ofrece compartir (Archivos, Libros…); en el escritorio, descargar. */
async function entregarArchivo(blob, nombre) {
  const file = new File([blob], nombre, { type: "audio/mpeg" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: nombre });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return;      // el usuario cerró el menú
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast("MP3 descargado.");
}

/* ---------- tiempo restante ----------
   El ritmo se aprende de los párrafos ya generados (caracteres por segundo a
   velocidad 1) y con él se estima lo que falta del documento. */

const CPS_INICIAL = 15;

function calibrarRitmo(caracteres, segundos) {
  if (!segundos || caracteres < 40) return;
  const cps = caracteres / segundos / Math.min(MAX_SPEED, state.settings.speed);
  state.cps = state.cps ? state.cps * 0.7 + cps * 0.3 : cps;   // media suavizada
}

function caracteresRestantes() {
  if (!state.doc) return 0;
  const segs = state.doc.segments;
  let total = 0;
  for (let i = state.para + 1; i < segs.length; i++) total += segs[i].text.length;

  // Del párrafo en curso, solo lo que queda por leer.
  const actual = segs[state.para].text;
  if (state.engine === "neural" && state.audio.duration > 0) {
    const avance = state.audio.currentTime / state.audio.duration;
    total += actual.length * (1 - Math.min(1, avance));
  } else {
    const s = sentencesFor(state.para)[state.sent];
    total += actual.length - (s ? s.cs : 0);
  }
  return total;
}

function formatoTiempo(segundos) {
  const t = Math.max(0, Math.round(segundos));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const dosCifras = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${dosCifras(m)}:${dosCifras(s)}` : `${m}:${dosCifras(s)}`;
}

function updateTimeLeft() {
  const el = $("timeLeft");
  if (!el) return;
  if (!state.doc) { el.textContent = ""; return; }
  const cps = (state.cps || CPS_INICIAL) * Math.min(MAX_SPEED, state.settings.speed);
  el.textContent = formatoTiempo(caracteresRestantes() / cps);
  el.title = "Tiempo restante del documento";
}

let relojRestante = 0;
function startClock() {
  clearInterval(relojRestante);
  relojRestante = setInterval(updateTimeLeft, 1000);
}
function stopClock() {
  clearInterval(relojRestante);
  updateTimeLeft();
}

/* Con el siguiente párrafo ya descargado, la lectura no se corta ni con la
   pantalla bloqueada, donde el navegador apenas deja trabajar en segundo plano. */
function prefetchNext(i) {
  if (i + 1 < state.doc.segments.length) fetchPara(i + 1).catch(() => {});
}

function syncKaraoke() {
  const t = state.audio.currentTime * 1000;
  const palabras = state.timings;
  if (!palabras.length) return;
  let lit = -1;
  for (let i = 0; i < palabras.length; i++) {
    if (t >= palabras[i].s) lit = i; else break;
  }
  if (lit === state.litIdx) return;
  state.litIdx = lit;
  for (let i = 0; i < state.words.length; i++) {
    const el = state.words[i].el;
    el.classList.toggle("sung", i < lit);
    el.classList.toggle("lit", i === lit);
    if (i === lit) el.classList.add("sung");
  }
  if (lit >= 0) {
    const car = palabras[lit].cs;
    const sents = sentencesFor(state.para);
    let k = 0;
    for (let i = 0; i < sents.length; i++) if (sents[i].cs <= car) k = i; else break;
    markSentence(k);
  }
}

function startSync() {
  cancelAnimationFrame(state.raf);
  const tick = () => {
    syncKaraoke();
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}
// rAF se detiene con la pantalla apagada; timeupdate mantiene el resaltado al volver.
state.audio.addEventListener("timeupdate", () => { if (state.playing) syncKaraoke(); });

/* Tiempo en el que empieza una oración, según los tiempos del motor. */
function timeOfSentence(k) {
  const s = sentencesFor(state.para)[k];
  const w = state.timings.find((x) => x.cs >= s.cs);
  return w ? Math.max(0, w.s / 1000 - 0.06) : 0;
}

async function playNeural(seekSent = null) {
  const token = ++state.token;
  const i = state.para;
  setPlayUI("loading");
  try {
    const { url, words } = await fetchPara(i);
    if (token !== state.token) return;
    state.timings = words;
    state.litIdx = -1;
    if (state.audio.src !== url) state.audio.src = url;
    state.audio.playbackRate = 1;
    if (seekSent !== null) {
      await new Promise((r) => {
        if (state.audio.readyState >= 1) return r();
        state.audio.addEventListener("loadedmetadata", r, { once: true });
        setTimeout(r, 1500);
      });
      if (token !== state.token) return;
      state.audio.currentTime = timeOfSentence(seekSent);
    }
    await state.audio.play();
    if (token !== state.token) { state.audio.pause(); return; }
    state.playing = true;
    state.engine = "neural";
    setPlayUI("playing");
    setImmersive(true);
    requestWakeLock();
    updateMediaSession();
    startSync();
    prefetchNext(i);
  } catch (err) {
    if (token !== state.token) return;
    const v = bestDeviceVoice(paraLang(i));
    if (v) {
      state.engine = "device";
      toast("Motor de voz no disponible: seguimos con la voz del dispositivo.");
      speakDevice();
      return;
    }
    state.playing = false;
    setPlayUI("paused");
    toast(err.message || "No se pudo reproducir", true);
  }
}

state.audio.addEventListener("ended", () => {
  if (!state.playing || state.engine !== "neural") return;
  if (state.para + 1 < state.doc.segments.length) {
    setCurrent(state.para + 1, 0);
    playNeural();
  } else {
    finishDocument();
  }
});

/* ---------- respaldo: voz del dispositivo ---------- */

let keepAlive = 0;
function speakDevice() {
  if (!("speechSynthesis" in window)) { toast("Este navegador no tiene voces integradas", true); return; }
  const token = ++state.token;
  const s = sentencesFor(state.para)[state.sent];
  const texto = sentenceText(state.para, state.sent);
  const voz = bestDeviceVoice(paraLang(state.para));

  const { texto: paraVoz, mapa } = prepararTextoVoz(texto);
  const u = new SpeechSynthesisUtterance(paraVoz);
  if (voz) { u.voice = voz; u.lang = voz.lang; }
  u.rate = Math.min(MAX_SPEED, state.settings.speed);
  u.onboundary = (e) => {
    if (token !== state.token || typeof e.charIndex !== "number") return;
    const abs = s.cs + (mapa ? (mapa[e.charIndex] ?? e.charIndex) : e.charIndex);
    let lit = -1;
    for (let i = 0; i < state.words.length; i++) {
      if (state.words[i].c <= abs) lit = i; else break;
    }
    if (lit === state.litIdx) return;
    state.litIdx = lit;
    state.words.forEach((w, i) => {
      w.el.classList.toggle("sung", i <= lit);
      w.el.classList.toggle("lit", i === lit);
    });
  };
  u.onend = () => {
    if (token !== state.token || !state.playing) return;
    const sents = sentencesFor(state.para);
    if (state.sent + 1 < sents.length) { setCurrent(state.para, state.sent + 1); speakDevice(); }
    else if (state.para + 1 < state.doc.segments.length) { setCurrent(state.para + 1, 0); speakDevice(); }
    else finishDocument();
  };
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
  state.playing = true;
  state.engine = "device";
  setPlayUI("playing");
  setImmersive(true);
  requestWakeLock();
  clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    if (state.playing && window.speechSynthesis.speaking) window.speechSynthesis.resume();
  }, 10000);
}

/* ---------- control de reproducción ---------- */

function usaNeural() {
  return Boolean(engineUrl()) && voiceById(voiceForPara(state.para)) !== undefined;
}

function play(seekSent = null) {
  $("endCap").classList.add("hidden");
  startClock();
  if (usaNeural()) playNeural(seekSent);
  else speakDevice();
}

function stopPlayback() {
  state.token++;
  state.playing = false;
  stopClock();
  cancelAnimationFrame(state.raf);
  clearInterval(keepAlive);
  state.audio.pause();
  window.speechSynthesis?.cancel();
  setPlayUI("paused");
  setImmersive(false);
  savePosition();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
}

function finishDocument() {
  stopPlayback();
  $("endCap").classList.remove("hidden");
}

function togglePlay() {
  if (state.playing) stopPlayback();
  else play();
}

/* Salto a una oración: con el motor es instantáneo, sin volver a pedir audio. */
function goToSentence(para, sent) {
  const sonando = state.playing;
  const mismoParrafo = para === state.para;
  state.token++;
  window.speechSynthesis?.cancel();
  cancelAnimationFrame(state.raf);
  state.translation = null;

  if (usaNeural() && mismoParrafo && state.timings.length) {
    // markSentence se encarga del desplazamiento, ya con las clases puestas.
    setCurrent(para, sent, { redraw: false, scroll: false });
    markSentence(sent, { force: true });
    state.audio.currentTime = timeOfSentence(sent);
    state.litIdx = -1;
    if (sonando) { state.token++; state.playing = true; state.audio.play().catch(() => {}); startSync(); }
    return;
  }
  state.audio.pause();
  setCurrent(para, sent);
  if (sonando) play(sent);
  else { state.playing = false; setPlayUI("paused"); }
}

function goToPara(i) {
  const destino = Math.max(0, Math.min(state.doc.segments.length - 1, i));
  const sonando = state.playing;
  state.token++;
  state.audio.pause();
  window.speechSynthesis?.cancel();
  cancelAnimationFrame(state.raf);
  state.translation = null;
  setCurrent(destino, 0);
  if (sonando) play();
  else { state.playing = false; setPlayUI("paused"); }
}

function setPlayUI(mode) {
  $("iconPlay").classList.toggle("hidden", mode !== "paused");
  $("iconPause").classList.toggle("hidden", mode !== "playing");
  $("iconSpin").classList.toggle("hidden", mode !== "loading");
  $("playLabel").textContent = mode === "playing" ? "Pausa" : "Leer";
  $("btnPlay").setAttribute("aria-label", mode === "playing" ? "Pausa" : "Reproducir");
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = mode === "playing" ? "playing" : "paused";
  }
}

function setImmersive(on) {
  $("reader").classList.toggle("immersive", on);
  if (on) { closePopovers(); hideHlMenu(); }
}

/* ---------- pantalla de bloqueo y pantalla encendida ---------- */

function updateMediaSession() {
  if (!("mediaSession" in navigator) || !state.doc) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.doc.title,
    artist: voiceById(voiceForPara(state.para))?.name || "Lyrio",
    album: `Párrafo ${state.para + 1} de ${state.doc.segments.length}`,
    artwork: [{ src: "icon-512.png", sizes: "512x512", type: "image/png" }],
  });
  const set = (accion, fn) => { try { navigator.mediaSession.setActionHandler(accion, fn); } catch {} };
  set("play", () => { if (!state.playing) play(); });
  set("pause", () => stopPlayback());
  set("previoustrack", () => goToPara(state.para - 1));
  set("nexttrack", () => goToPara(state.para + 1));
  set("seekbackward", () => goToPara(state.para - 1));
  set("seekforward", () => goToPara(state.para + 1));
}

async function requestWakeLock() {
  if (state.wakeLock || document.visibilityState !== "visible") return;
  try {
    state.wakeLock = await navigator.wakeLock?.request("screen");
    state.wakeLock?.addEventListener?.("release", () => { state.wakeLock = null; });
  } catch { /* el navegador no lo permite */ }
}
function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (state.doc) requestWakeLock();
  } else {
    savePosition();
  }
});

/* ---------- subrayados ---------- */

function hlKey(p, s) { return `${p}:${s}`; }

function showHlMenu(sn, p, s) {
  state.pick = { sn, p, s };
  document.querySelectorAll(".sn.picked").forEach((el) => el.classList.remove("picked"));
  sn.classList.add("picked");
  const menu = $("hlMenu");
  menu.classList.remove("hidden");
  const r = sn.getBoundingClientRect();
  const mw = menu.offsetWidth || 300;
  const mh = menu.offsetHeight || 46;
  let x = r.left + r.width / 2 - mw / 2;
  x = Math.max(10, Math.min(x, window.innerWidth - mw - 10));
  let y = r.top - mh - 10;
  if (y < 10) y = Math.min(r.bottom + 10, window.innerHeight - mh - 10);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function hideHlMenu() {
  $("hlMenu").classList.add("hidden");
  document.querySelectorAll(".sn.picked").forEach((el) => el.classList.remove("picked"));
  state.pick = null;
}

async function setHighlight(color) {
  if (!state.pick) return;
  const { p, s, sn } = state.pick;
  const k = hlKey(p, s);
  if (color) { state.highlights[k] = color; sn.dataset.hl = color; }
  else { delete state.highlights[k]; delete sn.dataset.hl; }
  await saveHighlights(state.doc.id, state.highlights).catch(() => {});
  hideHlMenu();
}

async function copyPicked() {
  if (!state.pick) return;
  const texto = sentenceText(state.pick.p, state.pick.s);
  try {
    await navigator.clipboard.writeText(texto);
    toast("Oración copiada");
  } catch {
    toast("No se pudo copiar en este navegador", true);
  }
  hideHlMenu();
}

/* ---------- traducción ---------- */

function attachTranslation(el, i) {
  el.querySelector(".trans")?.remove();
  const t = state.translation;
  if (!t || t.para !== i) return;
  const destino = el.querySelectorAll(".sn")[t.sent];
  if (!destino) return;
  const span = document.createElement("span");
  span.className = "trans" + (t.text ? "" : " loading");
  span.textContent = t.text || "traduciendo…";
  destino.after(span);
}

async function translateCurrentSentence() {
  if (!state.doc) return;
  const t = state.translation;
  if (t && t.para === state.para && t.sent === state.sent) {
    state.translation = null;
    renderParagraph(state.para);
    updateChips();
    return;
  }
  const para = state.para, sent = state.sent;
  const texto = sentenceText(para, sent);
  const destino = paraLang(para) === "es" ? "en" : "es";
  state.translation = { para, sent, text: "" };
  renderParagraph(para);
  updateChips();
  try {
    const traducido = await geminiTranslate(texto, destino);
    if (state.translation?.para === para && state.translation?.sent === sent) {
      state.translation.text = traducido;
    }
  } catch (err) {
    if (state.translation?.para === para && state.translation?.sent === sent) {
      state.translation.text = `⚠ ${err.message}`;
    }
  }
  if (state.para === para) renderParagraph(para);
}

const LANG_NAMES = { es: "español latinoamericano natural", en: "natural American English" };

async function geminiTranslate(text, target) {
  const apiKey = (state.settings.gemini_api_key || "").trim();
  if (!apiKey) throw new Error("Configura tu API key de Google AI Studio en Ajustes (es gratis).");
  const cache = await getCachedTranslation(target, text).catch(() => null);
  if (cache) return cache;

  const prompt = `Traduce el siguiente texto a ${LANG_NAMES[target] || target}. ` +
    "Mantén el tono y el significado, con fluidez nativa. " +
    "Responde ÚNICAMENTE con la traducción, sin comentarios.\n\n" + text;
  const override = (state.settings.gemini_model || "").trim();
  const modelos = override ? [override] : GEMINI_MODELS.filter((m) => !geminiBadModels.has(m));
  let ultimo = "sin modelos disponibles";

  for (const model of modelos.length ? modelos : GEMINI_MODELS) {
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }),
      });
    } catch { throw new Error("Sin conexión con Google (¿hay internet?)"); }
    if (res.ok) {
      const out = (await res.json())?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!out) throw new Error("Gemini devolvió una respuesta inesperada");
      cacheTranslation(target, text, out).catch(() => {});
      return out;
    }
    let mensaje = "";
    try { mensaje = (await res.json())?.error?.message || ""; } catch {}
    ultimo = mensaje || `HTTP ${res.status}`;
    if (res.status === 429) throw new Error("Google limitó el uso por ahora. Espera un momento.");
    if (UNAVAILABLE_HINTS.some((h) => mensaje.toLowerCase().includes(h))) { geminiBadModels.add(model); continue; }
    throw new Error(`Gemini API: ${ultimo}`);
  }
  throw new Error(`Gemini API: ${ultimo}`);
}

/* ---------- posición ---------- */

let posTimer = 0;
const schedulePositionSave = () => {
  clearTimeout(posTimer);
  posTimer = setTimeout(savePosition, 1500);
};
function savePosition() {
  if (state.doc) storePosition(state.doc.id, state.para).catch(() => {});
}
window.addEventListener("pagehide", savePosition);

/* ---------- capítulos ---------- */

function openChapters() {
  const capitulos = state.doc?.chapters || [];
  if (!capitulos.length) return;
  const wrap = $("chapterList");
  wrap.innerHTML = "";
  let actual = -1;
  capitulos.forEach((c, k) => { if (c.seg <= state.para) actual = k; });
  capitulos.forEach((ch, k) => {
    const btn = document.createElement("button");
    btn.className = "chapter-item" + (k === actual ? " active" : "");
    btn.innerHTML = `<span class="ch-n">${k + 1}</span><span class="ch-t"></span>`;
    btn.querySelector(".ch-t").textContent = ch.title;
    btn.addEventListener("click", () => { closeSheet(); goToPara(ch.seg); });
    wrap.appendChild(btn);
  });
  $("chapterSheet").classList.remove("hidden");
  $("sheetBackdrop").classList.remove("hidden");
  wrap.querySelector(".chapter-item.active")?.scrollIntoView({ block: "center" });
}

/* ---------- barra y desplegables ---------- */

function updateChips() {
  const v = voiceById(voiceForPara(state.para));
  $("voiceName").textContent = v ? nombreVoz(v) : "Voz";
  $("chipSpeed").textContent = `${state.settings.speed.toFixed(2).replace(/0$/, "")}×`;
  const t = state.translation;
  $("chipTranslate").classList.toggle("active", Boolean(t && t.para === state.para && t.sent === state.sent));
  updateTimeLeft();
}

function closePopovers() {
  ["popVoices", "popSpeed", "popSize"].forEach((id) => $(id).classList.add("hidden"));
  ["chipVoice", "chipSpeed", "chipFont"].forEach((id) => $(id).classList.remove("open"));
}

function togglePopover(cual) {
  const mapa = { voces: ["popVoices", "chipVoice"], vel: ["popSpeed", "chipSpeed"], tam: ["popSize", "chipFont"] };
  const [popId, chipId] = mapa[cual];
  const abierto = !$(popId).classList.contains("hidden");
  closePopovers();
  if (abierto) return;
  if (cual === "vel") {
    $("speedRange").value = state.settings.speed;
    $("speedOut").textContent = `${state.settings.speed.toFixed(2).replace(/0$/, "")}×`;
  } else if (cual === "tam") {
    $("sizeRange").value = state.settings.fontSize;
    $("sizeOut").textContent = `${state.settings.fontSize} px`;
  } else {
    state.filterLang = paraLang(state.para);
    state.filterRegion = "";
    renderVoicePicker();
  }
  $(popId).classList.remove("hidden");
  $(chipId).classList.add("open");
}

/* El mismo selector sirve en la barra del lector y en Ajustes; en Ajustes
   además suena una frase de muestra al tocar cada voz. */
function renderVoicePicker(destino = "voice", { conPrueba = false } = {}) {
  const id = (sufijo) => (destino === "voice" ? `voice${sufijo}` : `setVoice${sufijo}`);
  const repintar = () => renderVoicePicker(destino, { conPrueba });

  const idiomas = $(id("Langs"));
  idiomas.innerHTML = "";
  for (const [lang, etiqueta] of [["es", "Español"], ["en", "English"]]) {
    const b = document.createElement("button");
    b.className = "pill" + (state.filterLang === lang ? " on" : "");
    b.textContent = etiqueta;
    b.addEventListener("click", () => { state.filterLang = lang; state.filterRegion = ""; repintar(); });
    idiomas.appendChild(b);
  }

  const delIdioma = state.voices.filter((v) => v.lang === state.filterLang);
  const regiones = [...new Set(delIdioma.map((v) => v.region))].sort();
  const barra = $(id("Regions"));
  barra.innerHTML = "";
  const todos = document.createElement("button");
  todos.className = "pill" + (state.filterRegion ? "" : " on");
  todos.textContent = "Todos";
  todos.addEventListener("click", () => { state.filterRegion = ""; repintar(); });
  barra.appendChild(todos);
  for (const r of regiones) {
    const b = document.createElement("button");
    b.className = "pill" + (state.filterRegion === r ? " on" : "");
    b.textContent = r;
    b.addEventListener("click", () => { state.filterRegion = r; repintar(); });
    barra.appendChild(b);
  }

  const lista = delIdioma.filter((v) => !state.filterRegion || v.region === state.filterRegion);
  const wrap = $(id("List"));
  wrap.innerHTML = "";
  const activa = state.filterLang === "es" ? state.settings.voice_es : state.settings.voice_en;
  for (const v of lista) {
    const btn = document.createElement("button");
    btn.className = "voice-item" + (v.id === activa ? " active" : "");
    btn.innerHTML = `<span class="vg">${v.gender === "F" ? "♀" : "♂"}</span><span><span class="vn"></span><span class="vr"></span></span>`;
    btn.querySelector(".vn").textContent = nombreVoz(v);
    btn.querySelector(".vr").textContent = v.region;
    btn.addEventListener("click", () => {
      selectVoice(v, { repintar: conPrueba ? repintar : null });
      if (conPrueba) previewVoice(v, btn);
    });
    wrap.appendChild(btn);
  }
  const es = state.voices.filter((v) => v.lang === "es").length;
  const en = state.voices.filter((v) => v.lang === "en").length;
  $(id("Count")).textContent = `${es} voces en español · ${en} en inglés`;
}

/* ---------- prueba de voz ---------- */

const previewAudio = new Audio();
previewAudio.setAttribute("playsinline", "");

/* Microsoft nombra sus voces sin tildes; aquí se muestran bien escritas. */
const NOMBRES_CON_TILDE = {
  Salome: "Salomé", Tomas: "Tomás", Alvaro: "Álvaro", Sofia: "Sofía",
  Maria: "María", Andres: "Andrés", Sebastian: "Sebastián", Victor: "Víctor",
};
const nombreVoz = (v) => NOMBRES_CON_TILDE[v.name] || v.name;

/* Las abreviaturas del catálogo se leerían mal en voz alta ("Rep punto"),
   así que la frase de muestra usa el nombre completo. */
const REGION_HABLADA = {
  "Rep. Dominicana": "la República Dominicana",
  "EE.UU.": "Estados Unidos",
  "Reino Unido": "el Reino Unido",
  "El Salvador": "El Salvador",
  "Guinea Ecuatorial": "Guinea Ecuatorial",
  "Costa Rica": "Costa Rica",
  "Puerto Rico": "Puerto Rico",
  "Nueva Zelanda": "Nueva Zelanda",
};

const GENTILICIO_EN = {
  "EE.UU.": "American", "Reino Unido": "British", "Australia": "Australian",
  "Canadá": "Canadian", "Irlanda": "Irish", "India": "Indian", "Nigeria": "Nigerian",
  "Sudáfrica": "South African", "Nueva Zelanda": "New Zealand", "Filipinas": "Philippine",
  "Singapur": "Singaporean", "Hong Kong": "Hong Kong", "Kenia": "Kenyan", "Tanzania": "Tanzanian",
};

function frasePrueba(v) {
  if (v.lang === "es") {
    const lugar = REGION_HABLADA[v.region] || v.region;
    return `Hola, soy ${nombreVoz(v)} y leo con acento de ${lugar}. Así voy a sonar mientras te acompaño en la lectura.`;
  }
  const gentilicio = GENTILICIO_EN[v.region] || v.region;
  const articulo = /^[AEIOU]/i.test(gentilicio) ? "an" : "a";
  return `Hi, I'm ${v.name} and I read with ${articulo} ${gentilicio} accent. This is how I'll sound while I read along with you.`;
}

async function previewVoice(v, btn) {
  const base = engineUrl();
  if (!base) { toast("Configura el motor de voz en Ajustes para escuchar las voces.", true); return; }
  previewAudio.pause();
  document.querySelectorAll(".voice-item.sonando").forEach((e) => e.classList.remove("sonando"));
  btn?.classList.add("sonando");
  try {
    const res = await fetch(`${base}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: frasePrueba(v), voice: v.id, speed: state.settings.speed }),
    });
    if (!res.ok) throw new Error("no disponible");
    const data = await res.json();
    const bytes = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
    previewAudio.src = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
    await previewAudio.play();
  } catch {
    toast("No se pudo escuchar la voz (¿motor despertando?)", true);
  }
}
previewAudio.addEventListener("ended", () =>
  document.querySelectorAll(".voice-item.sonando").forEach((e) => e.classList.remove("sonando")));

function selectVoice(v, { repintar = null } = {}) {
  saveSettings(v.lang === "es" ? { voice_es: v.id } : { voice_en: v.id });
  state.clips.clear();
  (repintar || renderVoicePicker)();
  if (state.doc) { updateChips(); updateMediaSession(); }
  if (state.playing) { state.token++; state.audio.pause(); play(); }
}

/* ---------- hoja de ajustes ---------- */

function renderThemes() {
  const wrap = $("themeChips");
  wrap.innerHTML = "";
  for (const t of TEMAS) {
    const btn = document.createElement("button");
    btn.className = "theme-card" + (state.settings.theme === t.id ? " active" : "");
    btn.innerHTML = `<span class="swatch" style="background:${t.bg};color:${t.fg}">Aa</span><span></span>`;
    btn.querySelector("span:last-child").textContent = t.name;
    btn.addEventListener("click", () => { saveSettings({ theme: t.id }); renderThemes(); });
    wrap.appendChild(btn);
  }
}

const SCROLL_HINTS = {
  auto: "El texto solo sube cuando la oración en curso pasa de dos tercios de la pantalla, y entonces queda a un cuarto desde arriba.",
  siempre: "Cada oración se coloca a un cuarto desde arriba, como un teleprompter.",
  parrafo: "El texto solo se mueve al empezar un párrafo nuevo.",
  manual: "El texto nunca se mueve solo; lo desplazas tú.",
};

function highlightChipRows() {
  $("fontChips").querySelectorAll(".chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.font === state.settings.font));
  $("widthChips").querySelectorAll(".chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.width === (state.settings.width || "medio")));
  $("alignChips").querySelectorAll(".chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.align === (state.settings.align || "izquierda")));
  const modo = state.settings.scrollMode || "auto";
  $("scrollChips").querySelectorAll(".chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.scroll === modo));
  $("scrollHint").textContent = SCROLL_HINTS[modo] || "";
}

function openSheet({ desdeInicio = false } = {}) {
  // Las voces con prueba de sonido solo en el inicio: dentro del lector ya
  // están en la barra, y sonarían encima de la lectura.
  $("secVoices").classList.toggle("hidden", !desdeInicio);
  if (desdeInicio) renderVoicePicker("set", { conPrueba: true });
  renderThemes();
  highlightChipRows();
  $("engineUrl").value = state.settings.engine_url || "";
  $("engineStatus").textContent = engineUrl() ? "✓ Motor configurado" : "";
  $("geminiKey").value = state.settings.gemini_api_key || "";
  $("keyStatus").textContent = state.settings.gemini_api_key ? "✓ Clave configurada" : "";
  $("sheet").classList.remove("hidden");
  $("sheetBackdrop").classList.remove("hidden");
}

function closeSheet() {
  previewAudio.pause();
  $("sheet").classList.add("hidden");
  $("chapterSheet").classList.add("hidden");
  $("sheetBackdrop").classList.add("hidden");
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
  $("btnExport").addEventListener("click", abrirExportador);
  $("exportStart").addEventListener("click", exportarMP3);
  $("exportCancel").addEventListener("click", cerrarExportador);
  $("homeSettings").addEventListener("click", () => openSheet({ desdeInicio: true }));
  $("btnSettings").addEventListener("click", () => openSheet());
  $("btnSettings2").addEventListener("click", () => openSheet());
  $("btnChapters").addEventListener("click", openChapters);
  $("docTitle").addEventListener("click", openChapters);
  $("chipVoice").addEventListener("click", () => togglePopover("voces"));
  $("chipSpeed").addEventListener("click", () => togglePopover("vel"));
  $("chipFont").addEventListener("click", () => togglePopover("tam"));
  $("chipTranslate").addEventListener("click", translateCurrentSentence);
  $("sheetBackdrop").addEventListener("click", closeSheet);

  /* lectura: toque en oración salta; mantener pulsado abre el menú de subrayado;
     toque en cualquier zona vacía muestra u oculta los controles */
  let pressTimer = 0, pressed = null, moved = false;
  const stage = $("stage");

  const startPress = (e) => {
    const sn = e.target.closest?.(".sn");
    moved = false;
    pressed = sn || null;
    clearTimeout(pressTimer);
    if (!sn || state.playing) return;
    const p = Number(sn.closest(".seg").dataset.i);
    const s = Number(sn.dataset.s);
    pressTimer = setTimeout(() => { pressed = null; showHlMenu(sn, p, s); }, LONG_PRESS_MS);
  };
  const cancelPress = () => { clearTimeout(pressTimer); };

  stage.addEventListener("pointerdown", startPress);
  stage.addEventListener("pointermove", () => { moved = true; cancelPress(); });
  stage.addEventListener("pointerup", cancelPress);
  stage.addEventListener("pointercancel", cancelPress);
  stage.addEventListener("contextmenu", (e) => { if (e.target.closest(".sn")) e.preventDefault(); });

  stage.addEventListener("click", (e) => {
    if (moved) return;
    if (!$("hlMenu").classList.contains("hidden")) { hideHlMenu(); return; }
    const sn = e.target.closest(".sn");
    if (sn && pressed === sn) {
      goToSentence(Number(sn.closest(".seg").dataset.i), Number(sn.dataset.s));
      return;
    }
    if (!sn) setImmersive(!$("reader").classList.contains("immersive"));
  });

  ["wheel", "touchmove"].forEach((ev) =>
    stage.addEventListener(ev, () => { state.userScrolledAt = Date.now(); }, { passive: true }));

  $("hlCopy").addEventListener("click", copyPicked);
  $("hlMenu").querySelectorAll(".hl-dot").forEach((b) =>
    b.addEventListener("click", () => setHighlight(b.dataset.c)));

  $("speedRange").addEventListener("input", (e) => {
    const speed = Number(e.target.value);
    $("speedOut").textContent = `${speed.toFixed(2).replace(/0$/, "")}×`;
    saveSettings({ speed });
    updateChips();
  });
  $("speedRange").addEventListener("change", () => {
    state.clips.clear();
    if (state.playing) { state.token++; state.audio.pause(); play(state.sent); }
  });
  $("sizeRange").addEventListener("input", (e) => {
    saveSettings({ fontSize: Number(e.target.value) });
    $("sizeOut").textContent = `${e.target.value} px`;
  });

  $("fontChips").addEventListener("click", (e) => {
    const font = e.target.closest(".chip")?.dataset.font;
    if (font) { saveSettings({ font }); highlightChipRows(); }
  });
  $("widthChips").addEventListener("click", (e) => {
    const width = e.target.closest(".chip")?.dataset.width;
    if (width) { saveSettings({ width }); highlightChipRows(); }
  });
  $("alignChips").addEventListener("click", (e) => {
    const align = e.target.closest(".chip")?.dataset.align;
    if (align) { saveSettings({ align }); highlightChipRows(); }
  });
  $("scrollChips").addEventListener("click", (e) => {
    const scrollMode = e.target.closest(".chip")?.dataset.scroll;
    if (scrollMode) { saveSettings({ scrollMode }); highlightChipRows(); }
  });

  $("saveEngine").addEventListener("click", async () => {
    const url = $("engineUrl").value.trim().replace(/\/+$/, "");
    saveSettings({ engine_url: url });
    state.clips.clear();
    if (!url) { $("engineStatus").textContent = "Sin motor: se usan las voces del dispositivo."; return; }
    $("engineStatus").textContent = "Comprobando… (puede tardar si estaba dormido)";
    try {
      const res = await fetch(url + "/");
      const ok = res.ok && (await res.json()).service === "lyrio-voice";
      $("engineStatus").textContent = ok ? "✓ Motor conectado" : "⚠ Responde, pero no parece el motor de Lyrio";
      if (ok) { await loadVoiceCatalog(); updateChips(); }
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
    if (e.code === "Escape") { closeSheet(); closePopovers(); hideHlMenu(); }
  });
}

/* ---------- arranque ---------- */

async function boot() {
  wireEvents();
  applyDisplaySettings();
  renderLibrary();
  await loadVoiceCatalog();
  updateChips();
}

boot();

window.lyrio = {
  state, uploadFile, goToSentence, goToPara, togglePlay, stopPlayback, setImmersive,
  openChapters, saveSettings, exitReader, openSheet, closeSheet, togglePopover,
  translateCurrentSentence, sentencesFor, renderVoicePicker, showHlMenu, hideHlMenu,
  setHighlight, loadVoiceCatalog, prepararTextoVoz, updateTimeLeft,
  abrirExportador, exportarMP3, cerrarExportador, entregarArchivo,
};
