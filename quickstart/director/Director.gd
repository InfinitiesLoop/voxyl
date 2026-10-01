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
var _orbit_gen := 0
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
		print("quickstart: no narration file for '%s' (fine for a design run)" % chapter_name)
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
	var text := _plain(" ".join(buf))
	_narration[id] = {"text": text, "duration": maxf(1.2, text.split(" ", false).size() / WORDS_PER_SEC + 0.5), "wav": ""}

# The line as it reads in captions: `*emphasis*` loses its asterisks and `{caption|spoken}` keeps the caption.
func _plain(text: String) -> String:
	var hint_re := RegEx.new()
	hint_re.compile(r"\{([^|}]*)\|[^}]*\}")
	return hint_re.sub(text, "$1", true).replace("*", "")

# Queue a line. It starts when the previous one finishes (or now), and its captions are cut to
# fit. Returns immediately: do the on-screen action while it plays, then sync().
func say(id: String) -> void:
	if not _narration.has(id):
		push_error("quickstart: no narration line [%s]" % id)
		return
	var n: Dictionary = _narration[id]
	print("[quickstart] say %s  video=%.1fs  wall=%.0fs" % [id, t, Time.get_ticks_msec() / 1000.0])
	var start := maxf(t, _speech_end)
	var dur: float = n["duration"]
	_speech_end = start + dur
	timeline.append({"kind": "say", "id": id, "text": n["text"], "start": start, "end": start + dur, "wav": n["wav"]})
	for cue in _cut_cues(str(n["text"]), start, dur):
		_cues.append(cue)
		timeline.append({"kind": "cue", "text": cue["text"], "start": cue["start"], "end": cue["end"]})

# When a line was queued to start and end (video seconds): {start, end}.
func line_timing(id: String) -> Dictionary:
	for e in timeline:
		if e["kind"] == "say" and e["id"] == id:
			return {"start": e["start"], "end": e["end"]}
	return {"start": t, "end": t}

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
	return Ui.find(get_tree().root, query)

# First visible node anywhere on screen whose script has this global class name ("ImportPanel").
func node_of_class(global_name: String) -> Node:
	var stack: Array[Node] = [get_tree().root]
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		if n.name == &"QuickstartFx" or n is SubViewport:
			continue
		var sc := n.get_script() as Script
		if sc != null and sc.get_global_name() == global_name:
			if not (n is Control) or (n as Control).is_visible_in_tree():
				return n
		stack.append_array(n.get_children(true))
	return null

func ctl_all(query: Variant) -> Array:
	return Ui.find_all(get_tree().root, query)

func rect_of(target: Variant) -> Rect2:
	return Ui.rect_of(get_tree().root, target)

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
	await _glide(Ui.center_of(get_tree().root, target), dur)

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

# Open an OptionButton's list, glide to the entry and choose it (the click on the entry is shown,
# the selection made directly, since popup entries aren't controls we can target).
func pick_option(button: OptionButton, index: int) -> void:
	await click(button)
	await wait(0.35)
	var popup := button.get_popup()
	var item_h := float(popup.size.y) / float(maxi(popup.item_count, 1))
	var spot := Vector2(popup.position) + Vector2(60.0, item_h * (index + 0.5))
	await move_to(spot)
	await wait(0.2)
	fx.set_pressed(true)
	fx.click_fx()
	await wait(0.1)
	fx.set_pressed(false)
	button.select(index)
	button.item_selected.emit(index)
	popup.hide()
	await wait(0.3)

# Open a MenuButton's menu and choose the item with this id (the click on the item is shown; the
# choice is made directly, since popup items aren't controls we can target).
func pick_menu(button: MenuButton, item_id: int) -> void:
	await click(button)
	await wait(0.35)
	var popup := button.get_popup()
	var idx := popup.get_item_index(item_id)
	var item_h := float(popup.size.y) / float(maxi(popup.item_count, 1))
	var spot := Vector2(popup.position) + Vector2(70.0, item_h * (idx + 0.5))
	await move_to(spot)
	await wait(0.25)
	fx.set_pressed(true)
	fx.click_fx()
	await wait(0.1)
	fx.set_pressed(false)
	popup.id_pressed.emit(item_id)
	popup.hide()
	await wait(0.3)

