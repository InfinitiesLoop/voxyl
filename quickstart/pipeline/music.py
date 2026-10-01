"""A generated background-music bed for the quickstart video: original, so nothing to license.

    quickstart/.venv/Scripts/python.exe quickstart/pipeline/music.py [--style upbeat|calm] [--bpm N] [--seed 7] [--out FILE]

A synth made from numpy only: a warm chord pad, a soft bass, and a plucked arpeggio with a ping-pong
delay and a touch of reverb. Four chords (I - vi - IV - V) in a bright key,
two sections (the second adds the arpeggio's upper octave), about 80 seconds that loops without a seam.
It is meant to sit well under the voice: pass it to `make.py assemble --music`, which lowers it a further
20 dB and ducks it while someone is speaking.

I can't listen to it, only measure it, so treat it as a starting point: tell me what to change (tempo,
brightness, how busy the arpeggio is), or drop in a track you prefer (any audio file works with --music).
"""
import argparse
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 48000
ROOT = Path(__file__).resolve().parent.parent


def midi(n):
    return 440.0 * 2.0 ** ((np.asarray(n, dtype=np.float64) - 69.0) / 12.0)


def env_adsr(n, a, d, s, r, sr=SR):
    t = np.arange(n) / sr
    e = np.ones(n)
    ai, di = int(a * sr), int(d * sr)
    ri = int(r * sr)
    e[:ai] = np.linspace(0, 1, ai, endpoint=False)
    if di > 0 and ai + di < n:
        e[ai:ai + di] = np.linspace(1, s, di, endpoint=False)
        e[ai + di:] = s
    if ri > 0 and ri < n:
        e[-ri:] *= np.linspace(1, 0, ri)
    return e


def lowpass(x, cutoff, sr=SR):
    """One-pole low-pass (cheap and smooth)."""
    a = np.exp(-2.0 * np.pi * cutoff / sr)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc = (1 - a) * x[i] + a * acc
        y[i] = acc
    return y


def lowpass_fast(x, cutoff, sr=SR):
    """Vectorised via FFT (zero-phase brick-wall with a gentle slope)."""
    n = len(x)
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1.0 / sr)
    spec *= 1.0 / (1.0 + (f / cutoff) ** 4)
    return np.fft.irfft(spec, n)


def pad(freqs, dur, sr=SR):
    n = int(dur * sr)
    t = np.arange(n) / sr
    out = np.zeros(n)
    for f in freqs:
        for det in (-0.07, 0.0, 0.06):                       # three slightly detuned voices per note
            fr = f * 2.0 ** (det / 12.0)
            out += np.sin(2 * np.pi * fr * t) + 0.35 * np.sin(2 * np.pi * 2 * fr * t) + 0.12 * np.sin(2 * np.pi * 3 * fr * t)
    out *= env_adsr(n, 0.55, 0.4, 0.85, 0.9, sr) / (len(freqs) * 3.0)
    return out


def bass(f, dur, sr=SR):
    n = int(dur * sr)
    t = np.arange(n) / sr
    x = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t)
    return x * env_adsr(n, 0.015, 0.25, 0.55, 0.25, sr)


def pluck(f, dur, rng, sr=SR):
    """A soft marimba-ish pluck: a sine and a quick-decaying inharmonic overtone."""
    n = int(dur * sr)
    t = np.arange(n) / sr
    x = np.sin(2 * np.pi * f * t) * np.exp(-t * 5.5)
    x += 0.35 * np.sin(2 * np.pi * f * 3.97 * t) * np.exp(-t * 16.0)
    x += 0.12 * np.sin(2 * np.pi * f * 2.0 * t) * np.exp(-t * 8.0)
    attack = np.minimum(1.0, t / 0.009)
    return x * attack


def shaker(dur, rng, sr=SR):
    n = int(dur * sr)
    x = rng.standard_normal(n)
    x = x - lowpass_fast(x, 4500.0, sr)                      # keep only the top
    return x * np.exp(-np.arange(n) / sr * 40.0)


