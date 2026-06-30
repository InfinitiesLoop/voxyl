class_name View2DGrid
extends VBoxContainer

# Emitted on a mouse press in the grid so the shell can focus this pane.
signal focus_requested

const CELL_SIZE := 32
const VIEW_PADDING := 4
# Minimum in-plane radius (in cells) drawn around the center, so a slice that
# sits outside the build still presents a usable canvas.
const CENTER_RADIUS := 10
# Zoom limits, in pixels-per-cell.
const MIN_CELL_PX := 8.0
const MAX_CELL_PX := 96.0
# Guideline showing where another view's active slice crosses this one (amber).
const GUIDE_FILL := Color(1.0, 0.6, 0.2, 0.12)
const GUIDE_LINE := Color(1.0, 0.65, 0.25, 0.85)

# Slice configuration
# axis 0=X (slice is YZ plane), 1=Y (slice is XZ plane), 2=Z (slice is XY plane)
var axis := 1
var slice_pos := 0
# World cell this view is centered on (kept centered in the GridArea).
var _center := Vector3i.ZERO

var _is_placing := false
var _is_erasing := false
var _drag_start := Vector2i(-1, -1)
var _preview_cells: Array[Vector2i] = []
# Orientation for the in-progress stroke, derived from which quadrant of the cell
# the press landed in (so a click already orients stairs/slabs sensibly).
var _place_orientation := 0

# View transform (pan/zoom).
var _cell_px := float(CELL_SIZE)
var _user_pan := Vector2.ZERO
var _panning := false
var _pan_last := Vector2.ZERO

# Set by the shell (focus).
var _active := true

# Set true while the inventory overlay is up, gating this view's input.
var _suspended := false

# In-plane view orientation.
# _rotation (0–3) rotates the grid 90° CW per step (like turning a map).
# _mirror_h flips left/right within the current rotation, toggled with F.
# Together they determine which world directions map to screen right and down.
var _rotation := 0
var _mirror_h := false

# Another view's active slice, broadcast by the shell: {axis, offset} or {}.
var _guide: Dictionary = {}

@onready var _layer_label: Label = $Toolbar/LayerBar/LayerLabel
@onready var _grid_area: Control = $GridArea

func configure(p_axis: int, p_center: Vector3i, p_flipped: bool = false) -> void:
	axis = p_axis
	_center = p_center
	slice_pos = p_center[axis]
	_mirror_h = p_flipped
	_rotation = 0
	if is_inside_tree():
		_reset()

func _ready() -> void:
	# Style the toolbar bar — dark tray with a subtle bottom border.
	var bar_style := StyleBoxFlat.new()
	bar_style.bg_color = Color(0.13, 0.13, 0.15)
	bar_style.border_width_bottom = 1
	bar_style.border_color = Color(0.28, 0.28, 0.32)
	bar_style.content_margin_left = 2
	bar_style.content_margin_right = 2
	bar_style.content_margin_top = 2
	bar_style.content_margin_bottom = 2
	($Toolbar as PanelContainer).add_theme_stylebox_override("panel", bar_style)

	_grid_area.clip_contents = true
	_grid_area.draw.connect(_draw_grid)
	_grid_area.gui_input.connect(_on_grid_input)
	VoxelWorld.block_changed.connect(func(_p, _s): _grid_area.queue_redraw())
	VoxelWorld.palette_stack_changed.connect(_grid_area.queue_redraw)
	VoxelWorld.block_type_changed.connect(_grid_area.queue_redraw)
	VoxelWorld.project_opened.connect(func(_p): _reset())
	_update_slice_label()

# ---------------------------------------------------------------------------
# View orientation — in-plane axis vectors
# ---------------------------------------------------------------------------
# The grid has two screen-space axes: h (horizontal, +right) and v (vertical,
# +down). Each maps to a world direction. _rotation cycles these 90° CW per
# step; _mirror_h negates the h direction within the current rotation.
#
# Rotation tables for _base_h_dir / _base_v_dir are derived by the 90° CW
# rule: new_h = -old_v, new_v = old_h. Verified for all three slice axes.

