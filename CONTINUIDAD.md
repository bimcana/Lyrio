# Lyrio — documento de continuidad

Guía para retomar el proyecto en otra sesión. Recoge **qué es**, **cómo está montado**,
**qué se probó y descartó** (para no repetir callejones sin salida) y **qué no se debe romper**.

Última actualización: 2026-08-13 · versión publicada `?v=17`

---

## 1. Qué es

App web que lee PDFs en voz alta con voces neuronales de Microsoft, resaltando
palabra por palabra al estilo de las letras de Musixmatch. Funciona en iPhone, iPad
y PC desde cualquier red, sin depender de ninguna computadora encendida.

- **App:** https://bimcana.github.io/Lyrio/
- **Repositorio:** https://github.com/bimcana/Lyrio
- **Motor de voz:** https://lyrio-voz.onrender.com

Idiomas: español (45 voces, 22 países) e inglés (47 voces, 14 países).

---

## 2. Arquitectura

Dos piezas independientes, ambas gratuitas:

**La app** es estática y vive en GitHub Pages. Todo ocurre en el dispositivo: el PDF
se procesa en el navegador con pdf.js, y la biblioteca, el progreso, los subrayados y
los ajustes se guardan en IndexedDB y localStorage. **Ningún documento sale del
dispositivo.**

**El motor de voz** (`motor-voz/`) es un microservicio FastAPI + `edge-tts` desplegado
en Render. Recibe texto y devuelve MP3 más los tiempos exactos de cada palabra. No
guarda nada. Existe solo porque el navegador no puede llamar directamente al servicio
de voces de Microsoft (rechaza la cabecera `Origin` que los navegadores imponen).

Lo único que viaja fuera del dispositivo es el texto del párrafo que se está leyendo
(a Microsoft, vía el motor) y la oración concreta que se pida traducir (a Google).

### Mapa de archivos

| Ruta | Qué es |
|---|---|
| `webapp/` | **La app.** Es lo que se publica. |
| `webapp/index.html` | Estructura: inicio, lector, barra de control, hojas de ajustes. |
| `webapp/app.js` | Motor de la app: reproducción, karaoke, subrayados, traducción, exportación. |
| `webapp/extract.js` | PDF → párrafos. Toda la inteligencia de extracción vive aquí. |
| `webapp/sentences.js` | División de párrafos en oraciones. |
| `webapp/storage.js` | IndexedDB (documentos, subrayados, traducciones) y ajustes. |
| `webapp/styles.css` | Temas y diseño. |
| `webapp/pdfjs/` | pdf.js 4.10.38 + `cmaps/` + `standard_fonts/` (necesarios, ver §5). |
| `deploy/Lyrio/` | Copia de trabajo del repositorio; se usa al publicar. |
| `deploy/Lyrio/motor-voz/` | El microservicio de voz. **Vive solo aquí**, porque Render lo despliega desde el repositorio público. No moverlo ni borrarlo. |

---

## 3. Cómo publicar cambios

1. Editar dentro de `webapp/`.
2. **Subir el número de `?v=`** en `index.html` (dos sitios: `styles.css` y `app.js`)
   y en los tres `import` de `app.js`. Si no se sube, los dispositivos mezclan el HTML
   nuevo con los scripts viejos en caché y **la app se rompe al arrancar**.
3. Doble clic en `actualizar-web.bat` (copia a `deploy/Lyrio`, hace commit y empuja
   a `main` y `gh-pages`).
4. GitHub Pages tarda entre 15 s y 3 min. Comprobar con:
   `curl -s "https://bimcana.github.io/Lyrio/index.html?cb=1" | findstr "app.js?v="`

**El motor es aparte.** Render no está conectado a GitHub, así que tras tocar
`motor-voz/` hay que pulsar **Manual Deploy** en el panel de Render.

---

## 4. Vías cerradas (no volver a intentarlas)

Cada una costó tiempo; están comprobadas empíricamente.

| Vía | Resultado |
|---|---|
| **Navegador → Microsoft directo** | ❌ Rechaza la conexión: exige `Origin: chrome-extension://…`, cabecera que los navegadores prohíben fijar. Por eso hace falta el motor. |
| **Cloudflare Workers** | ❌ Microsoft acepta la conexión pero no envía audio (5 de 5 intentos). Es bloqueo por IP: el mismo código funcionaba en local con el runtime de Cloudflare. El worker se eliminó; está en el historial de git si alguna vez cambia la situación. |
| **Hugging Face Spaces** | ❌ Docker pasó a plan de pago; solo los Spaces estáticos siguen gratis. |
| **Voces Gemini (TTS)** | ❌ Cuota **diaria** minúscula: se agota en unos 4 párrafos. Medido: `GenerateRequestsPerDayPerProjectPerModel`. Sirve para traducir, no para leer. |
| **Azure Speech** | ⚠️ Funcionaría (500 000 caracteres/mes gratis) pero pide tarjeta para verificar identidad. Descartada por preferencia del autor. |
| **iPad como servidor** | ❌ iPadOS suspende las apps en segundo plano; no puede escuchar en un puerto. |
| **Google Apps Script** | ❌ No soporta WebSockets, que es lo que exige el protocolo de voz. |
| **GitHub Actions** | ✅ Sí puede sintetizar (probado), pero se descartó por innecesario al funcionar Render. |
| **Render** | ✅ **Funciona.** Plan gratuito sin tarjeta. Único costo: se duerme sin uso y la primera lectura tarda ~40 s en despertarlo. |

