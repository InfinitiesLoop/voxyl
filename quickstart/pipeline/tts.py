"""Text-to-speech for the quickstart video.

Two engines, same interface:
  kokoro  local neural voice (kokoro-onnx); model files live in quickstart/.cache (downloaded once,
          gitignored). Free and offline: the default, good for drafts.
  openai  OpenAI's speech API (model gpt-4o-mini-tts by default, which takes spoken-style instructions
          such as "playful, confident"). Needs OPENAI_API_KEY in the environment; a few cents per
          full render, and make.py only re-synthesises lines whose text changed.
"""
import io
import json
import os
import urllib.request
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
SAMPLE_RATE = 24000

_engine = None


def engine():
    global _engine
    if _engine is None:
        from kokoro_onnx import Kokoro
        _engine = Kokoro(str(CACHE / "kokoro-v1.0.onnx"), str(CACHE / "voices-v1.0.bin"))
    return _engine


def voices():
    return sorted(engine().get_voices())


def synth(text: str, voice: str = "af_heart", speed: float = 1.0, lang: str = "en-us"):
    """Returns (float32 samples, sample_rate)."""
    samples, rate = engine().create(text, voice=voice, speed=speed, lang=lang)
    return samples, rate


DEFAULT_VOICE = {"kokoro": "af_heart", "openai": "marin"}
DEFAULT_INSTRUCTIONS = ("A playful, confident guide giving a quick tour of a creative tool: warm, upbeat, "
                        "a little cheeky, clear diction, natural pacing, never salesy.")


def _openai_samples(text: str, voice: str, instructions: str):
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise SystemExit("OPENAI_API_KEY isn't set (needed for --engine openai)")
    body = {"model": os.environ.get("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"), "voice": voice, "input": text,
            "response_format": "wav"}
    if instructions:
        body["instructions"] = instructions
    req = urllib.request.Request("https://api.openai.com/v1/audio/speech", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        data, rate = sf.read(io.BytesIO(resp.read()), dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    return data, rate


def synth_to_wav(text: str, path: Path, voice: str = "af_heart", speed: float = 1.0,
                 pad_end: float = 0.18, engine: str = "kokoro", instructions: str = "") -> float:
    """Write a mono WAV (a little silence on the end so lines don't run together) and
    return its duration in seconds."""
    if engine == "openai":
        samples, rate = _openai_samples(text, voice, instructions or DEFAULT_INSTRUCTIONS)
    else:
        samples, rate = synth(text, voice, speed)
    samples = np.concatenate([samples, np.zeros(int(rate * pad_end), dtype=samples.dtype)])
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), samples, rate)
    return len(samples) / rate
