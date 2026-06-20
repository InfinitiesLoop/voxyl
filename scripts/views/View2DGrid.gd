class_name View2DGrid
extends VBoxContainer

const CELL_SIZE := 32
const PADDING := 8

var current_layer := 0
var _is_placing := false
var _is_erasing := false

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

func _on_grid_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_LEFT:
			_is_placing = mb.pressed
			_is_erasing = false
		elif mb.button_index == MOUSE_BUTTON_RIGHT:
			_is_erasing = mb.pressed
			_is_placing = false
		if mb.pressed:
			_paint_at(mb.position)
	elif event is InputEventMouseMotion and (_is_placing or _is_erasing):
		_paint_at(event.position)

func _paint_at(mouse_pos: Vector2) -> void:
	if not VoxelWorld.active_project:
		return
	var gx := int((mouse_pos.x - PADDING) / CELL_SIZE)
	var gz := int((mouse_pos.y - PADDING) / CELL_SIZE)
	var pos := Vector3i(gx, current_layer, gz)
	if not VoxelWorld.active_project.data.is_in_bounds(pos):
		return
	if _is_erasing:
		VoxelWorld.clear_block(pos)
	elif _is_placing and not VoxelWorld.selected_semantic.is_empty():
		VoxelWorld.set_block(pos, VoxelWorld.selected_semantic)

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
