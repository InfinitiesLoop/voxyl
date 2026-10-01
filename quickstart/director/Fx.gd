extends Node

# The director's overlay stack: everything drawn on top of the real app, and so baked into
# the recorded frames — spotlight, arrow callouts, the pointer, zoom, captions, chapter
# cards, the key HUD, fades. Three CanvasLayers, bottom to top:
#   world (10)  spotlight, callouts, pointer — these zoom along with the app
#   zoom  (20)  re-draws everything below it magnified (a screen-texture shader)
#   top   (30)  captions, chapter cards, key HUD, fade — never zoomed
# Every control here ignores the mouse, so nothing can eat a click.

const ACCENT := Color(0.38, 0.86, 1.0)
const INK := Color(0.05, 0.06, 0.08)

const _SPOT_SHADER := """
shader_type canvas_item;
uniform vec4 rect = vec4(0.0);
uniform vec2 view_size = vec2(1600.0, 900.0);
uniform float strength : hint_range(0.0, 1.0) = 0.0;
uniform float corner = 14.0;
uniform float feather = 70.0;
uniform vec4 ring_color : source_color = vec4(0.38, 0.86, 1.0, 1.0);
void fragment() {
	vec2 p = UV * view_size;
	vec2 hs = rect.zw * 0.5;
	vec2 q = abs(p - (rect.xy + hs)) - hs + vec2(corner);
	float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - corner;
	float shade = smoothstep(0.0, feather, d) * strength * 0.74;
	float ring = (1.0 - smoothstep(0.0, 2.2, abs(d - 1.0))) * strength;
	COLOR = vec4(mix(vec3(0.0), ring_color.rgb, ring), max(shade, ring * 0.95));
}
"""

const _ZOOM_SHADER := """
shader_type canvas_item;
uniform sampler2D screen_tex : hint_screen_texture, filter_linear;
uniform vec2 center = vec2(0.5);
uniform float zoom = 1.0;
void fragment() {
	vec2 uv = center + (SCREEN_UV - vec2(0.5)) / zoom;
	COLOR = vec4(texture(screen_tex, uv).rgb, 1.0);
}
"""

var view_size := Vector2(1600, 900)   # the canvas, in logical px

var _world: CanvasLayer
var _zoom_layer: CanvasLayer
var _top: CanvasLayer
var _spot: ColorRect
var _spot_mat: ShaderMaterial
var _zoom_rect: ColorRect
var _zoom_mat: ShaderMaterial
var _zoom := 1.0
var _zoom_center := Vector2(0.5, 0.5)
var _pointer: Pointer
var _callouts: Array[Callout] = []
var _caption: PanelContainer
var _caption_label: Label
var _card: PanelContainer
var _card_label: Label
var _fade: ColorRect
var _keys: KeysHud
var _hint: PanelContainer
var _hint_label: RichTextLabel
var _chat: ChatCard
var _tween_hint: Tween
var _tween_spot: Tween
var _tween_zoom: Tween
var _caption_mode := "bottom"   # bottom | top | left | right
var _caption_margin := 122.0   # gap under the caption: clears the editor's hotbar

func build(parent: Node, size: Vector2) -> void:
	name = "QuickstartFx"
	view_size = size
	parent.add_child(self)
	_world = _layer(10)
	_zoom_layer = _layer(20)
	_top = _layer(30)

	_spot = ColorRect.new()
	_spot_mat = ShaderMaterial.new()
	_spot_mat.shader = _shader(_SPOT_SHADER)
	_spot.material = _spot_mat
	_fill_rect(_spot)
	_spot_mat.set_shader_parameter("view_size", view_size)
	_world.add_child(_spot)
	_spot.visible = false

	_pointer = Pointer.new()
	_pointer.visible = false
	_world.add_child(_pointer)

	_zoom_rect = ColorRect.new()
	_zoom_mat = ShaderMaterial.new()
	_zoom_mat.shader = _shader(_ZOOM_SHADER)
	_zoom_rect.material = _zoom_mat
	_fill_rect(_zoom_rect)
	_zoom_layer.add_child(_zoom_rect)
	_zoom_layer.visible = false

	_keys = KeysHud.new()
	_keys.position = Vector2(36, view_size.y - 122.0 - 316.0)
	_keys.visible = false
	_top.add_child(_keys)
	_build_caption()
	_build_card()
	_build_hint()
	_chat = ChatCard.new()
	_chat.position = Vector2(view_size.x - 48.0 - ChatCard.WIDTH, 150)
	_chat.visible = false
	_top.add_child(_chat)
	_fade = ColorRect.new()
	_fade.color = Color.BLACK
	_fill_rect(_fade)
	_fade.modulate.a = 0.0
	_top.add_child(_fade)