def add_at(buf, snd, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= buf.shape[1]:
        return
    j = min(i + len(snd), buf.shape[1])
    seg = snd[:j - i] * gain
    l = np.sqrt(0.5 * (1.0 - pan))
    r = np.sqrt(0.5 * (1.0 + pan))
    buf[0, i:j] += seg * l
    buf[1, i:j] += seg * r


def delay_pingpong(x, bpm, feedback=0.38, mix=0.32):
    """Dotted-eighth ping-pong echo on a stereo buffer."""
    d = int(SR * 60.0 / bpm * 0.75)
    out = x.copy()
    wet = np.zeros_like(x)
    tap_l = x[0].copy()
    tap_r = x[1].copy()
    for k in range(1, 7):
        g = feedback ** k
        src = tap_l if k % 2 else tap_r
        shift = d * k
        if shift >= x.shape[1]:
            break
        wet[1 if k % 2 else 0, shift:] += (x[0] if k % 2 else x[1])[:x.shape[1] - shift] * g
    return out + wet * mix / max(feedback, 0.01) * feedback


def reverb(x, rng, seconds=2.4, mix=0.22):
    n = int(SR * seconds)
    t = np.arange(n) / SR
    ir = rng.standard_normal((2, n)) * np.exp(-t * 2.2)
    ir[:, :int(0.02 * SR)] *= np.linspace(0, 1, int(0.02 * SR))
    ir = np.stack([lowpass_fast(ir[0], 4200.0), lowpass_fast(ir[1], 4200.0)])
    size = 1 << int(np.ceil(np.log2(x.shape[1] + n)))
    out = np.zeros_like(x)
    for c in range(2):
        conv = np.fft.irfft(np.fft.rfft(x[c], size) * np.fft.rfft(ir[c], size), size)[:x.shape[1]]
        out[c] = conv
    out *= np.max(np.abs(x)) / max(np.max(np.abs(out)), 1e-9)
    return x * (1.0 - mix) + out * mix


# C major, bright: I vi IV V as seventh / sixth chords. (root, [chord tones as midi notes])
PROG = [
    (48, [60, 64, 67, 71]),    # Cmaj7
    (45, [57, 60, 64, 67]),    # Am7
    (41, [57, 60, 65, 69]),    # Fmaj7 (A C F A)
    (43, [59, 62, 67, 69]),    # G6   (B D G A)
]
ARP = [0, 1, 2, 3, 2, 1, 2, 1]        # indices into the chord for the eighth-note pattern


def build(bpm=92.0, seed=7, sections=2):
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    bar = 4 * beat
    bars = len(PROG) * 4 * sections                         # each chord held for 4 bars... shortened below
    bars = len(PROG) * 2 * 2 * sections                     # two bars per chord, four chords, two passes per section
    total = bars * bar
    tail = 3.0
    buf = np.zeros((2, int((total + tail) * SR)))
    for b in range(bars):
        chord = PROG[(b // 2) % len(PROG)]
        t0 = b * bar
        section = b // (len(PROG) * 2 * 2)                  # 0 = first pass, 1 = second
        if b % 2 == 0:                                      # pad: one long swell per chord
            add_at(buf, pad([midi(n) for n in chord[1]], bar * 2.0 + 0.6, SR), t0, 0.55, 0.0)
        for k in range(4):                                  # bass on 1 and 3, a pickup on the "and" of 4
            if k in (0, 2):
                add_at(buf, bass(float(midi(chord[0])), beat * 1.6), t0 + k * beat, 0.55)
        if b % 2 == 1:
            add_at(buf, bass(float(midi(chord[0] + 7)), beat * 0.9), t0 + 3.5 * beat, 0.28)
        notes = chord[1] + [chord[1][0] + 12, chord[1][1] + 12]
        for i in range(8):                                  # eighth-note arpeggio, a touch of swing
            idx = ARP[i % len(ARP)]
            n = notes[idx] + (12 if (section == 1 and i % 4 == 3) else 0)
            at = t0 + i * beat * 0.5 + (0.03 * beat if i % 2 else 0.0)
            vel = 0.30 if i % 2 == 0 else 0.20
            vel *= 1.0 + 0.1 * rng.standard_normal()
            add_at(buf, pluck(float(midi(n + 12)), beat * 2.2, rng), at, vel, pan=-0.35 + 0.7 * ((i % 3) / 2.0))
    buf = delay_pingpong(buf, bpm)
    buf = reverb(buf, rng)
    buf = np.stack([lowpass_fast(buf[0], 7500.0), lowpass_fast(buf[1], 7500.0)])   # nothing brittle: it's a bed
    # make it loop: fold the tail back over the start
    loop_len = int(total * SR)
    head = buf[:, :loop_len].copy()
    tail_part = buf[:, loop_len:loop_len + int(tail * SR)]
    head[:, :tail_part.shape[1]] += tail_part
    head -= head.mean(axis=1, keepdims=True)
    peak = np.max(np.abs(head))
    head *= 0.85 / peak
    return head


# ---------------------------------------------------------------- upbeat
# I - V - vi - IV in C with added colour, one chord a bar: the bright "pop" loop. A soft four-on-the-floor kick,
# a quiet snap on 2 and 4, off-beat chord stabs, a syncopated bass and a sixteenth-note pluck arpeggio. Three
# energy levels across the loop (sparse -> groove -> full), all of it kept low and rounded off so it stays a bed.

UP_PROG = [
    (48, [60, 64, 67, 71]),    # Cmaj7
    (43, [59, 62, 67, 74]),    # G (add9)
    (45, [57, 60, 64, 67]),    # Am7
    (41, [57, 60, 65, 72]),    # F (add9)
]
UP_ARP = [0, 2, 1, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 3, 1, 2]


def kick(rng, sr=SR):
    n = int(0.22 * sr)
    t = np.arange(n) / sr
    f = 45.0 + 85.0 * np.exp(-t * 28.0)
    ph = 2 * np.pi * np.cumsum(f) / sr
    return np.sin(ph) * np.exp(-t * 14.0) * np.minimum(1.0, t / 0.004)


def snap(rng, sr=SR):
    n = int(0.12 * sr)
    t = np.arange(n) / sr
    x = rng.standard_normal(n)
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1.0 / sr)
    spec *= np.exp(-((f - 1800.0) / 1400.0) ** 2)               # band-limited, so it ticks rather than hisses
    x = np.fft.irfft(spec, n)
    return x / max(np.max(np.abs(x)), 1e-9) * np.exp(-t * 32.0) * np.minimum(1.0, t / 0.005)


def hat(rng, sr=SR):
    n = int(0.05 * sr)
    t = np.arange(n) / sr
    x = rng.standard_normal(n)
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1.0 / sr)
    spec *= np.exp(-((f - 7000.0) / 2200.0) ** 2)
    x = np.fft.irfft(spec, n)
    return x / max(np.max(np.abs(x)), 1e-9) * np.exp(-t * 70.0) * np.minimum(1.0, t / 0.004)


def stab(notes, dur, sr=SR):
    """A short electric-piano-ish chord hit."""
    n = int(dur * sr)
    t = np.arange(n) / sr
    out = np.zeros(n)
    for note in notes:
        f = float(midi(note))
        out += np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 9.0) + 0.15 * np.sin(2 * np.pi * 3 * f * t) * np.exp(-t * 14.0)
    return out / len(notes) * np.exp(-t * 7.0) * np.minimum(1.0, t / 0.006)


