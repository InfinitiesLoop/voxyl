class_name LibraryStore
extends RefCounted

# On-disk persistence for the shared, id-addressed material libraries — the
# BlockModel / TextureAsset / BlockType resources a VoxelWorkspace holds. This is
# the container the Phase 2 importer fills, but it is importer-agnostic: anything
# can write these files, by hand or by tool (decision 5 / "fillable by hand").
#
# The files are loose .tres under the AssetLibrary root. .tres is plain text and
# hand-editable, and crucially carries no Godot *import* sidecar (decision 3) — a
# runtime-saved .tres loads directly via ResourceLoader, unlike a .png/.obj which
# would need the editor import pipeline. The encoding is an implementation detail
# of this module: to move to JSON later, change it here and nowhere else.
#
# Pixels (the images TextureAsset.image_path references) are copied in separately
# by the importer; this module persists only the resource metadata.

# --- Save -------------------------------------------------------------------

# Write every model, texture and block type in `workspace` to the library root.
# Existing files for the same id/name are overwritten; stale files are not pruned
# (the importer owns its own dedup). Returns the first error, or OK.
static func save_all(workspace: VoxelWorkspace) -> Error:
	var err := _ensure_dirs()
	if err != OK:
		return err
	for model in workspace.block_models:
		err = _save(model, AssetLibrary.MODELS_DIR, model.id)
		if err != OK:
			return err
	for texture in workspace.texture_assets:
		err = _save(texture, AssetLibrary.TEXTURES_DIR, texture.id)
		if err != OK:
			return err
	for block_type in workspace.block_types:
		err = _save(block_type, AssetLibrary.BLOCK_TYPES_DIR, block_type.name)
		if err != OK:
			return err
	return OK

# --- Load -------------------------------------------------------------------

# Read every saved model, texture and block type into `workspace`, merging by
# id/name (an entry with a matching id replaces the in-memory one; new entries are
# appended). Merge — not replace — so code-seeded built-ins (full/slab/stairs) and
# defaults survive a load that only carries imported additions.
static func load_into(workspace: VoxelWorkspace) -> void:
	for model in _load_dir(AssetLibrary.MODELS_DIR):
		workspace.remove_block_model(model.id)
		workspace.block_models.append(model)
	for texture in _load_dir(AssetLibrary.TEXTURES_DIR):
		workspace.remove_texture_asset(texture.id)
		workspace.texture_assets.append(texture)
	for block_type in _load_dir(AssetLibrary.BLOCK_TYPES_DIR):
		workspace.remove_block_type(block_type.name)
		workspace.block_types.append(block_type)

# --- Internals --------------------------------------------------------------

static func _ensure_dirs() -> Error:
	for d in [AssetLibrary.MODELS_DIR, AssetLibrary.TEXTURES_DIR, AssetLibrary.BLOCK_TYPES_DIR]:
		var err := AssetLibrary.ensure_dir(d)
		if err != OK:
			return err
	return OK

static func _save(resource: Resource, dir: String, base: String) -> Error:
	# validate_filename() keeps human ids/names ("Oak Planks") usable as files
	# while stripping anything the filesystem would choke on.
	var rel := dir.path_join(base.validate_filename() + ".tres")
	return ResourceSaver.save(resource, AssetLibrary.path_for(rel))

static func _load_dir(dir: String) -> Array:
	var out: Array = []
	for file_name in AssetLibrary.list_files(dir):
		if not file_name.ends_with(".tres"):
			continue
		var rel := dir.path_join(file_name)
		# CACHE_MODE_IGNORE so a reload returns the file's contents, not a stale
		# instance ResourceLoader may already hold from an earlier save/load.
		var res := ResourceLoader.load(
			AssetLibrary.path_for(rel), "", ResourceLoader.CACHE_MODE_IGNORE)
		if res != null:
			out.append(res)
	return out
