"""Stitch the voice-test WAVs into one labelled MP3 ("One. <sample> Two. <sample> ...")."""
import subprocess, sys
from pathlib import Path
import numpy as np, soundfile as sf
import tts

voices = sys.argv[1:] or ["af_heart", "af_bella", "af_nicole", "af_sky", "am_puck", "am_michael", "bf_emma", "bm_george"]
out = tts.ROOT / "out" / "voice-test"
parts, names = [], ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"]
gap = np.zeros(int(tts.SAMPLE_RATE * 0.5), dtype=np.float32)
for i, v in enumerate(voices):
    label, _ = tts.synth(names[i] + ".", voice="af_nova", speed=1.0)
    data, rate = sf.read(str(out / f"{v}.wav"), dtype="float32")
    assert rate == tts.SAMPLE_RATE
    parts += [label, gap, data, gap, gap]
wav = out / "audition.wav"
sf.write(str(wav), np.concatenate(parts), tts.SAMPLE_RATE)
print(wav)