# World direction that screen-right (+h) corresponds to, before mirroring.
func _base_h_dir() -> Vector3i:
	match axis:
		0:  # X-slice (YZ plane): in-plane world axes are Y and Z
			match _rotation:
				1: return Vector3i(0, 1, 0)
				2: return Vector3i(0, 0, -1)
				3: return Vector3i(0, -1, 0)
				_: return Vector3i(0, 0, 1)
		1:  # Y-slice (XZ plane): in-plane world axes are X and Z
			match _rotation:
				1: return Vector3i(0, 0, -1)
				2: return Vector3i(-1, 0, 0)
				3: return Vector3i(0, 0, 1)
				_: return Vector3i(1, 0, 0)
		_:  # Z-slice (XY plane): in-plane world axes are X and Y
			match _rotation:
				1: return Vector3i(0, 1, 0)
				2: return Vector3i(-1, 0, 0)
				3: return Vector3i(0, -1, 0)
				_: return Vector3i(1, 0, 0)

# World direction that screen-down (+v) corresponds to.
func _base_v_dir() -> Vector3i:
	match axis:
		0:
			match _rotation:
				1: return Vector3i(0, 0, 1)
				2: return Vector3i(0, 1, 0)
				3: return Vector3i(0, 0, -1)
				_: return Vector3i(0, -1, 0)
		1:
			match _rotation:
				1: return Vector3i(1, 0, 0)
				2: return Vector3i(0, 0, -1)
				3: return Vector3i(-1, 0, 0)
				_: return Vector3i(0, 0, 1)
		_:
			match _rotation:
				1: return Vector3i(1, 0, 0)
				2: return Vector3i(0, 1, 0)
				3: return Vector3i(-1, 0, 0)
				_: return Vector3i(0, -1, 0)

func _get_h_dir() -> Vector3i:
	return -_base_h_dir() if _mirror_h else _base_h_dir()

func _get_v_dir() -> Vector3i:
	return _base_v_dir()

# Index (0=X, 1=Y, 2=Z) of the nonzero component of a cardinal unit vector.
static func _dir_axis(d: Vector3i) -> int:
	if d.x != 0: return 0
	if d.y != 0: return 1
	return 2

# ---------------------------------------------------------------------------
# Bounding box / slice extents
# ---------------------------------------------------------------------------

func _get_view_min() -> Vector3i:
	var lo := _center - Vector3i(CENTER_RADIUS, CENTER_RADIUS, CENTER_RADIUS)
	if not VoxelWorld.active_project:
		return lo
	var aabb := VoxelWorld.active_project.data.get_used_aabb()
	if aabb.is_empty():
		return lo
	var amin := (aabb[0] as Vector3i) - Vector3i(VIEW_PADDING, VIEW_PADDING, VIEW_PADDING)
	return Vector3i(mini(lo.x, amin.x), mini(lo.y, amin.y), mini(lo.z, amin.z))

func _get_view_max() -> Vector3i:
	var hi := _center + Vector3i(CENTER_RADIUS, CENTER_RADIUS, CENTER_RADIUS)
	if not VoxelWorld.active_project:
		return hi
	var aabb := VoxelWorld.active_project.data.get_used_aabb()
	if aabb.is_empty():
		return hi
	var amax := (aabb[1] as Vector3i) + Vector3i(VIEW_PADDING, VIEW_PADDING, VIEW_PADDING)
	return Vector3i(maxi(hi.x, amax.x), maxi(hi.y, amax.y), maxi(hi.z, amax.z))

func _get_min_slice() -> int:
	return _get_view_min()[axis]

func _get_max_slice() -> int:
	return _get_view_max()[axis]

# ---------------------------------------------------------------------------
# Grid coordinate mapping
# ---------------------------------------------------------------------------

# Map 2D (h, v) screen grid coordinates to a world Vector3i.
# h=0 is the left column, v=0 is the top row.
func _grid_to_world(h: int, v: int) -> Vector3i:
	var mn := _get_view_min()
	var mx := _get_view_max()
	var hd := _get_h_dir()
	var vd := _get_v_dir()
	var ha := _dir_axis(hd)
	var va := _dir_axis(vd)
	var result := Vector3i.ZERO
	result[axis] = slice_pos
	result[ha] = mn[ha] + h if hd[ha] > 0 else mx[ha] - h
	result[va] = mn[va] + v if vd[va] > 0 else mx[va] - v
	return result

