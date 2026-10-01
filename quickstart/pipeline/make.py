"""Quickstart video pipeline.

    quickstart/.venv/Scripts/python.exe quickstart/pipeline/make.py <command> <chapter> [options]

Commands
    narrate   synthesise the voice-over for chapters/<chapter>.narration.txt (cached per line)
    render    play the chapter in the real app under Godot's Movie Maker -> out/<chapter>/raw.avi
              + timeline.json (what was said, and when)
    encode    trim, mix the narration in and write <chapter>.mp4 + .srt + .vtt
    stills    pull PNG frames out of raw.avi for a look:  stills <chapter> --at 4,12.5,30
    all       narrate + render + encode

Everything lands in quickstart/out/<chapter>/ (gitignored). See quickstart/README.md.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent          # quickstart/
PROJECT = ROOT.parent                                  # the Godot project
CHAPTERS = ROOT / "chapters"
OVERRIDE = PROJECT / "override.cfg"


# --- tools -------------------------------------------------------------------------

def keep_display_awake():
    """Windows: wake the display and stop it sleeping while this process runs. With the display
    asleep (an untouched PC overnight) the GPU's presentation is throttled and Movie Maker renders
    about 4x slower (155 ms a frame instead of 40). The flag lasts as long as this thread does."""
    if os.name != "nt":
        return
    try:
        import ctypes
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000002 | 0x00000001)
        ctypes.windll.user32.mouse_event(0x0001, 1, 0, 0, 0)     # a one-pixel nudge wakes a sleeping display
        ctypes.windll.user32.mouse_event(0x0001, -1, 0, 0, 0)
    except Exception:
        pass


def find_godot() -> str:
    for cand in (os.environ.get("GODOT"), r"C:\godot.exe", "/Applications/Godot.app/Contents/MacOS/Godot"):
        if cand and Path(cand).exists():
            return cand
    found = shutil.which("godot")
    if found:
        return found
    sys.exit("Can't find Godot: set the GODOT env var")


def find_ffmpeg(tool="ffmpeg") -> str:
    found = shutil.which(tool)
    if found:
        return found
    local = os.environ.get("LOCALAPPDATA")
    if local:
        for p in Path(local, "Microsoft", "WinGet", "Packages").glob(f"Gyan.FFmpeg*/**/bin/{tool}.exe"):
            return str(p)
    sys.exit(f"Can't find {tool}: install it (winget install Gyan.FFmpeg)")


def run(cmd, **kw):
    print("  $", " ".join(str(c) for c in cmd)[:240])
    return subprocess.run([str(c) for c in cmd], check=True, **kw)


# --- narration ---------------------------------------------------------------------

def parse_narration(chapter: str) -> dict:
    """id -> text, in file order. Format: '[id] text', continued until a blank line."""
    path = CHAPTERS / f"{chapter}.narration.txt"
    lines, cur_id, buf = {}, None, []

    def flush():
        if cur_id and buf:
            lines[cur_id] = " ".join(buf)

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("#"):
            continue
        m = re.match(r"^\[(\w+)(?:\s[^\]]*)?\]\s*(.*)$", line)
        if m:
            flush()
            cur_id, buf = m.group(1), ([m.group(2)] if m.group(2) else [])
        elif not line:
            flush()
            cur_id, buf = None, []
        elif cur_id:
            buf.append(line)
    flush()
    return lines


def load_lexicon() -> list:
    pairs = []
    path = CHAPTERS / "lexicon.txt"
    if path.exists():
        for raw in path.read_text(encoding="utf-8").splitlines():
            if "=" in raw and not raw.strip().startswith("#"):
                a, b = raw.split("=", 1)
                pairs.append((re.compile(r"\b%s\b" % re.escape(a.strip()), re.I), b.strip()))
    return pairs


def spoken(text: str, lexicon: list) -> str:
    """What the voice should say. `{word|spoken}` in a line is a one-off respelling (the captions
    keep `word`); lexicon.txt applies everywhere; `*word*` marks emphasis (left for tts.py)."""
    text = re.sub(r"\{([^|}]*)\|([^}]*)\}", r"\2", text)
    for pat, repl in lexicon:
        text = pat.sub(repl, text)
    return text


def cmd_narrate(chapter: str, voice: str, speed: float, engine: str = "kokoro", instructions: str = ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import tts

    out = ROOT / "out" / chapter
    wav_dir = out / "narration"
    wav_dir.mkdir(parents=True, exist_ok=True)
    meta_path = out / "narration.json"
    old = json.loads(meta_path.read_text()) if meta_path.exists() else {"lines": {}}
    lexicon = load_lexicon()
    voice = voice or tts.DEFAULT_VOICE[engine]
    result = {"engine": engine, "voice": voice, "speed": speed, "lines": {}}
    for lid, text in parse_narration(chapter).items():
        said = spoken(text, lexicon)
        key = hashlib.sha1(f"{tts.TTS_VERSION}|{engine}|{voice}|{speed}|{instructions}|{said}".encode()).hexdigest()[:12]
        prev = old.get("lines", {}).get(lid)
        wav = wav_dir / f"{lid}.wav"
        if prev and prev.get("key") == key and wav.exists():
            result["lines"][lid] = prev
            print(f"  = {lid} (cached, {prev['duration']:.1f}s)")
            continue
        dur = tts.synth_to_wav(said, wav, voice=voice, speed=speed, engine=engine, instructions=instructions)
        result["lines"][lid] = {"key": key, "duration": dur, "wav": str(wav)}
        print(f"  + {lid}: {dur:.1f}s")
    meta_path.write_text(json.dumps(result, indent=2))


# --- render ------------------------------------------------------------------------

def chapter_setup(chapter: str) -> dict:
    """A chapter script may open with  `# quickstart: library=empty|real  seed=demo`.
    library: where block libraries come from (real = this machine's, empty = a fresh install's).
    seed: copy quickstart/demo/ (projects, palettes, prefabs) into the sandbox."""
    opts = {"library": "real", "seed": ""}
    m = re.search(r"^#\s*quickstart:\s*(.*)$", (CHAPTERS / f"{chapter}.gd").read_text(encoding="utf-8"), re.M)
    if m:
        for kv in m.group(1).split():
            k, _, v = kv.partition("=")
            opts[k] = v
    return opts


def seed_sandbox(sandbox: Path, seed: str):
    if not seed:
        return
    demo = ROOT / "demo"
    for sub in ("projects", "palettes", "prefabs"):
        src = demo / sub
        if src.is_dir():
            shutil.copytree(src, sandbox / sub, dirs_exist_ok=True)
            print(f"  seeded {sub}: {len(list((sandbox / sub).iterdir()))} files")


def cmd_render(chapter: str, size: str, fps: int, burn: bool, timeout: int):
    out = ROOT / "out" / chapter
    out.mkdir(parents=True, exist_ok=True)
    keep_display_awake()
    sandbox = out / "sandbox"
    shutil.rmtree(sandbox, ignore_errors=True)
    sandbox.mkdir(parents=True)
    setup = chapter_setup(chapter)
    seed_sandbox(sandbox, setup["seed"])
    raw = out / "raw.avi"
    raw.unlink(missing_ok=True)
    (out / "timeline.json").unlink(missing_ok=True)
    w, h = size.split("x")
    # Movie Maker records at the project's window size, and only override.cfg can change that
    # without touching project.godot. Written for the run, removed afterwards.
    OVERRIDE.write_text(f"[display]\n\nwindow/size/viewport_width={w}\nwindow/size/viewport_height={h}\nwindow/size/mode=0\n")
    log = out / "render.log"
    cmd = [find_godot(), "--path", PROJECT, "--write-movie", raw, "--fixed-fps", fps,
           "-s", "res://quickstart/director/Run.gd", "--",
           f"--chapter={chapter}", f"--out={out}", f"--sandbox={sandbox}"]
    if setup["library"] == "empty":
        cmd.append(f"--library={sandbox / 'library'}")
    if not burn:
        cmd.append("--no-captions")
    print("  $", " ".join(str(c) for c in cmd)[:300])
    started = time.time()
    try:
        with open(log, "w", encoding="utf-8") as lf:
            proc = subprocess.Popen([str(c) for c in cmd], cwd=PROJECT, stdout=lf, stderr=subprocess.STDOUT)
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                sys.exit(f"render timed out after {timeout}s (see {log})")
    finally:
        OVERRIDE.unlink(missing_ok=True)
    text = log.read_text(encoding="utf-8", errors="replace")
    errors = [l for l in text.splitlines() if l.startswith(("SCRIPT ERROR", "ERROR:")) and "res://.logs" not in l and "log file" not in l]
    print(f"  rendered in {time.time() - started:.0f}s; {len(errors)} error line(s)")
    for l in errors[:12]:
        print("   ", l)
    if not (out / "timeline.json").exists():
        sys.exit(f"no timeline.json — the chapter didn't finish (see {log})")


def cmd_design(chapter: str, timeout: int):
    """Run a chapter script live (no recording) in a fresh sandbox, for building and looking:
    anything it captures lands in out/<chapter>/sandbox/captures/. Used to develop builds like the
    watchtower before they're filmed."""
    out = ROOT / "out" / chapter
    sandbox = out / "sandbox"
    shutil.rmtree(sandbox, ignore_errors=True)
    sandbox.mkdir(parents=True)
    out.mkdir(parents=True, exist_ok=True)
    setup = chapter_setup(chapter)
    seed_sandbox(sandbox, setup["seed"])
    cmd = [find_godot(), "--path", PROJECT, "-s", "res://quickstart/director/Run.gd", "--",
           f"--chapter={chapter}", f"--out={out}", f"--sandbox={sandbox}", "--no-captions", "--keep-mouse"]
    if setup["library"] == "empty":
        cmd.append(f"--library={sandbox / 'library'}")
    log = out / "design.log"
    with open(log, "w", encoding="utf-8") as lf:
        proc = subprocess.Popen([str(c) for c in cmd], cwd=PROJECT, stdout=lf, stderr=subprocess.STDOUT)
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            sys.exit(f"timed out after {timeout}s (see {log})")
    text = log.read_text(encoding="utf-8", errors="replace")
    for l in text.splitlines():
        if l.startswith(("SCRIPT ERROR", "ERROR:", "DESIGN")) and "res://.logs" not in l and "log file" not in l:
            print("  ", l)
    caps = sorted((sandbox / "captures").glob("*.png")) if (sandbox / "captures").is_dir() else []
    print(f"  {len(caps)} capture(s) in {sandbox / 'captures'}")
    for c in caps:
        print("   ", c.name)