func _layer(n: int) -> CanvasLayer:
	var l := CanvasLayer.new()
	l.layer = n
	add_child(l)
	return l

func _shader(code: String) -> Shader:
	var s := Shader.new()
	s.code = code
	return s

func _fill_rect(r: ColorRect) -> void:
	r.mouse_filter = Control.MOUSE_FILTER_IGNORE
	r.position = Vector2.ZERO
	r.size = view_size

# --- Fade --------------------------------------------------------------------------

# Fade the whole picture to black (alpha 1) or back (0).
func fade_to(alpha: float, dur: float) -> void:
	var tw := create_tween()
	tw.tween_property(_fade, "modulate:a", alpha, maxf(dur, 0.001))
	await tw.finished

func set_fade(alpha: float) -> void:
	_fade.modulate.a = alpha

# --- Spotlight ---------------------------------------------------------------------

# Dim everything outside `rect` (logical px), ringing it in the accent colour.
func spotlight(rect: Rect2, dur := 0.45) -> void:
	if _tween_spot != null and _tween_spot.is_valid():
		_tween_spot.kill()
	var was_visible := _spot.visible
	if not was_visible:
		# Start from a zero-strength box around the target so it grows in rather than flashing.
		_spot_mat.set_shader_parameter("rect", Vector4(rect.position.x, rect.position.y, rect.size.x, rect.size.y))
		_spot_mat.set_shader_parameter("strength", 0.0)
		_spot.visible = true
	var from_rect: Vector4 = _spot_mat.get_shader_parameter("rect")
	var to_rect := Vector4(rect.position.x, rect.position.y, rect.size.x, rect.size.y)
	_tween_spot = create_tween().set_parallel(true).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN_OUT)
	_tween_spot.tween_method(func(v: float): _spot_mat.set_shader_parameter("rect", from_rect.lerp(to_rect, v)), 0.0, 1.0, dur)
	_tween_spot.tween_method(func(v: float): _spot_mat.set_shader_parameter("strength", v),
		float(_spot_mat.get_shader_parameter("strength")), 1.0, dur)
	await _tween_spot.finished

func spotlight_off(dur := 0.35) -> void:
	if not _spot.visible:
		return
	if _tween_spot != null and _tween_spot.is_valid():
		_tween_spot.kill()
	_tween_spot = create_tween()
	_tween_spot.tween_method(func(v: float): _spot_mat.set_shader_parameter("strength", v),
		float(_spot_mat.get_shader_parameter("strength")), 0.0, dur)
	await _tween_spot.finished
	_spot.visible = false

# --- Zoom --------------------------------------------------------------------------

# Magnify so `rect` (logical px) fills the frame, centre kept inside the picture.
func zoom_to(rect: Rect2, max_zoom := 2.4, margin := 0.12, dur := 0.8) -> void:
	var z := minf(view_size.x / maxf(rect.size.x, 1.0), view_size.y / maxf(rect.size.y, 1.0)) * (1.0 - margin)
	z = clampf(z, 1.0, max_zoom)
	var half := Vector2(0.5, 0.5) / z
	var c := (rect.position + rect.size * 0.5) / view_size
	c = Vector2(clampf(c.x, half.x, 1.0 - half.x), clampf(c.y, half.y, 1.0 - half.y))
	await _zoom_tween(z, c, dur)

