extends Node

# The quickstart director: plays a chapter script against the real app, injecting real input
# events and drawing overlays (Fx), while it keeps a timeline of what was said and when. The
# recording itself is Godot's Movie Maker (see Run.gd) — frames are deterministic, so
# everything here is timed in video seconds (the sum of frame deltas), never wall-clock time.
#
# Chapter scripts talk to this object (`d`):
#   narration   say("id") queues a line (speaks after the previous one; returns at once so the
#               visuals can play over it), sync() waits for the queue to drain, wait(sec)
#   pointer     move_to(target) click(target) right_click(target) type_text(text)
#   keys        key_down/key_up(KEY_*) press(KEY_*, mods) hold_keys([KEY_*], sec)
#   overlays    spotlight(target) arrow(target, "label") zoom_to(target) card("Chapter") ...
#   the app     ctl(query) view3d() aim_at_cell(cell) agent("tool_name", args)
# `target` is a Control, Rect2, Vector2 (logical px), or a Ui query ("Select", {text:..}).

const Fx := preload("res://quickstart/director/Fx.gd")
const Ui := preload("res://quickstart/director/Ui.gd")

const WORDS_PER_SEC := 2.7    # only used to estimate a line before its audio has been rendered

var fx: Fx
var main: Control
var t := 0.0                  # video seconds
var out_dir := ""
var chapter_name := ""
var burn_captions := true
var timeline: Array = []
var marks := {}

var _narration := {}          # id -> {text, duration, wav}
var _speech_end := 0.0
var _cues: Array = []
var _cue_index := -1
var _ptr := Vector2(800, 450)
var _last_px := Vector2.ZERO
var _mask := 0
var _bend := 1.0
var _world: Node
var _mcp: Node

func setup(p_main: Control, p_fx: Fx, p_out: String, p_chapter: String, p_burn: bool) -> void:
	main = p_main
	fx = p_fx
	out_dir = p_out
	chapter_name = p_chapter
	burn_captions = p_burn
	_world = get_node("/root/VoxelWorld")
	_mcp = get_node("/root/McpServer")
	_load_narration()

func _process(delta: float) -> void:
	t += delta
	_update_captions()

# --- Narration ---------------------------------------------------------------------

# Lines come from chapters/<name>.narration.txt ("[id] text", paragraphs end at a blank line);
# measured durations come from <out>/narration.json once pipeline/narrate.py has run. Without
# audio yet, a line lasts as long as it would take to say.
func _load_narration() -> void:
	var path := "res://quickstart/chapters/%s.narration.txt" % chapter_name
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		push_error("quickstart: no narration file at %s" % path)
		return
	var id := ""
	var buf: Array[String] = []
	for raw in f.get_as_text().split("\n"):
		var line := raw.strip_edges()
		if line.begins_with("#"):
			continue
		if line.begins_with("[") and line.contains("]"):
			_flush_line(id, buf)
			id = line.substr(1, line.find("]") - 1)
			buf = []
			var rest := line.substr(line.find("]") + 1).strip_edges()
			if not rest.is_empty():
				buf.append(rest)
		elif line.is_empty():
			_flush_line(id, buf)
			id = ""
			buf = []
		elif not id.is_empty():
			buf.append(line)
	_flush_line(id, buf)
	var jf := FileAccess.open(out_dir.path_join("narration.json"), FileAccess.READ)
	if jf != null:
		var parsed: Variant = JSON.parse_string(jf.get_as_text())
		if parsed is Dictionary:
			for k in (parsed as Dictionary).get("lines", {}):
				if _narration.has(k):
					_narration[k]["duration"] = float(parsed["lines"][k]["duration"])
					_narration[k]["wav"] = str(parsed["lines"][k].get("wav", ""))

func _flush_line(id: String, buf: Array[String]) -> void:
	if id.is_empty() or buf.is_empty():
		return
	var text := " ".join(buf)
	_narration[id] = {"text": text, "duration": maxf(1.2, text.split(" ", false).size() / WORDS_PER_SEC + 0.5), "wav": ""}

