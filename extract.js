/* Lyrio Web — client-side PDF extraction (pdf.js port of server/extract.py).
   Chapters: A) PDF outline/bookmarks, B) typographic heuristics. */
"use strict";

import * as pdfjsLib from "./pdfjs/pdf.min.mjs?v=22";
import {
  MAX_SEGMENT_CHARS, MIN_SEGMENT_CHARS, RE_HUECO, RE_HUECO_G, RE_LETRA,
  normalizeAccents, limpiarRestos, cleanBlock, splitLong, detectLanguage,
} from "./texto.js?v=22";

export { detectLanguage };

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdfjs/pdf.worker.min.mjs", import.meta.url).toString();

const MAX_HEADING_CHARS = 90;
const HEADING_MIN_SCORE = 3;

/* Versión del motor de extracción. Se guarda en cada documento para poder
   avisar cuando un libro de la biblioteca se procesó con un motor anterior
   y conviene volver a arrastrar el PDF. */
export const MOTOR_EXTRACCION = 2;

const HEADING_WORDS = /^\s*(cap[íi]tulo|chapter|parte|part|secci[óo]n|section|pilar|lecci[óo]n|lesson|libro|book|unidad|unit|tema|m[óo]dulo|module|ap[ée]ndice|appendix|pr[óo]logo|prologue|ep[íi]logo|epilogue|introducci[óo]n|introduction|conclusi[óo]n|conclusion|prefacio|preface)\b/i;
const NUMBERED = /^\s*\d{1,3}[.)\-–—:]\s+\S/;
const ROMAN = /^\s*[IVXLC]{1,7}[.)\-–—:]\s+\S/;
const BOLD_FONT = /bold|black|heavy|semib|demib/i;

function cleanTitle(title) {
  title = normalizeAccents(title).trim().replace(/^\s*Microsoft \w+\s*-\s*/, "");
  title = title.replace(/\.(docx?|rtf|odt|pdf|txt)\s*$/i, "");
  return title.trim();
}

/* ---- identificar los glifos que el PDF entrega rotos ----

   Algunos PDF traen la capa de texto ya sin la letra: el generador manda
   ciertos glifos a U+0000 (o al area privada) y no queda ni nombre de glifo
   ni entrada en el cmap de la fuente. El caso corriente es la "f" recortada
   que las imprentas usan delante de i o de l -- por eso "final" llega como
   un hueco y "inal", y "beneficios" como "bene" y "icios".

   No se adivina la letra: se deduce del propio documento. Se juntan TODAS
   las apariciones del mismo hueco, se prueban los candidatos tipograficos
   posibles y gana el que explique la evidencia: que letra le sigue siempre
   y cuantas palabras reconstruidas ya existen bien escritas en el libro. Si
   ninguno convence, no se toca el texto y se avisa al lector. */

const CANDIDATOS = ["f", "fi", "fl", "ff", "ffi", "ffl", "ft"];

/* Recorta la palabra a la que pertenece el hueco. El hueco ocupa el lugar
   exacto de la letra: no se tocan los espacios de alrededor, que son
   separaciones de verdad ("destino ?inal" es "destino final", no
   "destinofinal"). */
function palabraEn(texto, pos) {
  let ini = pos - 1;
  while (ini >= 0 && RE_LETRA.test(texto[ini])) ini--;
  let fin = pos + 1;
  while (fin < texto.length && RE_LETRA.test(texto[fin])) fin++;
  return { antes: texto.slice(ini + 1, pos), despues: texto.slice(pos + 1, fin) };
}