---

## 5. Trampas de la extracción de PDF (`extract.js`)

Aquí es donde más se ha sufrido. Cada regla nació de un fallo real:

**pdf.js normaliza el texto para búsquedas, no para leer.** Se le pide
`getTextContent({ disableNormalization: true })`. Con la normalización activada
descompone los acentos y desarma ligaduras perdiendo letras.

**Acentos descompuestos.** Algunos PDFs entregan la letra base y el acento por
separado, usando además la **i sin punto** (`U+0131`, letra turca) como base de la í.
El motor no la reconoce como vocal y **la salta al leer**. `normalizeAccents()` la
convierte a `i`, hace lo propio con la `ȷ`, y aplica `NFC`.

**Ligaduras tipográficas.** `ﬁ ﬂ ﬀ ﬃ ﬄ` llegan como un solo signo y se pierden letras
(el síntoma es una `f` que desaparece). El mapa `LIGADURAS` las devuelve a letras
sueltas.

**Datos auxiliares de pdf.js.** `cMapUrl` y `standardFontDataUrl` deben estar
configurados y sus carpetas presentes en `webapp/pdfjs/`. Sin ellos, pdf.js no sabe
traducir glifos de fuentes estándar y **deja letras vacías**.

**Frases partidas por salto de página.** Si un bloque queda abierto (sin puntuación
final) y el siguiente empieza en minúscula con tipografía del mismo tamaño, se unen.
Sin esto la voz hace una pausa que rompe el sentido.

**Encabezados y pies corridos.** Texto corto pegado al 8 % superior o inferior de la
página se descarta. Además de leerse en voz alta, se interponían entre las dos mitades
de una frase partida e impedían unirlas.

**Capítulos.** Primero el índice interno del PDF (`getOutline`); si no lo hay,
heurística tipográfica (tamaño respecto al cuerpo, negrita, palabras como «Capítulo»,
mayúsculas). Se exige un mínimo de dos para darlo por bueno.

> ⚠️ Los documentos ya guardados en IndexedDB **conservan el texto viejo**. Tras
> mejorar la extracción hay que volver a arrastrar el PDF; el progreso de lectura se
> conserva.

---

## 6. Detalles del lector que conviene no romper

**Unidad de lectura: la oración.** Un toque en cualquier oración rebobina a ella; las
flechas saltan de párrafo. El audio se pide **por párrafo completo** (mejor para la
pantalla bloqueada) y el salto a una oración es una búsqueda dentro de ese audio, sin
red.

**Desplazamiento.** La línea que suena se ancla a **1/4 de pantalla** desde arriba. El
texto solo se mueve **al terminar una oración**, nunca en mitad, y en el modo `auto`
solo si la lectura pasó de 2/3 de la pantalla. Configurable en Ajustes.
El punto donde se decide es `markSentence()`, que es por donde pasa el avance durante
la lectura; `setCurrent()` lo hace al cambiar de párrafo.

**Números.** Con punto como separador de miles el motor deletrea cifra por cifra.
`prepararTextoVoz()` envía el número sin separadores conservando el decimal, y
**devuelve un mapa de posiciones**: `reubicarPalabras()` traduce los tiempos de vuelta
al texto original, así la pantalla no cambia y el resaltado sigue alineado. Respeta
decimales, fechas y versiones.

**Tiempo restante.** No asume una velocidad: `calibrarRitmo()` la aprende de cada
párrafo generado (el MP3 es de tasa constante, así que `bytes*8/48000` da la duración
exacta).

**Solo movimiento vertical.** `touch-action: pan-y`, sin selección nativa de texto (el
subrayado usa su propio menú de pulsación larga) y sin zoom. Si se reactiva la
selección del sistema, en el móvil vuelve el arrastre lateral.

**Caché de versiones.** Ver §3. Es el fallo más fácil de provocar y el más confuso de
diagnosticar.

---

## 7. Límites conocidos

- **PDFs escaneados**: sin texto seleccionable no hay nada que leer (haría falta OCR).
- **Primera lectura del día**: ~40 s mientras Render despierta.
- **Sin conexión**: la app abre y muestra la biblioteca, pero las voces necesitan red.
  Quedan como respaldo las voces del propio dispositivo.
- **Exportar MP3**: ~1,5 s por párrafo. Un libro largo puede tardar veinte minutos y
  ocupar unos 20 MB por hora de audio.
- **La biblioteca no se sincroniza** entre dispositivos: cada uno guarda la suya.

---

## 8. Ideas pendientes

OCR para escaneados · EPUB y DOCX · capítulos incrustados en el MP3 exportado ·
vocabulario guardado al tocar una palabra · resúmenes o preguntas de comprensión ·
sincronizar la biblioteca entre dispositivos.

---

## 9. Cómo probar cambios

Hay un servidor local definido en `.claude/launch.json` (`lyrio-web`, puerto 8090).
Los PDFs de prueba se generan con los scripts del historial de la sesión y cubren:
saltos de página con encabezados corridos, capítulos por índice y por heurística,
ligaduras tipográficas y párrafos largos para el desplazamiento.

La forma de verificar que ha funcionado algo **no es mirar la interfaz**, sino medir:
posiciones con `getBoundingClientRect`, texto extraído carácter a carácter, audio
decodificado de verdad. Varios fallos de este proyecto parecían resueltos a simple
vista y no lo estaban.
