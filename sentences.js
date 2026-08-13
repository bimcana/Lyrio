/* División de un párrafo en oraciones (de punto a punto).
   Es la unidad de lectura y de navegación: cada oración se habla por separado
   y se puede tocar para volver a ella. */
"use strict";

const MIN_SENTENCE_CHARS = 12;
const CLOSERS = "\"'»”’)\\]";

// Abreviaturas tras las que un punto no termina la oración.
const ABBREVIATIONS = new Set([
  "sr", "sra", "srta", "dr", "dra", "lic", "ing", "arq", "prof", "gral",
  "etc", "ej", "vs", "núm", "num", "no", "pág", "pag", "fig", "art", "cap",
  "vol", "ed", "edit", "trad", "av", "avda", "ee", "uu", "aprox", "máx", "mín",
  "mr", "mrs", "ms", "st", "jr", "inc", "dept", "vol", "op", "cit",
]);

const BOUNDARY = new RegExp(`[.!?…]+(?=[${CLOSERS}]*(\\s|$))`, "g");
const STARTS_SENTENCE = /^[A-ZÁÉÍÓÚÜÑ¿¡"'«(\[—–-]/;

function endsWithAbbreviation(textBefore) {
  const m = /([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)$/.exec(textBefore);
  if (!m) return false;
  const word = m[1].toLowerCase();
  return word.length === 1 || ABBREVIATIONS.has(word);   // "J. Smith", "etc."
}

export function splitSentences(text) {
  const out = [];
  let start = 0;
  let match;
  BOUNDARY.lastIndex = 0;

  while ((match = BOUNDARY.exec(text)) !== null) {
    let end = match.index + match[0].length;
    while (end < text.length && new RegExp(`[${CLOSERS}]`).test(text[end])) end++;

    const before = text.slice(0, match.index);
    const after = text.slice(end);
    const nextChar = after.trimStart()[0];

    const isDecimal = /\d$/.test(before) && /^\d/.test(after);
    const tooShort = end - start < MIN_SENTENCE_CHARS;
    const continuesLower = nextChar && !STARTS_SENTENCE.test(nextChar);

    if (isDecimal || tooShort || continuesLower || endsWithAbbreviation(before)) continue;

    out.push({ cs: start, ce: end });
    start = end + (after.length - after.trimStart().length);
  }

  if (start < text.length) {
    if (out.length && text.length - start < MIN_SENTENCE_CHARS) {
      out[out.length - 1].ce = text.length;        // cola muy corta: se une a la anterior
    } else {
      out.push({ cs: start, ce: text.length });
    }
  }
  return out.length ? out : [{ cs: 0, ce: text.length }];
}