func _get_grid_w() -> int:
	var mn := _get_view_min(); var mx := _get_view_max()
	var ha := _dir_axis(_get_h_dir())
	return mx[ha] - mn[ha] + 1

func _get_grid_h() -> int:
	var mn := _get_view_min(); var mx := _get_view_max()
	var va := _dir_axis(_get_v_dir())
	return mx[va] - mn[va] + 1

# In-plane (h, v) grid coordinate of the center cell.
func _center_hv() -> Vector2i:
	var mn := _get_view_min()
	var mx := _get_view_max()
	var hd := _get_h_dir()
	var vd := _get_v_dir()
	var ha := _dir_axis(hd)
	var va := _dir_axis(vd)
	var ch := _center[ha] - mn[ha] if hd[ha] > 0 else mx[ha] - _center[ha]
	var cv := _center[va] - mn[va] if vd[va] > 0 else mx[va] - _center[va]
	return Vector2i(ch, cv)

# Screen position of grid cell (0,0)'s top-left.
func _auto_center_origin() -> Vector2:
	var hv := _center_hv()
	return _grid_area.size * 0.5 - (Vector2(hv) + Vector2(0.5, 0.5)) * _cell_px

func _draw_origin() -> Vector2:
	return _auto_center_origin() + _user_pan

# Where a perpendicular active slice crosses this plane as a col or row line.
func _guide_line() -> Dictionary:
	if _guide.is_empty():
		return {}
	var g_axis: int = _guide["axis"]
	var g_off: int = _guide["offset"]
	if g_axis == axis:
		return {}
	var mn := _get_view_min()
	var mx := _get_view_max()
	var hd := _get_h_dir()
	var vd := _get_v_dir()
	var ha := _dir_axis(hd)
	var va := _dir_axis(vd)
	if g_axis == ha:
		return {"col": g_off - mn[ha] if hd[ha] > 0 else mx[ha] - g_off}
	return {"row": g_off - mn[va] if vd[va] > 0 else mx[va] - g_off}

# Screen-space unit direction (right=+x, down=+y) for a world facing in this slice.
# Zero means the facing is perpendicular to the plane (points into/out of screen).
func _facing_screen_dir(facing: int) -> Vector2:
	var d: Vector3i = Orientation.DIRS[facing]
	var hd := _get_h_dir()
	var vd := _get_v_dir()
	var ha := _dir_axis(hd)
	var va := _dir_axis(vd)
	return Vector2(float(d[ha] * hd[ha]), float(d[va] * vd[va]))

# ---------------------------------------------------------------------------
# Reset / label
# ---------------------------------------------------------------------------

func _reset() -> void:
	_cell_px = float(CELL_SIZE)
	_user_pan = Vector2.ZERO
	_panning = false
	_preview_cells.clear()
	_drag_start = Vector2i(-1, -1)
	_update_slice_label()
	_grid_area.queue_redraw()

func _update_slice_label() -> void:
	var axis_name: String = (["X", "Y", "Z"] as Array)[axis]
	_layer_label.text = "%s = %d" % [axis_name, slice_pos]

# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------