function deducirGlifos(textos) {
  const lexico = new Set();
  const casos = new Map();          // codigo -> [{antes, despues}]
  for (const texto of textos) {
    for (const palabra of texto.split(/\s+/)) {
      if (palabra && !RE_HUECO.test(palabra)) {
        lexico.add(palabra.toLowerCase().replace(/[^\w\u00C0-\u024F]/g, ""));
      }
    }
    let m;
    RE_HUECO_G.lastIndex = 0;
    while ((m = RE_HUECO_G.exec(texto)) !== null) {
      const ctx = palabraEn(texto, m.index);
      if (!ctx.antes && !ctx.despues) continue;      // hueco suelto: no es una letra
      const cod = m[0];
      if (!casos.has(cod)) casos.set(cod, []);
      casos.get(cod).push(ctx);
    }
  }

  const mapa = new Map();
  const informe = [];
  for (const [cod, lista] of casos) {
    if (lista.length < 2) continue;                 // sin evidencia suficiente
    // Evidencia 1: la letra que sigue. La "f" de ligadura solo aparece
    // delante de i o de l; una ligadura entera (fi, fl) nunca las lleva.
    const seguidasDeIL = lista.filter((c) => /^[il]/i.test(c.despues)).length;
    const fraccionIL = seguidasDeIL / lista.length;
    // Evidencia 2: cuantas palabras reconstruidas ya existen en el libro.
    let mejor = null;
    for (const cand of CANDIDATOS) {
      if (cand !== "f" && fraccionIL > 0.5) continue;   // incompatible con la evidencia 1
      if (cand === "f" && fraccionIL < 0.5) continue;
      let aciertos = 0;
      for (const c of lista) {
        const palabra = (c.antes + cand + c.despues).toLowerCase();
        if (lexico.has(palabra)) aciertos++;
      }
      const punt = aciertos / lista.length;
      if (!mejor || punt > mejor.punt) mejor = { cand, punt, aciertos };
    }
    if (!mejor) continue;
    // Se acepta si el contexto es concluyente (evidencia 1) o si el libro
    // confirma bastantes reconstrucciones (evidencia 2).
    const concluyente = fraccionIL >= 0.85 && mejor.cand === "f";
    if (concluyente || mejor.punt >= 0.25) {
      // Se guarda tambien la condicion que justifica la letra: la f de
      // ligadura solo existe delante de i o de l.
      mapa.set(cod, { letra: mejor.cand, exigeIL: mejor.cand === "f" });
      informe.push({
        codigo: "U+" + cod.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"),
        letra: mejor.cand, casos: lista.length,
        porContexto: Math.round(fraccionIL * 100), porLexico: Math.round(mejor.punt * 100),
      });
    }
  }
  return { mapa, informe };
}

/* Aplica la deduccion hueco por hueco. Cada pagina incrusta su propio
   subconjunto de fuente, asi que dos glifos distintos pueden acabar en el
   mismo U+0000: la letra solo se pone donde el contexto la respalda, y si no
   se deja el hueco (que luego se retira) antes que inventar una letra. */
function aplicarGlifos(texto, mapa) {
  if (!mapa.size) return texto;
  return texto.replace(RE_HUECO_G, (c, pos) => {
    const regla = mapa.get(c);
    if (!regla) return c;
    if (regla.exigeIL && !/[il]/i.test(texto[pos + 1] || "")) return c;
    return regla.letra;
  });
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
      top: b.top,
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

/* ---- donde estan las imagenes de cada pagina ----

   Los operadores de dibujo dicen donde se pinta cada imagen. Aqui solo interesa
   el RECTANGULO, no los pixeles: guardar la posicion no cuesta nada, y la
   imagen se saca luego del archivo original, solo cuando va a verse. */

const mulMatriz = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

async function imagenesDePagina(page, numero) {
  const ops = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const anchoPagina = page.getViewport({ scale: 1 }).width;
  const encontradas = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const pila = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === OPS.save) pila.push(ctm.slice());
    else if (fn === OPS.restore) ctm = pila.pop() || ctm;
    else if (fn === OPS.transform) ctm = mulMatriz(ctm, ops.argsArray[i]);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) {
      const clave = ops.argsArray[i]?.[0];
      // La imagen se dibuja sobre el cuadrado unidad transformado por la matriz
      // en curso: sus cuatro esquinas dan el rectangulo real en la pagina.
      const [a, b, c, d, e, f] = ctm;
      const xs = [e, a + e, c + e, a + c + e];
      const ys = [f, b + f, d + f, b + d + f];
      encontradas.push({
        pagina: numero,
        clave,
        rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        anchoPagina,
      });
    }
  }
  return encontradas;
}

/* Que se descarta y que no.

   La tentacion es filtrar por forma: "si es ancha y baja sera un adorno". Se
   probo con el libro real y result0 SER FALSO — los diagramas manuscritos de
   estos libros son justo anchos y bajos ("SI NO LOGRAS X EN Y TIEMPO...", el
   esquema de escasez), y el filtro se los comia. Contenido perdido en silencio
   es peor que un logotipo de mas.

   Asi que solo se descarta lo indiscutible: motas de pocos puntos, y el
   mobiliario que se repite pagina tras pagina (un logotipo en la cabecera de
   cada capitulo). Ante cualquier duda, se muestra. */
function esMota(rect) {
  return (rect[2] - rect[0]) < 20 || (rect[3] - rect[1]) < 20;
}

/* Una imagen del mismo tamano repetida en muchas paginas distintas no es una
   figura: es el sello de la casa impreso en cada capitulo. */
function marcarRepetidas(lista) {
  const grupos = new Map();
  for (const im of lista) {
    const clave = `${Math.round(im.rect[2] - im.rect[0])}x${Math.round(im.rect[3] - im.rect[1])}`;
    if (!grupos.has(clave)) grupos.set(clave, new Set());
    grupos.get(clave).add(im.pagina);
  }
  const mobiliario = new Set();
  for (const [clave, paginas] of grupos) {
    if (paginas.size >= 5) mobiliario.add(clave);
  }
  return mobiliario;
}