# --- encode ------------------------------------------------------------------------

def srt_time(sec: float, vtt=False) -> str:
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{'.' if vtt else ','}{ms:03d}"


def write_captions(events, t0: float, end: float, base: Path):
    """SRT/VTT for upload sites, in a captions/ folder, never beside the mp4: players such as VLC
    load a same-named .srt automatically, and it would draw over the captions burned into the picture."""
    base = base.parent / "captions" / base.name
    base.parent.mkdir(parents=True, exist_ok=True)
    cues = [e for e in events if e["kind"] == "cue" and e["end"] > t0]
    srt, vtt = [], ["WEBVTT", ""]
    for i, c in enumerate(cues, 1):
        a, b = max(c["start"] - t0, 0.0), min(c["end"] - t0, end - t0)
        srt += [str(i), f"{srt_time(a)} --> {srt_time(b)}", c["text"], ""]
        vtt += [f"{srt_time(a, True)} --> {srt_time(b, True)}", c["text"], ""]
    base.with_suffix(".srt").write_text("\n".join(srt), encoding="utf-8")
    base.with_suffix(".vtt").write_text("\n".join(vtt), encoding="utf-8")


def cmd_encode(chapter: str, size: str, crf: int):
    out = ROOT / "out" / chapter
    tl = json.loads((out / "timeline.json").read_text())
    t0 = float(tl["marks"].get("start", 0.0))
    end = float(tl["duration"])
    says = [e for e in tl["events"] if e["kind"] == "say" and e.get("wav")]
    final = out / f"{chapter}.mp4"
    ffmpeg = find_ffmpeg()
    w, h = size.split("x")

    cmd = [ffmpeg, "-y", "-loglevel", "error", "-ss", f"{t0:.3f}", "-i", out / "raw.avi"]
    for e in says:
        cmd += ["-i", e["wav"]]
    parts = []
    for i, e in enumerate(says, 1):
        ms = max(int(round((e["start"] - t0) * 1000)), 0)
        parts.append(f"[{i}:a]adelay={ms}|{ms},aresample=48000[a{i}]")
    if says:
        mix = "".join(f"[a{i}]" for i in range(1, len(says) + 1))
        parts.append(f"{mix}amix=inputs={len(says)}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo,apad[aout]")
    parts.append(f"[0:v]scale={w}:{h}:flags=lanczos,format=yuv420p[vout]")
    script = out / "filter.txt"
    script.write_text(";\n".join(parts))
    cmd += ["-/filter_complex", script, "-map", "[vout]"]
    if says:
        cmd += ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-c:v", "libx264", "-preset", "slow", "-crf", crf, "-movflags", "+faststart",
            "-t", f"{end - t0:.3f}", final]
    run(cmd)
    write_captions(tl["events"], t0, end, out / chapter)
    print(f"  -> {final} ({final.stat().st_size / 1e6:.1f} MB)")


