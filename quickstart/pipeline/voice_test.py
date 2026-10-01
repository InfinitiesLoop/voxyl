"""Audition voices on a line from the actual script: python pipeline/voice_test.py [voice ...]"""
import sys
from pathlib import Path

import tts

LINE = ("Hey, welcome to voxyl! Here's the big idea: build first, decide later. "
        "Lay out a whole structure with semantic blocks, then swap the palette whenever "
        "you're ready. Let's dive in!")
DEFAULT = ["af_heart", "af_bella", "af_nicole", "af_sky", "am_puck", "am_michael", "bf_emma", "bm_george"]

out = tts.ROOT / "out" / "voice-test"
for v in (sys.argv[1:] or DEFAULT):
    d = tts.synth_to_wav(LINE, out / f"{v}.wav", voice=v, speed=1.05)
    print(f"{v}: {d:.1f}s")
