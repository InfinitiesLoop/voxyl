class_name CaptureService
extends Node

# Offscreen renders for agents — never touching the user's panes or cameras. It owns:
#   - a private View3D (flagged offscreen) inside a hidden SubViewport. View3D already builds
#     the whole scene — environment, lights, meshes — and follows VoxelWorld's signals, so
#     it always shows the live build; this just points its camera and reads frames back.
#   - a 2D "stage" SubViewport that composites renders with labels: a caption strip, an
#     axes gizmo, an intent legend, and sheets of captioned tiles. The model can't hover, so
#     every image says what it shows.
#   - a small lit "swatch" scene for block swatches (the shared block renderer + light rig).
# Rendering needs the window to be drawing: a minimized Voxyl can't capture (reported).

const DEFAULT_SIZE := Vector2i(1280, 720)
const CAPTION_H := 30
const DRAW_TIMEOUT_MS := 4000
const SWATCH_RES := 176
const _SWATCH_CELL_WORLD := 1.85
const _SWATCH_CAM_DIR := Vector3(-0.9, 1.0, -1.2)

var _host: SubViewport
var _view: View3D
var _stage: SubViewport
var _swatch_vp: SubViewport
var _swatch_cam: Camera3D
var _cameras := {}    # capture_id -> camera dict
var _next_id := 1
var _drawn := false

func _ready() -> void:
	_host = SubViewport.new()
	_host.size = DEFAULT_SIZE
	_host.render_target_update_mode = SubViewport.UPDATE_DISABLED
	add_child(_host)
	_view = View3D.new()
	_view.offscreen = true
	_host.add_child(_view)
	_view.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_view.set_active(false)
	_stage = SubViewport.new()
	_stage.disable_3d = true
	_stage.transparent_bg = false
	_stage.render_target_update_mode = SubViewport.UPDATE_DISABLED
	add_child(_stage)

func is_rendering_available() -> bool:
	return DisplayServer.get_name() != "headless"

# --- 3D renders ---------------------------------------------------------------------

# Render the live build. `pose` = { pos, target, fov, ortho_size (0 = perspective) },
# `render` = RenderSpec ({mode, lighting, background, ...}), `marker` = [min, max] cells to
# outline or []. Returns the Image, or null if the window isn't drawing.
func render(pose: Dictionary, render_spec: Dictionary, size: Vector2i, marker: Array = []) -> Image:
	_host.size = size
	_view.set_viewport_size(size)
	var opts := ViewOptions.defaults()
	opts["projection"] = "orthographic" if float(pose.get("ortho_size", 0.0)) > 0.0 else "perspective"
	opts.merge(render_spec, true)
	_view.set_render_options(opts)
	_view.set_camera_pose(pose["pos"], pose["target"], float(pose.get("fov", 50.0)), float(pose.get("ortho_size", 0.0)))
	if marker.size() == 2:
		_view.set_marker_box(marker[0], marker[1])
	else:
		_view.set_marker_box(null)
	await get_tree().process_frame   # layout + the view's deferred mesh flush
	_view.render_once()
	if not await wait_draw():
		return null
	var img := _view.viewport_image()
	return img if img != null and not img.is_empty() else null

func camera_basis() -> Dictionary:
	return _view.camera_info()

# The aspect of an output size (for framing).
static func aspect_of(size: Vector2i) -> float:
	return float(size.x) / maxf(1.0, float(size.y))

func remember_camera(cam: Dictionary) -> int:
	var id := _next_id
	_next_id += 1
	_cameras[id] = cam
	return id

func camera_for(id: int) -> Dictionary:
	return _cameras.get(id, {})

func wait_draw() -> bool:
	_drawn = false
	RenderingServer.frame_post_draw.connect(_on_drawn, CONNECT_ONE_SHOT)
	var t0 := Time.get_ticks_msec()
	while not _drawn:
		if Time.get_ticks_msec() - t0 > DRAW_TIMEOUT_MS:
			if RenderingServer.frame_post_draw.is_connected(_on_drawn):
				RenderingServer.frame_post_draw.disconnect(_on_drawn)
			return false
		await get_tree().process_frame
	return true

func _on_drawn() -> void:
	_drawn = true

# --- Compositing --------------------------------------------------------------------

