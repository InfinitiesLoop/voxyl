class_name BlockLibrary
extends Resource

# A named bundle of block types plus the models/textures they need — e.g. `basic`,
# `vanilla-mc`, `gtnh`. This is the "named libraries" feature: what used to be a flat
# pile of block types on VoxelWorkspace is now split into swappable named sets, each
# its own self-contained material library. A Palette subscribes to an ordered stack of
# these (Palette.library_names) and draws its block types from them.
#
# It owns the per-array add/get/remove helpers that used to live on VoxelWorkspace
# (the importers and UI call these on a target library now), plus `order` bookkeeping:
# block types carry a per-library `order` so the Block Types grid can show one library
# at a time in a stable, user-meaningful sequence.
#
# `builtin` marks the code-seeded `basic` library — undeletable and re-seeded on launch
# so the "undecided"/planning floor always exists (Principle 5). It otherwise looks and
# behaves like any normal library.

@export var name: String = ""
@export var builtin := false
@export var block_types: Array[BlockType] = []
@export var block_models: Array[BlockModel] = []
@export var texture_assets: Array[TextureAsset] = []

# --- Block types ------------------------------------------------------------

# Add a block type, assigning it the next per-library order so a fresh block sorts
# after the existing ones in the grid.
func add_block_type(block_name: String) -> BlockType:
	var bt := BlockType.new()
	bt.name = block_name
	bt.order = next_order()
	block_types.append(bt)
	return bt

func get_block_type(block_name: String) -> BlockType:
	for bt in block_types:
		if bt.name == block_name:
			return bt
	return null

func remove_block_type(block_name: String) -> void:
	for i in block_types.size():
		if block_types[i].name == block_name:
			block_types.remove_at(i)
			return

# Block types sorted by (order, name) — the stable grid order. order is per-library;
# name breaks ties so equal-order blocks (e.g. a bulk import) stay alphabetical.
func sorted_block_types() -> Array[BlockType]:
	var out: Array[BlockType] = block_types.duplicate()
	out.sort_custom(func(a, b):
		if a.order != b.order:
			return a.order < b.order
		return a.name < b.name)
	return out

# The next order value (max existing + 1), so newly added/imported blocks append.
func next_order() -> int:
	var hi := -1
	for bt in block_types:
		if bt.order > hi:
			hi = bt.order
	return hi + 1

# --- Block model library (referenced by BlockType.model_id) -----------------

func add_block_model(model: BlockModel) -> BlockModel:
	block_models.append(model)
	return model

func get_block_model(model_id: String) -> BlockModel:
	for m in block_models:
		if m.id == model_id:
			return m
	return null

func remove_block_model(model_id: String) -> void:
	for i in block_models.size():
		if block_models[i].id == model_id:
			block_models.remove_at(i)
			return

# Seed the three built-in shape models so block types without an explicit model_id can
# resolve geometry by `shape`. Idempotent.
func register_builtin_models() -> void:
	for m in BlockModel.builtin_models():
		if get_block_model(m.id) == null:
			block_models.append(m)

# --- Texture asset library (referenced by BlockModel.textures) --------------

func add_texture_asset(texture: TextureAsset) -> TextureAsset:
	texture_assets.append(texture)
	return texture

func get_texture_asset(texture_id: String) -> TextureAsset:
	for t in texture_assets:
		if t.id == texture_id:
			return t
	return null

func remove_texture_asset(texture_id: String) -> void:
	for i in texture_assets.size():
		if texture_assets[i].id == texture_id:
			texture_assets.remove_at(i)
			return