func _draw_grid() -> void:
	if not VoxelWorld.active_project:
		return
	var data := VoxelWorld.active_project.data
	var origin := _draw_origin()
	var cell_dim := Vector2(_cell_px - 1.0, _cell_px - 1.0)
	for h in _get_grid_w():
		for v in _get_grid_h():
			var rect := Rect2(origin + Vector2(h, v) * _cell_px, cell_dim)
			var world := _grid_to_world(h, v)
			var semantic := data.get_block(world)
			var fill: Color
			if semantic.is_empty():
				fill = Color(0.12, 0.12, 0.12)
			else:
				fill = VoxelWorld.get_color_for_semantic(semantic)
			_grid_area.draw_rect(rect, fill)
			_grid_area.draw_rect(rect, Color(0.22, 0.22, 0.22), false)
			if not semantic.is_empty() and VoxelWorld.get_shape_for_semantic(semantic) != BlockType.Shape.FULL:
				_draw_facing_glyph(rect, data.get_orientation(world))

	if not _preview_cells.is_empty():
		var preview_color := VoxelWorld.get_color_for_semantic(VoxelWorld.selected_semantic)
		preview_color.a = 0.65
		for cell in _preview_cells:
			var rect := Rect2(origin + Vector2(cell) * _cell_px, cell_dim)
			_grid_area.draw_rect(rect, preview_color)

	var gl := _guide_line()
	if gl.has("col"):
		var gx := origin.x + int(gl["col"]) * _cell_px
		_grid_area.draw_rect(Rect2(gx, 0, _cell_px, _grid_area.size.y), GUIDE_FILL)
		_grid_area.draw_line(Vector2(gx + _cell_px * 0.5, 0),
			Vector2(gx + _cell_px * 0.5, _grid_area.size.y), GUIDE_LINE, 1.5)
	elif gl.has("row"):
		var gy := origin.y + int(gl["row"]) * _cell_px
		_grid_area.draw_rect(Rect2(0, gy, _grid_area.size.x, _cell_px), GUIDE_FILL)
		_grid_area.draw_line(Vector2(0, gy + _cell_px * 0.5),
			Vector2(_grid_area.size.x, gy + _cell_px * 0.5), GUIDE_LINE, 1.5)

	_draw_hint()

# Facing arrow for an oriented cell, mapped into this slice's screen space.
# A facing perpendicular to the plane is drawn as a diamond.
# Two redundant cues distinguish top-half (upside-down) from bottom-half:
#   • bottom-half → SOLID arrowhead, white fill
#   • top-half    → HOLLOW (outlined) arrowhead, blue tint, + a bar on the shaft
const _GLYPH_OUTLINE := Color(0, 0, 0, 0.8)

func _draw_facing_glyph(rect: Rect2, orientation: int) -> void:
	var top := Orientation.is_top(orientation)
	var dir := _facing_screen_dir(Orientation.facing_of(orientation))
	var col := Color(0.5, 0.8, 1.0, 0.97) if top else Color(1, 1, 1, 0.95)
	var c := rect.position + rect.size * 0.5
	var s := minf(rect.size.x, rect.size.y)
	if dir == Vector2.ZERO:
		var d := s * 0.16
		var dia := PackedVector2Array([c + Vector2(0, -d), c + Vector2(d, 0), c + Vector2(0, d), c + Vector2(-d, 0)])
		_glyph_poly(dia, col, not top)
		return
	var perp := Vector2(-dir.y, dir.x)
	var reach := s * 0.30
	var back := c - dir * (reach * 0.55)
	var hw := s * 0.17
	var head := PackedVector2Array([c + dir * reach, back + perp * hw, back - perp * hw])
	var shaft_w := maxf(1.5, s * 0.05)
	_grid_area.draw_line(c - dir * reach, back, _GLYPH_OUTLINE, shaft_w + 2.0)
	_grid_area.draw_line(c - dir * reach, back, col, shaft_w)
	_glyph_poly(head, col, not top)
	if top:
		_grid_area.draw_line(c - perp * (hw * 0.9), c + perp * (hw * 0.9), col, shaft_w)

func _glyph_poly(pts: PackedVector2Array, col: Color, solid: bool) -> void:
	var closed := pts.duplicate()
	closed.append(pts[0])
	if solid:
		_grid_area.draw_colored_polygon(pts, col)
		_grid_area.draw_polyline(closed, _GLYPH_OUTLINE, 1.5)
	else:
		_grid_area.draw_polyline(closed, _GLYPH_OUTLINE, 3.0)
		_grid_area.draw_polyline(closed, col, 1.8)

func _draw_hint() -> void:
	var font := ThemeDB.fallback_font
	var hint := "LMB paint (quadrant orients) · RMB erase · R rotate · Shift+R flip · Scroll slot · Shift+Scroll zoom · Mid-drag pan · ▲/▼ layer · ↺/↻ rotate view · F mirror"
	var fs := 12
	var tw := font.get_string_size(hint, HORIZONTAL_ALIGNMENT_LEFT, -1, fs).x
	var y := _grid_area.size.y - 6.0
	_grid_area.draw_rect(Rect2(4.0, y - 14.0, tw + 10.0, 18.0), Color(0, 0, 0, 0.45))
	_grid_area.draw_string(font, Vector2(9.0, y), hint,
		HORIZONTAL_ALIGNMENT_LEFT, -1, fs, Color(1, 1, 1, 0.7))