# Every 3D view in the editor, in pane order (offscreen ones excluded).
func views3d() -> Array:
	var shell: Node = main.get_node("Editor/VBoxContainer/ContentArea/ViewShell")
	var out := []
	for v in shell.call("all_views"):
		if v.has_method("set_camera_pose") and not bool(v.get("offscreen")):
			out.append(v)
	return out

# Every 2D slice view, in pane order.
func slice_views() -> Array:
	var shell: Node = main.get_node("Editor/VBoxContainer/ContentArea/ViewShell")
	var out := []
	for v in shell.call("all_views"):
		if str(v.call("view_kind")) == "slice":
			out.append(v)
	return out

# Press the left button, glide the pointer through `points` (logical px) over `dur` seconds, release.
func drag_path(points: Array, dur := 1.2, button := MOUSE_BUTTON_LEFT) -> void:
	await move_to(points[0])
	await wait(0.15)
	_button(button, true)
	fx.set_pressed(true)
	var legs := points.size() - 1
	for i in legs:
		var a: Vector2 = points[i]
		var b: Vector2 = points[i + 1]
		var t0 := t
		var leg_dur := dur / float(legs)
		while t < t0 + leg_dur:
			var u := clampf((t - t0) / leg_dur, 0.0, 1.0)
			_set_pointer(a.lerp(b, u * u * (3.0 - 2.0 * u)))
			await get_tree().process_frame
		_set_pointer(b)
	_button(button, false)
	fx.set_pressed(false)
	await wait(0.2)

# Scroll the wheel `ticks` times over a point (positive = up).
func scroll(at: Vector2, ticks: int) -> void:
	await move_to(at)
	for i in absi(ticks):
		var idx := MOUSE_BUTTON_WHEEL_UP if ticks > 0 else MOUSE_BUTTON_WHEEL_DOWN
		_button(idx, true)
		_button(idx, false)
		await wait(0.12)

# A click that only looks like one: the pointer glides, presses and ripples, but no event is sent.
# For things the app would answer with an OS window the recording can't see (native file pickers) --
# the chapter then makes the same change itself.
func show_click(target: Variant) -> void:
	await move_to(target)
	await wait(0.14)
	fx.set_pressed(true)
	fx.click_fx()
	await wait(0.09)
	fx.set_pressed(false)
	await wait(0.2)

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

# Flash a picture from quickstart/assets/ over the app for a few seconds.
func flash_image(file_name: String, height := 760.0, hold := 3.0, rings: Array = []) -> void:
	var path := ProjectSettings.globalize_path("res://quickstart/assets/%s" % file_name)
	var img := Image.load_from_file(path)
	if img == null:
		push_error("quickstart: can't read %s" % path)
		return
	await fx.show_image(ImageTexture.create_from_image(img), height, hold, rings)

# Intro / outro title over the picture, and a numbered-steps card.
func title_card(title: String, subtitle: String, hold := 2.5) -> void:
	await fx.show_title(title, subtitle, hold)

func steps_card(heading: String, steps: Array, step_delay := 1.0, hold := 1.5) -> void:
	await fx.show_steps(heading, steps, step_delay, hold)

# A terminal window over the app: terminal_open("Terminal"), terminal_type("cmd"), terminal_print("out"), terminal_close().
func terminal_open(title := "Terminal") -> void:
	await fx.term_open(title)

func terminal_type(command: String, cps := 55.0) -> void:
	var l: RichTextLabel = fx.term_line("$ ")
	for i in range(1, command.length() + 1):
		l.text = "$ " + command.substr(0, i)
		if i % 6 == 0:
			await get_tree().process_frame     # let the wrapped height settle before resizing the card
			fx.term_relayout()
		await wait(1.0 / cps)
	await get_tree().process_frame
	fx.term_relayout()
	await wait(0.5)

func terminal_print(text: String) -> void:
	fx.term_line(text, true)
	await wait(0.4)

func terminal_close() -> void:
	await fx.term_close()

# A tag above the caption: hint("LEFT-HANDED", "Delete also opens the inventory").
func hint(tag: String, text: String, hold := 3.5) -> void:
	fx.show_hint(tag, text, hold)