def build_upbeat(bpm=118.0, seed=7, passes=10):
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    bar = 4 * beat
    bars = len(UP_PROG) * passes
    total = bars * bar
    tail = 2.5
    buf = np.zeros((2, int((total + tail) * SR)))
    for b in range(bars):
        chord = UP_PROG[b % len(UP_PROG)]
        t0 = b * bar
        level = 0 if b < len(UP_PROG) * 2 else (1 if b < len(UP_PROG) * 6 else 2)       # sparse -> groove -> full
        add_at(buf, pad([midi(n) for n in chord[1]], bar + 0.5, SR), t0, 0.45, 0.0)
        for k, (when, tone, ln, g) in enumerate([(0.0, 0, 0.9, 0.55), (1.5, 12, 0.45, 0.32), (2.0, 0, 0.9, 0.48), (3.5, 7, 0.45, 0.30)]):
            if level == 0 and k > 0:
                continue
            add_at(buf, bass(float(midi(chord[0] + tone)), beat * ln), t0 + when * beat, g)
        if level >= 1:
            for k in range(4):                                                              # soft kick on every beat
                add_at(buf, kick(rng), t0 + k * beat, 0.30 if level == 1 else 0.36)
            for k in (1, 3):                                                                # snap on 2 and 4
                add_at(buf, snap(rng), t0 + k * beat, 0.10 if level == 1 else 0.14, pan=0.1)
            for i in range(8):                                                              # off-beat hats
                if i % 2 == 1:
                    add_at(buf, hat(rng), t0 + i * beat * 0.5, 0.045 if level == 1 else 0.06, pan=-0.2)
            for when in (1.5, 3.5):                                                         # off-beat chord stabs
                add_at(buf, stab(chord[1], beat * 0.9), t0 + when * beat, 0.20, pan=-0.15)
        notes = chord[1] + [chord[1][0] + 12, chord[1][2] + 12]
        steps = 16
        for i in range(steps):
            if level == 0 and i % 2:
                continue
            idx = UP_ARP[i % len(UP_ARP)]
            n = notes[idx % len(notes)] + (12 if (level == 2 and i % 4 == 3) else 0)
            at = t0 + i * beat * 0.25
            vel = (0.22 if i % 4 == 0 else 0.13) * (1.0 + 0.08 * rng.standard_normal())
            add_at(buf, pluck(float(midi(n + 12)), beat * 1.6, rng), at, vel, pan=-0.4 + 0.8 * ((i % 5) / 4.0))
    buf = delay_pingpong(buf, bpm, feedback=0.3, mix=0.26)
    buf = reverb(buf, rng, seconds=1.8, mix=0.16)
    buf = np.stack([lowpass_fast(buf[0], 9000.0), lowpass_fast(buf[1], 9000.0)])
    loop_len = int(total * SR)
    head = buf[:, :loop_len].copy()
    tail_part = buf[:, loop_len:loop_len + int(tail * SR)]
    head[:, :tail_part.shape[1]] += tail_part
    head -= head.mean(axis=1, keepdims=True)
    head *= 0.85 / np.max(np.abs(head))
    return head


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--style", choices=["upbeat", "calm"], default="upbeat")
    ap.add_argument("--bpm", type=float, default=0.0, help="default: 118 upbeat, 92 calm")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default=str(ROOT / "assets" / "music" / "bed.wav"))
    a = ap.parse_args()
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if a.style == "upbeat":
        audio = build_upbeat(a.bpm or 118.0, a.seed)
    else:
        audio = build(a.bpm or 92.0, a.seed)
    sf.write(str(out), audio.T.astype(np.float32), SR)
    dur = audio.shape[1] / SR
    rms = float(np.sqrt(np.mean(audio ** 2)))
    print(f"wrote {out}: {dur:.1f}s, rms {20 * np.log10(rms):.1f} dBFS, peak {20 * np.log10(np.max(np.abs(audio))):.1f} dBFS")


if __name__ == "__main__":
    main()
