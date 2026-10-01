# Quickstart video

The walkthrough video is **rendered from the real app**, not screen-recorded: a small
director script plays each chapter against Voxyl itself (real mouse clicks, real key
presses, real tools), Godot's Movie Maker records every frame, and ffmpeg adds the
voice-over. Re-render after a UI change and the video is current again.

```
quickstart/
  film.json    the chapters, in order (and their titles for the YouTube chapter list)
  chapters/    <name>.gd             the storyboard: what the viewer sees, in order
               <name>.narration.txt  the voice-over (also the captions and the SRT)
               lexicon.txt           how the voice should pronounce things ("voxyl = vox-ill")
  director/    Run.gd (entry) · Director.gd (timing, input, API) · Fx.gd (overlays) · Ui.gd (finding controls)
  pipeline/    make.py (narrate / render / encode / assemble / design) · tts.py · music.py · voice_test.py
  design/      generators for builds the film shows (watchtower.py -> chapters/watchtower.build.json)
  demo/        the demo build (the Conduit Pillar: project, palette, prefabs). Semantics only; no textures
  assets/      images flashed in the video (the NEI Data Dumps screen, the watchtower reference photo) and music/
  out/ .venv/ .cache/    rendered output, local Python env, downloaded voice model (all gitignored)
```

Nothing here is loaded by the app itself: `-s` replaces the main scene, so a normal run or
export never sees it.

## One-time setup

```bash
python -m venv quickstart/.venv
quickstart/.venv/Scripts/python.exe -m pip install kokoro-onnx soundfile numpy      # local neural voice
curl -L -o quickstart/.cache/kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o quickstart/.cache/voices-v1.0.bin  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
winget install Gyan.FFmpeg
```

Godot is found via `GODOT`, `C:\godot.exe`, the macOS app path, or `godot` on PATH.

## What a render needs

- **A sleeping display slows a render about 4x** (Windows throttles presentation). `make.py` wakes it and keeps
  it awake for the run, so an untouched PC is fine.
- **Close Voxyl first.** The agent chapter turns the MCP server on (default port 47823) and a
  render takes over the GPU. Don't touch the mouse during fly-mode beats: the real cursor is captured.
- **Chapters that say `library=real`** (palettes, views, selection, prefabs, intro, outro) read the
  block libraries on *this machine*: the Conduit Pillar is shown through the real GTNH blocks
  (`gtnh.Ztones` etc.). The demo's project, palette and prefabs are committed, the libraries are not,
  so those chapters can only be re-rendered where a GTNH library has been imported. The finished
  video is the thing to commit.
