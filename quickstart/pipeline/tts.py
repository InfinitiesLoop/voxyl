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


TTS_VERSION = 2   # bump when synthesis changes in a way that should invalidate cached lines

_VOWELS = set("aeiouɑɐɒæɔəɛɜɪʊʌɚɝᵻɨ")
_SECOND = set("ɪʊə")           # the second half of a diphthong (oʊ, aɪ, eɪ...)


def _emphasise_word(ph: str) -> str:
    """Make one word's phonemes stressed and a little longer. Kokoro reads stress marks as pitch and length,
    so this lands as emphasis *inside* the sentence's own intonation. (Synthesising the emphasised words as
    a separate clip and gluing it in leaves an audible break either side of it.)"""
    core = ph.rstrip(",.;:!?")
    tail = ph[len(core):]
    if not core:
        return ph
    core = core.replace("ˌ", "ˈ")
    if "ˈ" not in core:
        core = "ˈ" + core
    i = core.index("ˈ") + 1
    while i < len(core) and core[i] not in _VOWELS:
        i += 1
    if i < len(core):
        i += 1
        if i < len(core) and core[i] in _SECOND:
            i += 1
        if i >= len(core) or core[i] != "ː":
            core = core[:i] + "ː" + core[i:]
    return core + tail


def _split_emphasis(text: str):
    """'a *b c*, d' -> [('a', False), ('b c,', True), ('d', False)]  (punctuation after the closing
    asterisk joins the emphasised stretch, so it keeps its falling or rising ending)."""
    import re
    out, pos = [], 0
    for m in re.finditer(r"\*([^*]+)\*([,.;:!?]*)", text):
        before = text[pos:m.start()].strip()
        if before:
            out.append((before, False))
        out.append(((m.group(1) + m.group(2)).strip(), True))
        pos = m.end()
    rest = text[pos:].strip()
    if rest:
        out.append((rest, False))
    return out or [(text, False)]


def _kokoro_with_emphasis(text: str, voice: str, speed: float):
    if "*" not in text:
        return synth(text, voice, speed)
    from kokoro_onnx.tokenizer import Tokenizer
    tok = Tokenizer()
    pieces = []
    for chunk, emph in _split_emphasis(text):
        ph = tok.phonemize(chunk, "en-us")
        if emph:
            ph = " ".join(_emphasise_word(w) for w in ph.split(" "))
        pieces.append(ph)
    samples, rate = engine().create(" ".join(pieces), voice=voice, speed=speed, is_phonemes=True)
    return samples, rate


def synth_to_wav(text: str, path: Path, voice: str = "af_heart", speed: float = 1.0,
                 pad_end: float = 0.18, engine: str = "kokoro", instructions: str = "") -> float:
    """Write a mono WAV (a little silence on the end so lines don't run together) and
    return its duration in seconds. *word* marks emphasis."""
    if engine == "openai":
        import re
        shouted = re.sub(r"\*([^*]+)\*", lambda m: m.group(1).upper(), text)   # caps carry emphasis for this model
        samples, rate = _openai_samples(shouted, voice, instructions or DEFAULT_INSTRUCTIONS)
    else:
        samples, rate = _kokoro_with_emphasis(text, voice, speed)
    samples = np.concatenate([samples, np.zeros(int(rate * pad_end), dtype=samples.dtype)])
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), samples, rate)
    return len(samples) / rate
