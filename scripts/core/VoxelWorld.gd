extends Node

signal block_changed(pos: Vector3i, type_id: String)
signal palette_changed()
signal block_types_changed()
signal project_loaded(project: VoxelProject)
signal selection_changed(type_id: String)

var project: VoxelProject
var selected_type_id: String = ""

func _ready() -> void:
	load_default_project()

func load_default_project() -> void:
	project = VoxelProject.new()
	project.project_name = "New Project"
	project.data.size = Vector3i(16, 16, 16)
	_add_default_block_types()
	selected_type_id = project.block_types[0].id if not project.block_types.is_empty() else ""
	project_loaded.emit(project)

# Semantic block types ship with sensible default colors so you can build
# without choosing a palette first. The palette can be changed at any time
# without touching the voxel data.
func _add_default_block_types() -> void:
	var defaults: Array = [
		["base",      "Base",      Color(0.58, 0.50, 0.42)],
		["accent",    "Accent",    Color(0.80, 0.70, 0.30)],
		["highlight", "Highlight", Color(0.85, 0.30, 0.30)],
		["detail",    "Detail",    Color(0.35, 0.55, 0.80)],
		["trim",      "Trim",      Color(0.45, 0.65, 0.45)],
	]
	for d in defaults:
		project.add_block_type(d[0], d[1], d[2])
		var pe := PaletteEntry.new()
		pe.block_type_id = d[0]
		pe.block_name = d[1]
		pe.color = d[2]
		project.palette.entries.append(pe)

func set_block(pos: Vector3i, type_id: String) -> void:
	if not project.data.is_in_bounds(pos):
		return
	project.data.set_block(pos, type_id)
	block_changed.emit(pos, type_id)

func clear_block(pos: Vector3i) -> void:
	project.data.clear_block(pos)
	block_changed.emit(pos, "")

func get_block(pos: Vector3i) -> String:
	return project.data.get_block(pos)

func get_color_for_type(type_id: String) -> Color:
	return project.palette.get_color(type_id)

func select_type(type_id: String) -> void:
	selected_type_id = type_id
	selection_changed.emit(type_id)
