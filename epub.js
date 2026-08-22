/* Lyrio — leer libros EPUB.

   Un EPUB es un ZIP con HTML dentro. El navegador sabe descomprimir por su
   cuenta, así que no hace falta ninguna librería: Lyrio sigue siendo una app
   estática sin dependencias. El resultado es el MISMO documento que produce el
   PDF, de modo que la lectura, los subrayados, la traducción y la exportación
   funcionan igual sin tocar nada. */
"use strict";

import {
  MIN_SEGMENT_CHARS, cleanBlock, limpiarRestos, splitLong, detectLanguage,
} from "./texto.js?v=27";

export const MOTOR_EPUB = 1;

const FIRMA_FIN = 0x06054b50;      // fin del directorio central
const FIRMA_ENTRADA = 0x02014b50;  // entrada del directorio central

async function inflar(bytes, metodo) {
  if (metodo === 0) return bytes;                     // guardado sin comprimir
  if (metodo !== 8) throw new Error(`Compresión no soportada: ${metodo}`);
  const flujo = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(flujo).arrayBuffer());
}

/* Se lee el índice del ZIP y se anotan las posiciones, pero NO se descomprime
   nada todavía. Descomprimir las 241 imágenes de un libro y quedárselas en
   memoria era lo que tumbaba la app con archivos grandes: ahora cada entrada
   se descomprime cuando se pide, y solo se guardan las pequeñas. */
export async function leerZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);

  // El directorio central está al final: se busca su firma hacia atrás.
  let fin = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (dv.getUint32(i, true) === FIRMA_FIN) { fin = i; break; }
  }
  if (fin < 0) throw new Error("No parece un archivo EPUB válido");

  const cuantas = dv.getUint16(fin + 10, true);
  let p = dv.getUint32(fin + 16, true);

  const indice = new Map();          // ruta -> { metodo, inicio, largo }
  const decodificador = new TextDecoder("utf-8");
  for (let n = 0; n < cuantas; n++) {
    if (dv.getUint32(p, true) !== FIRMA_ENTRADA) break;
    const metodo = dv.getUint16(p + 10, true);
    const comprimido = dv.getUint32(p + 20, true);
    const largoNombre = dv.getUint16(p + 28, true);
    const largoExtra = dv.getUint16(p + 30, true);
    const largoComentario = dv.getUint16(p + 32, true);
    const offsetLocal = dv.getUint32(p + 42, true);
    const nombre = decodificador.decode(buf.subarray(p + 46, p + 46 + largoNombre));
    p += 46 + largoNombre + largoExtra + largoComentario;
    if (nombre.endsWith("/")) continue;               // carpeta

    // La cabecera local repite los tamaños de nombre y extra, y pueden no
    // coincidir con los del directorio: hay que leerlos de ahí.
    const nombreLocal = dv.getUint16(offsetLocal + 26, true);
    const extraLocal = dv.getUint16(offsetLocal + 28, true);
    indice.set(nombre, {
      metodo,
      inicio: offsetLocal + 30 + nombreLocal + extraLocal,
      largo: comprimido,
    });
  }

  const cache = new Map();
  const LIMITE_CACHE = 64 * 1024;     // solo se guardan las entradas pequeñas
  return {
    nombres: () => [...indice.keys()],
    has: (ruta) => indice.has(ruta),
    async leer(ruta) {
      if (cache.has(ruta)) return cache.get(ruta);
      const e = indice.get(ruta);
      if (!e) return null;
      let bytes;
      try {
        bytes = await inflar(buf.subarray(e.inicio, e.inicio + e.largo), e.metodo);
      } catch {
        return null;                  // una entrada ilegible no tumba el libro
      }
      if (bytes.length <= LIMITE_CACHE) cache.set(ruta, bytes);
      return bytes;
    },
  };
}

/* El tamaño se lee de la cabecera del archivo, no decodificando la imagen:
   hace falta para reservar el hueco antes de cargarla, y decodificar las 241
   imágenes de un libro al importar sería justo lo que se quiere evitar. */
function tamanoImagen(bytes) {
  if (!bytes || bytes.length < 24) return { w: 0, h: 0 };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PNG: el bloque IHDR trae ancho y alto en los primeros bytes.
  if (dv.getUint32(0) === 0x89504e47) return { w: dv.getUint32(16), h: dv.getUint32(20) };
  // JPEG: se recorren los marcadores hasta el SOF, que es quien los declara.
  if (dv.getUint16(0) === 0xFFD8) {
    let p = 2;
    while (p + 9 < bytes.length) {
      if (dv.getUint8(p) !== 0xFF) { p++; continue; }
      const marca = dv.getUint8(p + 1);
      const esSOF = marca >= 0xC0 && marca <= 0xCF &&
                    marca !== 0xC4 && marca !== 0xC8 && marca !== 0xCC;
      if (esSOF) return { h: dv.getUint16(p + 5), w: dv.getUint16(p + 7) };
      const largo = dv.getUint16(p + 2);
      if (largo < 2) break;
      p += 2 + largo;
    }
  }
  return { w: 0, h: 0 };
}

