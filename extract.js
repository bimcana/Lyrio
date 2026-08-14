/* Lyrio Web — client-side PDF extraction (pdf.js port of server/extract.py).
   Chapters: A) PDF outline/bookmarks, B) typographic heuristics. */
"use strict";

import * as pdfjsLib from "./pdfjs/pdf.min.mjs?v=17";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdfjs/pdf.worker.min.mjs", import.meta.url).toString();

const MAX_SEGMENT_CHARS = 600;
const MIN_SEGMENT_CHARS = 3;
const MAX_HEADING_CHARS = 90;
const HEADING_MIN_SCORE = 3;

const SENTENCE_SPLIT = /(?<=[.!?…])\s+(?=[A-ZÁÉÍÓÚÑ¿¡"'(«0-9])/;
const HEADING_WORDS = /^\s*(cap[íi]tulo|chapter|parte|part|secci[óo]n|section|pilar|lecci[óo]n|lesson|libro|book|unidad|unit|tema|m[óo]dulo|module|ap[ée]ndice|appendix|pr[óo]logo|prologue|ep[íi]logo|epilogue|introducci[óo]n|introduction|conclusi[óo]n|conclusion|prefacio|preface)\b/i;
const NUMBERED = /^\s*\d{1,3}[.)\-–—:]\s+\S/;
const ROMAN = /^\s*[IVXLC]{1,7}[.)\-–—:]\s+\S/;
const BOLD_FONT = /bold|black|heavy|semib|demib/i;

const ES_STOP = new Set(["el", "la", "los", "las", "de", "que", "en", "un", "una", "por", "con", "para", "como", "más", "pero", "sus", "está"]);
const EN_STOP = new Set(["the", "and", "of", "to", "in", "is", "it", "that", "for", "with", "as", "was", "on", "are", "this", "be"]);

function cleanTitle(title) {
  title = normalizeAccents(title).trim().replace(/^\s*Microsoft \w+\s*-\s*/, "");
  title = title.replace(/\.(docx?|rtf|odt|pdf|txt)\s*$/i, "");
  return title.trim();
}

/* Muchos PDF guardan los acentos por separado: la letra base y encima el
   acento suelto. Para la í usan además la «i sin punto» (ı, una letra turca),
   que el motor de voz no reconoce como vocal y se salta al leer. Aquí se
   recomponen a la letra acentuada de toda la vida. */
/* Las imprentas unen ciertas parejas en un solo signo (ﬁ, ﬂ, ﬀ…). Si llegan
   así, la voz las lee mal o se las salta; aquí vuelven a ser letras sueltas. */
const LIGADURAS = {
  "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st",
  "Ĳ": "IJ", "ĳ": "ij", "Œ": "OE", "œ": "oe", "Æ": "AE", "æ": "ae",
};

function normalizeAccents(text) {
  return text
    .replace(/[ﬀ-ﬆĲĳŒœ]/g, (c) => LIGADURAS[c] ?? c)
    .replace(/ı/g, "i")          // ı sin punto -> i
    .replace(/ȷ/g, "j")          // ȷ sin punto -> j
    .normalize("NFC");                // i + ́  -> í
}

