class_name View2DGrid
extends VBoxContainer

const CELL_SIZE := 32
const VIEW_PADDING := 4
# Minimum in-plane radius (in cells) drawn around the center, so a slice that
# sits outside the build still presents a usable canvas.
const CENTER_RADIUS := 10
# Zoom limits, in pixels-per-cell.
const MIN_CELL_PX := 8.0
const MAX_CELL_PX := 96.0

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

# View transform (pan/zoom). The view auto-centers on _center; _user_pan is the
# manual offset on top of that, and _cell_px is the zoom (pixels per cell).
var _cell_px := float(CELL_SIZE)
var _user_pan := Vector2.ZERO
var _panning := false
var _pan_last := Vector2.ZERO

@onready var _layer_label: Label = $LayerBar/LayerLabel
@onready var _grid_area: Control = $GridArea

func configure(p_axis: int, p_center: Vector3i) -> void:
	axis = p_axis
	_center = p_center
	slice_pos = p_center[axis]
	if is_inside_tree():
		_reset()

func _ready() -> void:
	_grid_area.clip_contents = true
	_grid_area.draw.connect(_draw_grid)
	_grid_area.gui_input.connect(_on_grid_input)
	VoxelWorld.block_changed.connect(func(_p, _s): _grid_area.queue_redraw())
	VoxelWorld.palette_stack_changed.connect(_grid_area.queue_redraw)
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
		0: return Vector2i(_center.z - mn.z, mx.y - _center.y)
		2: return Vector2i(_center.x - mn.x, mx.y - _center.y)
		_: return Vector2i(_center.x - mn.x, _center.z - mn.z)

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
			var semantic := data.get_block(_grid_to_world(h, v))
			var fill: Color
			if semantic.is_empty():
				fill = Color(0.12, 0.12, 0.12)
			else:
				fill = VoxelWorld.get_color_for_semantic(semantic)
			_grid_area.draw_rect(rect, fill)
			_grid_area.draw_rect(rect, Color(0.22, 0.22, 0.22), false)

	if not _preview_cells.is_empty():
		var preview_color := VoxelWorld.get_color_for_semantic(VoxelWorld.selected_semantic)
		preview_color.a = 0.65
		for cell in _preview_cells:
			var rect := Rect2(origin + Vector2(cell) * _cell_px, cell_dim)
			_grid_area.draw_rect(rect, preview_color)

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
	var tool := VoxelWorld.active_tool
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_LEFT:
			if mb.pressed:
				var cell := _mouse_to_cell(mb.position)
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
				_zoom_at(mb.position, 1.15)
		elif mb.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			if mb.pressed:
				_zoom_at(mb.position, 1.0 / 1.15)
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
		VoxelWorld.set_block(pos, VoxelWorld.selected_semantic)

func _commit_preview() -> void:
	if not VoxelWorld.active_project:
		return
	for cell in _preview_cells:
		var pos := _grid_to_world(cell.x, cell.y)
		if VoxelWorld.selected_semantic.is_empty():
			VoxelWorld.clear_block(pos)
		else:
			VoxelWorld.set_block(pos, VoxelWorld.selected_semantic)
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
			VoxelWorld.set_block(pos, fill_semantic)
		queue.append(Vector2i(cell.x + 1, cell.y))
		queue.append(Vector2i(cell.x - 1, cell.y))
		queue.append(Vector2i(cell.x, cell.y + 1))
		queue.append(Vector2i(cell.x, cell.y - 1))

# ---------------------------------------------------------------------------
# Slice navigation
# ---------------------------------------------------------------------------

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