const resolverRuta = (base, rel) => new URL(rel, `http://e/${base}`).pathname.slice(1);
const leerTexto = async (zip, ruta) =>
  new TextDecoder("utf-8").decode(await zip.leer(ruta) || new Uint8Array());

async function sha1Hex(buffer) {
  const hash = await crypto.subtle.digest("SHA-1", buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const BLOQUES = "h1,h2,h3,h4,h5,h6,p,li,blockquote";

export async function extractFromEpub(arrayBuffer, fileName) {
  const id = (await sha1Hex(arrayBuffer)).slice(0, 12);
  const zip = await leerZip(new Blob([arrayBuffer]));
  const parser = new DOMParser();

  // container.xml dice dónde está el OPF, que es el índice del libro.
  const cont = parser.parseFromString(
    await leerTexto(zip, "META-INF/container.xml"), "application/xml");
  const rutaOpf = cont.querySelector("rootfile")?.getAttribute("full-path");
  if (!rutaOpf) throw new Error("Este EPUB no declara su contenido (¿está protegido con DRM?)");
  const baseOpf = rutaOpf.includes("/") ? rutaOpf.slice(0, rutaOpf.lastIndexOf("/") + 1) : "";

  const opf = parser.parseFromString(await leerTexto(zip, rutaOpf), "application/xml");
  const manifiesto = new Map();
  for (const it of opf.querySelectorAll("item")) {
    manifiesto.set(it.getAttribute("id"), {
      href: resolverRuta(baseOpf, it.getAttribute("href") || ""),
      tipo: it.getAttribute("media-type") || "",
    });
  }

  let orden = [...opf.querySelectorAll("itemref")]
    .map((r) => manifiesto.get(r.getAttribute("idref")))
    .filter((x) => x && /html|xml/.test(x.tipo))
    .map((x) => x.href);
  if (!orden.length) {
    // Respaldo si el spine no sirve: los HTML del manifiesto, por orden.
    orden = [...manifiesto.values()].filter((x) => /html/.test(x.tipo))
      .map((x) => x.href).sort();
  }
  if (!orden.length) throw new Error("No se encontró texto legible en este EPUB");

  const segments = [];
  const imagenes = [];
  const chapters = [];
  let imagenesDescartadas = 0;

  for (const ruta of orden) {
    const texto = await leerTexto(zip, ruta);
    if (!texto) continue;
    const doc = parser.parseFromString(texto, "text/html");
    doc.querySelectorAll("script,style,nav").forEach((n) => n.remove());
    for (const el of doc.body?.querySelectorAll(BLOQUES) || []) {
      // Las imágenes del bloque se anclan donde va el bloque.
      for (const img of el.querySelectorAll("img")) {
        const src = img.getAttribute("src");
        if (!src) continue;
        const rutaImg = resolverRuta(ruta, src);
        const { w, h } = tamanoImagen(await zip.leer(rutaImg));
        // Solo se descartan motas: los diagramas de estos libros suelen ser
        // anchos y bajos, y filtrar por forma se comería contenido.
        if (w < 60 || h < 60) { imagenesDescartadas++; continue; }
        imagenes.push({
          tras: segments.length - 1,
          ref: { ruta: rutaImg },
          w, h,
          alt: img.getAttribute("alt") || "",
        });
      }
      const limpio = limpiarRestos(cleanBlock(el.textContent || ""));
      if (limpio.length < MIN_SEGMENT_CHARS) continue;
      if (/^H[1-6]$/.test(el.tagName)) {
        chapters.push({ title: limpio.slice(0, 80), seg: segments.length });
        segments.push({ i: segments.length, text: limpio });
        continue;
      }
      for (const trozo of splitLong(limpio)) {
        if (trozo.length >= MIN_SEGMENT_CHARS) {
          segments.push({ i: segments.length, text: trozo });
        }
      }
    }
  }

  const meta = opf.querySelector("metadata") || opf;
  const titulo = [...meta.children].find((n) => n.localName === "title")?.textContent?.trim();
  const idioma = [...meta.children].find((n) => n.localName === "language")?.textContent?.trim();
  const muestra = segments.slice(0, 200).map((s) => s.text).join(" ");
  const dos = (idioma || "").slice(0, 2).toLowerCase();
  const docLang = dos === "en" || dos === "es" ? dos : detectLanguage(muestra);

  for (const seg of segments) {
    if (seg.text.length > 60) {
      const l = detectLanguage(seg.text);
      if (l !== docLang) seg.lang = l;
    }
  }

  return {
    id,
    title: titulo || fileName.replace(/\.epub$/i, ""),
    pages: orden.length,
    segments,
    chapters: chapters.length >= 2 ? chapters : [],
    lang: docLang,
    motor: MOTOR_EPUB,
    formato: "epub",
    imagenes,
    ...(imagenesDescartadas ? { imagenesDescartadas } : {}),
  };
}
