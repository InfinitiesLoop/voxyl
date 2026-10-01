"""Local neural text-to-speech for the quickstart video (Kokoro, via kokoro-onnx).

Model files live in quickstart/.cache (downloaded once, gitignored). Everything here is
offline after that.
"""
import os
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


def synth_to_wav(text: str, path: Path, voice: str = "af_heart", speed: float = 1.0,
                 pad_end: float = 0.18) -> float:
    """Write a mono WAV (a little silence on the end so lines don't run together) and
    return its duration in seconds."""
    samples, rate = synth(text, voice, speed)
    samples = np.concatenate([samples, np.zeros(int(rate * pad_end), dtype=samples.dtype)])
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), samples, rate)
    return len(samples) / rate