# The staged agent: a chat card on screen while the real tools run underneath (agent()).
#   await d.chat_user("select just the glowing channels")
#   await d.chat_tool("selection_filter", "whitelist: [Channel Glow]", func(): ...do it...)
#   await d.chat_agent("Done: 84 cells.")
func chat_user(text: String, cps := 38.0) -> void:
	var l: Label = fx.chat_add("user")
	for i in range(1, text.length() + 1):
		l.text = text.substr(0, i)
		await wait(1.0 / cps)
	await wait(0.35)

# Shows the call as running, runs `work` (a Callable, may be async) while it spins, then ticks it.
func chat_tool(tool_name: String, args_text: String, work: Callable = Callable(), keep := 3) -> void:
	fx.chat_trim_tools(keep - 1)
	var l: Label = fx.chat_add("tool", "...  %s  %s" % [tool_name, args_text])
	await wait(0.5)
	if work.is_valid():
		await work.call()
	await wait(0.25)
	l.text = "OK  %s  %s" % [tool_name, args_text]
	await wait(0.2)

func chat_agent(text: String, cps := 60.0) -> void:
	var l: Label = fx.chat_add("agent")
	for i in range(1, text.length() + 1):
		l.text = text.substr(0, i)
		await wait(1.0 / cps)
	await wait(0.3)

# Attach a picture from quickstart/assets/ to the chat (a reference image for the agent).
func chat_image(file_name: String) -> void:
	var path := ProjectSettings.globalize_path("res://quickstart/assets/%s" % file_name)
	var img := Image.load_from_file(path)
	if img == null:
		push_error("quickstart: can't read %s" % path)
		return
	fx.chat_add_image(ImageTexture.create_from_image(img))
	await wait(0.6)

func chat_clear() -> void:
	fx.chat_clear()

func chat_hide() -> void:
	fx.chat_show(false)

func caption_top(top: bool) -> void:
	fx.set_caption_top(top)

# bottom | top | left | right (the last two are narrow columns above the hotbar).
func caption_at(where: String) -> void:
	fx.set_caption_mode(where)

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
	var badge: bool = _mcp.is_listening()
	if badge:
		_mcp.set("_calls_in_flight", int(_mcp.get("_calls_in_flight")) + 1)
		_mcp.call_started.emit(tool_name)
	var r: Variant = await _mcp.registry.call_tool(tool_name, args)
	if badge:
		_mcp.set("_calls_in_flight", maxi(int(_mcp.get("_calls_in_flight")) - 1, 0))
		_mcp.call_finished.emit(tool_name)
	if r is Dictionary and (r as Dictionary).has("__error"):
		push_error("quickstart: %s failed: %s" % [tool_name, str(r["__error"])])
	return r

# Let rebuilds and layouts settle (a few frames, or until the 3D view has flushed).
func settle(frames := 6) -> void:
	for i in frames:
		await get_tree().process_frame

# The visible 2D slice view, or null.
func slice_view() -> Control:
	var shell: Node = main.get_node("Editor/VBoxContainer/ContentArea/ViewShell")
	for v in shell.call("all_views"):
		if str(v.call("view_kind")) == "slice" and (v as Control).is_visible_in_tree():
			return v
	return null

# Where a world cell's centre sits on screen in a 2D slice view (logical px).
func slice_cell_screen(view: Control, cell: Vector3i) -> Vector2:
	var hv: Vector2i = view.call("_world_to_grid", cell)
	var area := view.get_node("GridArea") as Control
	var origin: Vector2 = view.call("_draw_origin")
	var px: float = view.get("_cell_px")
	return Ui.global_rect(area).position + origin + (Vector2(hv) + Vector2(0.5, 0.5)) * px

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
	await aim_at_point(Vector3(cell) + Vector3(0.5, 0.5, 0.5), dur)

# ...or an exact world point (e.g. a spot on the ground plane, y = 0).
func aim_at_point(point: Vector3, dur := 0.9) -> void:
	var v := view3d()
	var pos: Vector3 = v.get("_camera_pos")
	var dir := (point - pos).normalized()
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