/* Cuenta letras que el PDF entrega ya rotas y que no se pueden recuperar:
   nulos de mapas defectuosos, glifos del área privada sin equivalencia y
   signos de reemplazo. Sirve para avisar con honestidad, no para adivinar. */
function contarDanos(str, danos) {
  for (const ch of str) {
    const o = ch.codePointAt(0);
    if (o === 0) danos.nulos++;
    else if (o === 0xFFFD) danos.reemplazos++;
    else if (o >= 0xE000 && o <= 0xF8FF && o !== 0xF001 && o !== 0xF002) danos.glifos++;
  }
}

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
  const imagenesCrudas = [];
  const sizeCount = new Map();
  const danos = { nulos: 0, glifos: 0, reemplazos: 0 };
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    // Sin la normalización de pdf.js (pensada para buscar, no para leer):
    // es la que parte los acentos y deshace ligaduras perdiendo letras.
    const content = await page.getTextContent({ disableNormalization: true });
    const pageHeight = page.getViewport({ scale: 1 }).height;
    for (const im of await imagenesDePagina(page, p)) imagenesCrudas.push(im);
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

  // Con el libro entero a la vista ya se puede deducir qué letra era cada
  // hueco; lo que no se identifique se cuenta como daño y se retira.
  const { mapa: mapaGlifos, informe: reparaciones } = deducirGlifos(rawBlocks.map((b) => b.text));
  for (const b of rawBlocks) {
    const conLetras = aplicarGlifos(b.text, mapaGlifos);
    contarDanos(conLetras, danos);
    b.text = limpiarRestos(conLetras);
  }

  const blocks = joinContinuations(rawBlocks).filter((b) => b.text.length >= MIN_SEGMENT_CHARS);

  const segments = [];
  const heuristicChapters = [];
  for (const rb of blocks) {
    const isHeading = headingScore(rb.text, rb.avgSize, rb.boldFrac, bodySize) >= HEADING_MIN_SCORE;
    if (isHeading) {
      heuristicChapters.push({ title: rb.text.slice(0, 80), seg: segments.length });
      segments.push({ i: segments.length, text: rb.text, page: rb.page, top: rb.top });
      continue;
    }
    for (const piece of splitLong(rb.text)) {
      if (piece.length >= MIN_SEGMENT_CHARS) {
        segments.push({ i: segments.length, text: piece, page: rb.page, top: rb.top });
      }
    }
  }

  /* El ancla es un indice de SEGMENTO, pero la posicion de la imagen se conoce
     en coordenadas de pagina. Entre medias, joinContinuations() une bloques
     partidos por salto de pagina y descarta encabezados corridos, asi que los
     indices se desplazan: por eso esto se resuelve AL FINAL, cuando cada
     segmento ya sabe de que pagina viene. Anclar antes las colocaria corridas. */
  const imagenes = [];
  let imagenesDescartadas = 0;
  const mobiliario = marcarRepetidas(imagenesCrudas);
  for (const im of imagenesCrudas) {
    const forma = `${Math.round(im.rect[2] - im.rect[0])}x${Math.round(im.rect[3] - im.rect[1])}`;
    if (esMota(im.rect) || mobiliario.has(forma)) { imagenesDescartadas++; continue; }
    // Ultimo segmento que queda por encima de la imagen. El eje vertical del
    // PDF crece hacia arriba, asi que "por encima" es tener la y mayor.
    let tras = -1;
    for (const seg of segments) {
      if (seg.page < im.pagina) tras = seg.i;
      else if (seg.page === im.pagina && (seg.top ?? Infinity) > im.rect[3]) tras = seg.i;
      else if (seg.page > im.pagina) break;
    }
    imagenes.push({
      tras,
      ref: { pagina: im.pagina, clave: im.clave },
      w: Math.round(im.rect[2] - im.rect[0]),
      h: Math.round(im.rect[3] - im.rect[1]),
    });
  }
  imagenes.sort((a, b) => a.tras - b.tras);

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

  const totalDanos = danos.nulos + danos.glifos + danos.reemplazos;
  return {
    id,
    title: metaTitle || fileName.replace(/\.pdf$/i, ""),
    pages,
    segments,
    chapters: finalChapters,
    lang: docLang,
    motor: MOTOR_EXTRACCION,
    formato: "pdf",
    imagenes,
    ...(imagenesDescartadas ? { imagenesDescartadas } : {}),
    ...(totalDanos ? { danos } : {}),
    ...(reparaciones.length ? { reparaciones } : {}),
  };
}
