class_name LibraryStore
extends RefCounted

# On-disk persistence for the named block libraries and palettes. Each BlockLibrary is
# its own folder under the AssetLibrary root —
#   ROOT/<library>/{models,textures,block_types}/*.tres
#   ROOT/<library>/pixels/<ns>/...png        (the images, copied by the importers)
# — so libraries are self-contained, swappable sets that can be added/removed wholesale.
# Palettes (which now carry library_names) persist alongside, under a reserved
# ROOT/palettes/ folder.
#
# The files are loose .tres: plain text, hand-editable, and crucially carrying no Godot
# *import* sidecar, so a runtime-saved .tres loads directly via ResourceLoader (unlike a
# .png/.obj which would need the editor import pipeline). The encoding is an
# implementation detail of this module — to move to JSON later, change it here.

# Reserved root child folder for palettes (so list_libraries can exclude it).
const PALETTES_DIR := "palettes"

# --- Save -------------------------------------------------------------------

# Persist one library: its models, textures, and block types under ROOT/<library>/.
# Existing files for the same id/name are overwritten; stale files are not pruned.
static func save_library(library: BlockLibrary) -> Error:
	var err := _ensure_library_dirs(library.name)
	if err != OK:
		return err
	for model in library.block_models:
		err = _save(model, AssetLibrary.in_library(library.name, AssetLibrary.MODELS_DIR), model.id)
		if err != OK:
			return err
	for texture in library.texture_assets:
		err = _save(texture, AssetLibrary.in_library(library.name, AssetLibrary.TEXTURES_DIR), texture.id)
		if err != OK:
			return err
	for block_type in library.block_types:
		err = _save(block_type, AssetLibrary.in_library(library.name, AssetLibrary.BLOCK_TYPES_DIR), block_type.name)
		if err != OK:
			return err
	return OK

# Persist every palette (they carry library_names + builtin) under ROOT/palettes/.
static func save_palettes(workspace: VoxelWorkspace) -> Error:
	var err := AssetLibrary.ensure_dir(PALETTES_DIR)
	if err != OK:
		return err
	for palette in workspace.palettes:
		err = _save(palette, PALETTES_DIR, palette.name)
		if err != OK:
			return err
	return OK

# Persist the whole workspace material layer: every library + every palette. The
# convenient "save everything" used after edits/imports when the caller doesn't want to
# track exactly which library changed.
static func save_all(workspace: VoxelWorkspace) -> Error:
	for library in workspace.libraries:
		var err := save_library(library)
		if err != OK:
			return err
	return save_palettes(workspace)

# --- Load -------------------------------------------------------------------

# The library folder names present under ROOT (every child dir except the reserved
# palettes folder).
static func list_libraries() -> PackedStringArray:
	var out := PackedStringArray()
	var dir := DirAccess.open(AssetLibrary.path_for())
	if dir == null:
		return out
	for d in dir.get_directories():
		if d != PALETTES_DIR:
			out.append(d)
	return out

# Read one library folder into a fresh BlockLibrary. `basic` is flagged builtin so it
# stays undeletable after a reload.
static func load_library(name: String) -> BlockLibrary:
	var lib := BlockLibrary.new()
	lib.name = name
	lib.builtin = name == VoxelWorkspace.BASIC_LIBRARY
	for model in _load_dir(AssetLibrary.in_library(name, AssetLibrary.MODELS_DIR)):
		lib.block_models.append(model)
	for texture in _load_dir(AssetLibrary.in_library(name, AssetLibrary.TEXTURES_DIR)):
		lib.texture_assets.append(texture)
	for block_type in _load_dir(AssetLibrary.in_library(name, AssetLibrary.BLOCK_TYPES_DIR)):
		lib.block_types.append(block_type)
	return lib

# Load every on-disk library + saved palette into `workspace`, over the code-seeded
# defaults. Libraries merge by id/name (disk wins for an edited block; a missing
# baseline block stays seeded — so `basic` is persisted-but-re-seeded and can't be
# emptied). Palettes replace by name (the saved Default carries the user's library
# subscriptions). Projects are not persisted — they stay code-seeded each launch.
static func load_persisted(workspace: VoxelWorkspace) -> void:
	for name in list_libraries():
		var target := workspace.get_or_add_library(name)
		if name == VoxelWorkspace.BASIC_LIBRARY:
			target.builtin = true
		_merge_library(target, load_library(name))
	# Keep the built-in shape models present even if an old on-disk basic lacked them.
	workspace.register_builtin_models()
	for palette in _load_dir(PALETTES_DIR):
		_replace_palette(workspace, palette)

# --- Internals --------------------------------------------------------------

# Merge `loaded` into `target` in place: disk entries win (replace same id/name), and
# baseline entries the disk doesn't carry are left untouched.
static func _merge_library(target: BlockLibrary, loaded: BlockLibrary) -> void:
	for model in loaded.block_models:
		target.remove_block_model(model.id)
		target.block_models.append(model)
	for texture in loaded.texture_assets:
		target.remove_texture_asset(texture.id)
		target.texture_assets.append(texture)
	for block_type in loaded.block_types:
		target.remove_block_type(block_type.name)
		target.block_types.append(block_type)

# Replace a palette by name (or append). Bypasses remove_palette's builtin guard so a
# saved Default (carrying the user's edited library subscriptions) overrides the seeded one.
static func _replace_palette(workspace: VoxelWorkspace, palette: Palette) -> void:
	for i in workspace.palettes.size():
		if workspace.palettes[i].name == palette.name:
			workspace.palettes[i] = palette
			return
	workspace.palettes.append(palette)

static func _ensure_library_dirs(library_name: String) -> Error:
	for d in [AssetLibrary.MODELS_DIR, AssetLibrary.TEXTURES_DIR, AssetLibrary.BLOCK_TYPES_DIR]:
		var err := AssetLibrary.ensure_dir(AssetLibrary.in_library(library_name, d))
		if err != OK:
			return err
	return OK

static func _save(resource: Resource, dir: String, base: String) -> Error:
	# validate_filename() keeps human ids/names ("Oak Planks") usable as files while
	# stripping anything the filesystem would choke on.
	var rel := dir.path_join(base.validate_filename() + ".tres")
	return ResourceSaver.save(resource, AssetLibrary.path_for(rel))

static func _load_dir(dir: String) -> Array:
	var out: Array = []
	for file_name in AssetLibrary.list_files(dir):
		if not file_name.ends_with(".tres"):
			continue
		var rel := dir.path_join(file_name)
		# CACHE_MODE_IGNORE so a reload returns the file's contents, not a stale instance
		# ResourceLoader may already hold from an earlier save/load.
		var res := ResourceLoader.load(
			AssetLibrary.path_for(rel), "", ResourceLoader.CACHE_MODE_IGNORE)
		if res != null:
			out.append(res)
	return out
