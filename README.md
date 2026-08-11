# Lyrio — Tu lectura, en voz alta

Lector de PDF con voces naturales, resaltado palabra a palabra estilo karaoke, capítulos, modo inmersivo y traducción ES↔EN para practicar idiomas.

**App:** https://bimcana.github.io/Lyrio/

## Cómo funciona

- Abre la app y arrastra (o toca para elegir) un PDF.
- Todo se guarda **en tu dispositivo**: el PDF procesado, tu progreso de lectura y tus ajustes. Nada se sube a ningún servidor.
- Las voces usan el sintetizador integrado del dispositivo. En **Microsoft Edge** (PC) son las voces neuronales de máxima calidad; en iPhone/iPad son las voces de Apple (mejorables en Ajustes → Accesibilidad → Contenido leído → Voces).
- En iPhone/iPad: botón Compartir → **Añadir a pantalla de inicio** para instalarla como app.

## Motor de voz neuronal (opcional)

Da voces neuronales de máxima calidad (Dalia, Jorge, Ramona, Ava…) en **todos** los dispositivos, incluido el iPhone. No guarda ningún dato: recibe el texto de un párrafo y devuelve el audio.

- **[`motor-cloudflare/worker.js`](motor-cloudflare/worker.js)** — recomendado. Un solo archivo: se pega en un Worker de Cloudflare (plan gratuito, sin tarjeta, sin arranques lentos).
- **[`motor-voz/`](motor-voz/)** — la misma funcionalidad en Python + Docker, por si prefieres Koyeb o Render.

Luego pega la dirección resultante en ⚙ Ajustes → Motor de voz, en cada dispositivo.

## Traducción (opcional)

⚙ Ajustes → Traducción → pega tu API key gratuita de [Google AI Studio](https://aistudio.google.com/apikey).

## Créditos

Extracción de PDF con [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0, Mozilla). Interfaz y motor de lectura propios.