- **The imports chapter** imports from this machine too: set `QUICKSTART_VANILLA_JAR` (a Minecraft
  1.21 jar) and `QUICKSTART_GTNH_DIR` (a GTNH instance's `.minecraft` with the NEI dumps) if yours live
  elsewhere. It starts from an empty library (`--library`), so the result is a fresh install's.

## Making a chapter, or the whole film

```bash
PY=quickstart/.venv/Scripts/python.exe
$PY quickstart/pipeline/make.py narrate selection                    # voice-over (cached per line)
$PY quickstart/pipeline/make.py render selection --size 1280x720     # fast draft: ~1 s per second of video
$PY quickstart/pipeline/make.py stills selection --at 4,12,20        # look at frames: out/selection/stills/
$PY quickstart/pipeline/make.py all selection                        # narrate + render at 1080p + encode
$PY quickstart/pipeline/make.py film quickstart --size 1920x1080     # every chapter, then assemble
$PY quickstart/pipeline/make.py assemble quickstart                  # just join the encoded chapters
```

Output: `out/<chapter>/<chapter>.mp4`, plus `timeline.json` (what was said and when).
`assemble` writes `out/<name>/<name>.mp4` and `chapters.txt` (paste it into a YouTube description).
Captions are burned into the picture. The `.srt` / `.vtt` (for uploading as caption tracks) are written to a
`captions/` folder and never beside the mp4: players like VLC load a same-named .srt automatically and would
draw it over the burned-in captions. Pass `--no-captions` to a render for a clean picture.
`render.log` has the engine output; the script prints any error lines.

**Music:** `make.py assemble quickstart --music quickstart/assets/music/bed.wav` mixes a bed under the whole
film (-20 dB, faded in and out, and ducked about 6 dB while the voice speaks; `--music-db`, `--no-duck`,
`--duck-threshold` / `--duck-ratio` for more or less ducking). `pipeline/music.py`
generates an original bed (no licensing): `--style chill` (chillstep, 150 bpm half-time, the default), `chill-slow` (the first, 140 bpm take), `upbeat` or
`calm`; any audio file works too.

**Voice:** `--engine kokoro` (local, the default) or `--engine openai` (needs `OPENAI_API_KEY`).
In a narration line, `*word*` adds emphasis, and `{caption|spoken}` respells one word for the voice only
(`where your blocks {live|liv}`). `chapters/lexicon.txt` respells words everywhere. To check a respelling
without listening, look at its phonemes: `kokoro_onnx.tokenizer.Tokenizer().phonemize(text, "en-us")`.

**Developing a build:** `make.py design <chapter>` runs a chapter live (no recording) in a fresh sandbox and
leaves any `capture` images in `out/<chapter>/sandbox/captures/` (see `chapters/design_tower.gd`).

## Writing a chapter

A chapter is a script with `run(d)`; `d` is the director. Name controls by what a viewer
would call them, not by node path. The first lines can say where its data comes from:
`# quickstart: library=empty|real  seed=demo` (a fresh library or this machine's; copy `demo/` into the sandbox).

```gdscript
d.say("tool")                                  # queue a narration line; visuals play over it
d.caption_at("right")                          # bottom | top | left | right: keep captions off a panel
await d.press(KEY_E)                           # a real key press (press(KEY_P, ["ctrl"]) for chords)
var btn = d.ctl({"text": "Select", "class": "Button"})    # also {"tooltip": ...}, {"tab": "Libraries"}, a Callable
await d.spotlight(btn); d.arrow(btn, "Select tool", "above")
await d.click(btn)                             # the pointer glides there and really clicks
await d.show_click(btn)                        # looks like a click, sends nothing (OS file pickers)
await d.pick_option(option_button, 1)          # open a dropdown and choose an entry
await d.zoom_to(panel); await d.zoom_out()
await d.wait_for("slice", "press Tab")        # wait until the voice reaches those words (estimated from the captions' timing)
await d.hint("LEFT-HANDED", "Delete opens the inventory too")   # a tag above the caption
await d.chat_user("..."); await d.chat_tool("selection_filter", "...", func(): ...)   # the staged agent
await d.terminal_open(); await d.terminal_type("claude mcp add ..."); await d.title_card("voxyl", "...")
await d.agent("region_fill", {...})            # a real tool call, the same registry the MCP server serves
await d.sync()                                 # wait for the narration to catch up
```

Everything before `d.mark("start")` is off camera (set-up) and trimmed from the video.

## Notes

- **Recording size** comes from `override.cfg`, which `make.py` writes for the duration of
  a render and deletes after (it's gitignored). Movie Maker ignores `--resolution`.
- The app lays out in a fixed 1600x900 canvas and is scaled to the video size, so the
  UI looks the same at 720p, 1080p or 4K.
- Each render starts from a fresh `--sandbox`, i.e. what a new install looks like.
- Overlay layers sit above 1024, where the engine draws embedded windows (the import panel, the
  save-prefab dialog), so the pointer, spotlight and zoom work on those too. Native OS file pickers
  are separate windows Movie Maker can't see: a chapter shows the click and hands the panel the path.
- The voice is Kokoro (`af_heart`), local and free. Words it gets wrong are respelled in
  `chapters/lexicon.txt`; captions keep the real spelling.
