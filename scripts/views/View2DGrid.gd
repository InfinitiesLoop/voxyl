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
# Guideline showing where another view's active slice crosses this one (amber,
# distinct from the cyan focus chrome).
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

# View transform (pan/zoom). The view auto-centers on _center; _user_pan is the
# manual offset on top of that, and _cell_px is the zoom (pixels per cell).
var _cell_px := float(CELL_SIZE)
var _user_pan := Vector2.ZERO
var _panning := false
var _pan_last := Vector2.ZERO

# Set by the shell (focus). The 2D view's input is per-control via gui_input, so
# this is mostly for symmetry / future use rather than input gating.
var _active := true

# When true the horizontal world-axis is reversed (mirrors h) so that "left in
# 2D == left in 3D" for the camera angle the slice was made from. Toggled with F.
var _flipped := false

# Another view's active slice, broadcast by the shell: {axis, offset} or {}.
var _guide: Dictionary = {}

@onready var _layer_label: Label = $LayerBar/LayerLabel
@onready var _grid_area: Control = $GridArea

func configure(p_axis: int, p_center: Vector3i, p_flipped: bool = false) -> void:
	axis = p_axis
	_center = p_center
	slice_pos = p_center[axis]
	_flipped = p_flipped
	if is_inside_tree():
		_reset()

func _ready() -> void:
	_grid_area.clip_contents = true
	_grid_area.draw.connect(_draw_grid)
	_grid_area.gui_input.connect(_on_grid_input)
	VoxelWorld.block_changed.connect(func(_p, _s): _grid_area.queue_redraw())
	VoxelWorld.palette_stack_changed.connect(_grid_area.queue_redraw)
	VoxelWorld.block_type_changed.connect(_grid_area.queue_redraw)
	VoxelWorld.project_opened.connect(func(_p): _reset())
	_update_slice_label()

# ---------------------------------------------------------------------------
# Axis helpers
# ---------------------------------------------------------------------------

# Map 2D grid coordinates (h = horizontal, v = vertical) to world Vector3i.
# Each axis choice fixes one world coordinate (slice_pos) and maps the other two.
# v=0 is the TOP row on screen, so for the vertical (elevation) slices v is
# inverted against world Y — that keeps +Y pointing up on screen, consistent
# with the 3D view no matter which way the camera faced when the slice was made.
#   Y-axis slice (top-down): h→X, v→Z
#   X-axis slice (side):     h→Z, v→Y (up)
#   Z-axis slice (front):    h→X, v→Y (up)

# Bounding box of placed blocks, padded for room to build.
# Returns sensible defaults when the project is empty.
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

func _grid_to_world(h: int, v: int) -> Vector3i:
	var mn := _get_view_min()
	var mx := _get_view_max()
	if _flipped:
		match axis:
			0: h = mx.z - mn.z - h
			_: h = mx.x - mn.x - h
	match axis:
		0: return Vector3i(slice_pos, mx.y - v, mn.z + h)
		2: return Vector3i(mn.x + h, mx.y - v, slice_pos)
		_: return Vector3i(mn.x + h, slice_pos, mn.z + v)

func _get_grid_w() -> int:
	var mn := _get_view_min(); var mx := _get_view_max()
	return (mx.z - mn.z + 1) if axis == 0 else (mx.x - mn.x + 1)

func _get_grid_h() -> int:
	var mn := _get_view_min(); var mx := _get_view_max()
	return (mx.z - mn.z + 1) if axis == 1 else (mx.y - mn.y + 1)

func _get_min_slice() -> int:
	var mn := _get_view_min()
	match axis:
		0: return mn.x
		2: return mn.z
		_: return mn.y

func _get_max_slice() -> int:
	var mx := _get_view_max()
	match axis:
		0: return mx.x
		2: return mx.z
		_: return mx.y

# In-plane (h, v) grid coordinates of the center cell.
func _center_hv() -> Vector2i:
	var mn := _get_view_min()
	var mx := _get_view_max()
	match axis:
		0:
			var ch := _center.z - mn.z
			if _flipped: ch = mx.z - mn.z - ch
			return Vector2i(ch, mx.y - _center.y)
		2:
			var ch := _center.x - mn.x
			if _flipped: ch = mx.x - mn.x - ch
			return Vector2i(ch, mx.y - _center.y)
		_:
			var ch := _center.x - mn.x
			if _flipped: ch = mx.x - mn.x - ch
			return Vector2i(ch, _center.z - mn.z)