# Queue a line. It starts when the previous one finishes (or now), and its captions are cut to
# fit. Returns immediately: do the on-screen action while it plays, then sync().
func say(id: String) -> void:
	if not _narration.has(id):
		push_error("quickstart: no narration line [%s]" % id)
		return
	var n: Dictionary = _narration[id]
	var start := maxf(t, _speech_end)
	var dur: float = n["duration"]
	_speech_end = start + dur
	timeline.append({"kind": "say", "id": id, "text": n["text"], "start": start, "end": start + dur, "wav": n["wav"]})
	for cue in _cut_cues(str(n["text"]), start, dur):
		_cues.append(cue)
		timeline.append({"kind": "cue", "text": cue["text"], "start": cue["start"], "end": cue["end"]})

# Wait until everything queued has been spoken.
func sync() -> void:
	while t < _speech_end:
		await get_tree().process_frame

func wait(sec: float) -> void:
	var end := t + sec
	while t < end:
		await get_tree().process_frame

func _cut_cues(text: String, start: float, dur: float) -> Array:
	var chunks: Array[String] = []
	var cur: Array[String] = []
	for w in text.split(" ", false):
		cur.append(w)
		var joined := " ".join(cur)
		var ends := w.ends_with(".") or w.ends_with("!") or w.ends_with("?")
		var soft := w.ends_with(",") or w.ends_with(":") or w.ends_with(";") or w.ends_with("—")
		if (ends and joined.length() > 28) or (soft and joined.length() > 56) or joined.length() > 88:
			chunks.append(joined)
			cur = []
	if not cur.is_empty():
		chunks.append(" ".join(cur))
	var total := 0
	for c in chunks:
		total += c.length()
	var out: Array = []
	var at := start
	for c in chunks:
		var d := dur * float(c.length()) / float(maxi(total, 1))
		out.append({"start": at, "end": at + d, "text": c})
		at += d
	return out

func _update_captions() -> void:
	if not burn_captions:
		return
	var idx := -1
	for i in _cues.size():
		if t >= float(_cues[i]["start"]) and t < float(_cues[i]["end"]):
			idx = i
			break
	if idx == _cue_index:
		return
	_cue_index = idx
	if idx < 0:
		fx.hide_caption()
	else:
		fx.show_caption(str(_cues[idx]["text"]))

func mark(label: String) -> void:
	marks[label] = t

func finish() -> void:
	var data := {
		"chapter": chapter_name,
		"duration": t,
		"size": [get_tree().root.size.x, get_tree().root.size.y],
		"marks": marks,
		"events": timeline,
	}
	DirAccess.make_dir_recursive_absolute(out_dir)
	var f := FileAccess.open(out_dir.path_join("timeline.json"), FileAccess.WRITE)
	f.store_string(JSON.stringify(data, "  "))
	f.close()

# --- Finding things ----------------------------------------------------------------

func ctl(query: Variant) -> Control:
	return Ui.find(main, query)

func rect_of(target: Variant) -> Rect2:
	return Ui.rect_of(main, target)

func view3d() -> Control:
	var shell: Node = main.get_node("Editor/VBoxContainer/ContentArea/ViewShell")
	var v: Control = shell.call("focused_view")
	if v != null and v.has_method("set_camera_pose"):
		return v
	for cand in shell.call("all_views"):
		if cand.has_method("set_camera_pose") and not bool(cand.get("offscreen")):
			return cand
	return null

# --- Pointer & mouse ---------------------------------------------------------------

func move_to(target: Variant, dur := -1.0) -> void:
	await _glide(Ui.center_of(main, target), dur)

func click(target: Variant, button := MOUSE_BUTTON_LEFT) -> void:
	await move_to(target)
	await wait(0.14)
	_button(button, true)
	fx.set_pressed(true)
	fx.click_fx()
	await wait(0.09)
	_button(button, false)
	fx.set_pressed(false)
	await wait(0.16)

func right_click(target: Variant) -> void:
	await click(target, MOUSE_BUTTON_RIGHT)

# A click while flying (the mouse is captured, so there's no pointer): aimed by the crosshair.
func click_crosshair(button: int) -> void:
	_button(button, true, true)
	await wait(0.07)
	_button(button, false, true)
	await wait(0.12)