# ---------------------------------------------------------------------------
# Input
# ---------------------------------------------------------------------------

func _mouse_to_cell(mouse_pos: Vector2) -> Vector2i:
	var origin := _draw_origin()
	return Vector2i(
		floori((mouse_pos.x - origin.x) / _cell_px),
		floori((mouse_pos.y - origin.y) / _cell_px)
	)

# Zoom toward the cursor: the grid point under `anchor` stays under it.
func _zoom_at(anchor: Vector2, factor: float) -> void:
	var new_px := clampf(_cell_px * factor, MIN_CELL_PX, MAX_CELL_PX)
	if is_equal_approx(new_px, _cell_px):
		return
	var grid_point := (anchor - _draw_origin()) / _cell_px
	_cell_px = new_px
	_user_pan += anchor - (_draw_origin() + grid_point * _cell_px)
	_grid_area.queue_redraw()

func _on_grid_input(event: InputEvent) -> void:
	if _suspended:
		return
	if event is InputEventMouseButton and (event as InputEventMouseButton).pressed and not _active:
		focus_requested.emit()
		_grid_area.accept_event()
		return
	var tool := VoxelWorld.active_tool
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_LEFT:
			if mb.pressed:
				var cell := _mouse_to_cell(mb.position)
				_place_orientation = _orientation_from_pos(mb.position)
				match tool:
					VoxelWorld.Tool.PAINT:
						_is_placing = true
						_paint_cell(cell)
					VoxelWorld.Tool.ERASE:
						_is_erasing = true
						_paint_cell(cell)
					VoxelWorld.Tool.FILL:
						_do_fill(cell)
					VoxelWorld.Tool.LINE, VoxelWorld.Tool.RECT:
						_drag_start = cell
						_preview_cells = [cell]
						_grid_area.queue_redraw()
			else:
				if _drag_start != Vector2i(-1, -1):
					_commit_preview()
				_is_placing = false
				_is_erasing = false
		elif mb.button_index == MOUSE_BUTTON_RIGHT:
			_is_erasing = mb.pressed
			_is_placing = false
			if mb.pressed:
				_paint_cell(_mouse_to_cell(mb.position))
		elif mb.button_index == MOUSE_BUTTON_MIDDLE:
			_panning = mb.pressed
			_pan_last = mb.position
		elif mb.button_index == MOUSE_BUTTON_WHEEL_UP:
			if mb.pressed:
				if mb.shift_pressed: _zoom_at(mb.position, 1.15)
				else: _cycle_hotbar(-1)
		elif mb.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			if mb.pressed:
				if mb.shift_pressed: _zoom_at(mb.position, 1.0 / 1.15)
				else: _cycle_hotbar(1)
	elif event is InputEventMouseMotion:
		if _panning:
			if Input.is_mouse_button_pressed(MOUSE_BUTTON_MIDDLE):
				_user_pan += event.position - _pan_last
				_pan_last = event.position
				_grid_area.queue_redraw()
			else:
				_panning = false
		elif _is_placing or _is_erasing:
			_paint_cell(_mouse_to_cell(event.position))
		elif _drag_start != Vector2i(-1, -1):
			var cell := _mouse_to_cell(event.position)
			match tool:
				VoxelWorld.Tool.LINE:
					_preview_cells = _compute_line(_drag_start, cell)
				VoxelWorld.Tool.RECT:
					_preview_cells = _compute_rect(_drag_start, cell)
			_grid_area.queue_redraw()

func _paint_cell(cell: Vector2i) -> void:
	if not VoxelWorld.active_project:
		return
	var pos := _grid_to_world(cell.x, cell.y)
	if _is_erasing:
		VoxelWorld.clear_block(pos)
	elif _is_placing and not VoxelWorld.selected_semantic.is_empty():
		VoxelWorld.set_block(pos, VoxelWorld.selected_semantic, _place_orientation)