# Screen position of grid cell (0,0)'s top-left. The view auto-centers _center
# and then applies the user's manual pan; both scale with the current zoom, so
# the framing stays stable even as the build's bounds grow underneath it.
func _auto_center_origin() -> Vector2:
	var hv := _center_hv()
	return _grid_area.size * 0.5 - (Vector2(hv) + Vector2(0.5, 0.5)) * _cell_px

func _draw_origin() -> Vector2:
	return _auto_center_origin() + _user_pan

# ---------------------------------------------------------------------------
# Reset / label
# ---------------------------------------------------------------------------

func _reset() -> void:
	# slice_pos is intentionally not clamped — a slice may sit outside the build.
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
			# Shaped (non-cube) blocks carry an orientation; show which way they face
			# within this plane so 2D editing of stairs/slabs is legible.
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

# Facing arrow for an oriented cell, mapped from world facing into this slice's
# screen space. A facing perpendicular to the plane (pointing into/out of screen)
# is drawn as a diamond. Two redundant cues distinguish upside-down (so it stays
# legible over any future block texture, in colour or in greyscale):
#   • right-side-up → SOLID arrowhead, light fill
#   • upside-down   → HOLLOW (outlined) arrowhead, cool tint, + a bar on the shaft
# Every shape carries a dark outline halo so it reads on light and dark blocks.
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
	if top:  # extra greyscale-safe cue: a bar across the shaft
		_grid_area.draw_line(c - perp * (hw * 0.9), c + perp * (hw * 0.9), col, shaft_w)

# Draw a glyph polygon either filled (right-side-up) or hollow (upside-down),
# always with a dark outline so it survives any background.
func _glyph_poly(pts: PackedVector2Array, fill: Color, filled: bool) -> void:
	var closed := pts.duplicate()
	closed.append(pts[0])
	if filled:
		_grid_area.draw_colored_polygon(pts, fill)
		_grid_area.draw_polyline(closed, _GLYPH_OUTLINE, 1.5)
	else:
		_grid_area.draw_polyline(closed, _GLYPH_OUTLINE, 3.0)
		_grid_area.draw_polyline(closed, fill, 1.8)

# Screen-space unit direction (down = +y) for a world facing in this slice plane.
# Zero vector means the facing is perpendicular to the plane.
func _facing_screen_dir(facing: int) -> Vector2:
	var d: Vector3i = Orientation.DIRS[facing]
	var sx := 0.0
	var sy := 0.0
	match axis:
		1:  # top-down: h→X (right), v→Z (down)
			sx = d.x; sy = d.z
		0:  # X-slice side: h→Z (right), v→Y (up)
			sx = d.z; sy = -d.y
		2:  # Z-slice front: h→X (right), v→Y (up)
			sx = d.x; sy = -d.y
	if _flipped:
		sx = -sx
	return Vector2(sx, sy)

func _draw_hint() -> void:
	var font := ThemeDB.fallback_font
	var hint := "LMB paint (quadrant orients) · RMB erase · R rotate · Shift+R flip · Scroll slot · Shift+Scroll zoom · Mid-drag pan · ▲/▼ layer · F mirror"
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
			# Plain wheel scrubs the hotbar (shared with 3D); Shift+wheel zooms.
			if mb.pressed:
				if mb.shift_pressed: _zoom_at(mb.position, 1.15)
				else: _cycle_hotbar(-1)
		elif mb.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			if mb.pressed:
				if mb.shift_pressed: _zoom_at(mb.position, 1.0 / 1.15)
				else: _cycle_hotbar(1)
	elif event is InputEventMouseMotion:
		if _panning:
			# Self-heal if the release happened off-canvas (gui_input never saw it).
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
# Orientation: quadrant-on-place + R/Shift+R re-orient (and F mirror)
# ---------------------------------------------------------------------------

# Keyboard goes through _unhandled_input (the grid Control can't hold focus), so
# only the focused pane's active view acts. R rotates the hovered block about
# this plane's perpendicular axis; Shift+R flips it upside-down; F mirrors the
# whole view.
func _unhandled_input(event: InputEvent) -> void:
	if not _active or not is_visible_in_tree() or not VoxelWorld.active_project:
		return
	if not (event is InputEventKey) or not (event as InputEventKey).pressed:
		return
	var key := event as InputEventKey
	match key.keycode:
		KEY_R:
			_rotate_hovered(key.shift_pressed)
			get_viewport().set_input_as_handled()
		KEY_F:
			_flipped = not _flipped
			_grid_area.queue_redraw()
			get_viewport().set_input_as_handled()

func _cycle_hotbar(delta: int) -> void:
	var n := VoxelWorld.HOTBAR_SIZE
	VoxelWorld.select_slot((VoxelWorld.active_slot + delta % n + n) % n)