func zoom_out(dur := 0.7) -> void:
	await _zoom_tween(1.0, Vector2(0.5, 0.5), dur)
	_zoom_layer.visible = false

func _zoom_tween(z: float, c: Vector2, dur: float) -> void:
	if _tween_zoom != null and _tween_zoom.is_valid():
		_tween_zoom.kill()
	_zoom_layer.visible = true
	var z0 := _zoom
	var c0 := _zoom_center
	_tween_zoom = create_tween().set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN_OUT)
	_tween_zoom.tween_method(func(v: float):
		_zoom = lerpf(z0, z, v)
		_zoom_center = c0.lerp(c, v)
		_zoom_mat.set_shader_parameter("zoom", _zoom)
		_zoom_mat.set_shader_parameter("center", _zoom_center), 0.0, 1.0, maxf(dur, 0.001))
	await _tween_zoom.finished

func zoom_level() -> float:
	return _zoom

# --- Pointer -----------------------------------------------------------------------

func show_pointer(at: Vector2) -> void:
	_pointer.position = at
	_pointer.visible = true

func hide_pointer() -> void:
	_pointer.visible = false

func set_pointer(at: Vector2) -> void:
	_pointer.position = at

func pointer_visible() -> bool:
	return _pointer.visible

func click_fx() -> void:
	_pointer.ripple = 0.0
	var tw := create_tween()
	tw.tween_property(_pointer, "ripple", 1.0, 0.42)
	tw.tween_callback(func(): _pointer.ripple = -1.0)

func set_pressed(down: bool) -> void:
	_pointer.pressed = down

# --- Callouts ----------------------------------------------------------------------

# An arrow pointing at `target` (a point, or a rect — it aims at the nearest edge's midpoint on
# the chosen side), with an optional label. side: auto | left | right | above | below, naming
# where the arrow's tail (and label) sits relative to the target.
func callout(target: Variant, text := "", side := "auto") -> Callout:
	var c := Callout.new()
	var rect := Rect2(target, Vector2.ZERO) if target is Vector2 else (target as Rect2)
	if side == "auto":
		side = _roomiest_side(rect)
	c.setup(rect, text, side, view_size)
	_world.add_child(c)
	_callouts.append(c)
	var tw := create_tween().set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	tw.tween_property(c, "progress", 1.0, 0.45)
	return c

func clear_callouts(dur := 0.25) -> void:
	var list := _callouts.duplicate()
	_callouts.clear()
	if list.is_empty():
		return
	var tw := create_tween().set_parallel(true)
	for c in list:
		tw.tween_property(c, "progress", 0.0, dur)
	await tw.finished
	for c in list:
		c.queue_free()

func _roomiest_side(r: Rect2) -> String:
	var room := {
		"left": r.position.x,
		"right": view_size.x - r.end.x,
		"above": r.position.y,
		"below": view_size.y - r.end.y,
	}
	var best := "left"
	for k in room:
		if room[k] > room[best]:
			best = k
	return best

# --- Captions ----------------------------------------------------------------------

func _build_caption() -> void:
	_caption = PanelContainer.new()
	_caption.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.03, 0.04, 0.06, 0.84)
	sb.set_corner_radius_all(14)
	sb.content_margin_left = 26
	sb.content_margin_right = 26
	sb.content_margin_top = 12
	sb.content_margin_bottom = 14
	sb.border_color = Color(ACCENT, 0.35)
	sb.set_border_width_all(1)
	_caption.add_theme_stylebox_override("panel", sb)
	_caption_label = Label.new()
	_caption_label.add_theme_font_size_override("font_size", 30)
	_caption_label.add_theme_color_override("font_color", Color(0.97, 0.98, 1.0))
	_caption_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_caption_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_caption_label.custom_minimum_size.x = minf(view_size.x * 0.62, 1000.0)
	_caption.add_child(_caption_label)
	_caption.modulate.a = 0.0
	_top.add_child(_caption)

