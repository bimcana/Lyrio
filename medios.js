/* Lyrio — las imágenes del libro, traídas solo cuando hacen falta.

   No se guardan aparte: se sacan del archivo original en el momento en que van
   a verse. Con libros de doscientas y pico imágenes, traerlas todas al abrir
   sería agotar la memoria del teléfono para enseñar tres. */
"use strict";

import * as pdfjsLib from "./pdfjs/pdf.min.mjs?v=26";
import { obtenerArchivo } from "./storage.js?v=26";

const MAX_CACHE = 30;
const cache = new Map();          // "idDoc|k" -> objectURL
let pdfAbierto = null;            // { id, pdf }
let zipAbierto = null;            // { id, entradas }

const BASE_PDFJS = new URL("./pdfjs/", import.meta.url).toString();

async function archivoDe(doc) {
  const blob = await obtenerArchivo(doc.id);
  if (!blob) throw new Error("El archivo original de este libro no está guardado");
  return blob;
}

async function abrirPdf(doc) {
  if (pdfAbierto?.id === doc.id) return pdfAbierto.pdf;
  if (pdfAbierto) { pdfAbierto.pdf.destroy().catch(() => {}); pdfAbierto = null; }
  const blob = await archivoDe(doc);
  const pdf = await pdfjsLib.getDocument({
    data: await blob.arrayBuffer(),
    cMapUrl: `${BASE_PDFJS}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${BASE_PDFJS}standard_fonts/`, useSystemFonts: false,
  }).promise;
  pdfAbierto = { id: doc.id, pdf };
  return pdf;
}

/* Se saca el objeto de imagen que el PDF lleva incrustado, en vez de dibujar
   la página entera y recortarla. Es más rápido, conserva la calidad original y
   —lo que importa— no depende del ciclo de animación del navegador: pdf.js
   trocea el dibujado de página y espera entre trozos, así que fuera de pantalla
   o en segundo plano ese camino puede no terminar nunca. */
async function sacarDelPdf(doc, ref) {
  const pdf = await abrirPdf(doc);
  const page = await pdf.getPage(ref.pagina);
  // Recorrer los operadores es lo que puebla el almacén de objetos de la página.
  await page.getOperatorList();
  const obj = await new Promise((listo, falla) => {
    try { page.objs.get(ref.clave, listo); } catch (e) { falla(e); }
  });
  if (!obj) throw new Error("La imagen no está en el documento");

  const ancho = obj.width || obj.bitmap?.width;
  const alto = obj.height || obj.bitmap?.height;
  if (!ancho || !alto) throw new Error("Imagen sin dimensiones");

  const lienzo = document.createElement("canvas");
  lienzo.width = ancho;
  lienzo.height = alto;
  const ctx = lienzo.getContext("2d");

  if (obj.bitmap) {
    ctx.drawImage(obj.bitmap, 0, 0);
  } else if (obj.data) {
    // pdf.js entrega los píxeles sueltos: con tres bytes por píxel hay que
    // intercalar el canal alfa que ImageData exige.
    const origen = obj.data;
    const destino = new Uint8ClampedArray(ancho * alto * 4);
    if (origen.length === ancho * alto * 4) {
      destino.set(origen);
    } else if (origen.length === ancho * alto * 3) {
      for (let i = 0, j = 0; i < origen.length; i += 3, j += 4) {
        destino[j] = origen[i]; destino[j + 1] = origen[i + 1];
        destino[j + 2] = origen[i + 2]; destino[j + 3] = 255;
      }
    } else if (origen.length === ancho * alto) {
      for (let i = 0, j = 0; i < origen.length; i++, j += 4) {
        destino[j] = destino[j + 1] = destino[j + 2] = origen[i];
        destino[j + 3] = 255;
      }
    } else {
      throw new Error("Formato de imagen no reconocido");
    }
    ctx.putImageData(new ImageData(destino, ancho, alto), 0, 0);
  } else {
    throw new Error("La imagen llegó vacía");
  }

  const blob = await new Promise((r) => lienzo.toBlob(r, "image/jpeg", 0.9));
  if (!blob) throw new Error("No se pudo componer la imagen");
  return URL.createObjectURL(blob);
}

/* En el EPUB la imagen ya es un archivo: basta con sacarla del ZIP. */
async function sacarDelEpub(doc, ref) {
  if (zipAbierto?.id !== doc.id) {
    const { leerZip } = await import("./epub.js?v=26");
    zipAbierto = { id: doc.id, zip: await leerZip(await archivoDe(doc)) };
  }
  const bytes = await zipAbierto.zip.leer(ref.ruta);
  if (!bytes) throw new Error("Imagen no encontrada dentro del libro");
  return URL.createObjectURL(new Blob([bytes]));
}

export async function resolverImagen(doc, k) {
  const clave = `${doc.id}|${k}`;
  if (cache.has(clave)) return cache.get(clave);
  const im = doc.imagenes?.[k];
  if (!im) throw new Error("Imagen inexistente");
  const url = doc.formato === "epub"
    ? await sacarDelEpub(doc, im.ref)
    : await sacarDelPdf(doc, im.ref);
  cache.set(clave, url);
  while (cache.size > MAX_CACHE) {
    const vieja = cache.keys().next().value;
    URL.revokeObjectURL(cache.get(vieja));
    cache.delete(vieja);
  }
  return url;
}

export function liberarMedios() {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
  if (pdfAbierto) { pdfAbierto.pdf.destroy().catch(() => {}); pdfAbierto = null; }
  zipAbierto = null;
}
