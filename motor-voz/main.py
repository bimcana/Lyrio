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

VOICES = [
    {"id": "es-MX-DaliaNeural", "name": "Dalia", "region": "México", "gender": "F", "lang": "es"},
    {"id": "es-MX-JorgeNeural", "name": "Jorge", "region": "México", "gender": "M", "lang": "es"},
    {"id": "es-US-PalomaNeural", "name": "Paloma", "region": "Latino EE.UU.", "gender": "F", "lang": "es"},
    {"id": "es-US-AlonsoNeural", "name": "Alonso", "region": "Latino EE.UU.", "gender": "M", "lang": "es"},
    {"id": "es-DO-RamonaNeural", "name": "Ramona", "region": "Rep. Dominicana", "gender": "F", "lang": "es"},
    {"id": "es-DO-EmilioNeural", "name": "Emilio", "region": "Rep. Dominicana", "gender": "M", "lang": "es"},
    {"id": "es-CO-SalomeNeural", "name": "Salomé", "region": "Colombia", "gender": "F", "lang": "es"},
    {"id": "es-CO-GonzaloNeural", "name": "Gonzalo", "region": "Colombia", "gender": "M", "lang": "es"},
    {"id": "es-AR-ElenaNeural", "name": "Elena", "region": "Argentina", "gender": "F", "lang": "es"},
    {"id": "es-AR-TomasNeural", "name": "Tomás", "region": "Argentina", "gender": "M", "lang": "es"},
    {"id": "en-US-AvaMultilingualNeural", "name": "Ava", "region": "US · Multilingual", "gender": "F", "lang": "en"},
    {"id": "en-US-AndrewMultilingualNeural", "name": "Andrew", "region": "US · Multilingual", "gender": "M", "lang": "en"},
    {"id": "en-US-EmmaMultilingualNeural", "name": "Emma", "region": "US · Multilingual", "gender": "F", "lang": "en"},
    {"id": "en-US-BrianMultilingualNeural", "name": "Brian", "region": "US · Multilingual", "gender": "M", "lang": "en"},
    {"id": "en-US-JennyNeural", "name": "Jenny", "region": "US", "gender": "F", "lang": "en"},
    {"id": "en-US-GuyNeural", "name": "Guy", "region": "US", "gender": "M", "lang": "en"},
    {"id": "en-US-AriaNeural", "name": "Aria", "region": "US", "gender": "F", "lang": "en"},
    {"id": "en-US-ChristopherNeural", "name": "Christopher", "region": "US", "gender": "M", "lang": "en"},
]
VOICE_IDS = {v["id"] for v in VOICES}

MAX_TEXT = 2000
_cache: OrderedDict[str, dict] = OrderedDict()   # tiny warm cache, RAM only
_CACHE_MAX = 120

app = FastAPI(title="Lyrio voice engine")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    if body.voice not in VOICE_IDS:
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