func set_caption_top(top: bool) -> void:
	_caption_mode = "top" if top else "bottom"

# Where captions go: bottom (centred), top, or a narrow column at the bottom left / right --
# for screens where a panel owns the middle.
func set_caption_mode(mode: String) -> void:
	_caption_mode = mode

func set_caption_margin(px: float) -> void:
	_caption_margin = px

func show_caption(text: String) -> void:
	var narrow := _caption_mode == "left" or _caption_mode == "right"
	_caption_label.custom_minimum_size.x = 470.0 if narrow else minf(view_size.x * 0.62, 1000.0)
	_caption_label.text = text
	_caption.reset_size()
	var y := 46.0 if _caption_mode == "top" else view_size.y - _caption_margin - _caption.size.y
	var x := (view_size.x - _caption.size.x) * 0.5
	if _caption_mode == "left":
		x = 48.0
	elif _caption_mode == "right":
		x = view_size.x - 48.0 - _caption.size.x
	_caption.position = Vector2(x, y)
	_caption.modulate.a = 1.0

func hide_caption() -> void:
	_caption.modulate.a = 0.0

# --- Chapter card ------------------------------------------------------------------

func _build_card() -> void:
	_card = PanelContainer.new()
	_card.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.03, 0.04, 0.06, 0.88)
	sb.set_corner_radius_all(10)
	sb.border_color = ACCENT
	sb.border_width_left = 6
	sb.content_margin_left = 22
	sb.content_margin_right = 26
	sb.content_margin_top = 10
	sb.content_margin_bottom = 12
	_card.add_theme_stylebox_override("panel", sb)
	_card_label = Label.new()
	_card_label.add_theme_font_size_override("font_size", 34)
	_card_label.add_theme_color_override("font_color", Color.WHITE)
	_card.add_child(_card_label)
	_card.modulate.a = 0.0
	_top.add_child(_card)

func show_card(text: String, hold := 2.4) -> void:
	_card_label.text = text
	_card.reset_size()
	var rest := Vector2(48, 44)
	_card.position = rest + Vector2(-60, 0)
	var tw := create_tween().set_parallel(true).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	tw.tween_property(_card, "modulate:a", 1.0, 0.4)
	tw.tween_property(_card, "position", rest, 0.5)
	var out := create_tween()
	out.tween_interval(hold)
	out.tween_property(_card, "modulate:a", 0.0, 0.45)

# --- Hint pill ---------------------------------------------------------------------

# A short tag above the caption for things worth knowing but not worth saying aloud --
# chiefly the right-hand key alternatives: "LEFT-HANDED  Delete also opens the inventory".
func _build_hint() -> void:
	_hint = PanelContainer.new()
	_hint.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.03, 0.04, 0.06, 0.9)
	sb.set_corner_radius_all(10)
	sb.border_color = ACCENT
	sb.set_border_width_all(2)
	sb.content_margin_left = 18
	sb.content_margin_right = 20
	sb.content_margin_top = 8
	sb.content_margin_bottom = 9
	_hint.add_theme_stylebox_override("panel", sb)
	_hint_label = RichTextLabel.new()
	_hint_label.bbcode_enabled = true
	_hint_label.fit_content = true
	_hint_label.scroll_active = false
	_hint_label.autowrap_mode = TextServer.AUTOWRAP_OFF
	_hint_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_hint_label.add_theme_font_size_override("normal_font_size", 24)
	_hint_label.add_theme_font_size_override("bold_font_size", 24)
	_hint.add_child(_hint_label)
	_hint.modulate.a = 0.0
	_top.add_child(_hint)

