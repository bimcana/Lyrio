/* Lyrio Web — on-device persistence (IndexedDB + localStorage). */
"use strict";

const DB_NAME = "lyrio";
const DB_VERSION = 2;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs");
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function op(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const idbGet = (store, key) => op(store, "readonly", (s) => s.get(key));
export const idbPut = (store, key, value) => op(store, "readwrite", (s) => s.put(value, key));
export const idbDel = (store, key) => op(store, "readwrite", (s) => s.delete(key));

/* library: array of doc summaries, stored under one kv key */

export async function getLibrary() {
  return (await idbGet("kv", "library")) || [];
}

export async function saveLibrary(library) {
  await idbPut("kv", "library", library);
}

export async function getDoc(id) {
  return idbGet("docs", id);
}

export async function saveDoc(doc) {
  await idbPut("docs", doc.id, doc);
}

export async function deleteDoc(id) {
  await idbDel("docs", id);
  await saveLibrary((await getLibrary()).filter((d) => d.id !== id));
}

export async function savePosition(id, position) {
  const library = await getLibrary();
  const entry = library.find((d) => d.id === id);
  if (entry) {
    entry.position = position;
    await saveLibrary(library);
  }
}

/* translation cache */

const trKey = (target, text) => `tr:${target}:${text.length}:${hashCode(text)}`;

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export async function getCachedTranslation(target, text) {
  return idbGet("kv", trKey(target, text));
}

export async function cacheTranslation(target, text, translation) {
  await idbPut("kv", trKey(target, text), translation);
}

/* settings: small, synchronous access preferred -> localStorage */

const SETTINGS_KEY = "lyrio-settings";

export const DEFAULT_SETTINGS = {
  // Motor de voces neuronales de Microsoft; se puede cambiar en Ajustes.
  engine_url: "https://lyrio-voz.onrender.com",
  gemini_api_key: "",
  gemini_model: "",
  voice_es: "es-MX-DaliaNeural",
  voice_en: "en-US-AvaMultilingualNeural",
  speed: 1.0,
  font: "sans",
  fontSize: 26,
  theme: "kindle",
  width: "medio",
  scrollMode: "auto",     // auto | siempre | parrafo | manual
  align: "izquierda",     // izquierda | centro | derecha | justificado
};

/* subrayados por documento: { "parrafo:oracion": color } */

export async function getHighlights(docId) {
  return (await idbGet("kv", `hl:${docId}`)) || {};
}

export async function saveHighlights(docId, marcas) {
  await idbPut("kv", `hl:${docId}`, marcas);
}

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function persistSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