func _commit_preview() -> void:
	if not VoxelWorld.active_project:
		return
	for cell in _preview_cells:
		var pos := _grid_to_world(cell.x, cell.y)
		if VoxelWorld.selected_semantic.is_empty():
			VoxelWorld.clear_block(pos)
		else:
			VoxelWorld.set_block(pos, VoxelWorld.selected_semantic, _place_orientation)
	_preview_cells = []
	_drag_start = Vector2i(-1, -1)

func _compute_line(a: Vector2i, b: Vector2i) -> Array[Vector2i]:
	var cells: Array[Vector2i] = []
	var dx := b.x - a.x
	var dy := b.y - a.y
	var steps: int = max(abs(dx), abs(dy))
	if steps == 0:
		return [a]
	for i in steps + 1:
		var t := float(i) / float(steps)
		cells.append(Vector2i(roundi(a.x + dx * t), roundi(a.y + dy * t)))
	return cells

func _compute_rect(a: Vector2i, b: Vector2i) -> Array[Vector2i]:
	var cells: Array[Vector2i] = []
	for h in range(min(a.x, b.x), max(a.x, b.x) + 1):
		for v in range(min(a.y, b.y), max(a.y, b.y) + 1):
			cells.append(Vector2i(h, v))
	return cells

func _do_fill(start: Vector2i) -> void:
	if not VoxelWorld.active_project:
		return
	var data := VoxelWorld.active_project.data
	var gw := _get_grid_w(); var gh := _get_grid_h()
	if start.x < 0 or start.x >= gw or start.y < 0 or start.y >= gh:
		return
	var start_pos := _grid_to_world(start.x, start.y)
	var target_semantic := data.get_block(start_pos)
	var fill_semantic := VoxelWorld.selected_semantic
	if target_semantic == fill_semantic:
		return
	var queue: Array[Vector2i] = [start]
	var visited: Dictionary = {}
	while not queue.is_empty():
		var cell: Vector2i = queue.pop_front()
		if visited.has(cell):
			continue
		if cell.x < 0 or cell.x >= gw or cell.y < 0 or cell.y >= gh:
			continue
		var pos := _grid_to_world(cell.x, cell.y)
		if data.get_block(pos) != target_semantic:
			continue
		visited[cell] = true
		if fill_semantic.is_empty():
			VoxelWorld.clear_block(pos)
		else:
			VoxelWorld.set_block(pos, fill_semantic, _place_orientation)
		queue.append(Vector2i(cell.x + 1, cell.y))
		queue.append(Vector2i(cell.x - 1, cell.y))
		queue.append(Vector2i(cell.x, cell.y + 1))
		queue.append(Vector2i(cell.x, cell.y - 1))

# ---------------------------------------------------------------------------
# Keyboard input (R rotate block, F mirror view)
# ---------------------------------------------------------------------------

# Keyboard goes through _unhandled_input (the grid Control can't hold focus), so
# only the focused pane's active view acts.
func _unhandled_input(event: InputEvent) -> void:
	if not _active or _suspended or not is_visible_in_tree() or not VoxelWorld.active_project:
		return
	if not (event is InputEventKey) or not (event as InputEventKey).pressed:
		return
	var key := event as InputEventKey
	match key.keycode:
		KEY_R:
			_rotate_hovered(key.shift_pressed)
			get_viewport().set_input_as_handled()
		KEY_F:
			_mirror_h = not _mirror_h
			_grid_area.queue_redraw()
			get_viewport().set_input_as_handled()

func _cycle_hotbar(delta: int) -> void:
	var n := VoxelWorld.HOTBAR_SIZE
	VoxelWorld.select_slot((VoxelWorld.active_slot + delta % n + n) % n)

# ---------------------------------------------------------------------------
# Block orientation: quadrant-on-place + R/Shift+R re-orient
# ---------------------------------------------------------------------------

# Facing implied by where inside the cell the press landed.
# The half of the cell closest to the click becomes the direction the block faces.
func _orientation_from_pos(mouse_pos: Vector2) -> int:
	var cell := _mouse_to_cell(mouse_pos)
	var cell_origin := _draw_origin() + Vector2(cell) * _cell_px
	var local := (mouse_pos - cell_origin) / _cell_px
	var fx := local.x - 0.5  # -0.5..0.5, + = right
	var fy := local.y - 0.5  # -0.5..0.5, + = down
	var hd := _get_h_dir()
	var vd := _get_v_dir()
	if absf(fx) >= absf(fy):
		return Orientation.make(Orientation.from_dir(Vector3(hd if fx >= 0.0 else -hd)))
	return Orientation.make(Orientation.from_dir(Vector3(vd if fy >= 0.0 else -vd)))