# Orientation implied by where inside the cell the press landed. In a top-down
# slice the dominant offset axis picks the horizontal facing; in a side slice the
# horizontal half picks facing and the vertical half picks right-side-up vs upside
# down — so the four quadrants of a stair's cell give its four configurations.
func _orientation_from_pos(mouse_pos: Vector2) -> int:
	var cell := _mouse_to_cell(mouse_pos)
	var cell_origin := _draw_origin() + Vector2(cell) * _cell_px
	var local := (mouse_pos - cell_origin) / _cell_px
	var fx := local.x - 0.5  # -0.5..0.5, + = right
	var fy := local.y - 0.5  # -0.5..0.5, + = down
	match axis:
		1:  # top-down: pick N/E/S/W by the dominant offset
			if absf(fx) >= absf(fy):
				var east := fx >= 0.0
				if _flipped: east = not east
				return Orientation.make(Orientation.Facing.EAST if east else Orientation.Facing.WEST)
			return Orientation.make(Orientation.Facing.SOUTH if fy >= 0.0 else Orientation.Facing.NORTH)
		0:  # X-slice side: h→Z facing, upper half → upside-down
			var south := fx >= 0.0
			if _flipped: south = not south
			return Orientation.make(Orientation.Facing.SOUTH if south else Orientation.Facing.NORTH, fy < 0.0)
		2:  # Z-slice front: h→X facing, upper half → upside-down
			var east2 := fx >= 0.0
			if _flipped: east2 = not east2
			return Orientation.make(Orientation.Facing.EAST if east2 else Orientation.Facing.WEST, fy < 0.0)
	return 0

# One R step: turn the in-plane facing. Top-down turns through all four; a side
# slice swaps the two horizontal facings it can show (use Shift+R for upside-down).
func _rotate_in_plane(o: int) -> int:
	match axis:
		1:
			return Orientation.rotate_cw(o)
		0:
			var f := Orientation.facing_of(o)
			var nf := Orientation.Facing.NORTH if f == Orientation.Facing.SOUTH else Orientation.Facing.SOUTH
			return Orientation.make(nf, Orientation.is_top(o))
		2:
			var f2 := Orientation.facing_of(o)
			var nf2 := Orientation.Facing.WEST if f2 == Orientation.Facing.EAST else Orientation.Facing.EAST
			return Orientation.make(nf2, Orientation.is_top(o))
	return o

func _rotate_hovered(flip_top: bool) -> void:
	var cell := _mouse_to_cell(_grid_area.get_local_mouse_position())
	var world := _grid_to_world(cell.x, cell.y)
	var c := VoxelWorld.active_project.data.get_cell(world)
	if c == null:
		return
	var o := Orientation.toggle_top(c.orientation) if flip_top else _rotate_in_plane(c.orientation)
	VoxelWorld.reorient_block(world, o)

# ---------------------------------------------------------------------------
# Slice navigation
# ---------------------------------------------------------------------------

func set_active(active: bool) -> void:
	_active = active

func set_guide(desc: Dictionary) -> void:
	if desc == _guide:
		return
	_guide = desc
	_grid_area.queue_redraw()

func get_guide_descriptor() -> Dictionary:
	return {"axis": axis, "offset": slice_pos}

# Where a perpendicular active slice crosses this plane: a column (constant h)
# or row (constant v) in our grid. Empty when parallel/coincident (no crossing).
func _guide_line() -> Dictionary:
	if _guide.is_empty():
		return {}
	var g_axis: int = _guide["axis"]
	var g_off: int = _guide["offset"]
	if g_axis == axis:
		return {}
	var mn := _get_view_min()
	var mx := _get_view_max()
	match axis:
		0:
			if g_axis == 2:
				var col := g_off - mn.z
				if _flipped: col = mx.z - mn.z - col
				return {"col": col}
			return {"row": mx.y - g_off}
		2:
			if g_axis == 0:
				var col := g_off - mn.x
				if _flipped: col = mx.x - mn.x - col
				return {"col": col}
			return {"row": mx.y - g_off}
		_:
			if g_axis == 0:
				var col := g_off - mn.x
				if _flipped: col = mx.x - mn.x - col
				return {"col": col}
			return {"row": g_off - mn.z}

func set_slice(value: int) -> void:
	if not VoxelWorld.active_project:
		return
	# Unclamped: the up/down buttons may move the slice beyond the build.
	slice_pos = value
	_update_slice_label()
	_grid_area.queue_redraw()

func _on_layer_down_pressed() -> void:
	set_slice(slice_pos - 1)

func _on_layer_up_pressed() -> void:
	set_slice(slice_pos + 1)