func show_hint(tag: String, text: String, hold := 3.5) -> void:
	_hint_label.text = "[color=#%s][b]%s[/b][/color]   %s" % [ACCENT.to_html(false), tag, text]
	_hint.reset_size()
	await get_tree().process_frame
	_hint.reset_size()
	_hint.position = Vector2((view_size.x - _hint.size.x) * 0.5, view_size.y - _caption_margin - 126.0 - _hint.size.y)
	if _tween_hint != null and _tween_hint.is_valid():
		_tween_hint.kill()
	_tween_hint = create_tween()
	_tween_hint.tween_property(_hint, "modulate:a", 1.0, 0.25)
	_tween_hint.tween_interval(hold)
	_tween_hint.tween_property(_hint, "modulate:a", 0.0, 0.4)

# --- Agent chat card ---------------------------------------------------------------

func chat_show(on: bool) -> void:
	_chat.visible = on

func chat_clear() -> void:
	_chat.clear()

# kind: user | tool | agent. Returns the label so the caller can type into it.
func chat_add(kind: String, text := "") -> Label:
	_chat.visible = true
	return _chat.add(kind, text)

# --- Key HUD -----------------------------------------------------------------------

func show_keys(on: bool) -> void:
	_keys.visible = on

func light_key(keycode: int, down: bool) -> void:
	_keys.light(keycode, down)

# --- Drawn pieces ------------------------------------------------------------------

class Pointer extends Control:
	var ripple := -1.0:
		set(v):
			ripple = v
			queue_redraw()
	var pressed := false:
		set(v):
			pressed = v
			queue_redraw()

	func _init() -> void:
		mouse_filter = Control.MOUSE_FILTER_IGNORE

	func _draw() -> void:
		if ripple >= 0.0:
			draw_arc(Vector2.ZERO, 8.0 + ripple * 38.0, 0.0, TAU, 48, Color(ACCENT, 1.0 - ripple), 4.0, true)
		var k := 1.45
		var pts := PackedVector2Array([Vector2(0, 0), Vector2(0, 19), Vector2(4.6, 14.9), Vector2(8.1, 22.6),
			Vector2(11.3, 21.2), Vector2(7.8, 13.7), Vector2(13.4, 13.4)])
		for i in pts.size():
			pts[i] *= k
		var shadow := pts.duplicate()
		for i in shadow.size():
			shadow[i] += Vector2(3, 4)
		draw_colored_polygon(shadow, Color(0, 0, 0, 0.28))
		draw_colored_polygon(pts, Color(0.08, 0.08, 0.1) if pressed else Color.WHITE)
		var loop := pts.duplicate()
		loop.append(pts[0])
		draw_polyline(loop, Color.WHITE if pressed else Color(0.05, 0.05, 0.08), 2.2, true)