# Lay out tiles on the stage and read the sheet back. Each tile: { image, caption, gizmo?
# ({right, up} camera axes), legend? ([[name, Color], ...]) }. `title` goes on top.
func compose(tiles: Array, cols: int, tile_size: Vector2i, title := "") -> Image:
	for c in _stage.get_children():
		c.free()
	cols = clampi(cols, 1, maxi(1, tiles.size()))
	var rows := ceili(float(tiles.size()) / cols)
	var title_h := 34 if not title.is_empty() else 0
	var cell := Vector2i(tile_size.x, tile_size.y + CAPTION_H)
	var total := Vector2i(cell.x * cols, cell.y * rows + title_h)
	_stage.size = total
	var root := Control.new()
	root.size = Vector2(total)
	_stage.add_child(root)
	var bg := ColorRect.new()
	bg.color = Color(0.09, 0.09, 0.11)
	bg.size = Vector2(total)
	root.add_child(bg)
	if title_h > 0:
		root.add_child(_label(title, Vector2(10, 5), 17, Color(0.95, 0.95, 0.97)))
	for i in tiles.size():
		var t: Dictionary = tiles[i]
		var origin := Vector2((i % cols) * cell.x, title_h + (i / cols) * cell.y)
		var tex := TextureRect.new()
		tex.texture = ImageTexture.create_from_image(t["image"])
		tex.position = origin
		tex.size = Vector2(tile_size)
		tex.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		tex.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		root.add_child(tex)
		var strip := ColorRect.new()
		strip.color = Color(0.13, 0.13, 0.16)
		strip.position = origin + Vector2(0, tile_size.y)
		strip.size = Vector2(tile_size.x, CAPTION_H)
		root.add_child(strip)
		root.add_child(_label(str(t.get("caption", "")), origin + Vector2(8, tile_size.y + 6), 13, Color(0.86, 0.87, 0.9)))
		if t.get("gizmo") is Dictionary:
			var g := AxesGizmo.new()
			g.axes = t["gizmo"]
			g.position = origin + Vector2(8, tile_size.y - 86)
			g.size = Vector2(80, 80)
			root.add_child(g)
		if t.get("legend") is Array and not (t["legend"] as Array).is_empty():
			root.add_child(_legend(t["legend"], origin + Vector2(tile_size.x - 190, 8)))
		if cols > 1 or rows > 1:
			var border := ReferenceRect.new()
			border.border_color = Color(0.25, 0.25, 0.3)
			border.editor_only = false
			border.position = origin
			border.size = Vector2(cell)
			root.add_child(border)
	await get_tree().process_frame
	_stage.render_target_update_mode = SubViewport.UPDATE_ONCE
	if not await wait_draw():
		return null
	var img := _stage.get_texture().get_image()
	for c in _stage.get_children():
		c.queue_free()
	return img

func _label(text: String, pos: Vector2, font_size: int, color: Color) -> Label:
	var l := Label.new()
	l.text = text
	l.position = pos
	l.add_theme_font_size_override("font_size", font_size)
	l.add_theme_color_override("font_color", color)
	l.add_theme_color_override("font_shadow_color", Color(0, 0, 0, 0.8))
	l.add_theme_constant_override("shadow_offset_x", 1)
	l.add_theme_constant_override("shadow_offset_y", 1)
	return l

func _legend(entries: Array, pos: Vector2) -> Control:
	var panel := PanelContainer.new()
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.05, 0.05, 0.07, 0.8)
	sb.set_content_margin_all(6)
	sb.set_corner_radius_all(4)
	panel.add_theme_stylebox_override("panel", sb)
	panel.position = pos
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 2)
	panel.add_child(box)
	for e in entries.slice(0, 24):
		var row := HBoxContainer.new()
		var sw := ColorRect.new()
		sw.color = e[1]
		sw.custom_minimum_size = Vector2(14, 14)
		row.add_child(sw)
		var l := Label.new()
		l.text = str(e[0])
		l.add_theme_font_size_override("font_size", 12)
		row.add_child(l)
		box.add_child(row)
	return panel

# --- Block swatches -----------------------------------------------------------------