func _glide(dest: Vector2, dur: float) -> void:
	if not fx.pointer_visible():
		fx.show_pointer(_ptr)
	var from := _ptr
	var dist := from.distance_to(dest)
	if dur < 0.0:
		dur = clampf(0.3 + dist / 1500.0, 0.32, 1.05)
	var side := Vector2(-(dest - from).y, (dest - from).x).normalized()
	var ctrl := (from + dest) * 0.5 + side * dist * 0.10 * _bend
	_bend = -_bend
	var t0 := t
	while t < t0 + dur:
		var u := clampf((t - t0) / dur, 0.0, 1.0)
		u = u * u * (3.0 - 2.0 * u)
		_set_pointer(from.lerp(ctrl, u).lerp(ctrl.lerp(dest, u), u))
		await get_tree().process_frame
	_set_pointer(dest)

func _set_pointer(p: Vector2) -> void:
	_ptr = p
	fx.set_pointer(p)
	var px := Ui.to_window(get_tree().root, p)
	var ev := InputEventMouseMotion.new()
	ev.position = px
	ev.global_position = px
	ev.relative = px - _last_px
	ev.button_mask = _mask
	_last_px = px
	Input.parse_input_event(ev)

func _button(idx: int, down: bool, at_center := false) -> void:
	var win := get_tree().root
	var px := Vector2(win.size) * 0.5 if at_center else Ui.to_window(win, _ptr)
	var ev := InputEventMouseButton.new()
	ev.position = px
	ev.global_position = px
	ev.button_index = idx as MouseButton
	ev.pressed = down
	var bit := 1 << (idx - 1)
	_mask = (_mask | bit) if down else (_mask & ~bit)
	ev.button_mask = _mask
	Input.parse_input_event(ev)

func hide_pointer() -> void:
	fx.hide_pointer()

# The pointer reappears where the captured mouse was released: the middle of the window.
func pointer_to_center() -> void:
	_ptr = Vector2(get_tree().root.get_visible_rect().size) * 0.5
	fx.show_pointer(_ptr)
	_set_pointer(_ptr)

# --- Keyboard ----------------------------------------------------------------------

func key_down(keycode: int, right := false) -> void:
	_key(keycode, true, right, [])
	fx.light_key(keycode, true)

func key_up(keycode: int, right := false) -> void:
	_key(keycode, false, right, [])
	fx.light_key(keycode, false)

# A tap, with optional modifiers (["ctrl"], ["shift"]).
func press(keycode: int, mods: Array = [], hold := 0.1) -> void:
	for m in mods:
		_key(_mod_code(m), true, false, [])
	_key(keycode, true, false, mods)
	await wait(hold)
	_key(keycode, false, false, mods)
	for m in mods:
		_key(_mod_code(m), false, false, [])
	await wait(0.08)

func hold_keys(keycodes: Array, sec: float, right := false) -> void:
	for k in keycodes:
		key_down(k, right)
	await wait(sec)
	for k in keycodes:
		key_up(k, right)

func type_text(text: String, cps := 20.0) -> void:
	for ch in text:
		var ev := InputEventKey.new()
		ev.unicode = ch.unicode_at(0)
		ev.keycode = OS.find_keycode_from_string(ch.to_upper()) as Key
		ev.pressed = true
		Input.parse_input_event(ev)
		ev = ev.duplicate()
		ev.pressed = false
		Input.parse_input_event(ev)
		await wait(1.0 / cps)

func _mod_code(m: String) -> int:
	match m:
		"ctrl": return KEY_CTRL
		"shift": return KEY_SHIFT
		"alt": return KEY_ALT
	return KEY_NONE

func _key(keycode: int, down: bool, right: bool, mods: Array) -> void:
	var ev := InputEventKey.new()
	ev.keycode = keycode as Key
	ev.physical_keycode = keycode as Key
	ev.pressed = down
	if right:
		ev.location = KEY_LOCATION_RIGHT
	ev.ctrl_pressed = mods.has("ctrl") or keycode == KEY_CTRL
	ev.shift_pressed = mods.has("shift") or keycode == KEY_SHIFT
	ev.alt_pressed = mods.has("alt") or keycode == KEY_ALT
	Input.parse_input_event(ev)

# --- Overlays ----------------------------------------------------------------------

func spotlight(target: Variant, pad := 10.0, dur := 0.45) -> void:
	await fx.spotlight(rect_of(target).grow(pad), dur)

func spotlight_off() -> void:
	await fx.spotlight_off()

func arrow(target: Variant, text := "", side := "auto") -> void:
	fx.callout(rect_of(target), text, side)