class Callout extends Control:
	var tip := Vector2.ZERO
	var dir := Vector2.LEFT       # unit vector from the tip toward the tail
	var progress := 0.0
	var length := 130.0
	var _t := 0.0
	var _bubble: PanelContainer
	var _view := Vector2(1600, 900)

	func setup(target: Rect2, text: String, side: String, view: Vector2) -> void:
		mouse_filter = Control.MOUSE_FILTER_IGNORE
		_view = view
		var gap := 10.0
		match side:
			"left":  dir = Vector2.LEFT;  tip = Vector2(target.position.x - gap, target.position.y + target.size.y * 0.5)
			"right": dir = Vector2.RIGHT; tip = Vector2(target.end.x + gap, target.position.y + target.size.y * 0.5)
			"above": dir = Vector2.UP;    tip = Vector2(target.position.x + target.size.x * 0.5, target.position.y - gap)
			_:       dir = Vector2.DOWN;  tip = Vector2(target.position.x + target.size.x * 0.5, target.end.y + gap)
		if not text.is_empty():
			_bubble = PanelContainer.new()
			_bubble.mouse_filter = Control.MOUSE_FILTER_IGNORE
			var sb := StyleBoxFlat.new()
			sb.bg_color = ACCENT
			sb.set_corner_radius_all(10)
			sb.content_margin_left = 16
			sb.content_margin_right = 16
			sb.content_margin_top = 8
			sb.content_margin_bottom = 10
			_bubble.add_theme_stylebox_override("panel", sb)
			var l := Label.new()
			l.text = text
			l.add_theme_font_size_override("font_size", 26)
			l.add_theme_color_override("font_color", INK)
			_bubble.add_child(l)
			add_child(_bubble)
		set_process(true)

	func _process(delta: float) -> void:
		_t += delta
		queue_redraw()
		if _bubble == null:
			return
		_bubble.reset_size()
		var tail := tip + dir * (length * progress + bob())
		var s := _bubble.size
		var p := tail
		if dir == Vector2.LEFT:    p = tail + Vector2(-s.x, -s.y * 0.5)
		elif dir == Vector2.RIGHT: p = tail + Vector2(0, -s.y * 0.5)
		elif dir == Vector2.UP:    p = tail + Vector2(-s.x * 0.5, -s.y)
		else:                      p = tail + Vector2(-s.x * 0.5, 0)
		p.x = clampf(p.x, 12.0, _view.x - s.x - 12.0)
		p.y = clampf(p.y, 12.0, _view.y - s.y - 12.0)
		_bubble.position = p
		_bubble.modulate.a = clampf(progress * 1.6 - 0.3, 0.0, 1.0)

	func bob() -> float:
		return sin(_t * 5.0) * 5.0 * progress

	func _draw() -> void:
		if progress <= 0.001:
			return
		var tip_p := tip + dir * bob() * 0.6
		var tail := tip + dir * (length * progress + bob())
		var head_len := 30.0
		var shaft_end := tip_p + dir * head_len
		var perp := Vector2(-dir.y, dir.x)
		var head := PackedVector2Array([tip_p, shaft_end + perp * 17.0, shaft_end - perp * 17.0])
		draw_line(tail, shaft_end, INK, 13.0, true)
		draw_colored_polygon(PackedVector2Array([tip_p + dir * -3.0, shaft_end + perp * 21.0, shaft_end - perp * 21.0]), INK)
		draw_line(tail, shaft_end, ACCENT, 7.0, true)
		draw_colored_polygon(head, ACCENT)

class KeysHud extends Control:
	# [keycode, label, grid position, width in keys, right-hand alternative]
	const _ROWS := [
		[[KEY_W, "W", Vector2(1, 0), 1.0, "↑"]],
		[[KEY_A, "A", Vector2(0, 1), 1.0, "←"], [KEY_S, "S", Vector2(1, 1), 1.0, "↓"], [KEY_D, "D", Vector2(2, 1), 1.0, "→"]],
		[[KEY_SPACE, "Space", Vector2(0, 2), 2.0, "R-Ctrl"], [KEY_SHIFT, "Shift", Vector2(2, 2), 1.4, "/"]],
	]
	var _down := {}

	func _init() -> void:
		mouse_filter = Control.MOUSE_FILTER_IGNORE

	func light(keycode: int, down: bool) -> void:
		_down[keycode] = down
		queue_redraw()

	func _draw() -> void:
		var unit := 66.0
		var font := ThemeDB.fallback_font
		for row in _ROWS:
			for k in row:
				var lit: bool = _down.get(k[0], false)
				var pos: Vector2 = Vector2(k[2].x * (unit + 8), k[2].y * (unit + 8))
				var rect := Rect2(pos, Vector2(unit * k[3] + (k[3] - 1.0) * 8.0, unit))
				var sb := StyleBoxFlat.new()
				sb.bg_color = ACCENT if lit else Color(0.05, 0.06, 0.08, 0.85)
				sb.set_corner_radius_all(10)
				sb.border_color = ACCENT if lit else Color(0.5, 0.55, 0.62, 0.9)
				sb.set_border_width_all(2)
				draw_style_box(sb, rect)
				var label: String = k[1]
				var fs := 28 if label.length() == 1 else 22
				var ts := font.get_string_size(label, HORIZONTAL_ALIGNMENT_LEFT, -1, fs)
				draw_string(font, rect.position + Vector2((rect.size.x - ts.x) * 0.5, (rect.size.y + ts.y * 0.62) * 0.5 - 6.0),
					label, HORIZONTAL_ALIGNMENT_LEFT, -1, fs, INK if lit else Color.WHITE)
				# The right-hand alternative, small, in the corner: the same movement for
				# someone whose mouse hand is the left one.
				var alt: String = k[4]
				var af := 15
				var as_ := font.get_string_size(alt, HORIZONTAL_ALIGNMENT_LEFT, -1, af)
				draw_string(font, rect.position + Vector2((rect.size.x - as_.x) * 0.5, rect.size.y - 8.0),
					alt, HORIZONTAL_ALIGNMENT_LEFT, -1, af, INK if lit else Color(ACCENT, 0.95))
		draw_string(font, Vector2(0, 3 * (unit + 8) + 6.0), "small print = right-hand keys",
			HORIZONTAL_ALIGNMENT_LEFT, -1, 17, Color(ACCENT, 0.9))

