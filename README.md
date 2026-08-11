# Lyrio — Tu lectura, en voz alta

Lector de PDF con voces naturales, resaltado palabra a palabra estilo karaoke, capítulos, modo inmersivo y traducción ES↔EN para practicar idiomas.

**App:** https://bimcana.github.io/Lyrio/

## Cómo funciona

- Abre la app y arrastra (o toca para elegir) un PDF.
- Todo se guarda **en tu dispositivo**: el PDF procesado, tu progreso de lectura y tus ajustes. Nada se sube a ningún servidor.
- Las voces usan el sintetizador integrado del dispositivo. En **Microsoft Edge** (PC) son las voces neuronales de máxima calidad; en iPhone/iPad son las voces de Apple (mejorables en Ajustes → Accesibilidad → Contenido leído → Voces).
- En iPhone/iPad: botón Compartir → **Añadir a pantalla de inicio** para instalarla como app.

## Motor de voz neuronal (opcional)

La carpeta [`motor-voz/`](motor-voz/) contiene un microservicio opcional (sin datos, sin registro de nada) que da voces neuronales de máxima calidad en **todos** los dispositivos. Se despliega gratis en Hugging Face Spaces (SDK: Docker) subiendo sus 3 archivos; luego pega la URL del Space en ⚙ Ajustes → Motor de voz.

## Traducción (opcional)

⚙ Ajustes → Traducción → pega tu API key gratuita de [Google AI Studio](https://aistudio.google.com/apikey).

## Créditos

Extracción de PDF con [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0, Mozilla). Interfaz y motor de lectura propios.