def cmd_stills(chapter: str, at: str):
    out = ROOT / "out" / chapter
    tl = json.loads((out / "timeline.json").read_text())
    t0 = float(tl["marks"].get("start", 0.0))
    (out / "stills").mkdir(exist_ok=True)
    ffmpeg = find_ffmpeg()
    for tstr in at.split(","):
        ts = float(tstr)
        dest = out / "stills" / f"t{ts:07.2f}.png"
        run([ffmpeg, "-y", "-loglevel", "error", "-ss", f"{t0 + ts:.3f}", "-i", out / "raw.avi", "-frames:v", "1", dest])
        print("  ->", dest)


# --- the whole film ----------------------------------------------------------------

def probe_duration(path: Path) -> float:
    out = subprocess.run([find_ffmpeg("ffprobe"), "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def parse_srt(path: Path):
    cues = []
    for block in path.read_text(encoding="utf-8").strip().split("\n\n"):
        lines = block.strip().splitlines()
        if len(lines) >= 3:
            a, b = [x.strip() for x in lines[1].split("-->")]
            cues.append((to_sec(a), to_sec(b), "\n".join(lines[2:])))
    return cues


def to_sec(ts: str) -> float:
    h, m, rest = ts.replace(",", ".").split(":")
    return int(h) * 3600 + int(m) * 60 + float(rest)


def clock(sec: float) -> str:
    sec = int(round(sec))
    return f"{sec // 60}:{sec % 60:02d}"


# How far the bed dips while someone speaks: threshold 0.06 / ratio 3 takes about 6 dB off (0.02 / 9, the first
# setting, took about 15 dB: the bed vanished under the voice).
DUCK_THRESHOLD = 0.06
DUCK_RATIO = 3.0


# Where the bed sits against the voice (which is normalised to about -16 LUFS). The bed is measured the way small
# speakers hear it (a 150 Hz high-pass: a bass-heavy bed measures loud on paper and is barely there on a laptop),
# then brought to this level before any ducking. -30 is about 13 dB under the voice.
MUSIC_LUFS = -30.0


def measure_lufs(path: Path, hpf: int = 150) -> float:
    """Integrated loudness (LUFS) of an audio file as heard through a high-pass at `hpf` Hz."""
    out = subprocess.run([find_ffmpeg(), "-nostats", "-i", str(path), "-af", f"highpass=f={hpf},ebur128=peak=true",
                          "-f", "null", "-"], capture_output=True, text=True)
    m = re.search(r"Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+) LUFS", out.stderr)
    if not m:
        sys.exit("couldn't measure the music's loudness")
    return float(m.group(1))


def add_music(video: Path, music: Path, db: float, final: Path, duck: bool, thr: float = DUCK_THRESHOLD, ratio: float = DUCK_RATIO):
    """Mix a music bed under the film's audio: faded in and out, and (optionally) ducked whenever
    the voice is speaking, so it breathes around the narration. The picture is copied untouched."""
    dur = probe_duration(video)
    voice = "[0:a]asplit=2[v1][v2];" if duck else ""
    bed = f"[1:a]volume={db}dB,afade=t=in:d=3,afade=t=out:st={max(dur - 5.0, 0):.2f}:d=5[m];"
    if duck:
        mix = (f"[m][v1]sidechaincompress=threshold={thr}:ratio={ratio}:attack=25:release=700:makeup=1[bed];"
               "[v2][bed]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[a]")
    else:
        mix = "[0:a][m]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[a]"
    run([find_ffmpeg(), "-y", "-loglevel", "error", "-i", video, "-stream_loop", "-1", "-i", music,
         "-filter_complex", voice + bed + mix, "-map", "0:v", "-map", "[a]", "-c:v", "copy",
         "-c:a", "aac", "-b:a", "192k", "-t", f"{dur:.3f}", "-movflags", "+faststart", final])


def cmd_assemble(name: str, only, music: str = "", music_db=None, duck: bool = True, music_lufs: float = MUSIC_LUFS,
                 duck_thr: float = DUCK_THRESHOLD, duck_ratio: float = DUCK_RATIO):
    """Join the encoded chapters (film.json order) into out/<name>/<name>.mp4 with merged
    captions and a YouTube chapter list."""
    film = json.loads((ROOT / "film.json").read_text())
    chapters = [c for c in film["chapters"] if not only or c["id"] in only]
    out = ROOT / "out" / name
    out.mkdir(parents=True, exist_ok=True)
    lines, cues, listing, at = [], [], [], 0.0
    for c in chapters:
        mp4 = ROOT / "out" / c["id"] / f"{c['id']}.mp4"
        if not mp4.exists():
            sys.exit(f"missing {mp4}: run `make.py all {c['id']}` first")
        dur = probe_duration(mp4)
        lines.append(f"file '{mp4.as_posix()}'")
        listing.append(f"{clock(at)} {c['title']}")
        srt = ROOT / "out" / c["id"] / "captions" / f"{c['id']}.srt"
        if srt.exists():
            cues += [(a + at, b + at, t) for a, b, t in parse_srt(srt)]
        at += dur
    (out / "concat.txt").write_text("\n".join(lines) + "\n")
    final = out / f"{name}.mp4"
    joined = out / "_joined.mp4" if music else final
    run([find_ffmpeg(), "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", out / "concat.txt",
         "-c", "copy", "-movflags", "+faststart", joined])
    if music:
        gain = music_db if music_db is not None else music_lufs - measure_lufs(Path(music))
        print(f"  music gain {gain:+.1f} dB" + ("" if music_db is not None else f" (to {music_lufs} LUFS, speaker-weighted)"))
        add_music(joined, Path(music), gain, final, duck, duck_thr, duck_ratio)
        joined.unlink(missing_ok=True)
    srt_out, vtt_out = [], ["WEBVTT", ""]
    for i, (a, b, t) in enumerate(cues, 1):
        srt_out += [str(i), f"{srt_time(a)} --> {srt_time(b)}", t, ""]
        vtt_out += [f"{srt_time(a, True)} --> {srt_time(b, True)}", t, ""]
    (out / "captions").mkdir(exist_ok=True)
    (out / "captions" / f"{name}.srt").write_text("\n".join(srt_out), encoding="utf-8")
    (out / "captions" / f"{name}.vtt").write_text("\n".join(vtt_out), encoding="utf-8")
    (out / "chapters.txt").write_text("\n".join(listing) + "\n", encoding="utf-8")
    print(f"  -> {final} ({final.stat().st_size / 1e6:.1f} MB, {clock(at)})")
    print("  chapters:")
    for entry in listing:
        print("   " + entry)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["narrate", "render", "encode", "stills", "all", "assemble", "film", "design"])
    ap.add_argument("chapter", help="a chapter id, or the film's name for assemble / film")
    ap.add_argument("--only", default="", help="film / assemble: comma-separated chapter ids")
    ap.add_argument("--music", default="", help="film / assemble: a music file to mix under the whole film")
    ap.add_argument("--music-db", type=float, default=None, help="music gain in dB (default: automatic, to --music-lufs)")
    ap.add_argument("--music-lufs", type=float, default=MUSIC_LUFS, help="music loudness before ducking, high-passed at 150 Hz (default -30)")
    ap.add_argument("--no-duck", action="store_true", help="don't lower the music while the voice speaks")
    ap.add_argument("--duck-threshold", type=float, default=DUCK_THRESHOLD, help="sidechain threshold (higher = less ducking)")
    ap.add_argument("--duck-ratio", type=float, default=DUCK_RATIO, help="sidechain ratio (lower = less ducking)")
    ap.add_argument("--engine", choices=["kokoro", "openai"], default="kokoro",
                    help="voice engine: kokoro (local, free) or openai (needs OPENAI_API_KEY)")
    ap.add_argument("--voice", default="", help="voice name (kokoro: af_heart; openai: marin, cedar, coral...)")
    ap.add_argument("--instructions", default="", help="openai: how the voice should sound (default: playful, confident)")
    ap.add_argument("--speed", type=float, default=1.05)
    ap.add_argument("--size", default="1920x1080", help="recording size (the app lays out in a 1600x900 canvas and scales)")
    ap.add_argument("--out-size", default=None, help="final video size (default: same as --size)")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--no-captions", action="store_true", help="don't burn captions in (SRT/VTT are written regardless)")
    ap.add_argument("--timeout", type=int, default=900, help="kill a render that runs longer than this many seconds")
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--at", default="1,5,10", help="stills: seconds after the start mark, comma separated")
    a = ap.parse_args()

    only = [x for x in a.only.split(",") if x]
    if a.command == "film":
        film = json.loads((ROOT / "film.json").read_text())
        for c in film["chapters"]:
            if only and c["id"] not in only:
                continue
            print(f"== {c['id']}")
            cmd_narrate(c["id"], a.voice, a.speed, a.engine, a.instructions)
            cmd_render(c["id"], a.size, a.fps, not a.no_captions, a.timeout)
            cmd_encode(c["id"], a.out_size or a.size, a.crf)
        cmd_assemble(a.chapter, only, a.music, a.music_db, not a.no_duck, duck_thr=a.duck_threshold, duck_ratio=a.duck_ratio, music_lufs=a.music_lufs)
        return
    if a.command == "design":
        cmd_design(a.chapter, a.timeout)
        return
    if a.command == "assemble":
        cmd_assemble(a.chapter, only, a.music, a.music_db, not a.no_duck, duck_thr=a.duck_threshold, duck_ratio=a.duck_ratio, music_lufs=a.music_lufs)
        return
    if a.command in ("narrate", "all"):
        cmd_narrate(a.chapter, a.voice, a.speed, a.engine, a.instructions)
    if a.command in ("render", "all"):
        cmd_render(a.chapter, a.size, a.fps, not a.no_captions, a.timeout)
    if a.command in ("encode", "all"):
        cmd_encode(a.chapter, a.out_size or a.size, a.crf)
    if a.command == "stills":
        cmd_stills(a.chapter, a.at)


if __name__ == "__main__":
    main()