# Turn the camera so a world point lands at (screen_x, screen_y) of the 3D view (0..1 across, 0..1 down),
# smoothly. Solved numerically on the camera angles, so it needs no camera maths of its own.
func pan_to(world: Vector3, screen_x: float, screen_y := 0.5, dur := 1.0) -> void:
	var v := view3d()
	var cam: Camera3D = v.get("_camera")
	var box := (cam.get_viewport().get_parent() as Control).size
	var goal := Vector2(box.x * screen_x, box.y * screen_y)
	var yaw0: float = v.get("_yaw")
	var pitch0: float = v.get("_pitch")
	var yaw := yaw0
	var pitch := pitch0
	for i in 8:
		_aim(v, yaw, pitch)
		var cur := cam.unproject_position(world)
		var err := goal - cur
		if err.length() < 0.5:
			break
		_aim(v, yaw + 0.5, pitch)
		var dyaw := cam.unproject_position(world) - cur
		_aim(v, yaw, pitch + 0.5)
		var dpitch := cam.unproject_position(world) - cur
		var det := dyaw.x * dpitch.y - dyaw.y * dpitch.x
		if absf(det) < 0.000001:
			break
		yaw += 0.5 * (err.x * dpitch.y - err.y * dpitch.x) / det
		pitch = clampf(pitch + 0.5 * (dyaw.x * err.y - dyaw.y * err.x) / det, -89.0, 89.0)
	_aim(v, yaw0, pitch0)
	var t0 := t
	while t < t0 + dur:
		var u := clampf((t - t0) / dur, 0.0, 1.0)
		u = u * u * (3.0 - 2.0 * u)
		_look(v, lerpf(yaw0, yaw, u), lerpf(pitch0, pitch, u))
		await get_tree().process_frame
	_look(v, yaw, pitch)

func _aim(v: Control, yaw: float, pitch: float) -> void:
	v.set("_yaw", yaw)
	v.set("_pitch", pitch)
	v.call("_update_camera")

# The nearest ancestor whose script has this global class name (e.g. "ToolOverlayPanel").
func ancestor_of(node: Node, class_name_: String) -> Control:
	var n := node
	while n != null:
		var sc := n.get_script() as Script
		if sc != null and sc.get_global_name() == class_name_:
			return n as Control
		n = n.get_parent()
	return null

# Circle the camera around `center` (radius on the ground, `height` above it), bearing in degrees.
func orbit(center: Vector3, radius: float, height: float, from_deg: float, to_deg: float, dur: float) -> void:
	var v := view3d()
	var t0 := t
	_orbit_gen += 1
	var mine := _orbit_gen          # a newer orbit takes over the camera
	while t < t0 + dur:
		if mine != _orbit_gen:
			return
		var a := deg_to_rad(lerpf(from_deg, to_deg, clampf((t - t0) / dur, 0.0, 1.0)))
		v.call("set_camera_pose", center + Vector3(sin(a) * radius, height, cos(a) * radius), center)
		await get_tree().process_frame
	var b := deg_to_rad(to_deg)
	v.call("set_camera_pose", center + Vector3(sin(b) * radius, height, cos(b) * radius), center)

# Move the camera along its look direction (negative = back away), smoothly.
func dolly(dist: float, dur := 1.0) -> void:
	var v := view3d()
	var p0: Vector3 = v.get("_camera_pos")
	var dir: Vector3 = v.call("_get_look_dir")
	var t0 := t
	while t < t0 + dur:
		var u := clampf((t - t0) / dur, 0.0, 1.0)
		u = u * u * (3.0 - 2.0 * u)
		v.set("_camera_pos", p0 + dir * dist * u)
		v.call("_update_camera")
		await get_tree().process_frame
	v.set("_camera_pos", p0 + dir * dist)
	v.call("_update_camera")

# Turn the camera by a few degrees, smoothly (positive yaw turns toward the right of the screen).
func look_by(dyaw: float, dpitch: float, dur := 0.8) -> void:
	var v := view3d()
	var yaw0: float = v.get("_yaw")
	var pitch0: float = v.get("_pitch")
	var t0 := t
	while t < t0 + dur:
		var u := clampf((t - t0) / dur, 0.0, 1.0)
		u = u * u * (3.0 - 2.0 * u)
		_look(v, yaw0 + dyaw * u, clampf(pitch0 + dpitch * u, -89.0, 89.0))
		await get_tree().process_frame
	_look(v, yaw0 + dyaw, clampf(pitch0 + dpitch, -89.0, 89.0))

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
