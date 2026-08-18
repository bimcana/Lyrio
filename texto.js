/* Lyrio — limpieza de texto compartida por los dos formatos.

   Vive aparte de extract.js porque el EPUB necesita exactamente las mismas
   reglas (ligaduras, acentos descompuestos, restos invisibles, troceado) y no
   tiene por qué arrastrar pdf.js detrás. */
"use strict";

export const MAX_SEGMENT_CHARS = 600;
export const MIN_SEGMENT_CHARS = 3;

export const SENTENCE_SPLIT = /(?<=[.!?…])\s+(?=[A-ZÁÉÍÓÚÑ¿¡"'(«0-9])/;

const ES_STOP = new Set(["el", "la", "los", "las", "de", "que", "en", "un", "una", "por", "con", "para", "como", "más", "pero", "sus", "está"]);
const EN_STOP = new Set(["the", "and", "of", "to", "in", "is", "it", "that", "for", "with", "as", "was", "on", "are", "this", "be"]);

/* Muchos PDF guardan los acentos por separado: la letra base y encima el
   acento suelto. Para la í usan además la «i sin punto» (ı, una letra turca),
   que el motor de voz no reconoce como vocal y se salta al leer. Aquí se
   recomponen a la letra acentuada de toda la vida. */
/* Las imprentas unen ciertas parejas en un solo signo (fi ligada, etc.). Si
   llegan asi, la voz las lee mal o se las salta; aqui vuelven a ser letras
   sueltas. U+F001/U+F002 son la convencion antigua de Adobe para fi/fl en el
   area privada de Unicode: en pantalla no se ven y la voz las salta. */
const LIGADURAS = {
  "\uFB00": "ff", "\uFB01": "fi", "\uFB02": "fl", "\uFB03": "ffi", "\uFB04": "ffl",
  "\uFB05": "st", "\uFB06": "st",
  "\u0132": "IJ", "\u0133": "ij", "\u0152": "OE", "\u0153": "oe",
  "\u00C6": "AE", "\u00E6": "ae",
  "\uF001": "fi", "\uF002": "fl",
  "\u017F": "s",              // s larga de imprentas antiguas
};

/* Huecos que deja un PDF mal generado: el nulo al que algunos ToUnicode
   mandan sus glifos, el area privada sin equivalencia y el signo de
   reemplazo. NO se borran aqui: primero se intenta deducir que letra eran
   (ver deducirGlifos); lo que quede sin resolver lo quita limpiarRestos. */
export const RE_HUECO_G = /[\u0000\uE000-\uF8FF\uFFFD]/g;
export const RE_HUECO = /[\u0000\uE000-\uF8FF\uFFFD]/;   // sin /g: .test() no mueve lastIndex
export const RE_LETRA = /[A-Za-z\u00C0-\u024F]/;

export function normalizeAccents(text) {
  return text
    .replace(/[\uFB00-\uFB06\u0132\u0133\u0152\u0153\u00C6\u00E6\uF001\uF002\u017F]/g, (c) => LIGADURAS[c] ?? c)
    .replace(/\u0131/g, "i")          // i sin punto (turca) -> i
    .replace(/\u0237/g, "j")          // j sin punto -> j
    // Controles y anchos invisibles: no aportan nada y hacen tropezar a la
    // voz. Los huecos de glifo se conservan hasta intentar identificarlos.
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u00A0\u202F\u2007]/g, " ")
    .normalize("NFC");                // i + acento suelto -> i acentuada
}

/* Ultimo recorrido: se van los huecos que no se pudieron identificar y el
   espacio sobrante que dejan al desaparecer. */
export function limpiarRestos(text) {
  return text.replace(RE_HUECO_G, "").replace(/\s{2,}/g, " ").trim();
}


export function cleanBlock(text) {
  return normalizeAccents(text)
    .replace(/­/g, "")
    .replace(/-\s*\n\s*/g, "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function splitLong(text) {
  if (text.length <= MAX_SEGMENT_CHARS) return [text];
  const sentences = text.split(SENTENCE_SPLIT);
  const out = [];
  let current = "";
  for (const s of sentences) {
    if (current && current.length + s.length + 1 > MAX_SEGMENT_CHARS) {
      out.push(current);
      current = s;
    } else {
      current = (current + " " + s).trim();
    }
    while (current.length > MAX_SEGMENT_CHARS * 1.5) {
      let cut = current.lastIndexOf(",", MAX_SEGMENT_CHARS);
      if (cut < MAX_SEGMENT_CHARS / 2) cut = current.lastIndexOf(" ", MAX_SEGMENT_CHARS);
      if (cut <= 0) cut = MAX_SEGMENT_CHARS;
      out.push(current.slice(0, cut + 1).trim());
      current = current.slice(cut + 1).trim();
    }
  }
  if (current) out.push(current);
  return out;
}

export function detectLanguage(text) {
  const words = text.toLowerCase().match(/[a-záéíóúñü]+/g) || [];
  let es = 0, en = 0;
  for (const w of words) {
    if (ES_STOP.has(w)) es++;
    if (EN_STOP.has(w)) en++;
  }
  return es >= en ? "es" : "en";
}
