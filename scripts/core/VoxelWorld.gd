extends Node

signal workspace_changed()
signal layout_opened(layout: VoxelLayout, palette: Palette)
signal palette_swapped(palette: Palette)
signal block_changed(pos: Vector3i, semantic_name: String)
signal selection_changed(semantic_name: String)

var workspace: VoxelWorkspace
var active_layout: VoxelLayout
var active_palette: Palette
var selected_semantic: String = ""

func _ready() -> void:
	workspace = VoxelWorkspace.new()
	_populate_defaults()
	workspace_changed.emit()

func open(layout: VoxelLayout, palette: Palette) -> void:
	active_layout = layout
	active_palette = palette
	selected_semantic = palette.entries[0].semantic_name if not palette.entries.is_empty() else ""
	layout_opened.emit(layout, palette)

func swap_palette(palette: Palette) -> void:
	active_palette = palette
	if selected_semantic.is_empty() and not palette.entries.is_empty():
		selected_semantic = palette.entries[0].semantic_name
	palette_swapped.emit(palette)

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

func get_color_for_semantic(semantic_name: String) -> Color:
	return active_palette.get_color(semantic_name) if active_palette else Color.GRAY

func select_semantic(semantic_name: String) -> void:
	selected_semantic = semantic_name
	selection_changed.emit(semantic_name)

func _populate_defaults() -> void:
	_add_default_block_types()
	_add_default_palette()
	workspace.add_layout("My First Build")

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
		"Leaves", "Vines", "Bamboo", "Cactus",
		"Water", "Lava",
	]
	for n in names:
		workspace.add_block_type(n)

func _add_default_palette() -> void:
	var p := workspace.add_palette("Default")
	var slots := [
		["Base",      "Stone",       Color(0.55, 0.55, 0.55)],
		["Accent",    "Oak Planks",  Color(0.75, 0.60, 0.35)],
		["Highlight", "Brick",       Color(0.72, 0.38, 0.28)],
		["Detail",    "Glass",       Color(0.55, 0.78, 0.92)],
		["Trim",      "Cobblestone", Color(0.42, 0.42, 0.40)],
		["Floor",     "Dirt",        Color(0.48, 0.35, 0.22)],
		["Roof",      "Spruce Planks", Color(0.38, 0.28, 0.18)],
	]
	for s in slots:
		var e := PaletteEntry.new()
		e.semantic_name = s[0]
		e.block_type_name = s[1]
		e.color = s[2]
		p.entries.append(e)
