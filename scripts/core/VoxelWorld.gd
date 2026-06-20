extends Node

signal workspace_changed()
signal layout_opened(layout: VoxelLayout)
signal palette_stack_changed()
signal block_changed(pos: Vector3i, semantic_name: String)
signal selection_changed(semantic_name: String)

var workspace: VoxelWorkspace
var active_layout: VoxelLayout
var selected_semantic: String = ""

func _ready() -> void:
	workspace = VoxelWorkspace.new()
	_populate_defaults()
	workspace_changed.emit()

func open(layout: VoxelLayout) -> void:
	active_layout = layout
	var names := merged_semantic_names()
	selected_semantic = names[0] if not names.is_empty() else ""
	layout_opened.emit(layout)

func set_block(pos: Vector3i, semantic_name: String) -> void:
	if not active_layout or not active_layout.data.is_in_bounds(pos):
		return
	active_layout.data.set_block(pos, semantic_name)
	block_changed.emit(pos, semantic_name)

func clear_block(pos: Vector3i) -> void:
	if not active_layout:
		return
	active_layout.data.clear_block(pos)
	block_changed.emit(pos, "")

func get_block(pos: Vector3i) -> String:
	return active_layout.data.get_block(pos) if active_layout else ""

# Returns the display color for a semantic name, applying last-wins across
# the active layout's palette stack.
func get_color_for_semantic(semantic_name: String) -> Color:
	var result := Color(0.35, 0.35, 0.35)
	if not active_layout:
		return result
	for palette_name in active_layout.palette_names:
		var palette := workspace.get_palette(palette_name)
		if palette:
			var entry := palette.get_entry(semantic_name)
			if entry:
				result = entry.color
	return result

# Returns the resolved block type name for a semantic name (last-wins).
func get_block_type_for_semantic(semantic_name: String) -> String:
	var result := ""
	if not active_layout:
		return result
	for palette_name in active_layout.palette_names:
		var palette := workspace.get_palette(palette_name)
		if palette:
			var bt := palette.get_block_type_name(semantic_name)
			if not bt.is_empty():
				result = bt
	return result

# Union of all semantic names across the palette stack.
# Names keep their first-seen order; values are resolved last-wins.
func merged_semantic_names() -> Array[String]:
	var seen := {}
	var result: Array[String] = []
	if not active_layout:
		return result
	for palette_name in active_layout.palette_names:
		var palette := workspace.get_palette(palette_name)
		if not palette:
			continue
		for entry in palette.entries:
			if entry.semantic_name not in seen:
				seen[entry.semantic_name] = true
				result.append(entry.semantic_name)
	return result

func add_palette_to_stack(layout: VoxelLayout, palette_name: String) -> void:
	layout.palette_names.append(palette_name)
	if layout == active_layout:
		palette_stack_changed.emit()

func remove_palette_from_stack(layout: VoxelLayout, index: int) -> void:
	layout.palette_names.remove_at(index)
	if layout == active_layout:
		palette_stack_changed.emit()

func move_palette_in_stack(layout: VoxelLayout, from_idx: int, to_idx: int) -> void:
	layout.palette_names.insert(to_idx, layout.palette_names.pop_at(from_idx))
	if layout == active_layout:
		palette_stack_changed.emit()

func select_semantic(semantic_name: String) -> void:
	selected_semantic = semantic_name
	selection_changed.emit(semantic_name)

func _populate_defaults() -> void:
	_add_default_block_types()
	_add_default_palette()
	var layout := workspace.add_layout("My First Build")
	layout.palette_names.append("Default")

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
		e.color = s[2]
		p.entries.append(e)