function cleanBlock(text) {
  return normalizeAccents(text)
    .replace(/­/g, "")
    .replace(/-\s*\n\s*/g, "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function splitLong(text) {
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

/* Encabezados y pies de página sueltos (números, romanos): estorban la lectura. */
const PAGE_FURNITURE = /^\s*(\d{1,4}|[ivxlcdmIVXLCDM]{1,7}|[-–—|]{1,3}\s*\d{1,4}\s*[-–—|]{1,3})\s*$/;

/* Un bloque continúa la oración anterior cuando esta quedó abierta y el
   siguiente arranca en minúscula. Es lo que ocurre al cortar una página en
   mitad de una frase: sin unirlos, la voz haría una pausa que rompe el sentido. */
function continuesSentence(prev, next) {
  if (!prev.text || !next.text) return false;
  const scale = Math.max(prev.avgSize, next.avgSize);
  if (Math.abs(prev.avgSize - next.avgSize) > scale * 0.12) return false;  // tipografía distinta
  const hyphenated = /[-‐‑–]$/.test(prev.text);
  const openEnded = hyphenated || !/[.!?…:;»"'”’)\]]\s*$/.test(prev.text);
  // Continúa si arranca en minúscula, o con una conjunción/preposición típica de enlace.
  const startsLower = /^[a-záéíóúüñ]/.test(next.text);
  return openEnded && startsLower;
}

function joinContinuations(blocks) {
  const out = [];
  for (const block of blocks) {
    // Los encabezados y pies corridos se descartan: además de leerse en voz alta,
    // se interponían entre las dos mitades de una frase e impedían unirlas.
    if (block.furniture || PAGE_FURNITURE.test(block.text)) continue;
    const prev = out[out.length - 1];
    if (prev && continuesSentence(prev, block)) {
      if (/[-‐‑–]$/.test(prev.text)) {
        prev.text = prev.text.slice(0, -1) + block.text;           // palabra partida
      } else {
        prev.text = `${prev.text} ${block.text}`;
      }
      prev.chars += block.chars;
      continue;
    }
    out.push({ ...block });
  }
  return out;
}

function headingScore(text, avgSize, boldFrac, bodySize) {
  if (text.length < 2 || text.length > MAX_HEADING_CHARS) return 0;
  if (text.split(/\s+/).length > 14) return 0;
  let score = 0;
  if (avgSize >= bodySize * 1.35) score += 3;
  else if (avgSize >= bodySize * 1.15) score += 2;
  else if (avgSize >= bodySize * 1.05) score += 1;
  if (boldFrac >= 0.7) score += 1;
  if (HEADING_WORDS.test(text)) {
    score += 2;
    if (text.split(/\s+/).length <= 6) score += 1;
  }
  if (NUMBERED.test(text) || ROMAN.test(text)) score += 1;
  if (text === text.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{2}/.test(text) && text.length >= 4) score += 1;
  if (/[.;,]\s*$/.test(text)) score -= 1;
  return score;
}

/* ---- lines & blocks from pdf.js text items ---- */

function linesFromItems(items) {
  const lines = [];
  let current = null;
  for (const it of items) {
    if (!it.str || !it.str.trim()) {
      if (it.hasEOL && current) current = null;
      continue;
    }
    const y = it.transform[5];
    const x = it.transform[4];
    const size = it.height || Math.abs(it.transform[3]) || 10;
    if (current && Math.abs(y - current.y) <= Math.max(2, current.size * 0.45)) {
      current.frags.push({ str: it.str, x, width: it.width || 0, size, font: it.fontName || "" });
    } else {
      current = { y, size, frags: [{ str: it.str, x, width: it.width || 0, size, font: it.fontName || "" }] };
      lines.push(current);
    }
  }
  lines.sort((a, b) => b.y - a.y);          // top of page first (PDF y-axis grows upward)
  for (const line of lines) {
    line.frags.sort((a, b) => a.x - b.x);
    let text = "";
    let prevEnd = null;
    let weighted = 0, chars = 0, boldChars = 0;
    for (const f of line.frags) {
      if (prevEnd !== null && f.x - prevEnd > f.size * 0.22 && !text.endsWith(" ")) text += " ";
      text += f.str;
      prevEnd = f.x + f.width;
      const n = f.str.trim().length;
      weighted += f.size * n;
      chars += n;
      if (BOLD_FONT.test(f.font)) boldChars += n;
    }
    line.text = text.trim();
    line.avgSize = chars ? weighted / chars : line.size;
    line.boldFrac = chars ? boldChars / chars : 0;
    line.chars = chars;
  }
  return lines.filter((l) => l.text);
}

function blocksFromLines(lines, pageNumber, pageHeight) {
  const blocks = [];
  let current = null;
  let prev = null;
  for (const line of lines) {
    const gap = prev ? prev.y - line.y : 0;
    const sizeJump = prev
      ? Math.abs(line.avgSize - prev.avgSize) > 0.15 * Math.max(line.avgSize, prev.avgSize)
      : false;
    const newBlock = !current || !prev || gap > Math.max(line.avgSize, prev.avgSize) * 1.7 || sizeJump;
    if (newBlock) {
      current = { texts: [], weighted: 0, chars: 0, boldChars: 0, page: pageNumber,
                  top: line.y, bottom: line.y };
      blocks.push(current);
    }
    current.texts.push(line.text);
    current.weighted += line.avgSize * line.chars;
    current.chars += line.chars;
    current.boldChars += line.boldFrac * line.chars;
    current.top = Math.max(current.top, line.y);
    current.bottom = Math.min(current.bottom, line.y);
    prev = line;
  }
  return blocks
    .map((b) => ({
      text: cleanBlock(b.texts.join("\n")),
      page: b.page,
      avgSize: b.chars ? b.weighted / b.chars : 10,
      boldFrac: b.chars ? b.boldChars / b.chars : 0,
      chars: b.chars,
      // Encabezado o pie corrido: texto corto pegado al margen superior o inferior.
      furniture: isRunningHeadOrFoot(b, pageHeight),
    }))
    .filter((b) => b.text.length >= MIN_SEGMENT_CHARS);
}

function isRunningHeadOrFoot(block, pageHeight) {
  if (!pageHeight) return false;
  const text = cleanBlock(block.texts.join(" "));
  if (text.length > 90 || block.texts.length > 2) return false;
  const nearTop = block.bottom > pageHeight * 0.92;
  const nearBottom = block.top < pageHeight * 0.08;
  return nearTop || nearBottom;
}

/* ---- chapters from the PDF outline (source A) ---- */

function normalize(text) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function matchSegment(segments, title, page) {
  const normTitle = normalize(title).slice(0, 30);
  let fallback = null;
  for (const seg of segments) {
    if (seg.page < page) continue;
    if (seg.page > page + 1) break;
    if (fallback === null) fallback = seg.i;
    if (normTitle && normalize(seg.text).startsWith(normTitle)) return seg.i;
  }
  return fallback;
}

async function chaptersFromOutline(pdf, segments) {
  let outline;
  try {
    outline = await pdf.getOutline();
  } catch {
    return [];
  }
  if (!outline || !outline.length) return [];
  const flat = [];
  (function walk(nodes, lvl) {
    for (const n of nodes || []) {
      flat.push({ lvl, title: (n.title || "").trim(), dest: n.dest });
      walk(n.items, lvl + 1);
    }
  })(outline, 1);
  const levels = [...new Set(flat.map((f) => f.lvl))].sort((a, b) => a - b).slice(0, 2);
  const chapters = [];
  for (const f of flat) {
    if (!levels.includes(f.lvl) || !f.title) continue;
    try {
      let dest = f.dest;
      if (typeof dest === "string") dest = await pdf.getDestination(dest);
      if (!dest || !dest[0]) continue;
      const pageIndex = await pdf.getPageIndex(dest[0]);
      const seg = matchSegment(segments, f.title, pageIndex + 1);
      if (seg !== null) chapters.push({ title: f.title.slice(0, 80), seg });
    } catch {
      /* skip broken outline entry */
    }
  }
  chapters.sort((a, b) => a.seg - b.seg);
  const deduped = [];
  for (const ch of chapters) {
    if (!deduped.length || ch.seg > deduped[deduped.length - 1].seg) deduped.push(ch);
  }
  return deduped.length >= 2 ? deduped : [];
}

/* ---- main entry ---- */

async function sha1Hex(buffer) {
  const hash = await crypto.subtle.digest("SHA-1", buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Sin estos datos auxiliares, pdf.js no sabe traducir los glifos de las
   fuentes estándar ni de las codificaciones CID, y algunas letras salen
   vacías (típicamente la f y sus ligaduras). */
const BASE_PDFJS = new URL("./pdfjs/", import.meta.url).toString();

export async function extractFromPdf(arrayBuffer, fileName) {
  const id = (await sha1Hex(arrayBuffer)).slice(0, 12);
  const pdf = await pdfjsLib.getDocument({
    data: arrayBuffer.slice(0),
    cMapUrl: `${BASE_PDFJS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE_PDFJS}standard_fonts/`,
    useSystemFonts: false,
  }).promise;

  const rawBlocks = [];
  const sizeCount = new Map();
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    // Sin la normalización de pdf.js (pensada para buscar, no para leer):
    // es la que parte los acentos y deshace ligaduras perdiendo letras.
    const content = await page.getTextContent({ disableNormalization: true });
    const pageHeight = page.getViewport({ scale: 1 }).height;
    const lines = linesFromItems(content.items);
    for (const block of blocksFromLines(lines, p, pageHeight)) {
      rawBlocks.push(block);
      const key = Math.round(block.avgSize * 10) / 10;
      sizeCount.set(key, (sizeCount.get(key) || 0) + block.chars);
    }
  }

  let bodySize = 11;
  let bestCount = -1;
  for (const [size, count] of sizeCount) {
    if (count > bestCount) { bestCount = count; bodySize = size; }
  }

  const blocks = joinContinuations(rawBlocks);

  const segments = [];
  const heuristicChapters = [];
  for (const rb of blocks) {
    const isHeading = headingScore(rb.text, rb.avgSize, rb.boldFrac, bodySize) >= HEADING_MIN_SCORE;
    if (isHeading) {
      heuristicChapters.push({ title: rb.text.slice(0, 80), seg: segments.length });
      segments.push({ i: segments.length, text: rb.text, page: rb.page });
      continue;
    }
    for (const piece of splitLong(rb.text)) {
      if (piece.length >= MIN_SEGMENT_CHARS) {
        segments.push({ i: segments.length, text: piece, page: rb.page });
      }
    }
  }

  const chapters = (await chaptersFromOutline(pdf, segments));
  const finalChapters = chapters.length ? chapters : heuristicChapters;

  let metaTitle = "";
  try {
    const meta = await pdf.getMetadata();
    metaTitle = cleanTitle(meta?.info?.Title || "");
  } catch { /* no metadata */ }

  const fullText = segments.slice(0, 200).map((s) => s.text).join(" ");
  const docLang = segments.length ? detectLanguage(fullText) : "es";
  for (const seg of segments) {
    if (seg.text.length > 60) {
      const segLang = detectLanguage(seg.text);
      if (segLang !== docLang) seg.lang = segLang;
    }
  }

  const pages = pdf.numPages;
  await pdf.destroy();

  return {
    id,
    title: metaTitle || fileName.replace(/\.pdf$/i, ""),
    pages,
    segments,
    chapters: finalChapters,
    lang: docLang,
  };
}
