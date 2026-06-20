class_name View2DGrid
extends VBoxContainer

const CELL_SIZE := 32
const PADDING := 8

var current_layer := 0
var _is_placing := false
var _is_erasing := false
var _drag_start := Vector2i(-1, -1)
var _preview_cells: Array[Vector2i] = []

@onready var _layer_label: Label = $LayerBar/LayerLabel
@onready var _grid_area: Control = $GridArea

func _ready() -> void:
	_grid_area.draw.connect(_draw_grid)
	_grid_area.gui_input.connect(_on_grid_input)
	VoxelWorld.block_changed.connect(func(_p, _s): _grid_area.queue_redraw())
	VoxelWorld.palette_stack_changed.connect(_grid_area.queue_redraw)
	VoxelWorld.project_opened.connect(func(_p): _reset())

func _reset() -> void:
	current_layer = 0
	_preview_cells.clear()
	_drag_start = Vector2i(-1, -1)
	_update_layer_label()
	_grid_area.queue_redraw()

func _draw_grid() -> void:
	if not VoxelWorld.active_project:
		return
	var data := VoxelWorld.active_project.data
	for x in data.size.x:
		for z in data.size.z:
			var rect := Rect2(
				PADDING + x * CELL_SIZE,
				PADDING + z * CELL_SIZE,
				CELL_SIZE - 1, CELL_SIZE - 1
			)
			var semantic := data.get_block(Vector3i(x, current_layer, z))
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
			var rect := Rect2(
				PADDING + cell.x * CELL_SIZE,
				PADDING + cell.y * CELL_SIZE,
				CELL_SIZE - 1, CELL_SIZE - 1
			)
			_grid_area.draw_rect(rect, preview_color)

func _mouse_to_cell(mouse_pos: Vector2) -> Vector2i:
	return Vector2i(
		int((mouse_pos.x - PADDING) / CELL_SIZE),
		int((mouse_pos.y - PADDING) / CELL_SIZE)
	)

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
	elif event is InputEventMouseMotion:
		if _is_placing or _is_erasing:
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
	var pos := Vector3i(cell.x, current_layer, cell.y)
	if not VoxelWorld.active_project.data.is_in_bounds(pos):
		return
	if _is_erasing:
		VoxelWorld.clear_block(pos)
	elif _is_placing and not VoxelWorld.selected_semantic.is_empty():
		VoxelWorld.set_block(pos, VoxelWorld.selected_semantic)

func _commit_preview() -> void:
	if not VoxelWorld.active_project:
		return
	for cell in _preview_cells:
		var pos := Vector3i(cell.x, current_layer, cell.y)
		if not VoxelWorld.active_project.data.is_in_bounds(pos):
			continue
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
	for x in range(min(a.x, b.x), max(a.x, b.x) + 1):
		for y in range(min(a.y, b.y), max(a.y, b.y) + 1):
			cells.append(Vector2i(x, y))
	return cells

func _do_fill(start: Vector2i) -> void:
	if not VoxelWorld.active_project:
		return
	var data := VoxelWorld.active_project.data
	var start_pos := Vector3i(start.x, current_layer, start.y)
	if not data.is_in_bounds(start_pos):
		return
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
		var pos := Vector3i(cell.x, current_layer, cell.y)
		if not data.is_in_bounds(pos):
			continue
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

func set_layer(value: int) -> void:
	if not VoxelWorld.active_project:
		return
	current_layer = clamp(value, 0, VoxelWorld.active_project.data.size.y - 1)
	_update_layer_label()
	_grid_area.queue_redraw()

func _update_layer_label() -> void:
	_layer_label.text = "Layer %d" % current_layer

func _on_layer_down_pressed() -> void:
	set_layer(current_layer - 1)

func _on_layer_up_pressed() -> void:
	set_layer(current_layer + 1)