# Lit cubes of block types in a grid (the same renderer and light rig as the inventory
# icons, at a readable size). items: [{ bt: BlockType, caption }]. Returns one Image per item
# (null entries when the window isn't drawing).
func swatch_images(items: Array) -> Array:
	_ensure_swatch_scene()
	var n := items.size()
	var cols := maxi(1, ceili(sqrt(float(n))))
	var rows := maxi(1, ceili(float(n) / cols))
	_swatch_vp.size = Vector2i(cols * SWATCH_RES, rows * SWATCH_RES)
	_swatch_cam.set_orthogonal(rows * _SWATCH_CELL_WORLD, 0.05, 100.0)
	var holder: Node3D = _swatch_vp.get_node("Holder")
	for c in holder.get_children():
		c.free()
	var right := _swatch_cam.transform.basis.x
	var up := _swatch_cam.transform.basis.y
	for i in n:
		var slot := Node3D.new()
		slot.position = right * (((i % cols) + 0.5 - cols * 0.5) * _SWATCH_CELL_WORLD) \
			+ up * ((rows * 0.5 - (i / cols) - 0.5) * _SWATCH_CELL_WORLD)
		holder.add_child(slot)
		var mi := MeshInstance3D.new()
		slot.add_child(mi)
		BlockRender3D.build_into(mi, items[i]["bt"])
	await get_tree().process_frame
	_swatch_vp.render_target_update_mode = SubViewport.UPDATE_ONCE
	if not await wait_draw():
		return []
	var atlas := _swatch_vp.get_texture().get_image()
	var out: Array = []
	for i in n:
		out.append(atlas.get_region(Rect2i((i % cols) * SWATCH_RES, (i / cols) * SWATCH_RES, SWATCH_RES, SWATCH_RES)))
	return out

func _ensure_swatch_scene() -> void:
	if _swatch_vp != null:
		return
	_swatch_vp = SubViewport.new()
	_swatch_vp.own_world_3d = true
	_swatch_vp.transparent_bg = false
	_swatch_vp.render_target_update_mode = SubViewport.UPDATE_DISABLED
	add_child(_swatch_vp)
	BlockLightRig.apply(_swatch_vp, _SWATCH_CAM_DIR)
	for c in _swatch_vp.get_children():
		if c is WorldEnvironment:
			(c as WorldEnvironment).environment.background_mode = Environment.BG_COLOR
			(c as WorldEnvironment).environment.background_color = Color(0.16, 0.16, 0.19)
	_swatch_cam = Camera3D.new()
	_swatch_vp.add_child(_swatch_cam)
	_swatch_cam.position = _SWATCH_CAM_DIR.normalized() * 6.0
	_swatch_cam.look_at(Vector3.ZERO, Vector3.UP)
	var holder := Node3D.new()
	holder.name = "Holder"
	_swatch_vp.add_child(holder)

# --- Saving -------------------------------------------------------------------------

func save(img: Image, stem: String) -> String:
	DirAccess.make_dir_recursive_absolute(AppSettings.captures_dir)
	var path := AppSettings.captures_dir.path_join("%s.png" % stem.validate_filename())
	img.save_png(path)
	return ProjectSettings.globalize_path(path)

# The compass rose drawn over a render: world east (+X), south (+Z) and up (+Y) as seen by
# the camera, so "which way is north" is never a guess.
class AxesGizmo extends Control:
	var axes := {}   # { right: Vector3, up: Vector3 } — the camera's screen axes in world space

	func _draw() -> void:
		var c := size * 0.5
		draw_circle(c, 38.0, Color(0, 0, 0, 0.45))
		var font := ThemeDB.fallback_font
		for a in [[Vector3.RIGHT, "E", Color(0.95, 0.4, 0.35)], [Vector3.BACK, "S", Color(0.4, 0.6, 1.0)],
				[Vector3.UP, "U", Color(0.45, 0.9, 0.5)], [Vector3.FORWARD, "N", Color(0.75, 0.75, 0.78)]]:
			var w: Vector3 = a[0]
			var d := Vector2(w.dot(axes.get("right", Vector3.RIGHT)), -w.dot(axes.get("up", Vector3.UP)))
			var tip := c + d * 26.0
			draw_line(c, tip, a[2], 2.0 if a[1] != "N" else 1.0, true)
			if d.length() > 0.2 or a[1] == "U":
				draw_string(font, tip + d.normalized() * 7.0 - Vector2(4, -5), a[1], HORIZONTAL_ALIGNMENT_LEFT, -1, 13, a[2])