# 90° CW rotation of a block's facing within this slice's world-space plane.
# The rotation axis is the world normal to the slice (always, regardless of _rotation).
# Axis 1 (top-down, XZ): N→E→S→W→N
# Axis 0 (X-slice, YZ):  N→UP→S→DOWN→N
# Axis 2 (Z-slice, XY):  W→UP→E→DOWN→W
func _rotate_in_plane(o: int) -> int:
	match axis:
		1:
			return Orientation.rotate_cw(o)
		0:
			var cycle := [Orientation.Facing.NORTH, Orientation.Facing.UP, Orientation.Facing.SOUTH, Orientation.Facing.DOWN]
			var f := Orientation.facing_of(o)
			var idx: int = cycle.find(f)
			if idx < 0: idx = 0
			return Orientation.make(cycle[(idx + 1) % 4], Orientation.is_top(o))
		2:
			var cycle2 := [Orientation.Facing.WEST, Orientation.Facing.UP, Orientation.Facing.EAST, Orientation.Facing.DOWN]
			var f2 := Orientation.facing_of(o)
			var idx2: int = cycle2.find(f2)
			if idx2 < 0: idx2 = 0
			return Orientation.make(cycle2[(idx2 + 1) % 4], Orientation.is_top(o))
	return o

# Flip a block's orientation on the world vertical axis: UP↔DOWN for vertical
# facings, toggle is_top for horizontal ones (upside-down vs right-side-up).
func _flip_vertical(o: int) -> int:
	var f := Orientation.facing_of(o)
	if f == Orientation.Facing.UP:
		return Orientation.make(Orientation.Facing.DOWN, Orientation.is_top(o))
	if f == Orientation.Facing.DOWN:
		return Orientation.make(Orientation.Facing.UP, Orientation.is_top(o))
	return Orientation.toggle_top(o)

func _rotate_hovered(flip: bool) -> void:
	var cell := _mouse_to_cell(_grid_area.get_local_mouse_position())
	var world := _grid_to_world(cell.x, cell.y)
	var c := VoxelWorld.active_project.data.get_cell(world)
	if c == null:
		return
	var o := _flip_vertical(c.orientation) if flip else _rotate_in_plane(c.orientation)
	VoxelWorld.reorient_block(world, o)

# ---------------------------------------------------------------------------
# Slice navigation + view rotation
# ---------------------------------------------------------------------------

func set_active(active: bool) -> void:
	_active = active

# Suspend/resume while a modal overlay (the inventory screen) is up. The 2D view
# has no captured cursor, so this just gates its input; the overlay sits on top.
func set_input_suspended(s: bool) -> void:
	_suspended = s

func set_guide(desc: Dictionary) -> void:
	if desc == _guide:
		return
	_guide = desc
	_grid_area.queue_redraw()

func get_guide_descriptor() -> Dictionary:
	return {"axis": axis, "offset": slice_pos}

func set_slice(value: int) -> void:
	if not VoxelWorld.active_project:
		return
	slice_pos = value
	_update_slice_label()
	_grid_area.queue_redraw()

# Rotate the 2D view 90° clockwise (↻). Resets pan so the center stays visible.
func rotate_cw() -> void:
	_rotation = (_rotation + 1) % 4
	_user_pan = Vector2.ZERO
	_grid_area.queue_redraw()

# Rotate the 2D view 90° counter-clockwise (↺).
func rotate_ccw() -> void:
	_rotation = (_rotation + 3) % 4
	_user_pan = Vector2.ZERO
	_grid_area.queue_redraw()

func _on_layer_down_pressed() -> void:
	set_slice(slice_pos - 1)

func _on_layer_up_pressed() -> void:
	set_slice(slice_pos + 1)

func _on_rotate_ccw_pressed() -> void:
	rotate_ccw()

func _on_rotate_cw_pressed() -> void:
	rotate_cw()
