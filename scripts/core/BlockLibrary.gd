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

# Lazy name/id → resource indexes so a big import (vanilla MC is thousands of block
# types / models / textures) stays linear instead of O(n²): every get/add during the
# import walked the whole array before. Transient (not @export) — rebuilt on first use
# after a load. Mutations through the add/remove helpers below keep them in sync; any
# code that pokes the arrays directly must call invalidate_index() (LibraryStore does
# after merging on-disk libraries over the seeded ones).
var _bt_index := {}      # block name -> BlockType
var _model_index := {}   # model id   -> BlockModel
var _tex_index := {}     # texture id -> TextureAsset
var _max_order := -1     # highest block-type order seen (so next_order() is O(1))
var _indexed := false

func _ensure_index() -> void:
	if _indexed:
		return
	_bt_index.clear(); _model_index.clear(); _tex_index.clear()
	_max_order = -1
	for bt in block_types:
		_bt_index[bt.name] = bt
		if bt.order > _max_order:
			_max_order = bt.order
	for m in block_models:
		_model_index[m.id] = m
	for t in texture_assets:
		_tex_index[t.id] = t
	_indexed = true

# Drop the indexes so they rebuild on next access. Call after mutating the arrays
# directly (bypassing the add/remove helpers).
func invalidate_index() -> void:
	_indexed = false

# --- Block types ------------------------------------------------------------

# Add a block type, assigning it the next per-library order so a fresh block sorts
# after the existing ones in the grid.
func add_block_type(block_name: String) -> BlockType:
	_ensure_index()
	var bt := BlockType.new()
	bt.name = block_name
	bt.order = _max_order + 1
	block_types.append(bt)
	_bt_index[block_name] = bt
	_max_order = bt.order
	return bt

func get_block_type(block_name: String) -> BlockType:
	_ensure_index()
	return _bt_index.get(block_name)

func remove_block_type(block_name: String) -> void:
	_ensure_index()
	if not _bt_index.has(block_name):
		return
	_bt_index.erase(block_name)
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
	_ensure_index()
	return _max_order + 1

# --- Block model library (referenced by BlockType.model_id) -----------------

func add_block_model(model: BlockModel) -> BlockModel:
	_ensure_index()
	block_models.append(model)
	_model_index[model.id] = model
	return model

func get_block_model(model_id: String) -> BlockModel:
	_ensure_index()
	return _model_index.get(model_id)

func remove_block_model(model_id: String) -> void:
	_ensure_index()
	if not _model_index.has(model_id):
		return
	_model_index.erase(model_id)
	for i in block_models.size():
		if block_models[i].id == model_id:
			block_models.remove_at(i)
			return

# Seed the three built-in shape models so block types without an explicit model_id can
# resolve geometry by `shape`. Idempotent.
func register_builtin_models() -> void:
	for m in BlockModel.builtin_models():
		if get_block_model(m.id) == null:
			add_block_model(m)

# --- Texture asset library (referenced by BlockModel.textures) --------------

func add_texture_asset(texture: TextureAsset) -> TextureAsset:
	_ensure_index()
	texture_assets.append(texture)
	_tex_index[texture.id] = texture
	return texture

func get_texture_asset(texture_id: String) -> TextureAsset:
	_ensure_index()
	return _tex_index.get(texture_id)

func remove_texture_asset(texture_id: String) -> void:
	_ensure_index()
	if not _tex_index.has(texture_id):
		return
	_tex_index.erase(texture_id)
	for i in texture_assets.size():
		if texture_assets[i].id == texture_id:
			texture_assets.remove_at(i)
			return
