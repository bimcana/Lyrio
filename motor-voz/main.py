"""Lyrio voice engine — stateless TTS proxy.

The only job of this service: receive text -> return neural audio + word
timings from Microsoft Edge TTS. It stores nothing: no documents, no
library, no user data. Deployable on any free host (Hugging Face Spaces,
Render). Browsers cannot call Edge TTS directly (Origin check), so this
is the minimal intermediary.
"""
from __future__ import annotations

import base64
import re
from collections import OrderedDict

import edge_tts
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Nombre en español de cada país, para agrupar el catálogo en la app.
PAISES = {
    "AR": "Argentina", "BO": "Bolivia", "CL": "Chile", "CO": "Colombia", "CR": "Costa Rica",
    "CU": "Cuba", "DO": "Rep. Dominicana", "EC": "Ecuador", "ES": "España", "GQ": "Guinea Ecuatorial",
    "GT": "Guatemala", "HN": "Honduras", "MX": "México", "NI": "Nicaragua", "PA": "Panamá",
    "PE": "Perú", "PR": "Puerto Rico", "PY": "Paraguay", "SV": "El Salvador", "US": "EE.UU.",
    "UY": "Uruguay", "VE": "Venezuela",
    "AU": "Australia", "CA": "Canadá", "GB": "Reino Unido", "HK": "Hong Kong", "IE": "Irlanda",
    "IN": "India", "KE": "Kenia", "NG": "Nigeria", "NZ": "Nueva Zelanda", "PH": "Filipinas",
    "SG": "Singapur", "TZ": "Tanzania", "ZA": "Sudáfrica",
}

# El catálogo se descubre del servicio al arrancar: así aparecen todas las
# voces disponibles sin tener que mantener una lista a mano.
VOICES: list[dict] = []
VOICE_IDS: set[str] = set()

MAX_TEXT = 4000                                  # un párrafo completo cabe de sobra
_cache: OrderedDict[str, dict] = OrderedDict()   # tiny warm cache, RAM only
_CACHE_MAX = 120

app = FastAPI(title="Lyrio voice engine")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def cargar_catalogo() -> None:
    """Descubre todas las voces neuronales en español e inglés."""
    global VOICES, VOICE_IDS
    try:
        disponibles = await edge_tts.list_voices()
    except Exception:
        return                                   # sin catálogo, /tts sigue aceptando cualquier id
    catalogo = []
    for v in disponibles:
        locale = v.get("Locale", "")
        if not (locale.startswith("es-") or locale.startswith("en-")):
            continue
        idioma, pais = locale.split("-")[:2]
        catalogo.append({
            "id": v["ShortName"],
            "name": v["ShortName"].split("-")[-1].replace("Neural", ""),
            "region": PAISES.get(pais, pais),
            "gender": "F" if v.get("Gender") == "Female" else "M",
            "lang": idioma,
        })
    catalogo.sort(key=lambda x: (x["lang"], x["region"], x["name"]))
    VOICES = catalogo
    VOICE_IDS = {v["id"] for v in catalogo}


def _rate_string(speed: float) -> str:
    speed = max(0.5, min(2.0, speed))
    pct = round((speed - 1.0) * 100)
    return f"{'+' if pct >= 0 else ''}{pct}%"


def _align_words(text: str, events: list[dict]) -> list[dict]:
    lower = text.lower()
    words: list[dict] = []
    cursor = 0
    for ev in events:
        token = ev["text"].strip()
        if not token:
            continue
        pos = lower.find(token.lower(), cursor)
        if pos == -1:
            first = re.split(r"\s+", token)[0]
            pos = lower.find(first.lower(), cursor)
            if pos == -1:
                continue
            token = first
        start_ms = ev["offset"] / 10000.0
        words.append({
            "w": text[pos : pos + len(token)],
            "s": round(start_ms),
            "e": round(start_ms + ev["duration"] / 10000.0),
            "cs": pos,
            "ce": pos + len(token),
        })
        cursor = pos + len(token)
    return words


class TTSBody(BaseModel):
    text: str
    voice: str
    speed: float = 1.0


@app.get("/")
async def root():
    return {"ok": True, "service": "lyrio-voice"}


@app.get("/voices")
async def voices():
    return VOICES


@app.post("/tts")
async def tts(body: TTSBody):
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "Texto vacío")
    if len(text) > MAX_TEXT:
        raise HTTPException(400, "Texto demasiado largo")
    # Formato de voz válido; el catálogo solo filtra si ya se cargó.
    if not re.fullmatch(r"[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural", body.voice):
        raise HTTPException(400, "Voz desconocida")
    if VOICE_IDS and body.voice not in VOICE_IDS:
        raise HTTPException(400, "Voz desconocida")

    rate = _rate_string(body.speed)
    key = f"{body.voice}|{rate}|{text}"
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]

    communicate = edge_tts.Communicate(text, body.voice, rate=rate, boundary="WordBoundary")
    audio = bytearray()
    events: list[dict] = []
    try:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio.extend(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                events.append(chunk)
    except Exception as exc:
        raise HTTPException(502, f"El motor de voz falló: {exc}") from exc
    if not audio:
        raise HTTPException(502, "El motor de voz no devolvió audio")

    result = {
        "audio": base64.b64encode(bytes(audio)).decode("ascii"),
        "words": _align_words(text, events),
    }
    _cache[key] = result
    while len(_cache) > _CACHE_MAX:
        _cache.popitem(last=False)
    return result
