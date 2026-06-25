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
# Unified hotbar shared by every view (no view owns it). hotbar_changed fires on
# slot reassignment; active_slot_changed when the highlighted slot moves.
signal hotbar_changed()
signal active_slot_changed(slot: int)

const HOTBAR_SIZE := 9

var workspace: VoxelWorkspace
var active_project: VoxelProject
var selected_semantic: String = ""
var active_tool: Tool = Tool.PAINT

# Shared 9-slot hotbar: each entry is a semantic name ("" = empty slot). The
# active slot's semantic is the selected_semantic used for placement.
var hotbar: Array[String] = []
var active_slot: int = 0

func _ready() -> void:
	workspace = VoxelWorkspace.new()
	workspace.register_builtin_models()
	hotbar.resize(HOTBAR_SIZE)
	hotbar.fill("")
	_populate_defaults()
	workspace_changed.emit()

func open(project: VoxelProject) -> void:
	active_project = project
	_seed_hotbar_from_palette()
	var names := merged_semantic_names()
	selected_semantic = hotbar[active_slot] if not hotbar[active_slot].is_empty() \
		else (names[0] if not names.is_empty() else "")
	project_opened.emit(project)
	hotbar_changed.emit()
	active_slot_changed.emit(active_slot)

# Place a block. Orientation is decided by the edit view at placement time
# (2D: the clicked quadrant; 3D: how you place it), so it's always explicit here.
func set_block(pos: Vector3i, semantic_name: String, orientation: int = 0) -> void:
	if not active_project:
		return
	active_project.data.set_block(pos, semantic_name, orientation)
	block_changed.emit(pos, semantic_name)

# Re-orient an existing cell in place (the R / Shift+R rotate tools). No-op if the
# cell is empty; emits block_changed so every view repaints.
func reorient_block(pos: Vector3i, orientation: int) -> void:
	if not active_project:
		return
	var cell := active_project.data.get_cell(pos)
	if cell == null:
		return
	cell.orientation = orientation
	block_changed.emit(pos, cell.type_id)

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

# The resolved BlockType object for a semantic (last-wins palette walk), or null.
# Views that need more than color/geometry — e.g. the 3D view reading a block's
# state_map to drive orientation variants / multipart connection parts — go through
# this. It's still the material layer: the data never names a block type.
func get_block_type_object_for_semantic(semantic_name: String) -> BlockType:
	return workspace.get_block_type(get_block_type_for_semantic(semantic_name))

# Resolved render shape (FULL/SLAB/STAIRS) for a semantic, via the palette stack
# (last-wins, same as color/block-type). Shape is a visual property of the mapped
# block type — the data never stores it.
func get_shape_for_semantic(semantic_name: String) -> BlockType.Shape:
	var result := BlockType.Shape.FULL
	if not active_project:
		return result
	for palette_name in active_project.palette_names:
		var palette := workspace.get_palette(palette_name)
		if palette:
			var bt_name := palette.get_block_type_name(semantic_name)
			if not bt_name.is_empty():
				var bt := workspace.get_block_type(bt_name)
				if bt:
					result = bt.shape
	return result

# Resolved render geometry for a semantic, as a BlockModel. Same last-wins
# palette-stack walk as color/shape: find the mapped block type, then return its
# explicit model (model_id → library) or the built-in model for its `shape`.
# Always returns a model so the view never special-cases geometry.
func get_model_for_semantic(semantic_name: String) -> BlockModel:
	var bt := workspace.get_block_type(get_block_type_for_semantic(semantic_name))
	if bt and not bt.model_id.is_empty():
		var explicit := workspace.get_block_model(bt.model_id)
		if explicit:
			return explicit
	var shape_id := _builtin_model_id_for_shape(bt.shape if bt else BlockType.Shape.FULL)
	var builtin := workspace.get_block_model(shape_id)
	return builtin if builtin else BlockModel.builtin_by_id(shape_id)

# Primary TextureAsset for a semantic (the model's "all"/"side"/first binding),
# or null when the resolved model carries no textures — the color path. Resolves
# texture ids through the workspace library, same stack walk as the others.
# (Per-face lookup by slice-plane normal is deferred; see the plan.)
func get_texture_for_semantic(semantic_name: String) -> TextureAsset:
	var model := get_model_for_semantic(semantic_name)
	if model == null or model.textures.is_empty():
		return null
	var key := "all"
	if not model.textures.has(key):
		key = "side" if model.textures.has("side") else model.textures.keys()[0]
	return workspace.get_texture_asset(model.textures[key])

func _builtin_model_id_for_shape(shape: BlockType.Shape) -> String:
	match shape:
		BlockType.Shape.SLAB: return BlockModel.BUILTIN_SLAB
		BlockType.Shape.STAIRS: return BlockModel.BUILTIN_STAIRS
		_: return BlockModel.BUILTIN_FULL

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

# ---------------------------------------------------------------------------
# Hotbar (unified across all views)
# ---------------------------------------------------------------------------

# Make `slot` the active one; its semantic becomes the selection used to place.
func select_slot(slot: int) -> void:
	if slot < 0 or slot >= HOTBAR_SIZE:
		return
	active_slot = slot
	active_slot_changed.emit(slot)
	select_semantic(hotbar[slot])

# Assign a semantic to a slot (does not change which slot is active).
func set_hotbar_slot(slot: int, semantic_name: String) -> void:
	if slot < 0 or slot >= HOTBAR_SIZE:
		return
	hotbar[slot] = semantic_name
	hotbar_changed.emit()
	if slot == active_slot:
		select_semantic(semantic_name)

# Put a semantic "in hand": if it's already on the hotbar, just jump to that
# slot; otherwise drop it into the active slot. This is MC creative "pick block".
func pick_block(semantic_name: String) -> void:
	if semantic_name.is_empty():
		return
	var existing := hotbar.find(semantic_name)
	if existing >= 0:
		select_slot(existing)
	else:
		hotbar[active_slot] = semantic_name
		hotbar_changed.emit()
		select_semantic(semantic_name)

# Fill empty hotbar slots from the palette so a freshly opened project is usable.
# Existing assignments are preserved; only blanks get filled, in palette order.
func _seed_hotbar_from_palette() -> void:
	var names := merged_semantic_names()
	var next := 0
	for slot in HOTBAR_SIZE:
		if not hotbar[slot].is_empty():
			continue
		while next < names.size() and hotbar.has(names[next]):
			next += 1
		if next < names.size():
			hotbar[slot] = names[next]
			next += 1

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
	# Shaped blocks — orientation only reads as something other than a cube once
	# the mapped block type declares a non-full shape.
	workspace.add_block_type("Oak Stairs").shape = BlockType.Shape.STAIRS
	workspace.add_block_type("Stone Brick Stairs").shape = BlockType.Shape.STAIRS
	workspace.add_block_type("Stone Slab").shape = BlockType.Shape.SLAB
	workspace.add_block_type("Oak Slab").shape = BlockType.Shape.SLAB

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
		["Stairs",    "Oak Stairs",    Color(0.74, 0.58, 0.33)],
		["Slab",      "Stone Slab",    Color(0.60, 0.60, 0.62)],
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
