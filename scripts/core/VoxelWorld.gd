extends Node

enum Tool { PAINT, ERASE, LINE, RECT, FILL }

signal workspace_changed()
signal project_opened(project: VoxelProject)
signal palette_stack_changed()
signal block_changed(pos: Vector3i, semantic_name: String)
signal selection_changed(semantic_name: String)
signal tool_changed(tool: Tool)
signal slice_view_requested(axis: int, center: Vector3i, flipped: bool)
signal block_type_changed()

var workspace: VoxelWorkspace
var active_project: VoxelProject
var selected_semantic: String = ""
var active_tool: Tool = Tool.PAINT

func _ready() -> void:
	workspace = VoxelWorkspace.new()
	_populate_defaults()
	workspace_changed.emit()

func open(project: VoxelProject) -> void:
	active_project = project
	var names := merged_semantic_names()
	selected_semantic = names[0] if not names.is_empty() else ""
	project_opened.emit(project)

func set_block(pos: Vector3i, semantic_name: String) -> void:
	if not active_project:
		return
	active_project.data.set_block(pos, semantic_name)
	block_changed.emit(pos, semantic_name)

func clear_block(pos: Vector3i) -> void:
	if not active_project:
		return
	active_project.data.clear_block(pos)
	block_changed.emit(pos, "")

func get_block(pos: Vector3i) -> String:
	return active_project.data.get_block(pos) if active_project else ""

func get_color_for_semantic(semantic_name: String) -> Color:
	var result := Color(0.35, 0.35, 0.35)
	if not active_project:
		return result
	for palette_name in active_project.palette_names:
		var palette := workspace.get_palette(palette_name)
		if palette:
			var bt_name := palette.get_block_type_name(semantic_name)
			if not bt_name.is_empty():
				var bt := workspace.get_block_type(bt_name)
				if bt:
					result = bt.color
	return result

func notify_block_type_changed() -> void:
	block_type_changed.emit()

func get_block_type_for_semantic(semantic_name: String) -> String:
	var result := ""
	if not active_project:
		return result
	for palette_name in active_project.palette_names:
		var palette := workspace.get_palette(palette_name)
		if palette:
			var bt := palette.get_block_type_name(semantic_name)
			if not bt.is_empty():
				result = bt
	return result

func merged_semantic_names() -> Array[String]:
	var seen := {}
	var result: Array[String] = []
	if not active_project:
		return result
	for palette_name in active_project.palette_names:
		var palette := workspace.get_palette(palette_name)
		if not palette:
			continue
		for entry in palette.entries:
			if entry.semantic_name not in seen:
				seen[entry.semantic_name] = true
				result.append(entry.semantic_name)
	return result

func add_palette_to_stack(project: VoxelProject, palette_name: String) -> void:
	project.palette_names.append(palette_name)
	if project == active_project:
		palette_stack_changed.emit()

func remove_palette_from_stack(project: VoxelProject, index: int) -> void:
	project.palette_names.remove_at(index)
	if project == active_project:
		palette_stack_changed.emit()

func move_palette_in_stack(project: VoxelProject, from_idx: int, to_idx: int) -> void:
	project.palette_names.insert(to_idx, project.palette_names.pop_at(from_idx))
	if project == active_project:
		palette_stack_changed.emit()

func select_semantic(semantic_name: String) -> void:
	selected_semantic = semantic_name
	selection_changed.emit(semantic_name)

func set_active_tool(tool: Tool) -> void:
	active_tool = tool
	tool_changed.emit(tool)

func request_slice_view(axis: int, center: Vector3i, flipped: bool = false) -> void:
	slice_view_requested.emit(axis, center, flipped)

func _populate_defaults() -> void:
	_add_default_block_types()
	_add_default_palette()
	var project := workspace.add_project("My First Build")
	project.palette_names.append("Default")
	_add_default_blocks(project)

func _add_default_blocks(project: VoxelProject) -> void:
	# 3D plus: three 2-cell-wide bars along each world axis, roughly 10×10×10.
	# Each arm uses a different semantic so the palette is immediately visible.
	for x in range(0, 10):  # X arm
		for y in range(4, 6):
			for z in range(4, 6):
				project.data.set_block(Vector3i(x, y, z), "Base")
	for x in range(4, 6):  # Y arm (overwrites center)
		for y in range(0, 10):
			for z in range(4, 6):
				project.data.set_block(Vector3i(x, y, z), "Accent")
	for x in range(4, 6):  # Z arm (overwrites center again)
		for y in range(4, 6):
			for z in range(0, 10):
				project.data.set_block(Vector3i(x, y, z), "Highlight")

func _add_default_block_types() -> void:
	var names := [
		"Stone", "Cobblestone", "Stone Bricks", "Mossy Stone Bricks", "Cracked Stone Bricks",
		"Gravel", "Sand", "Sandstone", "Dirt", "Grass Block", "Clay", "Mud",
		"Oak Log", "Oak Planks", "Spruce Log", "Spruce Planks",
		"Birch Log", "Birch Planks", "Dark Oak Log", "Dark Oak Planks",
		"Acacia Log", "Acacia Planks", "Jungle Log", "Jungle Planks",
		"Mangrove Log", "Mangrove Planks",
		"Brick", "Nether Brick", "Quartz Block", "Smooth Quartz",
		"Prismarine", "Dark Prismarine", "Sea Lantern",
		"Iron Block", "Gold Block", "Copper Block", "Cut Copper",
		"Glass", "Glass Pane", "Iron Bars",
		"Obsidian", "Deepslate", "Tuff", "Calcite",
		"Glowstone", "Shroomlight", "Lantern",
		"White Concrete", "Gray Concrete", "Black Concrete",
		"White Terracotta", "Orange Terracotta", "Brown Terracotta",
		"White Wool", "Red Wool", "Blue Wool", "Green Wool", "Yellow Wool",
		"Leaves", "Vines", "Bamboo", "Water", "Lava",
	]
	for n in names:
		workspace.add_block_type(n)

func _add_default_palette() -> void:
	var p := workspace.add_palette("Default")
	var slots := [
		["Base",      "Stone",         Color(0.55, 0.55, 0.55)],
		["Accent",    "Oak Planks",    Color(0.75, 0.60, 0.35)],
		["Highlight", "Brick",         Color(0.72, 0.38, 0.28)],
		["Detail",    "Glass",         Color(0.55, 0.78, 0.92)],
		["Trim",      "Cobblestone",   Color(0.42, 0.42, 0.40)],
		["Floor",     "Dirt",          Color(0.48, 0.35, 0.22)],
		["Roof",      "Spruce Planks", Color(0.38, 0.28, 0.18)],
	]
	for s in slots:
		var e := PaletteEntry.new()
		e.semantic_name = s[0]
		e.block_type_name = s[1]
		p.entries.append(e)
		# Color lives on the block type, not the palette entry.
		var bt := workspace.get_block_type(s[1])
		if bt:
			bt.color = s[2]
