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

ROOT = Path(__file__).resolve().parent.parent          # quickstart/
PROJECT = ROOT.parent                                  # the Godot project
CHAPTERS = ROOT / "chapters"
OVERRIDE = PROJECT / "override.cfg"


# --- tools -------------------------------------------------------------------------

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
        m = re.match(r"^\[(\w+)\]\s*(.*)$", line)
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
    for pat, repl in lexicon:
        text = pat.sub(repl, text)
    return text


def cmd_narrate(chapter: str, voice: str, speed: float):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import tts

    out = ROOT / "out" / chapter
    wav_dir = out / "narration"
    wav_dir.mkdir(parents=True, exist_ok=True)
    meta_path = out / "narration.json"
    old = json.loads(meta_path.read_text()) if meta_path.exists() else {"lines": {}}
    lexicon = load_lexicon()
    result = {"voice": voice, "speed": speed, "lines": {}}
    for lid, text in parse_narration(chapter).items():
        said = spoken(text, lexicon)
        key = hashlib.sha1(f"{voice}|{speed}|{said}".encode()).hexdigest()[:12]
        prev = old.get("lines", {}).get(lid)
        wav = wav_dir / f"{lid}.wav"
        if prev and prev.get("key") == key and wav.exists():
            result["lines"][lid] = prev
            print(f"  = {lid} (cached, {prev['duration']:.1f}s)")
            continue
        dur = tts.synth_to_wav(said, wav, voice=voice, speed=speed)
        result["lines"][lid] = {"key": key, "duration": dur, "wav": str(wav)}
        print(f"  + {lid}: {dur:.1f}s")
    meta_path.write_text(json.dumps(result, indent=2))


# --- render ------------------------------------------------------------------------

def cmd_render(chapter: str, size: str, fps: int, burn: bool, timeout: int):
    out = ROOT / "out" / chapter
    out.mkdir(parents=True, exist_ok=True)
    sandbox = out / "sandbox"
    shutil.rmtree(sandbox, ignore_errors=True)
    sandbox.mkdir(parents=True)
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


# --- encode ------------------------------------------------------------------------

def srt_time(sec: float, vtt=False) -> str:
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{'.' if vtt else ','}{ms:03d}"


def write_captions(events, t0: float, end: float, base: Path):
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
        parts.append(f"{mix}amix=inputs={len(says)}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo[aout]")
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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["narrate", "render", "encode", "stills", "all"])
    ap.add_argument("chapter")
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--speed", type=float, default=1.05)
    ap.add_argument("--size", default="1920x1080", help="recording size (the app lays out in a 1600x900 canvas and scales)")
    ap.add_argument("--out-size", default=None, help="final video size (default: same as --size)")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--no-captions", action="store_true", help="don't burn captions in (SRT/VTT are written regardless)")
    ap.add_argument("--timeout", type=int, default=1800)
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--at", default="1,5,10", help="stills: seconds after the start mark, comma separated")
    a = ap.parse_args()

    if a.command in ("narrate", "all"):
        cmd_narrate(a.chapter, a.voice, a.speed)
    if a.command in ("render", "all"):
        cmd_render(a.chapter, a.size, a.fps, not a.no_captions, a.timeout)
    if a.command in ("encode", "all"):
        cmd_encode(a.chapter, a.out_size or a.size, a.crf)
    if a.command == "stills":
        cmd_stills(a.chapter, a.at)


if __name__ == "__main__":
    main()
