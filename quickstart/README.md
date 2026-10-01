# Quickstart video

The video walkthrough is **rendered from the real app**, not screen-recorded: a small
director script plays each chapter against Voxyl itself (real mouse clicks, real key
presses, real tools), Godot's Movie Maker records every frame, and ffmpeg adds the
voice-over. Re-render after a UI change and the video is current again.

```
quickstart/
  chapters/    <name>.gd             the storyboard: what the viewer sees, in order
               <name>.narration.txt  the voice-over (also the captions and the SRT)
               lexicon.txt           how the voice should pronounce things ("voxyl = vox-ill")
  director/    Run.gd (entry) · Director.gd (timing, input, API) · Fx.gd (overlays) · Ui.gd (finding controls)
  pipeline/    make.py (narrate / render / encode) · tts.py · voice_test.py
  assets/      images flashed in the video (nei-data-dumps.png: the NEI Data Dumps screen)
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

## Making a chapter

```bash
PY=quickstart/.venv/Scripts/python.exe
$PY quickstart/pipeline/make.py narrate selection                    # voice-over (cached per line)
$PY quickstart/pipeline/make.py render selection --size 1280x720     # fast draft: ~25 s for 30 s of video
$PY quickstart/pipeline/make.py stills selection --at 4,12,20        # look at frames: out/selection/stills/
$PY quickstart/pipeline/make.py all selection                        # narrate + render at 1080p + encode
```

Output: `out/<chapter>/<chapter>.mp4`, `.srt`, `.vtt`, plus `timeline.json` (what was said and when).
Captions are burned in; pass `--no-captions` for a clean picture (the SRT/VTT are always written).

While a render runs, leave the window alone: fly-mode captures the real mouse, and a render
needs the GPU's attention. `render.log` has the engine output; the script prints any error lines.

## Writing a chapter

A chapter is a script with `run(d)`; `d` is the director. Name controls by what a viewer
would call them, not by node path.

```gdscript
d.say("tool")                                  # queue a narration line; visuals play over it
d.caption_top(true)                            # keep the caption off a busy bottom strip
await d.press(KEY_E)                           # a real key press
var btn = d.ctl({"text": "Select", "class": "Button"})
await d.spotlight(btn); d.arrow(btn, "Select tool", "above")
await d.click(btn)                             # pointer glides there and clicks
await d.sync()                                 # wait for the line to finish
await d.zoom_to(panel); await d.zoom_out()
await d.agent("region_fill", {...})            # staged agent action: the same tools the MCP server serves
```

Everything before `d.mark("start")` is off camera (set-up) and trimmed from the video.

## Notes

- **Recording size** comes from `override.cfg`, which `make.py` writes for the duration of
  a render and deletes after (it's gitignored). Movie Maker ignores `--resolution`.
- The app lays out in a fixed 1600x900 canvas and is scaled to the video size, so the
  UI looks the same at 720p, 1080p or 4K.
- Each render starts from a fresh `--sandbox`, i.e. what a new install looks like.
- Native OS file pickers (`use_native_dialog = true` in the import panel and a few dialogs)
  are separate OS windows that Movie Maker can't see, so a chapter should feed them a path
  instead of opening them. Embedded dialogs (the import panel, settings) haven't been
  exercised yet; check that overlays draw above them when the first chapter uses one.