class ChatCard extends PanelContainer:
	const WIDTH := 520.0
	var _box: VBoxContainer
	var _mono: SystemFont

	func _init() -> void:
		mouse_filter = Control.MOUSE_FILTER_IGNORE
		custom_minimum_size.x = WIDTH
		var sb := StyleBoxFlat.new()
		sb.bg_color = Color(0.04, 0.05, 0.07, 0.94)
		sb.set_corner_radius_all(14)
		sb.border_color = Color(ACCENT, 0.7)
		sb.set_border_width_all(2)
		sb.content_margin_left = 20
		sb.content_margin_right = 20
		sb.content_margin_top = 14
		sb.content_margin_bottom = 16
		add_theme_stylebox_override("panel", sb)
		_mono = SystemFont.new()
		_mono.font_names = PackedStringArray(["Consolas", "Cascadia Mono", "Courier New", "monospace"])
		var col := VBoxContainer.new()
		col.add_theme_constant_override("separation", 10)
		add_child(col)
		var head := Label.new()
		head.text = "●  Your agent  ·  connected over MCP"
		head.add_theme_font_size_override("font_size", 20)
		head.add_theme_color_override("font_color", ACCENT)
		col.add_child(head)
		col.add_child(HSeparator.new())
		_box = VBoxContainer.new()
		_box.add_theme_constant_override("separation", 12)
		col.add_child(_box)

	func clear() -> void:
		for c in _box.get_children():
			c.queue_free()
		reset_size()

	func add(kind: String, text: String) -> Label:
		var l := Label.new()
		l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		l.custom_minimum_size.x = WIDTH - 40.0
		l.text = text
		match kind:
			"user":
				l.add_theme_font_size_override("font_size", 25)
				l.add_theme_color_override("font_color", Color.WHITE)
				var bubble := PanelContainer.new()
				var sb := StyleBoxFlat.new()
				sb.bg_color = Color(0.16, 0.2, 0.27)
				sb.set_corner_radius_all(10)
				sb.content_margin_left = 14
				sb.content_margin_right = 14
				sb.content_margin_top = 8
				sb.content_margin_bottom = 9
				bubble.add_theme_stylebox_override("panel", sb)
				l.custom_minimum_size.x = WIDTH - 68.0
				bubble.add_child(l)
				_box.add_child(bubble)
			"tool":
				l.add_theme_font_override("font", _mono)
				l.add_theme_font_size_override("font_size", 19)
				l.add_theme_color_override("font_color", Color(0.62, 0.9, 1.0))
				_box.add_child(l)
			_:
				l.add_theme_font_size_override("font_size", 25)
				l.add_theme_color_override("font_color", Color(0.88, 0.92, 0.96))
				_box.add_child(l)
		reset_size()
		return l
