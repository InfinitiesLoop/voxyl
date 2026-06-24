class_name VoxelWorkspace
extends Resource

@export var block_types: Array[BlockType] = []
@export var palettes: Array[Palette] = []
@export var projects: Array[VoxelProject] = []
# Shared material-layer libraries, addressed by id. The importer dedups into
# these (a model/texture imported once, referenced by many block types).
@export var block_models: Array[BlockModel] = []
@export var texture_assets: Array[TextureAsset] = []

func add_block_type(block_name: String) -> BlockType:
	var bt := BlockType.new()
	bt.name = block_name
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

# Seed the three built-in shape models so block types without an explicit
# model_id can resolve geometry by `shape`. Idempotent.
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

func add_palette(palette_name: String) -> Palette:
	var p := Palette.new()
	p.name = palette_name
	palettes.append(p)
	return p

func get_palette(palette_name: String) -> Palette:
	for p in palettes:
		if p.name == palette_name:
			return p
	return null

func remove_palette(palette_name: String) -> void:
	for i in palettes.size():
		if palettes[i].name == palette_name:
			palettes.remove_at(i)
			return

func add_project(project_name: String) -> VoxelProject:
	var p := VoxelProject.new()
	p.name = project_name
	projects.append(p)
	return p

func get_project(project_name: String) -> VoxelProject:
	for p in projects:
		if p.name == project_name:
			return p
	return null

func remove_project(project_name: String) -> void:
	for i in projects.size():
		if projects[i].name == project_name:
			projects.remove_at(i)
			return