func arrows_off() -> void:
	await fx.clear_callouts()

func zoom_to(target: Variant, max_zoom := 2.2, dur := 0.8) -> void:
	await fx.zoom_to(rect_of(target), max_zoom, 0.1, dur)

func zoom_out(dur := 0.7) -> void:
	await fx.zoom_out(dur)

func card(text: String, hold := 2.4) -> void:
	fx.show_card(text, hold)

func keys_hud(on: bool) -> void:
	fx.show_keys(on)

func caption_top(top: bool) -> void:
	fx.set_caption_top(top)

# Gap between the caption and the bottom edge (default clears the editor's hotbar; use ~50 on
# screens without one).
func caption_margin(px: float) -> void:
	fx.set_caption_margin(px)

func fade_in(dur := 0.8) -> void:
	await fx.fade_to(0.0, dur)

func fade_out(dur := 0.8) -> void:
	await fx.fade_to(1.0, dur)

func set_fade(alpha: float) -> void:
	fx.set_fade(alpha)

# --- The app -----------------------------------------------------------------------

# Run an MCP tool exactly as an agent would — the staged "agent builds it" beats and quiet
# set-up both go through the same registry the HTTP server uses.
func agent(tool_name: String, args := {}) -> Variant:
	var r: Variant = await _mcp.registry.call_tool(tool_name, args)
	if r is Dictionary and (r as Dictionary).has("__error"):
		push_error("quickstart: %s failed: %s" % [tool_name, str(r["__error"])])
	return r

# Let rebuilds and layouts settle (a few frames, or until the 3D view has flushed).
func settle(frames := 6) -> void:
	for i in frames:
		await get_tree().process_frame

# Where a world-space point lands on screen (logical px) in the 3D view.
func world_to_screen(world: Vector3) -> Vector2:
	var v := view3d()
	var cam: Camera3D = v.get("_camera")
	var container := cam.get_viewport().get_parent() as Control
	return container.get_global_rect().position + cam.unproject_position(world)

func cell_rect(cell: Vector3i, pad := 14.0) -> Rect2:
	var c := world_to_screen(Vector3(cell) + Vector3(0.5, 0.5, 0.5))
	return Rect2(c - Vector2(pad, pad), Vector2(pad, pad) * 2.0)

# Turn the camera to put `cell` under the crosshair, smoothly.
func aim_at_cell(cell: Vector3i, dur := 0.9) -> void:
	var v := view3d()
	var pos: Vector3 = v.get("_camera_pos")
	var dir := (Vector3(cell) + Vector3(0.5, 0.5, 0.5) - pos).normalized()
	var yaw1 := rad_to_deg(atan2(dir.x, dir.z))
	var pitch1 := clampf(rad_to_deg(asin(clampf(dir.y, -1.0, 1.0))), -89.0, 89.0)
	var yaw0: float = v.get("_yaw")
	var pitch0: float = v.get("_pitch")
	var dyaw := fposmod(yaw1 - yaw0 + 180.0, 360.0) - 180.0
	var t0 := t
	while t < t0 + dur:
		var u := clampf((t - t0) / dur, 0.0, 1.0)
		u = u * u * (3.0 - 2.0 * u)
		_look(v, yaw0 + dyaw * u, lerpf(pitch0, pitch1, u))
		await get_tree().process_frame
	_look(v, yaw0 + dyaw, pitch1)

func _look(v: Control, yaw: float, pitch: float) -> void:
	v.set("_yaw", yaw)
	v.set("_pitch", pitch)
	v.call("_update_camera")
	v.call("_update_crosshair_target")

# Slide the camera to `pos`, ending up looking at `target`.
func glide_camera(pos: Vector3, target: Vector3, dur := 1.2) -> void:
	var v := view3d()
	var p0: Vector3 = v.get("_camera_pos")
	var look0: Vector3 = p0 + (v.call("_get_look_dir") as Vector3) * 10.0
	var t0 := t
	while t < t0 + dur:
		var u := clampf((t - t0) / dur, 0.0, 1.0)
		u = u * u * (3.0 - 2.0 * u)
		v.call("set_camera_pose", p0.lerp(pos, u), look0.lerp(target, u))
		await get_tree().process_frame
	v.call("set_camera_pose", pos, target)
